#!/usr/bin/env node
/**
 * verify-balances.js — prove an upgrade did not move anybody's money.
 *
 * Run this BEFORE and AFTER any deployment, migration or schema change. It is
 * the automated form of the check that has so far been done by hand.
 *
 *   node scripts/verify-balances.js            → check, exit 1 on any problem
 *   node scripts/verify-balances.js --lock     → record today's opening balances
 *                                                as the baseline to check against
 *   node scripts/verify-balances.js --lock --notes "after Contract 8 import"
 *   node scripts/verify-balances.js --json     → machine-readable, for CI
 *
 * Two independent things are checked.
 *
 * 1. Opening balances against the locked baseline.
 *    opening_balance is the base data: it comes from your reference sheets and
 *    nothing in the app should ever silently rewrite it. Any difference is
 *    reported as drift and fails the run. When you change a baseline on
 *    purpose, re-run with --lock to record the new truth.
 *
 * 2. The ledger identity, on every row.
 *      present_balance === opening_balance + contributed - charged + adjusted
 *    This needs no baseline, because it is a property the ledger must always
 *    satisfy. It is what catches a future edit to the balance query itself —
 *    a dropped term, a sign flip, a term counted twice — which a comparison of
 *    stored numbers would not notice.
 *
 * Exit: 0 clean, 1 drift or broken identity, 2 no baseline recorded yet.
 */
import { randomBytes } from 'node:crypto';
import { db, initSchema } from '../server/db.js';
import { ledgersRepo } from '../server/repos/ledgers.js';

initSchema();

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f, d = null) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const asJson = has('--json');

// Money is stored as REAL, so compare at the precision the app actually shows
// rather than demanding exact float equality.
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const differs = (a, b) => Math.abs(round(a) - round(b)) > 0.005;

const rows = ledgersRepo.all();

if (has('--lock')) {
  const batch = randomBytes(6).toString('hex');
  const at = new Date().toISOString();
  const notes = opt('--notes', '');
  const up = db.prepare(
    `INSERT INTO opening_balances_snapshot (id, contract_id, player_id, opening_balance, imported_by, import_batch, locked_at, notes)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT (contract_id, player_id) DO UPDATE SET
       opening_balance = excluded.opening_balance,
       import_batch = excluded.import_batch,
       locked_at = excluded.locked_at,
       notes = excluded.notes`
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows) up.run(randomBytes(8).toString('hex'), r.contract_id, r.player_id, r.opening_balance, batch, at, notes);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  console.log(`Locked ${rows.length} opening balance(s) as batch ${batch}.`);
  if (notes) console.log(`Notes: ${notes}`);
  console.log('Re-run without --lock to check against this baseline.');
  process.exit(0);
}

const baseline = db.prepare('SELECT contract_id, player_id, opening_balance FROM opening_balances_snapshot').all();
const problems = [];

if (!baseline.length) {
  const msg = 'No baseline recorded. Run with --lock once to record the current opening balances.';
  if (asJson) console.log(JSON.stringify({ ok: false, reason: 'no-baseline' }, null, 2));
  else console.error(msg);
  process.exit(2);
}

// --- 1. opening balances against the locked baseline -----------------------
const locked = new Map(baseline.map(b => [`${b.contract_id}|${b.player_id}`, b.opening_balance]));
const seen = new Set();
for (const r of rows) {
  const key = `${r.contract_id}|${r.player_id}`;
  seen.add(key);
  if (!locked.has(key)) {
    // A new player is normal; only flag it when they arrived carrying money,
    // which means somebody set an opening balance outside the locked baseline.
    if (round(r.opening_balance) !== 0) {
      problems.push({ type: 'unlocked-opening', contract: r.contract_id, player: r.player_name, opening: r.opening_balance });
    }
    continue;
  }
  const want = locked.get(key);
  if (differs(r.opening_balance, want)) {
    problems.push({ type: 'opening-drift', contract: r.contract_id, player: r.player_name, locked: want, now: r.opening_balance });
  }
}
for (const [key, amount] of locked) {
  if (!seen.has(key) && round(amount) !== 0) {
    const [contract, player] = key.split('|');
    problems.push({ type: 'ledger-vanished', contract, player, locked: amount });
  }
}

// --- 2. the ledger identity, on every row ----------------------------------
for (const r of rows) {
  const expected = round(r.opening_balance + r.contributed - r.charged + r.adjusted);
  if (differs(r.present_balance, expected)) {
    problems.push({
      type: 'identity-broken', contract: r.contract_id, player: r.player_name,
      present: r.present_balance, expected,
      parts: { opening: r.opening_balance, contributed: r.contributed, charged: r.charged, adjusted: r.adjusted },
    });
  }
}

const totals = {};
for (const r of rows) totals[r.contract_id] = round((totals[r.contract_id] || 0) + r.present_balance);

if (asJson) {
  console.log(JSON.stringify({ ok: !problems.length, checked: rows.length, baseline: baseline.length, totals, problems }, null, 2));
  process.exit(problems.length ? 1 : 0);
}

console.log(`Checked ${rows.length} ledger row(s) against ${baseline.length} locked opening balance(s).`);
for (const [c, t] of Object.entries(totals)) console.log(`  ${c}: ${t}`);

if (!problems.length) {
  console.log('\nOK — every opening balance matches the baseline, and every present balance');
  console.log('equals opening + contributed - charged + adjusted.');
  process.exit(0);
}

console.error(`\n${problems.length} problem(s):\n`);
for (const p of problems) {
  if (p.type === 'opening-drift') {
    console.error(`  DRIFT      ${p.contract}/${p.player}: opening was locked at ${p.locked}, now ${p.now}`);
  } else if (p.type === 'unlocked-opening') {
    console.error(`  UNLOCKED   ${p.contract}/${p.player}: opening ${p.opening} with no locked baseline`);
  } else if (p.type === 'ledger-vanished') {
    console.error(`  VANISHED   ${p.contract}/${p.player}: locked at ${p.locked}, ledger row is gone`);
  } else {
    console.error(`  IDENTITY   ${p.contract}/${p.player}: shows ${p.present}, parts give ${p.expected}`);
    console.error(`             opening ${p.parts.opening} + contributed ${p.parts.contributed} - charged ${p.parts.charged} + adjusted ${p.parts.adjusted}`);
  }
}
console.error('\nIf a change was deliberate, re-run with --lock to record the new baseline.');
process.exit(1);
