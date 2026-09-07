#!/usr/bin/env node
/**
 * fix-schema-quoting.js — repair double-quoted string literals in the stored
 * schema so VACUUM works again.
 *
 * THE PROBLEM. Three ALTER TABLE migrations wrote string literals in DOUBLE
 * quotes:
 *
 *   players.player_type        DEFAULT "regular" CHECK(... IN ("regular","outside"))
 *   gameweeks.game_type        DEFAULT "regular"
 *   contracts.tournament_rates DEFAULT "{}"
 *
 * Double quotes denote an IDENTIFIER in SQL. SQLite accepts them as strings only
 * through a deprecated fallback for identifiers that resolve to nothing, which
 * is why the app works day to day. VACUUM re-parses the schema strictly, the
 * fallback does not apply, and it fails with:
 *
 *   no such column: "regular" - should this be a string literal in single-quotes?
 *
 * So VACUUM, VACUUM INTO and every VACUUM-based backup or maintenance path are
 * unavailable. The fallback is also deprecated and can be compiled out — if that
 * happens, these DEFAULT and CHECK clauses stop working outright.
 *
 * THE APPROACH. SQLite cannot ALTER a column definition, and rebuilding
 * `players` means dropping a table five others reference. PRAGMA
 * writable_schema is blocked by node:sqlite's defensive mode. So this dumps the
 * database to SQL with the sqlite3 CLI, corrects the three literals in the DDL
 * text, and reloads into a NEW file. The replacement is semantically identical —
 * the fallback was already treating these as strings.
 *
 * It never modifies the source database. It writes a repaired copy and verifies
 * it: integrity_check, foreign_key_check, per-table row counts against the
 * original, no remaining bad literals, and a real VACUUM. Swapping it in is a
 * separate, deliberate step.
 *
 * Requires the sqlite3 CLI (present on the droplet, 3.45+).
 *
 * Usage:
 *   node scripts/fix-schema-quoting.js --check
 *   node scripts/fix-schema-quoting.js --repair-to /path/to/repaired.db
 */
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const repairTo = args.includes('--repair-to') ? args[args.indexOf('--repair-to') + 1] : null;
const DB = process.env.FMSS_DB_PATH || join(process.cwd(), 'data', 'fmss.db');

if (!existsSync(DB)) { console.error(`✗ no database at ${DB}`); process.exit(1); }

/** The exact substitutions. Deliberately narrow — only these three literals. */
const FIXES = [
  ['DEFAULT "regular"', "DEFAULT 'regular'"],
  ['IN ("regular", "outside")', "IN ('regular', 'outside')"],
  ['DEFAULT "{}"', "DEFAULT '{}'"],
];
const applyFixes = sql => FIXES.reduce((s, [from, to]) => s.split(from).join(to), sql);

const badObjects = db => db
  .prepare('SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL')
  .all()
  .filter(r => applyFixes(r.sql) !== r.sql);

const rowCounts = db => Object.fromEntries(
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map(t => [t.name, db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get().c])
);

function vacuumWorks(db, path) {
  // Probe beside the database: /tmp does not exist on Windows, and a path error
  // would masquerade as the schema fault we are testing for.
  const probe = `${path}.vacuum-probe-${Date.now()}`;
  try { db.exec(`VACUUM INTO '${probe.replace(/'/g, "''")}'`); rmSync(probe, { force: true }); return null; }
  catch (e) { rmSync(probe, { force: true }); return e.message; }
}

/* ---------- report ---------- */
const src = new DatabaseSync(DB, { readOnly: true });
const bad = badObjects(src);
const before = rowCounts(src);
const srcVacuum = vacuumWorks(src, DB);

console.log(`database: ${DB}`);
console.log(`objects needing repair: ${bad.length}${bad.length ? ' → ' + bad.map(b => b.name).join(', ') : ''}`);
console.log(`VACUUM currently: ${srcVacuum ? 'FAILS — ' + srcVacuum : 'works'}`);
console.log(`tables: ${Object.keys(before).length}, rows: ${Object.values(before).reduce((a, b) => a + b, 0)}`);
src.close();

if (!bad.length) { console.log('\n✓ nothing to repair'); process.exit(0); }
if (!repairTo) { console.log('\n(report only — pass --repair-to <path> to build a repaired copy)'); process.exit(0); }

/* ---------- repair into a new file ---------- */
for (const s of ['', '-wal', '-shm']) rmSync(repairTo + s, { force: true });
const dumpPath = `${repairTo}.sql`;

console.log(`\ndumping ${DB} …`);
const dump = execFileSync('sqlite3', [DB, '.dump'], { maxBuffer: 1024 * 1024 * 512 }).toString();
const fixed = applyFixes(dump);

const changed = FIXES.filter(([from]) => dump.includes(from));
console.log(`corrected ${changed.length} literal form(s): ${changed.map(([f]) => f).join(' · ')}`);
if (fixed === dump) { console.error('✗ dump contained none of the target literals — aborting'); process.exit(1); }
if (/DEFAULT\s+"/.test(fixed)) {
  console.error('✗ a double-quoted DEFAULT survives in the corrected dump — aborting');
  process.exit(1);
}

writeFileSync(dumpPath, fixed);
console.log(`reloading into ${repairTo} …`);
execFileSync('sqlite3', [repairTo], { input: fixed, maxBuffer: 1024 * 1024 * 512 });
rmSync(dumpPath, { force: true });

/* ---------- verify the repaired copy ---------- */
const out = new DatabaseSync(repairTo);
const integrity = out.prepare('PRAGMA integrity_check').get().integrity_check;
const fks = out.prepare('PRAGMA foreign_key_check').all();
const after = rowCounts(out);
const stillBad = badObjects(out).length;
const outVacuum = vacuumWorks(out, repairTo);
out.close();

const missing = Object.keys(before).filter(t => after[t] === undefined);
const mismatched = Object.keys(before).filter(t => after[t] !== undefined && after[t] !== before[t]);

console.log('\nintegrity_check      :', integrity);
console.log('foreign_key_check    :', fks.length ? `${fks.length} violation(s)` : 'clean');
console.log('tables missing       :', missing.length ? missing.join(', ') : 'none');
console.log('row-count mismatches :', mismatched.length ? mismatched.map(t => `${t} ${before[t]}→${after[t]}`).join(', ') : 'none');
console.log('bad literals left    :', stillBad);
console.log('VACUUM on the copy   :', outVacuum ? 'STILL FAILS — ' + outVacuum : 'works');
console.log('size                 :', `${(statSync(repairTo).size / 1024).toFixed(0)} KB`);

const ok = integrity === 'ok' && !fks.length && !missing.length && !mismatched.length
  && !stillBad && !outVacuum;
console.log(ok ? '\n✓ repaired copy verified — safe to swap in'
                : '\n✗ NOT clean — do not swap this in');
process.exit(ok ? 0 : 1);
