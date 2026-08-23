#!/usr/bin/env node
/**
 * backup.js — export or restore the whole database from the command line.
 *
 * Useful when the site is down, when scheduling backups from cron, or when you
 * would rather not perform a destructive restore through a browser.
 *
 *   node scripts/backup.js export                     → data/backups/fmss-<stamp>.json
 *   node scripts/backup.js export --out /tmp/x.json
 *   node scripts/backup.js export --no-credentials    → redact PINs and hashes
 *
 *   node scripts/backup.js inspect <file>             → what a restore would do
 *   node scripts/backup.js restore <file>             → dry run, prints the plan
 *   node scripts/backup.js restore <file> --commit    → apply it
 *
 * A restore replaces everything. The current database is copied to
 * data/backups/pre-restore-<stamp>.db first, so it can be undone.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(n);
const opt = (n, d = null) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);

if (!cmd || flag('--help') || flag('-h')) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0].replace(/^\/\*\*?/, ''));
  process.exit(0);
}

const { exportAll, inspect, restore, writeBackupFile } = await import('../server/backup.js');
const { DB_FILE } = await import('../server/db.js');

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const fmt = (n) => String(n).padStart(6);

if (cmd === 'export') {
  const out = resolve(opt('--out') || join(ROOT, 'data', 'backups', `fmss-${stamp()}.json`));
  mkdirSync(dirname(out), { recursive: true });
  const doc = writeBackupFile(out, { includeCredentials: !flag('--no-credentials') });
  console.log(`Source : ${DB_FILE}`);
  console.log(`Written: ${out}`);
  console.log(`Rows   : ${doc.total_rows} across ${Object.keys(doc.tables).length} table(s)`);
  if (!doc.includes_credentials) console.log(`Redacted ${doc.redacted_fields} credential field(s).`);
  else console.log('NOTE: contains PINs and password hashes — store it accordingly.');
  process.exit(0);
}

const file = args.find(a => !a.startsWith('-') && a !== cmd);
if (!file) { console.error('Give the path to a backup file.'); process.exit(1); }
const doc = JSON.parse(readFileSync(resolve(file), 'utf8'));

if (cmd === 'inspect' || cmd === 'restore') {
  const check = inspect(doc);
  console.log(`Backup : ${file}`);
  console.log(`Created: ${check.created_at || 'unknown'}   format ${check.format}`);
  console.log(`Target : ${DB_FILE}`);
  console.log(`Credentials included: ${check.includes_credentials ? 'yes' : 'no (redacted)'}`);
  console.log('');
  console.log('  table                          in file   here now   action');
  for (const t of check.tables) {
    if (!t.rows && !t.current) continue;
    console.log('  ' + t.table.padEnd(28) + fmt(t.rows) + fmt(t.current ?? 0) + '   ' + t.action);
  }
  console.log('');
  console.log(`Total rows to restore: ${check.total_rows}`);
  if (check.problems.length) {
    console.log('');
    console.log('Warnings:');
    for (const p of check.problems) console.log('  - ' + p);
  }
  if (cmd === 'inspect') process.exit(check.ok ? 0 : 1);

  if (!check.ok) { console.error('\nRefusing to restore — see above.'); process.exit(1); }
  if (!flag('--commit')) {
    console.log('\nDRY RUN. Re-run with --commit to replace the database.');
    process.exit(0);
  }

  let res;
  try {
    res = restore(doc);
  } catch (e) {
    // The restore is transactional, so a failure here means nothing changed.
    console.error('');
    console.error(e.message);
    console.error('The database was NOT modified — the transaction rolled back.');
    process.exit(1);
  }
  console.log('');
  console.log(`Restored ${res.total_rows} row(s).`);
  if (res.safety_copy) console.log(`Previous database saved to: ${res.safety_copy}`);
  if (res.skipped.length) console.log(`Skipped tables: ${res.skipped.join(', ')}`);
  console.log('\nRestart the app so it picks the data up.');
  process.exit(0);
}

console.error(`Unknown command "${cmd}". Use export, inspect or restore.`);
process.exit(1);
