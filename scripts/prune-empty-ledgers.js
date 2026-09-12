#!/usr/bin/env node
/**
 * prune-empty-ledgers.js — remove accounts that were never used.
 *
 * Every charged player used to be given a ledger row on the contract they played,
 * including guests who pay cash and keep no balance at all. Those accounts hold
 * nothing and never will, but they appear in every list built from ledgers, which
 * is most of them — 110 rows for 61 people, and only a fraction of them real.
 *
 * A row goes only when it is provably empty and provably cannot stop being so:
 * no opening balance, no hand-set status, no contributions, no transactions, and
 * either no charges at all or — for a guest — none that could ever move a
 * balance, because cash and kitty-carried charges never do. Anything with a
 * trace of money or intent is left alone.
 *
 * Both contract totals and the guest cash still to collect are compared before
 * and after inside the transaction, and the whole prune rolls back if either
 * moves by a cent.
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

// Two kinds of account hold nothing.
//
// The first has no history at all — created by a charge that was later moved or
// removed, or by a contract someone never played.
//
// The second belongs to a guest whose every charge is settled in cash. Cash
// never touches a balance, so the row sits at zero and cannot leave it; what
// they owe is read from the charges, which is why they can be listed as owing
// while holding no account. Guests only: a regular player who happens to have
// played solely as somebody's guest still keeps their place on the ledger.
//
// Both require a zero opening balance, no hand-set status, no contributions and
// no transactions. Anything with a trace of money or intent is left alone.
const empty = db.prepare(`
  SELECT l.player_id, l.contract_id, p.name AS player_name,
         COALESCE(p.player_type,'regular') AS player_type,
         CASE WHEN EXISTS (SELECT 1 FROM charges ch JOIN gameweeks g ON g.id = ch.gameweek_id
                           WHERE g.contract_id = l.contract_id
                             AND (ch.player_id = l.player_id
                                  OR COALESCE(ch.charged_to, ch.player_id) = l.player_id))
              THEN 'guest, cash only' ELSE 'no history' END AS why
  FROM ledgers l
  JOIN players p ON p.id = l.player_id
  WHERE l.opening_balance = 0
    AND COALESCE(l.status,'') = ''
    AND NOT EXISTS (SELECT 1 FROM contributions q
                    WHERE q.player_id = l.player_id AND q.contract_id = l.contract_id)
    AND NOT EXISTS (SELECT 1 FROM transactions t
                    WHERE t.player_id = l.player_id AND t.contract_id = l.contract_id)
    AND (
      NOT EXISTS (SELECT 1 FROM charges ch JOIN gameweeks g ON g.id = ch.gameweek_id
                  WHERE g.contract_id = l.contract_id
                    AND (ch.player_id = l.player_id
                         OR COALESCE(ch.charged_to, ch.player_id) = l.player_id))
      OR (
        COALESCE(p.player_type,'regular') = 'outside'
        -- Not one charge against this row may be capable of moving it: every
        -- charge they settle has to be cash or carried by the kitty.
        AND NOT EXISTS (
          SELECT 1 FROM charges ch
          JOIN gameweeks g ON g.id = ch.gameweek_id
          LEFT JOIN players sp ON sp.id = COALESCE(ch.charged_to, ch.player_id)
          WHERE g.contract_id = l.contract_id
            AND COALESCE(ch.charged_to, ch.player_id) = l.player_id
            AND ch.settled_from_kitty = 0
            AND NOT (ch.settles_cash = 1
                     OR COALESCE(sp.player_type,'regular') = 'outside'))
      )
    )
  ORDER BY p.name, l.contract_id`).all();

const before = db.prepare('SELECT COUNT(*) n FROM ledgers').get().n;
console.log(`Ledger rows: ${before}. Provably empty: ${empty.length}.\n`);
for (const r of empty) {
  console.log(`  ${r.player_name.padEnd(22)} ${r.contract_id.padEnd(9)} `
    + `${r.player_type.padEnd(8)} ${r.why}`);
}

// The figures that must not move. If pruning changes either of these, the rows
// were not as empty as the query claimed and the whole thing is rolled back.
const totals = () => Object.fromEntries(
  db.prepare('SELECT id FROM contracts').all().map(c => [
    c.id,
    Math.round(ledgersRepo.forContract(c.id)
      .reduce((s, l) => s + l.present_balance, 0) * 100) / 100,
  ]));

// Guest debt is read from the charges, not from these rows, so it must come
// through the prune untouched. If it moves, the debt was being held in the row
// after all and the row is not safe to drop.
const owedTotal = () => Math.round(ledgersRepo.cashOutstanding()
  .reduce((s, r) => s + r.owed, 0) * 100) / 100;
const owedBefore = owedTotal();

const totalsBefore = totals();
console.log(`\nContract totals now: ${JSON.stringify(totalsBefore)}`);
console.log(`Guest cash still to collect: ${owedBefore} — must not change either.`);

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
  // What a guest owes is read from the charges, so removing their account must
  // leave it exactly where it was. If this moves, the debt was being held in the
  // row after all and the row is not safe to drop.
  const owedAfter = owedTotal();
  if (Math.abs(owedAfter - owedBefore) > 0.005) {
    throw new Error(`guest cash owed moved: ${owedBefore} → ${owedAfter}`);
  }
  db.exec('COMMIT');
  console.log(`\nRemoved ${empty.length} empty account(s). `
    + `Ledger rows: ${before} → ${db.prepare('SELECT COUNT(*) n FROM ledgers').get().n}.`);
  console.log(`Contract totals unchanged: ${JSON.stringify(totalsAfter)}`);
  console.log(`Guest cash still to collect, unchanged: ${owedAfter}`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error(`\nFailed, nothing changed: ${e.message}`);
  process.exit(1);
}
