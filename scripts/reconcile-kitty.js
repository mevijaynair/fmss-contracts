#!/usr/bin/env node
/**
 * reconcile-kitty.js — move the kitty onto the derived entries, once.
 *
 * Until now a game's profit reached the kitty through a confirm() dialog in the
 * browser, fired after the game had already been saved. Three things went wrong
 * with that, and all three are visible in the data:
 *
 *   - Declining the dialog (or losing the tab, or any error) left the game
 *     recorded and its money nowhere.
 *   - Accepting it twice banked the same profit twice — nothing keyed the entry
 *     to the game, so there was no second write to overwrite the first.
 *   - Deleting the game left the entry behind, crediting the pot for a match
 *     that no longer exists.
 *
 * The kitty is now derived from the charges, keyed to the game in `scope`, and
 * written inside the same transaction. This script retires the old rows and
 * rebuilds the new ones from what the games actually say.
 *
 * It prints what it would do and changes nothing unless you pass --apply.
 * Take a backup first; this rewrites money.
 *
 *   node scripts/reconcile-kitty.js            # report only
 *   node scripts/reconcile-kitty.js --apply    # do it
 */
import { db, initSchema, DB_FILE } from '../server/db.js';
import { gameweeksRepo } from '../server/repos/gameweeks.js';
import { kittyRepo } from '../server/repos/kitty.js';

const apply = process.argv.includes('--apply');
initSchema();

const money = (n) => (Math.round(n * 100) / 100).toFixed(2);
console.log(`Database: ${DB_FILE}`);
console.log(`Mode: ${apply ? 'APPLY — this will change the kitty' : 'report only (pass --apply to change anything)'}\n`);

const before = kittyRepo.balance();

// The old dialog's entries are recognisable by the label it hard-coded. They
// carry no scope, so nothing else can tell them apart from a hand-typed entry —
// which is the whole reason they could pile up.
const legacy = db.prepare(
  `SELECT id, kind, amount, date, label FROM kitty
   WHERE historical = 0 AND scope = '' AND (label LIKE 'GW Result%')
   ORDER BY date`).all();

console.log(`Old game entries to retire: ${legacy.length}`);
for (const r of legacy) {
  console.log(`  ${r.date}  ${r.kind.padEnd(7)} ${money(r.amount).padStart(9)}  ${r.label}`);
}

const games = db.prepare(
  'SELECT id, date, contract_id FROM gameweeks WHERE historical = 0 ORDER BY date').all();
console.log(`\nLive games to derive entries for: ${games.length}`);

if (!apply) {
  console.log('\nNothing changed. Re-run with --apply once the list above looks right.');
  process.exit(0);
}

/* Re-deriving is meant to restate the SAME money in the right rows, so unless
   legacy entries are being retired the pot must come out where it went in.
   Checked inside the transaction and rolled back on drift — a guard that runs
   afterwards only tells you the damage is done. --allow-change is for the case
   where the change IS the point, and it prints the delta either way. */
const allowChange = process.argv.includes('--allow-change');
const legacyNet = legacy.reduce((s, r) => s + (r.kind === 'income' ? r.amount : -r.amount), 0);

db.exec('BEGIN IMMEDIATE');
try {
  for (const r of legacy) db.prepare('DELETE FROM kitty WHERE id = ?').run(r.id);
  for (const g of games) gameweeksRepo.recomputeGameKitty(g.id);

  const moved = kittyRepo.balance().balance - before.balance;
  const expected = -legacyNet;            // only the retired rows may move it
  if (!allowChange && Math.abs(moved - expected) > 0.005) {
    throw new Error(`the pot moved ${money(moved)} and only ${money(expected)} was accounted for`
      + ' — re-run with --allow-change if that is intended');
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error(`\nFailed, nothing changed: ${e.message}`);
  process.exit(1);
}

const after = kittyRepo.balance();
const derived = db.prepare("SELECT id, kind, amount, date, label FROM kitty WHERE scope <> '' ORDER BY date").all();
console.log(`\nDerived entries now in place: ${derived.length}`);
for (const r of derived) {
  console.log(`  ${r.date}  ${r.kind.padEnd(7)} ${money(r.amount).padStart(9)}  ${r.label}`);
}
console.log(`\nKitty balance  before ${money(before.balance)}  →  after ${money(after.balance)}`);
