#!/usr/bin/env node
/**
 * test-backup.js — does a backup actually survive the round trip?
 *
 * Export and restore are the two operations nobody rehearses. They are used
 * once, in an emergency, by someone who is already having a bad day, and a
 * silent loss in either direction is only discovered when the data is needed
 * and gone. So this test does not ask the backup code whether it worked.
 *
 * It takes a database, exports it, restores that export into a SEPARATE empty
 * database, and then compares the two files **with raw SQL** — every table,
 * every row, every column, value and type. backup.js is the thing under test;
 * it is never the thing doing the checking. A self-referential test proves
 * self-consistency, not correctness.
 *
 * Run against real data when you have it:
 *   node scripts/test-backup.js                 → uses data/fmss.db
 *   node scripts/test-backup.js <some.db>       → uses that file
 */
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// An ESM import of an absolute path must be a file:// URL — a bare Windows
// path is read as a URL with scheme "c:" and refused.
const BACKUP_JS = JSON.stringify(pathToFileURL(join(ROOT, 'server/backup.js')).href);
const url = (p) => JSON.stringify(pathToFileURL(p).href);

let pass = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return true; }
  failures.push(detail ? `${name}\n      ${detail}` : name);
  return false;
};

/**
 * Read a whole database into a comparable shape, using nothing but SQL.
 *
 * Values carry their type so that a number that comes back as the string "5"
 * is a failure rather than a match — that is exactly the kind of drift a
 * JSON round trip introduces, and exactly what silently breaks arithmetic on
 * a restored ledger.
 */
function readDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(r => r.name);
  const out = {};
  for (const t of tables) {
    // Physical column order is NOT stable across installs: a database that grew
    // by ALTER TABLE has its newer columns at the end, while one built from the
    // current CREATE TABLE has them where they are declared. Both are correct
    // and hold identical data. So everything here is keyed by column NAME —
    // including the sort — or the comparison silently comes adrift and lines
    // one column up against a different one.
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name).sort();
    const order = cols.map(c => `"${c}"`).join(',');
    const rows = db.prepare(`SELECT * FROM "${t}" ORDER BY ${order}`).all();
    out[t] = {
      cols,
      rows: rows.map(r => Object.fromEntries(cols.map(c => [c, stamp(r[c])]))),
    };
  }
  db.close();
  return out;
}

/** A value plus its type, rendered so two of them can be compared as strings. */
function stamp(v) {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Uint8Array) return `blob:${Buffer.from(v).toString('hex')}`;
  return `${typeof v}:${String(v)}`;
}

