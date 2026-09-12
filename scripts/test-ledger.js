#!/usr/bin/env node
/**
 * test-ledger.js — golden tests for the balance formula.
 *
 * The ledger query is the one piece of this app that must never change by
 * accident: every figure the club acts on comes out of it. These tests pin it
 * to known inputs and known answers, so a future edit that drops a term, flips
 * a sign, or counts something twice fails here rather than in somebody's
 * balance.
 *
 * They run against a scratch database, never your real one, and clean up after
 * themselves.
 *
 * Run:  node scripts/test-ledger.js     (or npm test)
 * Exit: 0 all passed, 1 any failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// db.js resolves FMSS_DB_PATH at import time, so this must be set before
// anything pulls it in — hence the dynamic imports below.
const scratch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fmss-test-')), 'test.db');
process.env.FMSS_DB_PATH = scratch;

const { db, initSchema, DB_FILE } = await import('../server/db.js');
const { ledgersRepo } = await import('../server/repos/ledgers.js');
const { gameweeksRepo } = await import('../server/repos/gameweeks.js');

if (path.resolve(DB_FILE) !== path.resolve(scratch)) {
  console.error(`Refusing to run: tests would write to ${DB_FILE}, not the scratch database.`);
  process.exit(1);
}

initSchema();
db.exec('PRAGMA foreign_keys = OFF');

const CONTRACT = 'testc';
db.prepare("INSERT INTO contracts (id, name, rates, cost_per_gw, sort) VALUES (?, 'Test', '{}', 0, 1)").run(CONTRACT);

let seq = 0;
function player(name, opening = 0) {
  const id = `p${++seq}`;
  db.prepare('INSERT INTO players (id, name, aliases, created_at) VALUES (?, ?, \'[]\', ?)')
    .run(id, name, new Date().toISOString());
  db.prepare('INSERT INTO ledgers (player_id, contract_id, opening_balance, status) VALUES (?, ?, ?, \'\')')
    .run(id, CONTRACT, opening);
  return id;
}
const contribute = (pid, amount, historical = 0) =>
  db.prepare('INSERT INTO contributions (id,player_id,contract_id,amount,date,historical,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(`c${++seq}`, pid, CONTRACT, amount, '2026-01-01', historical, new Date().toISOString());

function game(historical = 0) {
  const id = `g${++seq}`;
  db.prepare(`INSERT INTO gameweeks (id,contract_id,gw_number,contract_number,date,cost_per_gw,num_players,
    teams_raw,captains_raw,score,comments,historical,created_at) VALUES (?,?,?,?,?,0,0,'','','','',?,?)`)
    .run(id, CONTRACT, ++seq, 0, '2026-01-01', historical, new Date().toISOString());
  return id;
}
const charge = (gid, pid, amount, { chargedTo = null, paid = 0 } = {}) =>
  db.prepare('INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,charged_to,paid) VALUES (?,?,?,\'\',0,\'\',?,?,?)')
    .run(`ch${++seq}`, gid, pid, amount, chargedTo ?? pid, paid);
const makeOutside = (pid) =>
  db.prepare("UPDATE players SET player_type = 'outside' WHERE id = ?").run(pid);
const txn = (pid, type, amount, status = 'approved', contractId = CONTRACT) =>
  db.prepare(`INSERT INTO transactions (id,player_id,contract_id,type,amount,description,status,created_at,updated_at)
              VALUES (?,?,?,?,?,'test',?,?,?)`)
    .run(`t${++seq}`, pid, contractId, type, amount, status, new Date().toISOString(), new Date().toISOString());

const balanceOf = (pid) => ledgersRepo.get(pid, CONTRACT).present_balance;

test('opening balance alone is the balance', () => {
  assert.equal(balanceOf(player('Opening only', 250)), 250);
  assert.equal(balanceOf(player('Negative opening', -137)), -137);
});

test('contributions add, charges subtract', () => {
  const p = player('Mover', 100);
  contribute(p, 50);
  assert.equal(balanceOf(p), 150);
  charge(game(), p, 35);
  assert.equal(balanceOf(p), 115);
});

test('historical rows are excluded — the opening balance already nets them out', () => {
  const p = player('Imported', 100);
  contribute(p, 999, 1);         // historical contribution
  charge(game(1), p, 999);       // charge on a historical gameweek
  assert.equal(balanceOf(p), 100, 'historical movement must not move a live balance');
});

test('approved transactions apply; pending and rejected do not', () => {
  const p = player('Adjusted', 100);
  txn(p, 'adjustment', 40);
  assert.equal(balanceOf(p), 140);
  txn(p, 'transfer_out', -500, 'pending');
  txn(p, 'event_deduction', -500, 'rejected');
  assert.equal(balanceOf(p), 140, 'only approved transactions may move a balance');
});

test('transaction types owned by their own tables are not double counted', () => {
  const p = player('No doubles', 100);
  contribute(p, 50);
  txn(p, 'contribution', 50);   // must be ignored — contributions table owns this
  txn(p, 'charge', -50);        // must be ignored — charges table owns this
  assert.equal(balanceOf(p), 150, 'contribution/charge typed transactions must not be counted');
});

test('a transaction naming no contract reaches no ledger', () => {
  const p = player('Contractless', 100);
  txn(p, 'adjustment', 75, 'approved', null);
  assert.equal(balanceOf(p), 100);
});

test('every term together, and the signs are right', () => {
  const p = player('Everything', 200);
  contribute(p, 300);
  charge(game(), p, 120);
  txn(p, 'event_deduction', -60);
  txn(p, 'adjustment', 30);
  // 200 + 300 - 120 + (-60 + 30)
  assert.equal(balanceOf(p), 350);
});

test('a charge lands on whoever settles it, not whoever played it', () => {
  const guest = player('Guest of', 0);
  const host = player('The host', 200);
  charge(game(), guest, 40, { chargedTo: host });
  assert.equal(balanceOf(host), 160, "the host pays for their guest");
  assert.equal(balanceOf(guest), 0, 'the guest who played is not billed themselves');
});

test('an outside player runs no balance — their cash never touches the ledger', () => {
  const cash = player('Pays cash', 0);
  makeOutside(cash);
  const g = game();
  charge(g, cash, 40);
  const owing = ledgersRepo.get(cash, CONTRACT);
  assert.equal(owing.present_balance, 0, 'owed to the club, not taken from a balance');
  assert.equal(owing.cash_owed, 40, 'but the club is still waiting on it');

  db.prepare('UPDATE charges SET paid = 1 WHERE gameweek_id = ? AND player_id = ?').run(g, cash);
  const settled = ledgersRepo.get(cash, CONTRACT);
  assert.equal(settled.present_balance, 0, 'settling up must not turn a guest into a debtor');
  assert.equal(settled.cash_owed, 0, 'nothing left to collect');
});

test('a guest billed to a contract member hits that member immediately', () => {
  const guest = player('Outside guest', 0);
  makeOutside(guest);
  const member = player('Contract member', 300);
  // Unpaid, but settled by someone who prepaid — so it applies at once.
  charge(game(), guest, 40, { chargedTo: member });
  assert.equal(balanceOf(member), 260);
  assert.equal(balanceOf(guest), 0);
});

test('an approved transfer moves money rather than destroying it', () => {
  const from = player('Sends', 300);
  const to = player('Receives', 100);
  // The legs as the approve endpoint writes them: negative out, positive in.
  txn(from, 'transfer_out', -50);
  txn(to, 'transfer_in', 50);
  assert.equal(balanceOf(from), 250);
  assert.equal(balanceOf(to), 150);
  assert.equal(balanceOf(from) + balanceOf(to), 400, 'the pair must still hold what it started with');
});

test('a pending transfer moves nothing until it is approved', () => {
  const from = player('Awaiting', 300);
  const to = player('Expecting', 100);
  txn(from, 'transfer_out', -50, 'pending');
  txn(to, 'transfer_in', 50, 'pending');
  assert.equal(balanceOf(from), 300);
  assert.equal(balanceOf(to), 100);
});

test('the identity holds for every row the repo returns', () => {
  for (const r of ledgersRepo.all()) {
    const expected = Math.round((r.opening_balance + r.contributed - r.charged + r.adjusted) * 100) / 100;
    assert.equal(r.present_balance, expected, `${r.player_name}: present must equal its own parts`);
  }
});

test('forContract and forPlayerCombined agree with get()', () => {
  const p = player('Consistent', 90);
  contribute(p, 10);
  const one = balanceOf(p);
  assert.equal(ledgersRepo.forContract(CONTRACT).find(r => r.player_id === p).present_balance, one);
  assert.equal(ledgersRepo.forPlayerCombined(p).present_balance, one);
});

test('a shared balance group sums its members', () => {
  const a = player('Group A', 100);
  const b = player('Group B', -30);
  db.prepare('UPDATE players SET balance_group_id = ? WHERE id IN (?, ?)').run('grp', a, b);
  contribute(a, 5);
  const g = ledgersRepo.getGroupBalance(CONTRACT, 'grp');
  assert.equal(g.combined_present_balance, 75, '100 + 5 - 30');
  assert.equal(g.members.length, 2);
});

// --- the kitty a game owes ---------------------------------------------------
// The pot used to be committed by a confirm() in the browser after the game had
// already saved, so declining it left a recorded game whose money went nowhere.
// These pin the replacement: the kitty is derived from the charges, inside the
// same transaction, and every later correction is re-derived rather than patched.

const kittyOf = (gwId) => db.prepare(
  `SELECT COALESCE(SUM(CASE WHEN kind='income' THEN amount ELSE -amount END),0) AS n
   FROM kitty WHERE scope = ?`).get(gwId).n;

function playGame({ pitch = 100, water = 0, players = [], ...rest }) {
  return gameweeksRepo.create(
    { contract_id: CONTRACT, date: '2026-02-01', cost_per_gw: pitch, game_cost: water, ...rest },
    players);
}

test('recording a game commits its kitty in the same breath', () => {
  const a = player('Kitty A'); const b = player('Kitty B');
  const gw = playGame({ pitch: 100, water: 15, players: [
    { player_id: a, amount: 40 }, { player_id: b, amount: 40 },
  ] });
  assert.equal(kittyOf(gw.id), 80 - 100 - 15, 'charged less pitch less water');
});

test('a game that loses money is an expense, not a negative income', () => {
  const a = player('Thin turnout');
  const gw = playGame({ pitch: 100, players: [{ player_id: a, amount: 40 }] });
  const row = db.prepare('SELECT kind, amount FROM kitty WHERE id = ?').get(`k_gw_${gw.id}`);
  assert.equal(row.kind, 'expense');
  assert.equal(row.amount, 60, 'magnitude only — the sign lives in kind');
});

test("a guest's cash reaches the kitty when it is collected, not before", () => {
  const host = player('Host'); const guest = player('Guest'); makeOutside(guest);
  const gw = playGame({ pitch: 50, players: [
    { player_id: host, amount: 40 }, { player_id: guest, amount: 35 },
  ] });
  assert.equal(kittyOf(gw.id), -10, 'guest cash is still in their pocket');

  const chargeId = gw.charges.find(c => c.player_id === guest).id;
  gameweeksRepo.setChargePaid(gw.id, chargeId, { paid: true });
  assert.equal(kittyOf(gw.id), 25, 'collected — now it is club money');

  gameweeksRepo.setChargePaid(gw.id, chargeId, { paid: false });
  assert.equal(kittyOf(gw.id), -10, 'un-collecting takes it straight back out');
});

test('collecting the same cash twice still only banks it once', () => {
  const guest = player('Repeat payer'); makeOutside(guest);
  const gw = playGame({ pitch: 0, players: [{ player_id: guest, amount: 35 }] });
  const chargeId = gw.charges[0].id;
  gameweeksRepo.setChargePaid(gw.id, chargeId, { paid: true });
  gameweeksRepo.setChargePaid(gw.id, chargeId, { paid: true });
  assert.equal(kittyOf(gw.id), 35, 'idempotent — one collection, one entry');
});

test('a guest already marked paid on the night is banked with the game', () => {
  const guest = player('Paid on the night'); makeOutside(guest);
  const gw = playGame({ pitch: 20, players: [{ player_id: guest, amount: 35, paid: 1 }] });
  assert.equal(kittyOf(gw.id), 15, 'cash in hand, counted once, not twice');
});

test('correcting a charge moves the kitty with it', () => {
  const a = player('Rate fixed');
  const gw = playGame({ pitch: 30, players: [{ player_id: a, amount: 40 }] });
  assert.equal(kittyOf(gw.id), 10);
  gameweeksRepo.applyChargeEdits(gw.id, [{ chargeId: gw.charges[0].id, newAmount: 50 }]);
  assert.equal(kittyOf(gw.id), 20, 'the pot follows the charge it was derived from');
});

test('a typed-over figure is kept as its own adjustment, and guests still top up', () => {
  const host = player('Override host'); const guest = player('Override guest');
  makeOutside(guest);
  const gw = playGame({ pitch: 100, kitty_earned: 5, kitty_override: true, players: [
    { player_id: host, amount: 40 }, { player_id: guest, amount: 35 },
  ] });
  assert.equal(kittyOf(gw.id), 5, 'the number the club actually agreed on');
  gameweeksRepo.setChargePaid(gw.id, gw.charges.find(c => c.player_id === guest).id, { paid: true });
  assert.equal(kittyOf(gw.id), 40, 'the guest paying is on top of the correction');
});

test('an imported results sheet moves no money, so it credits no kitty', () => {
  // Imported games record who played and nothing else — every charge is zero,
  // with no pitch or water. Nothing may reach the pot from a participation record.
  const a = player('Sheet row'); const b = player('Sheet row 2');
  const gw = playGame({ pitch: 0, players: [
    { player_id: a, amount: 0 }, { player_id: b, amount: 0 },
  ] });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kitty WHERE scope = ?').get(gw.id).n, 0);
});

test('water a player bought is owed back to them, not taken off the kitty twice', () => {
  const a = player('Plays', 500); const buyer = player('Bought the water', 500);
  const club = playGame({ pitch: 100, water: 15, players: [
    { player_id: a, amount: 40 }, { player_id: buyer, amount: 40 },
  ] });
  assert.equal(kittyOf(club.id), -35, 'the club bought it, so the pot paid: 80 - 100 - 15');

  const byPlayer = playGame({ pitch: 100, water: 15, game_cost_paid_by: buyer, players: [
    { player_id: a, amount: 40 }, { player_id: buyer, amount: 40 },
  ] });
  assert.equal(kittyOf(byPlayer.id), -20, 'no cash left the pot: 80 - 100');
  assert.equal(balanceOf(buyer), 500 - 40 - 40 + 15, 'they are credited for it instead');
});

test('a guest billed to someone who is not playing still counts as settled', () => {
  // The member covering a guest need not be on the pitch that night. Deciding
  // who settles by looking only at the other players in the game misses them.
  const guest = player('Sikku'); makeOutside(guest);
  const absent = player('Toby', 500);
  const gw = playGame({ pitch: 20, players: [
    { player_id: guest, amount: 35, charged_to: absent },
  ] });
  assert.equal(kittyOf(gw.id), 15, 'settled from a balance: 35 - 20, no cash pending');
  assert.equal(balanceOf(absent), 465, 'and it comes off the absent payer');
  assert.equal(gameweeksRepo.all(CONTRACT).find(g => g.id === gw.id).pending_amount, 0);
});

test('only a guest owes anything — a contract charge is settled on the night', () => {
  const guest = player('Guest'); makeOutside(guest);
  const a = player('Member A', 500); const b = player('Member B', 500);
  const gw = playGame({ pitch: 100, players: [
    { player_id: a, amount: 40 }, { player_id: b, amount: 40 }, { player_id: guest, amount: 35 },
  ] });
  const row = gameweeksRepo.all(CONTRACT).find(g => g.id === gw.id);
  assert.equal(row.charged, 115, 'everything billed');
  assert.equal(row.pending_amount, 35, "only the guest's cash is outstanding");
  assert.equal(row.paid_count, 2, 'both members count as settled, guest does not');
  // SQLite renders a REAL as "35.0"; the client parses the amount with Number(),
  // so the trailing zero never reaches the screen.
  assert.equal(row.pending_names, 'Guest|35.0', 'and the list says who to ask, and for how much');
});

// --- correcting how a charge settles ----------------------------------------
// Marking a regular player a cash guest for one night used to be honoured in the
// Game Day preview and then dropped on save, so a charge the club still had to
// collect was filed as already settled off a balance nobody was going to draw on.

test('a regular player can be a cash guest for one night', () => {
  const p = player('Yash', 500);
  const gw = playGame({ pitch: 20, players: [{ player_id: p, amount: 40, settles_cash: 1 }] });
  const r = ledgersRepo.get(p, CONTRACT);
  assert.equal(r.present_balance, 500, 'their balance is not touched');
  assert.equal(r.cash_owed, 40, 'the club is waiting on the cash');
  assert.equal(kittyOf(gw.id), -20, 'and the pot has not banked it yet');

  gameweeksRepo.setChargePaid(gw.id, gw.charges[0].id, { paid: true });
  assert.equal(kittyOf(gw.id), 20, 'collected: -20 + 40');
  assert.equal(ledgersRepo.get(p, CONTRACT).cash_owed, 0);
});

test('a charge filed the wrong way can be switched to cash after the fact', () => {
  const p = player('Wrongly billed', 500);
  const gw = playGame({ pitch: 0, players: [{ player_id: p, amount: 40 }] });
  assert.equal(balanceOf(p), 460, 'started off their balance');
  assert.equal(kittyOf(gw.id), 40);

  gameweeksRepo.setChargeSettlement(gw.id, gw.charges[0].id, { settles_cash: true });
  const r = ledgersRepo.get(p, CONTRACT);
  assert.equal(r.present_balance, 500, 'the balance is given back');
  assert.equal(r.cash_owed, 40, 'and it becomes cash to collect');
  assert.equal(kittyOf(gw.id), 0, 'the pot gives it back until the cash arrives');
});

test('a charge can be moved onto somebody else to settle', () => {
  const guest = player('Guest'); makeOutside(guest);
  const host = player('Host', 500);
  const gw = playGame({ pitch: 0, players: [{ player_id: guest, amount: 35 }] });
  assert.equal(ledgersRepo.get(guest, CONTRACT).cash_owed, 35, 'theirs to pay at first');

  gameweeksRepo.setChargeSettlement(gw.id, gw.charges[0].id,
    { settles_cash: false, charged_to: host });
  assert.equal(balanceOf(host), 465, 'the host carries it now');
  assert.equal(ledgersRepo.get(guest, CONTRACT).cash_owed, 0, 'nothing left to collect');
  assert.equal(kittyOf(gw.id), 35, 'and it is money the club already holds');
});

test('switching a collected charge back to a balance does not leave it looking paid', () => {
  const p = player('Collected then corrected', 500);
  const gw = playGame({ pitch: 0, players: [{ player_id: p, amount: 40, settles_cash: 1, paid: 1 }] });
  assert.equal(kittyOf(gw.id), 40, 'banked as cash');

  gameweeksRepo.setChargeSettlement(gw.id, gw.charges[0].id, { settles_cash: false });
  const charge = gameweeksRepo.get(gw.id).charges[0];
  assert.equal(charge.paid, 0, 'collected is a question only cash can answer');
  assert.equal(balanceOf(p), 460, 'it comes off the balance instead');
  assert.equal(kittyOf(gw.id), 40, 'still 40 in the pot, now from the balance');
});

test('the score is saved with the game, not in a second call that can be lost', () => {
  const a = player('Scorer');
  const gw = playGame({ pitch: 10, players: [{ player_id: a, amount: 40 }],
    result: { team_a_name: 'Reds', team_b_name: 'Blues', goals_team_a: 3, goals_team_b: 1 } });
  const r = db.prepare('SELECT * FROM game_results WHERE gameweek_id = ?').get(gw.id);
  assert.equal(r.result, 'a_wins');
  assert.equal(r.goals_team_a, 3);
});

test('deleting a game takes its kitty entries with it', () => {
  const a = player('Deleted game'); const guest = player('Deleted guest'); makeOutside(guest);
  const gw = playGame({ pitch: 10, players: [
    { player_id: a, amount: 40 }, { player_id: guest, amount: 35, paid: 1 },
  ] });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kitty WHERE scope = ?').get(gw.id).n, 2);
  gameweeksRepo.remove(gw.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kitty WHERE scope = ?').get(gw.id).n, 0,
    'no kitty row may outlive the game that justified it');
});

test('taking a player out of a game takes their money out of the kitty', () => {
  const a = player('Stays'); const guest = player('Leaves'); makeOutside(guest);
  const gw = playGame({ pitch: 10, players: [
    { player_id: a, amount: 40 }, { player_id: guest, amount: 35, paid: 1 },
  ] });
  assert.equal(kittyOf(gw.id), 65);
  gameweeksRepo.removeCharge(gw.id, gw.charges.find(c => c.player_id === guest).id);
  assert.equal(kittyOf(gw.id), 30, 'the guest and their cash both go');
});

test('a historical game contributes nothing — the opening snapshot already has it', () => {
  const a = player('Imported game');
  const gw = { ...playGame({ pitch: 10, players: [{ player_id: a, amount: 40 }] }) };
  db.prepare('UPDATE gameweeks SET historical = 1 WHERE id = ?').run(gw.id);
  gameweeksRepo.applyChargeEdits(gw.id, [{ chargeId: gw.charges[0].id, newAmount: 45 }]);
  assert.equal(kittyOf(gw.id), 0, 'historical money must never be banked twice');
});

process.on('exit', () => {
  try { fs.rmSync(path.dirname(scratch), { recursive: true, force: true }); } catch { /* temp dir */ }
});
