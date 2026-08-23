// backup.js — whole-database export and restore.
//
// The export is a single JSON document containing every table, so it can be kept
// offline and later reloaded into an empty or existing install. The restore is
// the most destructive operation in the app, so it is built defensively:
//
//   - table and column names from the file are NEVER used directly. They are
//     matched against the live schema first; anything unrecognised is reported
//     and skipped. A backup file is untrusted input, and these names would
//     otherwise be interpolated straight into SQL.
//   - the whole restore runs in one transaction and rolls back on any error, so
//     a bad file cannot leave a half-replaced database.
//   - the current database is written to a timestamped file before anything is
//     replaced, so an unwanted restore is itself undoable.
//
// auth_users holds PINs and password hashes. Exports include them by default so
// a restore produces a working system, but `includeCredentials: false` redacts
// them — use that for a copy you intend to share or store loosely.

import { db, DB_FILE } from './db.js';
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const BACKUP_FORMAT = 1;

const CREDENTIAL_COLUMNS = new Set(['pin', 'pin_hash', 'password_hash', 'token', 'secret']);

/** Tables that actually exist right now, with their real column names. */
function liveSchema() {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(r => r.name);
  const schema = {};
  for (const t of tables) {
    schema[t] = db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
  }
  return schema;
}

/** Everything, as a plain object ready to be JSON.stringify'd. */
export function exportAll({ includeCredentials = true } = {}) {
  const schema = liveSchema();
  const tables = {};
  const counts = {};
  let redacted = 0;

  for (const [name, cols] of Object.entries(schema)) {
    const rows = db.prepare(`SELECT * FROM "${name}"`).all().map(r => ({ ...r }));
    if (!includeCredentials) {
      for (const row of rows) {
        for (const c of cols) {
          if (CREDENTIAL_COLUMNS.has(c) && row[c] != null) { row[c] = null; redacted++; }
        }
      }
    }
    tables[name] = rows;
    counts[name] = rows.length;
  }

  return {
    fmss_backup: BACKUP_FORMAT,
    created_at: new Date().toISOString(),
    includes_credentials: includeCredentials,
    redacted_fields: redacted,
    counts,
    total_rows: Object.values(counts).reduce((a, b) => a + b, 0),
    schema,
    tables,
  };
}

/**
 * Validate a backup and describe what restoring it would do. Writes nothing.
 * Returns { ok, format, created_at, totals, tables:[...], problems:[...] }.
 */
export function inspect(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object') {
    return { ok: false, problems: ['Not a JSON object.'] };
  }
  if (doc.fmss_backup !== BACKUP_FORMAT) {
    problems.push(`Unexpected format: ${JSON.stringify(doc.fmss_backup)} (expected ${BACKUP_FORMAT}).`);
  }
  if (!doc.tables || typeof doc.tables !== 'object') {
    return { ok: false, problems: [...problems, 'No "tables" section — this is not an FMSS backup.'] };
  }

  const schema = liveSchema();
  const report = [];
  let willRestore = 0;

  for (const [name, rows] of Object.entries(doc.tables)) {
    const live = schema[name];
    const count = Array.isArray(rows) ? rows.length : 0;
    if (!live) {
      report.push({ table: name, rows: count, current: null, action: 'skip', reason: 'no such table here' });
      problems.push(`Table "${name}" does not exist in this install and will be skipped.`);
      continue;
    }
    const fileCols = count ? Object.keys(rows[0]) : [];
    const unknownCols = fileCols.filter(c => !live.includes(c));
    const missingCols = live.filter(c => count && !fileCols.includes(c));
    if (unknownCols.length) {
      problems.push(`"${name}": ignoring column(s) not in this schema — ${unknownCols.join(', ')}.`);
    }
    const current = db.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n;
    report.push({
      table: name, rows: count, current, action: 'replace',
      ignored_columns: unknownCols, defaulted_columns: missingCols,
    });
    willRestore += count;
  }

  // Tables present here but absent from the file would be emptied — call it out.
  for (const name of Object.keys(schema)) {
    if (!(name in doc.tables)) {
      const current = db.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n;
      if (current > 0) {
        problems.push(`"${name}" holds ${current} row(s) here but is absent from the backup; it will be emptied.`);
      }
      report.push({ table: name, rows: 0, current, action: 'empty' });
    }
  }

  return {
    ok: problems.every(p => !p.startsWith('Unexpected format')) && !!doc.tables,
    format: doc.fmss_backup,
    created_at: doc.created_at || null,
    includes_credentials: doc.includes_credentials !== false,
    total_rows: willRestore,
    tables: report.sort((a, b) => b.rows - a.rows),
    problems,
  };
}

/**
 * Replace the database contents with the backup. Everything happens in one
 * transaction; any error rolls the whole thing back.
 * Returns { restored, skipped, safety_copy }.
 */
export function restore(doc, { dbPath = DB_FILE } = {}) {
  const check = inspect(doc);
  if (!check.ok) throw new Error(`Refusing to restore: ${check.problems[0] || 'invalid backup'}`);

  // Snapshot the current file first so this operation is itself reversible.
  let safety = null;
  if (dbPath && existsSync(dbPath)) {
    const dir = join(dirname(dbPath), 'backups');
    mkdirSync(dir, { recursive: true });
    safety = join(dir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    copyFileSync(dbPath, safety);
  }

  const schema = liveSchema();
  const restored = {};
  const skipped = [];

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    // Clear every known table, including ones the file omits, so the result is
    // the backup exactly rather than a merge with whatever was here.
    for (const name of Object.keys(schema)) db.prepare(`DELETE FROM "${name}"`).run();

    for (const [name, rows] of Object.entries(doc.tables)) {
      const live = schema[name];
      if (!live) { skipped.push(name); continue; }
      if (!Array.isArray(rows) || !rows.length) { restored[name] = 0; continue; }

      // Only columns that exist here, quoted — never the file's names raw.
      const cols = Object.keys(rows[0]).filter(c => live.includes(c));
      if (!cols.length) { skipped.push(name); continue; }
      const stmt = db.prepare(
        `INSERT INTO "${name}" (${cols.map(c => `"${c}"`).join(',')})
         VALUES (${cols.map(() => '?').join(',')})`);
      for (const row of rows) {
        stmt.run(...cols.map(c => {
          const v = row[c];
          if (v === undefined) return null;
          // node:sqlite binds primitives only.
          return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
        }));
      }
      restored[name] = rows.length;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw new Error(`Restore failed and was rolled back: ${e.message}`);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  return {
    restored,
    skipped,
    total_rows: Object.values(restored).reduce((a, b) => a + b, 0),
    safety_copy: safety,
  };
}

/** Write an export to disk (used by the CLI). */
export function writeBackupFile(path, opts) {
  const doc = exportAll(opts);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2), 'utf8');
  return doc;
}
