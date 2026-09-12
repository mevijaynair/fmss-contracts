#!/usr/bin/env node
/**
 * prune-empty-ledgers.js — remove accounts that were never used.
 *
 * Every charged player used to be given a ledger row on the contract they played,
 * including guests who pay cash and keep no balance at all. Those accounts hold
 * nothing and never will, but they appear in every list built from ledgers, which
 * is most of them — 110 rows for 61 people, and only a fraction of them real.
 *
 * A row is safe to remove only when it is provably empty: no opening balance, no
 * status set by hand, no contributions, no charges either played or settled, and
 * no transactions. Anything with a trace of money or intent is left alone, so
 * this can never delete a balance.
 *
 * It prints what it would do and changes nothing unless you pass --apply.
 *
 *   node scripts/prune-empty-ledgers.js            # report only
 *   node scripts/prune-empty-ledgers.js --apply    # do it
 */
import { db, initSchema, DB_FILE } from '../server/db.js';
import { ledgersRepo } from '../server/repos/ledgers.js';

const apply = process.argv.includes('--apply');
initSchema();

console.log(`Database: ${DB_FILE}`);
console.log(`Mode: ${apply ? 'APPLY — rows will be deleted' : 'report only (pass --apply to change anything)'}\n`);

const empty = db.prepare(`
  SELECT l.player_id, l.contract_id, p.name AS player_name,
         COALESCE(p.player_type,'regular') AS player_type
  FROM ledgers l
  JOIN players p ON p.id = l.player_id
  WHERE l.opening_balance = 0
    AND COALESCE(l.status,'') = ''
    AND NOT EXISTS (SELECT 1 FROM contributions q
                    WHERE q.player_id = l.player_id AND q.contract_id = l.contract_id)
    AND NOT EXISTS (SELECT 1 FROM transactions t
                    WHERE t.player_id = l.player_id AND t.contract_id = l.contract_id)
    AND NOT EXISTS (SELECT 1 FROM charges ch JOIN gameweeks g ON g.id = ch.gameweek_id
                    WHERE g.contract_id = l.contract_id
                      AND (ch.player_id = l.player_id
                           OR COALESCE(ch.charged_to, ch.player_id) = l.player_id))
  ORDER BY p.name, l.contract_id`).all();

const before = db.prepare('SELECT COUNT(*) n FROM ledgers').get().n;
console.log(`Ledger rows: ${before}. Provably empty: ${empty.length}.\n`);
for (const r of empty) {
  console.log(`  ${r.player_name.padEnd(22)} ${r.contract_id.padEnd(9)} ${r.player_type}`);
}

// The figures that must not move. If pruning changes either of these, the rows
// were not as empty as the query claimed and the whole thing is rolled back.
const totals = () => Object.fromEntries(
  db.prepare('SELECT contract_id FROM contracts').all().map(c => [
    c.id,
    Math.round(ledgersRepo.forContract(c.id)
      .reduce((s, l) => s + l.present_balance, 0) * 100) / 100,
  ]));

const totalsBefore = totals();
console.log(`\nContract totals now: ${JSON.stringify(totalsBefore)}`);

if (!apply) {
  console.log('\nNothing changed. Re-run with --apply once the list above looks right.');
  process.exit(0);
}
if (!empty.length) {
  console.log('\nNothing to prune.');
  process.exit(0);
}

db.exec('BEGIN IMMEDIATE');
try {
  const del = db.prepare('DELETE FROM ledgers WHERE player_id = ? AND contract_id = ?');
  for (const r of empty) del.run(r.player_id, r.contract_id);

  const totalsAfter = totals();
  for (const [contract, value] of Object.entries(totalsBefore)) {
    if (Math.abs((totalsAfter[contract] ?? 0) - value) > 0.005) {
      throw new Error(`${contract} total moved: ${value} → ${totalsAfter[contract]}`);
    }
  }
  db.exec('COMMIT');
  console.log(`\nRemoved ${empty.length} empty account(s). `
    + `Ledger rows: ${before} → ${db.prepare('SELECT COUNT(*) n FROM ledgers').get().n}.`);
  console.log(`Contract totals unchanged: ${JSON.stringify(totalsAfter)}`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error(`\nFailed, nothing changed: ${e.message}`);
  process.exit(1);
}
