#!/usr/bin/env node
/**
 * reprice-cross-contract.js — put places paid for out of another contract's
 * pot onto that game's out-of-contract rate.
 *
 * The contract rates are the members' rates: they are what prepaying into THAT
 * contract buys. Somebody playing a Mon/Thu game out of their Saturdays credit
 * has not prepaid into Mon/Thu, so they pay what a guest pays. Game day and the
 * Season panel apply that rule as places are entered and moved; this is for the
 * ones entered BEFORE the rule existed, and for the day a rate card changes
 * under charges already recorded.
 *
 * It computes nothing of its own. The new price comes from
 * gameweeksRepo.rateForCharge — the same function both controls use — so these
 * charges end up priced by the identical rule rather than by a number somebody
 * typed into a migration.
 *
 * Deliberately narrow. It touches only a charge that is ALL of:
 *   - funded from a contract other than its game's
 *   - settled off a balance (not cash, not carried by the pot)
 *   - on a live game, never one behind a closed baseline
 *   - held by a member, never a guest, who keeps no balance to draw on
 *   - not already on the out-of-contract rate
 *
 * Safe to run twice: the last condition makes a second run find nothing.
 *
 *   node scripts/reprice-cross-contract.js            → what it would do
 *   node scripts/reprice-cross-contract.js --commit   → do it
 *
 * Everything happens in ONE transaction which re-reads every ledger balance and
 * every kitty line afterwards and requires each to have moved by exactly the
 * predicted amount, and nothing else to have moved at all. Any drift — a
 * balance nobody touched, a kitty row appearing from nowhere — rolls the whole
 * thing back. Take a backup first anyway: `sqlite3 data/fmss.db "VACUUM INTO
 * 'backup.db'"`.
 */
import { db, initSchema, DB_FILE } from '../server/db.js';
import { gameweeksRepo } from '../server/repos/gameweeks.js';
import { ledgersRepo } from '../server/repos/ledgers.js';

initSchema();

const commit = process.argv.includes('--commit');
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const signed = (n) => `${n >= 0 ? '+' : ''}${n}`;

console.log(`Database: ${DB_FILE}\n`);

const targets = db.prepare(`
  SELECT ch.id, ch.gameweek_id, ch.amount, ch.rate_type, ch.is_captain,
         ch.settle_contract_id AS paid_from, g.contract_id AS game_on, g.date,
         COALESCE(NULLIF(ch.charged_to, ''), ch.player_id) AS settler,
         p.name
  FROM charges ch
  JOIN gameweeks g ON g.id = ch.gameweek_id
  JOIN players p ON p.id = COALESCE(NULLIF(ch.charged_to, ''), ch.player_id)
  WHERE ch.settle_contract_id IS NOT NULL
    AND ch.settle_contract_id <> g.contract_id
    AND ch.settled_from_kitty = 0
    AND ch.settles_cash = 0
    AND g.historical = 0
    AND COALESCE(p.player_type, 'regular') <> 'outside'
    AND ch.rate_type <> 'noncontract'
  ORDER BY g.date`).all();

if (!targets.length) {
  console.log('Every place funded from another pot is already on the out-of-contract rate.');
  process.exit(0);
}

const plan = targets.map((t) => {
  const want = gameweeksRepo.rateForCharge({
    gameweekId: t.gameweek_id, isCaptain: !!t.is_captain, fromOtherContract: true,
  });
  return { ...t, to: want.amount, toType: want.rate_type, delta: r2(want.amount - t.amount) };
});

console.log('Places funded from another contract, not yet on the out-of-contract rate:\n');
for (const p of plan) {
  console.log(`  ${p.date}  ${p.name.padEnd(10)} ${p.game_on} game paid from ${p.paid_from}`
    + `   ${p.amount} → ${p.to}  (${signed(p.delta)})   ${p.rate_type} → ${p.toType}`);
}

