#!/usr/bin/env node
/**
 * correct-opening-balance.js — fix one mistyped figure in a closed baseline.
 *
 * The opening balances were locked on 2026-09-12 to the reference sheets and
 * are deliberately final: importBalances refuses a closed contract, and
 * verify-balances reports any ledger that has drifted from the snapshot. That
 * is the right default, because an opening balance is the one number in the
 * club's books with nothing behind it to recompute from — it is somebody's
 * word, and changing it quietly changes what a player owes with no trace.
 *
 * But a baseline transcribed by hand can carry a typo, and the only honest
 * answer to one is to correct it and say so. verify --lock would do it by
 * re-snapshotting all sixty-odd rows, overwriting every player's locked_at
 * and provenance note to fix a single line. This changes the one line, in
 * both places it is held, and writes down that it was changed, by whom and
 * why.
 *
 * It refuses to touch anything else: every other player's opening balance,
 * and every charge total on every contract, is compared before and after and
 * the whole thing rolls back if a single fil has moved.
 *
 *   node scripts/correct-opening-balance.js <contract> <player> <new> "<why>"
 *   node scripts/correct-opening-balance.js sat AWS -149 "typo in the seed" --apply
 */
import { randomBytes } from 'node:crypto';
import { db, initSchema, DB_FILE } from '../server/db.js';
import { ledgersRepo } from '../server/repos/ledgers.js';

const args = process.argv.slice(2).filter(a => a !== '--apply');
const apply = process.argv.includes('--apply');
const [contractId, playerName, rawAmount, why] = args;

if (!contractId || !playerName || rawAmount === undefined) {
  console.error('Usage: correct-opening-balance.js <contract> <player> <new-balance> "<why>" [--apply]');
  process.exit(1);
}
const next = Number(rawAmount);
if (!Number.isFinite(next)) {
  console.error(`Not a number: ${rawAmount}`);
  process.exit(1);
}
if (apply && !String(why || '').trim()) {
  console.error('A reason is required: this changes what somebody owes.');
  process.exit(1);
}

initSchema();
console.log(`Database: ${DB_FILE}`);
console.log(`Mode: ${apply ? 'APPLY' : 'report only (pass --apply to change anything)'}\n`);

const player = db.prepare('SELECT id, name FROM players WHERE LOWER(name) = LOWER(?)').get(playerName);
if (!player) { console.error(`No player called "${playerName}".`); process.exit(1); }

const ledger = db.prepare(
  'SELECT opening_balance FROM ledgers WHERE player_id = ? AND contract_id = ?')
  .get(player.id, contractId);
if (!ledger) { console.error(`${player.name} has no ${contractId} ledger.`); process.exit(1); }

const snap = db.prepare(
  'SELECT opening_balance, notes FROM opening_balances_snapshot WHERE player_id = ? AND contract_id = ?')
  .get(player.id, contractId);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const was = round2(ledger.opening_balance);
const delta = round2(next - was);

// Everything this must NOT change: every other opening balance, and what every
// contract has charged. Compared whole, not sampled.
const fingerprint = () => ({
  openings: db.prepare(`SELECT contract_id, player_id, opening_balance FROM ledgers
    ORDER BY contract_id, player_id`).all()
    .filter(r => !(r.player_id === player.id && r.contract_id === contractId))
    .map(r => `${r.contract_id}|${r.player_id}|${round2(r.opening_balance)}`).join(','),
  charged: db.prepare('SELECT id FROM contracts').all()
    .map(c => `${c.id}:${round2(db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM charges ch
      JOIN gameweeks g ON g.id = ch.gameweek_id WHERE g.contract_id = ?`).get(c.id).t)}`).join(','),
});

const before = ledgersRepo.get(player.id, contractId);
const contractTotal = () => round2(db.prepare(
  'SELECT COALESCE(SUM(opening_balance),0) t FROM ledgers WHERE contract_id = ?').get(contractId).t);

console.log(`${player.name} · ${contractId}`);
console.log(`  opening balance   ${was}  ->  ${next}   (${delta > 0 ? '+' : ''}${delta})`);
console.log(`  snapshot holds    ${snap ? round2(snap.opening_balance) : '(none)'}`);
console.log(`  present balance   ${round2(before.present_balance)}  ->  `
  + `${round2(before.present_balance + delta)}`);
console.log(`  ${contractId} opening total  ${contractTotal()}  ->  ${round2(contractTotal() + delta)}`);
if (!apply) { console.log('\nRe-run with --apply to make the change.'); process.exit(0); }

const fpBefore = fingerprint();
db.exec('BEGIN IMMEDIATE');
try {
  db.prepare('UPDATE ledgers SET opening_balance = ? WHERE player_id = ? AND contract_id = ?')
    .run(next, player.id, contractId);

  // The snapshot is what verify-balances checks the ledger against, so a
  // correction that moves one and not the other is reported as drift from
  // tomorrow onward. The original note is kept and the amendment appended, so
  // the row still says where the figure originally came from.
  const note = `${snap?.notes || ''} AMENDED ${new Date().toISOString().slice(0, 10)}: `
    + `${was} -> ${next}. ${String(why).trim()}`;
  db.prepare(`INSERT INTO opening_balances_snapshot
      (id, contract_id, player_id, opening_balance, imported_by, import_batch, locked_at, notes)
    VALUES (?,?,?,?,NULL,?,?,?)
    ON CONFLICT (contract_id, player_id) DO UPDATE SET
      opening_balance = excluded.opening_balance, notes = excluded.notes`)
    .run(randomBytes(8).toString('hex'), contractId, player.id, next,
      `amend_${randomBytes(4).toString('hex')}`, new Date().toISOString(), note.trim());

  db.prepare(`INSERT INTO audit_log (id, user_id, player_id, action, details, created_at)
    VALUES (?,NULL,?,?,?,?)`).run(
    randomBytes(8).toString('hex'), player.id, 'opening_balance_corrected',
    JSON.stringify({ contract_id: contractId, was, now: next, delta, why: String(why).trim() }),
    new Date().toISOString());

  const fpAfter = fingerprint();
  if (fpAfter.openings !== fpBefore.openings) {
    throw new Error('another player\'s opening balance moved');
  }
  if (fpAfter.charged !== fpBefore.charged) {
    throw new Error(`charges moved: ${fpBefore.charged} -> ${fpAfter.charged}`);
  }
  const after = ledgersRepo.get(player.id, contractId);
  if (round2(after.present_balance) !== round2(before.present_balance + delta)) {
    throw new Error(`present balance moved by ${round2(after.present_balance - before.present_balance)}`
      + `, expected ${delta}`);
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error(`\nRolled back: ${e.message}`);
  process.exit(1);
}

const after = ledgersRepo.get(player.id, contractId);
console.log('\nDone.');
console.log(`  opening   ${round2(after.opening_balance)}`);
console.log(`  present   ${round2(after.present_balance)}`);
console.log(`  ${contractId} opening total now ${contractTotal()}`);
console.log('\nRun npm run verify — the snapshot was moved with the ledger, so it should pass.');