/** Run a script with a chosen database, so each step gets a clean process. */
function withDb(dbPath, code) {
  const f = join(dirname(dbPath), `step-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(f, code, 'utf8');
  try {
    return execFileSync(process.execPath, [f], {
      env: { ...process.env, FMSS_DB_PATH: dbPath },
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally { rmSync(f, { force: true }); }
}

const source = resolve(process.argv[2] || join(ROOT, 'data', 'fmss.db'));
if (!existsSync(source)) {
  console.error(`No such database: ${source}`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'fmss-backup-'));
const origin = join(tmp, 'origin.db');
const target = join(tmp, 'target.db');
const docFile = join(tmp, 'backup.json');

console.log(`\nBackup round trip\n  source: ${source}\n`);

try {
  // Work on a copy so a bug in the code under test cannot touch real data.
  copyFileSync(source, origin);
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(source + ext)) copyFileSync(source + ext, origin + ext);
  }

  // ---- 1. export -------------------------------------------------------
  withDb(origin, `
    import { writeBackupFile } from ${BACKUP_JS};
    writeBackupFile(${JSON.stringify(docFile)}, { includeCredentials: true });
  `);
  const doc = JSON.parse(readFileSync(docFile, 'utf8'));
  ok('export produced a file', existsSync(docFile));
  ok('export declares the format', doc.fmss_backup === 1);

  const before = readDatabase(origin);

  // The export must contain every table that exists, not just the ones with
  // rows — an omitted table is emptied on restore, which is data loss.
  for (const t of Object.keys(before)) {
    ok(`export includes table "${t}"`, Array.isArray(doc.tables?.[t]),
      `table missing from the backup entirely`);
  }
  for (const [t, { rows }] of Object.entries(before)) {
    ok(`export row count matches for "${t}"`,
      (doc.tables?.[t]?.length ?? -1) === rows.length,
      `database has ${rows.length}, backup has ${doc.tables?.[t]?.length}`);
  }

  // ---- 2. restore into an empty database -------------------------------
  withDb(target, `
    import { restore } from ${BACKUP_JS};
    import { readFileSync } from 'node:fs';
    restore(JSON.parse(readFileSync(${JSON.stringify(docFile)}, 'utf8')));
  `);
  ok('restore produced a database', existsSync(target));

  // ---- 3. compare, with SQL, not with the backup code ------------------
  const after = readDatabase(target);

  const missing = Object.keys(before).filter(t => !(t in after));
  ok('every table survived', missing.length === 0, `lost: ${missing.join(', ')}`);

  let cellsChecked = 0;
  for (const [t, src] of Object.entries(before)) {
    const dst = after[t];
    if (!dst) continue;
    if (!ok(`"${t}" has the same number of rows`, src.rows.length === dst.rows.length,
      `before ${src.rows.length}, after ${dst.rows.length}`)) continue;
    ok(`"${t}" has the same columns`, src.cols.join() === dst.cols.join(),
      `before [${src.cols}], after [${dst.cols}]`);

    let bad = null;
    for (let i = 0; i < src.rows.length && !bad; i++) {
      for (const c of src.cols) {
        cellsChecked++;
        if (src.rows[i][c] !== dst.rows[i][c]) {
          bad = `row ${i}, column "${c}": ` +
                `before ${src.rows[i][c]} — after ${dst.rows[i][c]}`;
          break;
        }
      }
    }
    ok(`"${t}" round-trips value for value`, !bad, bad || '');
  }
  console.log(`  compared ${cellsChecked} cells across ${Object.keys(before).length} tables\n`);

  // ---- 4. the restored database must be internally sound ---------------
  const t2 = new DatabaseSync(target, { readOnly: true });
  const fk = t2.prepare('PRAGMA foreign_key_check').all();
  ok('restored database has no broken foreign keys', fk.length === 0,
    fk.slice(0, 5).map(r => `${r.table}.${r.rowid} -> ${r.parent}`).join('; '));
  const integrity = t2.prepare('PRAGMA integrity_check').get();
  ok('restored database passes integrity_check',
    Object.values(integrity)[0] === 'ok', JSON.stringify(integrity));
  t2.close();

  // ---- 5. the safety copy must be usable -------------------------------
  // A restore is only reversible if the copy it takes first is complete. In
  // WAL mode the newest writes live in the -wal file, so a copy of the main
  // database alone can be missing everything recent.
  const guard = join(tmp, 'guard.db');
  copyFileSync(origin, guard);
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(origin + ext)) copyFileSync(origin + ext, guard + ext);
  }
  const out = withDb(guard, `
    import { restore } from ${BACKUP_JS};
    import { readFileSync } from 'node:fs';
    const r = restore(JSON.parse(readFileSync(${JSON.stringify(docFile)}, 'utf8')));
    console.log(JSON.stringify({ safety: r.safety_copy }));
  `);
  const { safety } = JSON.parse(out.trim().split('\n').pop());
  if (ok('restore took a safety copy', !!safety && existsSync(safety), String(safety))) {
    const saved = readDatabase(safety);
    let lost = [];
    for (const [t, src] of Object.entries(before)) {
      const n = saved[t]?.rows.length ?? 0;
      if (n !== src.rows.length) lost.push(`${t}: ${src.rows.length} -> ${n}`);
    }
    ok('the safety copy holds the data it was protecting', lost.length === 0,
      `rows missing from the undo copy — ${lost.slice(0, 6).join(', ')}`);
  }

  // ---- 6. a redacted backup must not be silently restorable ------------
  const redacted = join(tmp, 'redacted.json');
  withDb(origin, `
    import { writeBackupFile } from ${BACKUP_JS};
    writeBackupFile(${JSON.stringify(redacted)}, { includeCredentials: false });
  `);
  const rdoc = JSON.parse(readFileSync(redacted, 'utf8'));
  ok('redacted export is marked as redacted', rdoc.includes_credentials === false);
  const stillHasSecrets = (rdoc.tables.auth_users || []).some(
    r => r.pin_hash != null || r.password_hash != null);
  ok('redacted export really removed the credentials', !stillHasSecrets,
    'a PIN or password hash survived --no-credentials');
  const warned = withDb(target, `
    import { inspect } from ${BACKUP_JS};
    import { readFileSync } from 'node:fs';
    const c = inspect(JSON.parse(readFileSync(${JSON.stringify(redacted)}, 'utf8')));
    console.log(JSON.stringify(c.problems));
  `);
  ok('restoring a redacted backup warns that logins will break',
    /credential|login|pin|password/i.test(warned),
    `inspect() said: ${warned.trim()}`);

  // ---- 7. a bad backup must be refused, and change nothing -------------
  // The restore is the most destructive thing the app can do. Refusing is only
  // half of it: what matters is that the database it refused to replace is
  // still exactly as it was.
  const victim = join(tmp, 'victim.db');
  copyFileSync(origin, victim);
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(origin + ext)) copyFileSync(origin + ext, victim + ext);
  }
  const intact = readDatabase(victim);

  const attempt = (label, mutate, expectPattern) => {
    const bad = JSON.parse(readFileSync(docFile, 'utf8'));
    mutate(bad);
    const badFile = join(tmp, `bad-${label.replace(/\W+/g, '-')}.json`);
    writeFileSync(badFile, JSON.stringify(bad), 'utf8');
    let out = '';
    try {
      out = withDb(victim, `
        import { restore } from ${BACKUP_JS};
        import { readFileSync } from 'node:fs';
        try {
          restore(JSON.parse(readFileSync(${url(badFile)}, 'utf8')));
          console.log('RESTORED');
        } catch (e) { console.log('REFUSED: ' + e.message); }
      `);
    } catch (e) { out = 'THREW: ' + e.message; }
    ok(`refuses ${label}`, expectPattern.test(out), out.trim().slice(0, 200));

    // …and the database must be byte-for-byte what it was.
    const now = readDatabase(victim);
    const changed = Object.keys(intact).filter(t =>
      JSON.stringify(intact[t]) !== JSON.stringify(now[t]));
    ok(`database untouched after refusing ${label}`, changed.length === 0,
      `these tables changed: ${changed.join(', ')}`);
  };

  // A reference that points at a player who is not in the file. Restoring this
  // would leave charges and ledgers hanging off nobody.
  attempt('a backup with a broken foreign key',
    (b) => {
      const t = b.tables.transactions?.[0] || b.tables.charges?.[0];
      if (t) t.player_id = 'no_such_player_at_all';
    },
    /REFUSED|THREW/);

  // A table this install has never heard of, carrying rows. Silently dropping
  // them would be reported as a successful restore.
  attempt('a backup carrying an unknown table with rows',
    (b) => { b.tables.some_future_table = [{ id: 'x', value: 1 }]; },
    /REFUSED|THREW/);

  // Not an FMSS backup at all.
  attempt('a file that is not a backup',
    (b) => { delete b.fmss_backup; b.tables = { players: [] }; },
    /REFUSED|THREW/);

} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures.length
  ? `FAILED ${failures.length} of ${pass + failures.length}\n\n  - ${failures.join('\n  - ')}\n`
  : `All ${pass} backup checks passed.\n`);
process.exit(failures.length ? 1 : 0);