// A bigger charge lowers the balance it comes off; the game it was played on
// takes the difference as income.
const byLedger = new Map();
for (const p of plan) {
  const k = `${p.settler}|${p.paid_from}`;
  byLedger.set(k, r2((byLedger.get(k) ?? 0) - p.delta));
}
const byGame = new Map();
for (const p of plan) byGame.set(p.gameweek_id, r2((byGame.get(p.gameweek_id) ?? 0) + p.delta));

console.log('\nBalances this moves:');
for (const [k, d] of byLedger) console.log(`  ${k.replace('|', ' on ')}: ${signed(d)}`);
console.log('\nGame kitty this moves:');
for (const [g, d] of byGame) console.log(`  ${g}: ${signed(d)}`);

const balancesBefore = new Map(
  ledgersRepo.all().map(l => [`${l.player_id}|${l.contract_id}`, l.present_balance]));
const kittyBefore = new Map(db.prepare('SELECT id, kind, amount FROM kitty').all()
  .map(k => [k.id, r2(k.kind === 'income' ? k.amount : -k.amount)]));

db.exec('BEGIN IMMEDIATE');
try {
  for (const p of plan) {
    db.prepare('UPDATE charges SET amount = ?, rate_type = ? WHERE id = ?')
      .run(p.to, p.toType, p.id);
  }
  // Make each touched game restate its line. updateGameAccounting is the
  // ordinary path for that and opens no transaction of its own, so it nests
  // inside this one.
  for (const gid of byGame.keys()) {
    const g = db.prepare(`SELECT game_cost, game_cost_paid_by, scoreline, teams_json,
      whatsapp_message, kitty_earned FROM gameweeks WHERE id = ?`).get(gid);
    gameweeksRepo.updateGameAccounting(gid, {
      scoreline: g.scoreline, teams_json: g.teams_json, whatsapp_message: g.whatsapp_message,
      game_cost: g.game_cost, game_cost_paid_by: g.game_cost_paid_by,
      kitty_earned: g.kitty_earned,
    });
  }

  // Reconcile BEFORE the commit, against what was predicted above — not against
  // a recomputation of the same rule, which would only prove this file agrees
  // with itself.
  const after = new Map(
    ledgersRepo.all().map(l => [`${l.player_id}|${l.contract_id}`, l.present_balance]));
  const drift = [];
  for (const [k, before] of balancesBefore) {
    const want = r2(before + (byLedger.get(k) ?? 0));
    const got = r2(after.get(k) ?? 0);
    if (Math.abs(want - got) > 0.005) drift.push(`${k}: expected ${want}, found ${got}`);
  }
  for (const k of after.keys()) if (!balancesBefore.has(k)) drift.push(`${k}: a new ledger appeared`);
  if (drift.length) throw new Error(`balances moved unexpectedly — ${drift.slice(0, 5).join('; ')}`);

  const kittyAfter = new Map(db.prepare('SELECT id, kind, amount FROM kitty').all()
    .map(k => [k.id, r2(k.kind === 'income' ? k.amount : -k.amount)]));
  const kDrift = [];
  for (const [id, before] of kittyBefore) {
    const want = r2(before + (byGame.get(id.replace('k_gw_', '')) ?? 0));
    const got = kittyAfter.get(id) ?? 0;
    if (Math.abs(want - got) > 0.005) kDrift.push(`${id}: expected ${want}, found ${got}`);
  }
  for (const id of kittyAfter.keys()) if (!kittyBefore.has(id)) kDrift.push(`${id}: appeared from nowhere`);
  if (kDrift.length) throw new Error(`the kitty moved unexpectedly — ${kDrift.slice(0, 5).join('; ')}`);

  if (!commit) throw new Error('DRY RUN — re-run with --commit to apply it.');
  db.exec('COMMIT');
  console.log('\nCommitted. Every balance and every kitty line moved by exactly the predicted'
    + '\namount, and nothing else moved at all.');
} catch (e) {
  db.exec('ROLLBACK');
  console.log(`\n${e.message}`);
  if (!commit) console.log('Nothing was written.');
  process.exit(commit ? 1 : 0);
}
