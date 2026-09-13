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
const { periodReportRepo } = await import('../server/repos/period_report.js');
const { movementsRepo } = await import('../server/repos/movements.js');
const { kittyRepo } = await import('../server/repos/kitty.js');
const { statsRepo } = await import('../server/repos/stats.js');
const { playersRepo } = await import('../server/repos/players.js');

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
const round2 = (n) => Math.round(n * 100) / 100;

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

test('a game nobody scored is unknown, not a nil-nil draw', () => {
  // Every game is created with scoreline "0-0" whether or not a score was
  // entered, so reading it as a result made "nobody recorded this" into a draw
  // and deflated every win rate on the contract.
  const a = player('Turned up'); const b = player('Also turned up');
  const gw = playGame({ pitch: 0, teams_raw: 'Red / Blue', players: [
    { player_id: a, amount: 0, team: 'Red' }, { player_id: b, amount: 0, team: 'Blue' },
  ] });
  const stored = db.prepare('SELECT score, scoreline FROM gameweeks WHERE id = ?').get(gw.id);
  assert.equal(stored.score, '', 'no score was entered');

  const r = statsRepo.matchRecord(a, CONTRACT);
  assert.equal(r.draws, 0, 'an unscored game is not a draw');
  assert.equal(r.unknown, 1, 'it is simply unknown');
  assert.equal(r.winRate, null, 'and it cannot make a win rate');

  // A real nil-nil, entered deliberately, still counts.
  gameweeksRepo.updateMetadata(gw.id, { score: '0-0' });
  const after = statsRepo.matchRecord(a, CONTRACT);
  assert.equal(after.draws, 1, 'a recorded 0-0 is a draw');
  assert.equal(after.unknown, 0);
  assert.ok(stored.scoreline !== undefined);
});

test('a win is read from the result row, not re-parsed from the text', () => {
  // The bare scoreline "3-7" cannot say who scored seven, and every live game
  // has one — so reading `scoreline || score` meant no Mon/Thu game ever
  // resolved a winner and the analytics were empty. Blanking the readable text
  // here proves the result row alone is enough.
  const red = player('Red shirt'); const blue = player('Blue shirt');
  const gw = playGame({ pitch: 0, teams_raw: 'Red / Blue',
    result: { team_a_name: 'Red', team_b_name: 'Blue', goals_team_a: 3, goals_team_b: 7 },
    players: [{ player_id: red, amount: 0, team: 'Red' },
      { player_id: blue, amount: 0, team: 'Blue' }] });
  db.prepare("UPDATE gameweeks SET score = '' WHERE id = ?").run(gw.id);

  const r = statsRepo.matchRecord(red, CONTRACT);
  assert.equal(r.unknown, 0, 'the game is decided');
  assert.equal(r.losses, 1);
  assert.equal(r.gf, 3);
  assert.equal(r.ga, 7);
  assert.equal(statsRepo.matchRecord(blue, CONTRACT).wins, 1);
});

// --- paying for one contract's game out of another's balance -----------------

test("a charge can be settled from the player's other contract", () => {
  // A Mon/Thu regular turning up one odd Saturday. Their money is on Mon/Thu;
  // billing the Saturday game against a Saturday balance they never paid into
  // opens an account at zero and drives it straight into the red.
  db.prepare("INSERT OR IGNORE INTO contracts (id,name,rates,cost_per_gw,sort) VALUES ('away','Away','{}',0,3)").run();
  const p = player('Cross dipper', 400);
  db.prepare("INSERT INTO ledgers (player_id,contract_id,opening_balance,status) VALUES (?,'away',0,'')").run(p);

  const gw = gameweeksRepo.create({ contract_id: 'away', date: '2026-05-01', cost_per_gw: 0 },
    [{ player_id: p, amount: 40 }]);
  assert.equal(ledgersRepo.get(p, 'away').present_balance, -40, 'billed where they have nothing');
  assert.equal(balanceOf(p), 400, 'and their real balance untouched');

  gameweeksRepo.setChargeSettlement(gw.id, gw.charges[0].id,
    { mode: 'balance', settle_contract_id: CONTRACT });
  assert.equal(ledgersRepo.get(p, 'away').present_balance, 0, 'the away account is clear');
  assert.equal(balanceOf(p), 360, 'it came off the contract they actually pay into');

  // And it can be put back.
  gameweeksRepo.setChargeSettlement(gw.id, gw.charges[0].id,
    { mode: 'balance', settle_contract_id: null });
  assert.equal(ledgersRepo.get(p, 'away').present_balance, -40);
  assert.equal(balanceOf(p), 400);
});

test('a guest can be settled from their host\'s other contract too', () => {
  // "Could be for any player or their plus ones" — charged_to and
  // settle_contract_id compose: whose money, and which of their balances.
  const host = player('Host', 400);
  const guest = player('Their plus one'); makeOutside(guest);
  db.prepare("INSERT OR IGNORE INTO contracts (id,name,rates,cost_per_gw,sort) VALUES ('away','Away','{}',0,3)").run();
  db.prepare("INSERT INTO ledgers (player_id,contract_id,opening_balance,status) VALUES (?,'away',0,'')").run(host);

  const gw = gameweeksRepo.create({ contract_id: 'away', date: '2026-05-02', cost_per_gw: 0 },
    [{ player_id: guest, amount: 35 }]);
  gameweeksRepo.setChargeSettlement(gw.id, gw.charges[0].id,
    { mode: 'balance', charged_to: host, settle_contract_id: CONTRACT });
  assert.equal(balanceOf(host), 365, "off the host's main balance");
  assert.equal(ledgersRepo.get(guest, CONTRACT).cash_owed, 0, 'and nothing left to collect');
});

test('a settling contract that does not exist is refused', () => {
  const p = player('Bad contract', 100);
  const gw = playGame({ pitch: 0, players: [{ player_id: p, amount: 10 }] });
  assert.throws(() => gameweeksRepo.setChargeSettlement(gw.id, gw.charges[0].id,
    { mode: 'balance', settle_contract_id: 'nope' }), /No such contract/);
});

// --- guests do not get an account they will never use ------------------------

test('a cash guest is given no ledger row, and still shows as owing', () => {
  const host = player('Regular', 500);
  // A guest with no ledger row of their own — only a players row for the name.
  const seq2 = `guest${Date.now()}`;
  db.prepare("INSERT INTO players (id,name,aliases,player_type,created_at) VALUES (?,?,'[]','outside',?)")
    .run(seq2, 'Walk-up', new Date().toISOString());

  const gw = playGame({ pitch: 0, players: [
    { player_id: host, amount: 32 }, { player_id: seq2, amount: 40 },
  ] });

  const row = db.prepare('SELECT COUNT(*) n FROM ledgers WHERE player_id = ?').get(seq2);
  assert.equal(row.n, 0, 'no account is created for someone who keeps no balance');

  // What they owe survives having no account, because it is read from charges.
  const owing = ledgersRepo.cashOutstanding(CONTRACT).find(r => r.player_id === seq2);
  assert.equal(owing.owed, 40);
  assert.equal(owing.player_name, 'Walk-up');
  assert.equal(gameweeksRepo.all(CONTRACT).find(g => g.id === gw.id).pending_amount, 40);

  // And collecting it still reaches the pot.
  gameweeksRepo.setChargePaid(gw.id, gw.charges.find(c => c.player_id === seq2).id, { paid: true });
  assert.equal(kittyOf(gw.id), 72, '32 from the balance plus 40 collected');
  assert.equal(ledgersRepo.cashOutstanding(CONTRACT).find(r => r.player_id === seq2), undefined);
});

// --- the pot carrying a place, and money moved without a game ----------------

test('a place the kitty carries is billed to nobody and owed by nobody', () => {
  const p = player('Odd Saturday', 500);
  const gw = playGame({ pitch: 100, players: [{ player_id: p, amount: 40 }] });
  assert.equal(kittyOf(gw.id), -60, 'while they are paying: 40 - 100');

  gameweeksRepo.setChargeSettlement(gw.id, gw.charges[0].id, { mode: 'kitty' });
  const r = ledgersRepo.get(p, CONTRACT);
  assert.equal(r.present_balance, 500, 'their balance is untouched');
  assert.equal(r.cash_owed, 0, 'and they owe nothing');
  // The pot pays by collecting nothing, not by a second expense on top.
  assert.equal(kittyOf(gw.id), -100, 'the pot is out the whole pitch cost');
  assert.equal(gameweeksRepo.all(CONTRACT).find(g => g.id === gw.id).pending_amount, 0);
  assert.equal(gameweeksRepo.get(gw.id).charges[0].settle_mode, 'kitty');
});

test('a kitty-carried place can be put back on a balance', () => {
  const p = player('Changed mind', 500);
  const gw = playGame({ pitch: 0, players: [{ player_id: p, amount: 40 }] });
  gameweeksRepo.setChargeSettlement(gw.id, gw.charges[0].id, { mode: 'kitty' });
  assert.equal(balanceOf(p), 500);
  gameweeksRepo.setChargeSettlement(gw.id, gw.charges[0].id, { mode: 'balance' });
  assert.equal(balanceOf(p), 460, 'back on their balance');
  assert.equal(kittyOf(gw.id), 40, 'and back in the pot');
});

test('the pot can pay somebody, and it is one movement or none', () => {
  const p = player('Bought the shirts', 500);
  const before = kittyRepo.balance().balance;
  movementsRepo.create({ from: 'kitty', to: p, amount: 120, contract_id: CONTRACT,
    date: '2026-03-01', note: 'shirts' });
  assert.equal(kittyRepo.balance().balance, round2(before - 120), 'the pot is down');
  assert.equal(balanceOf(p), 620, 'and they are up');

  const mv = movementsRepo.all({ limit: 1 })[0];
  assert.equal(mv.from_name, 'the kitty');
  movementsRepo.remove(mv.id);
  assert.equal(kittyRepo.balance().balance, before, 'undone on both sides');
  assert.equal(balanceOf(p), 500);
});

test('paying the cashier for a club expense moves no contract balance', () => {
  const p = player('Cashier', 500);
  const before = kittyRepo.balance().balance;
  movementsRepo.create({ from: 'kitty', to: p, amount: 90, date: '2026-03-02', note: 'BBQ' });
  assert.equal(kittyRepo.balance().balance, round2(before - 90), 'real money left the pot');
  assert.equal(balanceOf(p), 500, 'naming no contract keeps it off a contract balance');
});

test('money moved between players is moved, not created', () => {
  const a = player('Gives', 300);
  const b = player('Gets', 100);
  const potBefore = kittyRepo.balance().balance;
  movementsRepo.create({ from: a, to: b, amount: 75, contract_id: CONTRACT, date: '2026-03-03' });
  assert.equal(balanceOf(a), 225);
  assert.equal(balanceOf(b), 175);
  assert.equal(balanceOf(a) + balanceOf(b), 400, 'the pair still holds what it started with');
  assert.equal(kittyRepo.balance().balance, potBefore, 'the pot is not involved');
});

test("one contract's pot can carry another's place", () => {
  // A Mon/Thu regular turns up one odd Saturday and the Mon/Thu pot covers it.
  // The club is no better or worse off; the cost simply sits where it belongs.
  db.prepare("INSERT OR IGNORE INTO contracts (id,name,rates,cost_per_gw,sort) VALUES ('other','Other','{}',0,2)").run();
  const before = kittyRepo.balance();
  const shareOf = (b, c) => b.by_contract.find(r => r.contract_id === c)?.balance || 0;
  const testcBefore = shareOf(before, CONTRACT);
  const otherBefore = shareOf(before, 'other');

  movementsRepo.create({ from: 'kitty:other', to: `kitty:${CONTRACT}`, amount: 40,
    date: '2026-04-01', note: 'covering a drop-in' });

  const after = kittyRepo.balance();
  assert.equal(after.balance, before.balance, 'the club total cannot change');
  assert.equal(shareOf(after, 'other'), round2(otherBefore - 40), "it left the other pot");
  assert.equal(shareOf(after, CONTRACT), round2(testcBefore + 40), 'and landed in this one');

  const mv = movementsRepo.all({ limit: 1 })[0];
  assert.equal(mv.from_name, 'the Other kitty', 'named so it reads back plainly');
  movementsRepo.remove(mv.id);
  assert.equal(shareOf(kittyRepo.balance(), 'other'), otherBefore, 'undone on both sides');
});

test('a movement that would say nothing happened is refused', () => {
  const a = player('Same', 100);
  assert.throws(() => movementsRepo.create({ from: a, to: a, amount: 10, contract_id: CONTRACT }),
    /cannot move to where it already is/);
  assert.throws(() => movementsRepo.create({ from: 'kitty', to: a, amount: 0 }),
    /more than zero/);
  assert.throws(() => movementsRepo.create({ from: a, to: player('Other'), amount: 10 }),
    /needs a contract/);
  assert.throws(() => movementsRepo.create({ from: 'kitty', to: 'nobody', amount: 10 }),
    /No such player/);
});

// --- editing a game afterwards ----------------------------------------------

test('editing the score writes the result stats are built from', () => {
  const a = player('Reds', 500); const b = player('Blues', 500);
  const gw = playGame({ pitch: 0, teams_raw: 'Red: Reds / Blue: Blues', players: [
    { player_id: a, amount: 0, team: 'Red' }, { player_id: b, amount: 0, team: 'Blue' },
  ] });
  const read = () => ({
    ...db.prepare('SELECT score, scoreline, teams_raw FROM gameweeks WHERE id = ?').get(gw.id),
    result: db.prepare('SELECT goals_team_a a, goals_team_b b, result FROM game_results WHERE gameweek_id = ?').get(gw.id),
  });

  gameweeksRepo.updateMetadata(gw.id, { score: '13-9' });
  let r = read();
  assert.equal(r.score, 'Red win 13-9', 'the sentence is derived, not typed');
  assert.equal(r.scoreline, '13-9');
  assert.equal(r.result.result, 'a_wins', 'and the stats row exists');

  // A named winner beats position: "Blue win 7-5" is seven to Blue, whichever
  // team happens to be listed first.
  gameweeksRepo.updateMetadata(gw.id, { score: 'Blue win 7-5' });
  r = read();
  assert.equal(r.scoreline, '5-7');
  assert.equal(r.result.result, 'b_wins');

  gameweeksRepo.updateMetadata(gw.id, { score: '' });
  assert.equal(read().result, undefined, 'clearing the box clears the result');
});

test('editing a game keeps the fields the form did not send', () => {
  // The Season form sends four fields. Writing every column and defaulting the
  // absent ones to '' erased the pasted team message — the only record of who
  // actually played, and 20 August lost its copy that way.
  const a = player('Kept', 500);
  const gw = playGame({ pitch: 0, teams_raw: 'Red: the original message', players: [
    { player_id: a, amount: 10, team: 'Red' },
  ] });
  gameweeksRepo.updateMetadata(gw.id, { score: '3-1', comments: 'windy' });
  const g = db.prepare('SELECT teams_raw, comments FROM gameweeks WHERE id = ?').get(gw.id);
  assert.equal(g.teams_raw, 'Red: the original message', 'untouched fields stay untouched');
  assert.equal(g.comments, 'windy');
});

test('the Standing sheet is a credit position, not an attendance record', () => {
  // It answers "who is topped up, who needs a refill". Turning out once does not
  // create a credit position, and the old rule kept anyone with a single
  // appearance — which put four people on the Mon/Thu sheet at exactly 0 having
  // never paid anything in.
  const holder = player('Holds credit', 300);
  const oneOff = player('Played once, paid nothing', 0);
  const gw = playGame({ pitch: 0, players: [{ player_id: oneOff, amount: 0 }] });
  const names = () => periodReportRepo.report(CONTRACT, { since: '2000-01-01' })
    .rows.map(r => r.player_id);

  assert.ok(names().includes(holder), 'someone holding money is on it');
  assert.ok(!names().includes(oneOff), 'someone at zero who has never paid in is not');

  // And the manual override, for what a rule cannot know.
  playersRepo.update(holder, { hide_from_sheet: true });
  assert.ok(!names().includes(holder), 'hidden by hand');
  assert.equal(balanceOf(holder), 300, 'hiding moves no money');
  playersRepo.update(holder, { name: 'Holds credit' });
  assert.ok(!names().includes(holder), 'and a rename does not clear the flag');
  playersRepo.update(holder, { hide_from_sheet: false });
  assert.ok(names().includes(holder), 'shown again');
  assert.ok(gw.id);
});

test('the Standing sheet is the squad, not every guest who turned up once', () => {
  const member = player('Squad member', 300);
  const guest = player('One-off guest'); makeOutside(guest);
  const gw = playGame({ pitch: 0, players: [
    { player_id: member, amount: 32 }, { player_id: guest, amount: 40 },
  ] });
  const rep = periodReportRepo.report(CONTRACT, { since: '2000-01-01' });
  assert.ok(rep.rows.some(r => r.player_id === member), 'members are listed');
  assert.ok(!rep.rows.some(r => r.player_id === guest), 'guests are not');
  // Other tests above left guests owing on this same scratch contract, so the
  // total is the contract's, not this game's — what matters is that the guest
  // who was hidden from the sheet is still counted in it.
  assert.ok(rep.guest_cash_owed >= 40, 'what they owe is still counted, separately');
  assert.ok(rep.rows.every(r => r.player_type !== 'outside'), 'no guest reaches the sheet');
  assert.ok(gw.id);
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
  // One row, not two: the guest's cash is revenue inside the game line now
  // rather than a receipt of its own.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kitty WHERE scope = ?').get(gw.id).n, 1);
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

/* ===== Match Results: what a game contributes to a record =====
   These pin the three things that were wrong. A side-less helper is used so the
   team on each charge can be set, which the `charge` helper above does not do. */

const sided = (gid, pid, team, { captain = 0 } = {}) =>
  db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,charged_to,paid)
              VALUES (?,?,?,?,?,'',0,?,0)`).run(`ch${++seq}`, gid, pid, team, captain, pid);
const scored = (gid, text) =>
  db.prepare('UPDATE gameweeks SET score = ? WHERE id = ?').run(text, gid);

test('a winner with no scoreline counts as a win and contributes no goals', () => {
  const w = player('Won it'); const l = player('Lost it');
  const g = game();
  sided(g, w, 'Red'); sided(g, l, 'Blue');
  scored(g, 'Reds win');                    // no numbers anywhere in the text

  const win = statsRepo.matchRecord(w, CONTRACT);
  assert.equal(win.wins, 1, 'the result is known — it is a win');
  assert.equal(win.goalGames, 0, 'no game of theirs has recorded goals');
  assert.equal(win.gf, 0);
  assert.equal(win.ga, 0, 'a 3-0 must not be invented to fill the gap');
  assert.equal(win.gdPerGame, null, 'goal difference per game is undefined, not 0');
  assert.equal(statsRepo.matchRecord(l, CONTRACT).losses, 1);
});

test('a margin without a scoreline is still not a scoreline', () => {
  const w = player('By four'); const l = player('By four loser');
  const g = game();
  sided(g, w, 'Blue'); sided(g, l, 'Red');
  scored(g, 'Blues win by 4');
  const r = statsRepo.matchRecord(w, CONTRACT);
  assert.equal(r.wins, 1);
  assert.equal(r.goalGames, 0, '4-0 is a guess at which goals made the margin');
  assert.equal(r.gf, 0);
});

test('a real scoreline does contribute goals', () => {
  const w = player('Scorer'); const l = player('Conceder');
  const g = game();
  sided(g, w, 'Blue'); sided(g, l, 'Red');
  scored(g, 'Blue win 7-5');
  const win = statsRepo.matchRecord(w, CONTRACT);
  assert.equal(win.goalGames, 1);
  assert.deepEqual([win.gf, win.ga, win.gd], [7, 5, 2]);
  const lose = statsRepo.matchRecord(l, CONTRACT);
  assert.deepEqual([lose.gf, lose.ga, lose.gd], [5, 7, -2], 'the loser gets it the other way up');
});

test('a game with three sides is a tournament, not a match', () => {
  const a = player('Champ'); const b = player('Runner up'); const c = player('Third');
  const g = game();
  sided(g, a, 'Red'); sided(g, b, 'Blue'); sided(g, c, 'White');
  scored(g, 'Reds win');

  for (const [who, label] of [[a, 'winner'], [b, 'runner up'], [c, 'third']]) {
    const r = statsRepo.matchRecord(who, CONTRACT);
    assert.equal(r.tournaments, 1, `${label} played a tournament`);
    assert.equal(r.games, 0, `${label}: a tournament is not a match`);
    assert.equal(r.wins + r.draws + r.losses, 0,
      `${label}: three sides means there is no head-to-head to win or lose`);
  }
});

test('an explicit tournament is kept out even with two sides', () => {
  const a = player('Flagged'); const b = player('Flagged two');
  const g = game();
  sided(g, a, 'Red'); sided(g, b, 'Blue');
  scored(g, 'Red win 3-1');
  db.prepare("UPDATE gameweeks SET game_type = 'tournament' WHERE id = ?").run(g);
  assert.equal(statsRepo.matchRecord(a, CONTRACT).tournaments, 1);
  assert.equal(statsRepo.matchRecord(a, CONTRACT).games, 0);
});

test('every record still adds up once tournaments are held out', () => {
  const p = player('Adds up');
  const g1 = game(); sided(g1, p, 'Red'); scored(g1, 'Red win 4-2');
  const g2 = game(); sided(g2, p, 'Red');                       // no score at all
  const g3 = game(); sided(g3, p, 'Red');
  sided(g3, player('T2'), 'Blue'); sided(g3, player('T3'), 'White');
  scored(g3, 'Reds win');                                        // tournament
  const r = statsRepo.matchRecord(p, CONTRACT);
  assert.equal(r.wins + r.draws + r.losses + r.unknown, r.games,
    'games must account for every match, and only matches');
  assert.equal(r.games, 2);
  assert.equal(r.tournaments, 1);
});

/* ===== The player's own page must agree with the Standing sheet ===== */

const timelineBalance = (pid) => round2(statsRepo.playerTimeline(pid, CONTRACT).presentBalance);

test('a player timeline reconciles to their ledger balance', () => {
  const p = player('Reconciles', 200);
  contribute(p, 60);
  charge(game(), p, 35);
  txn(p, 'adjustment', -10);
  assert.equal(timelineBalance(p), balanceOf(p));
  assert.equal(timelineBalance(p), 215);
});

test('a guest billed to their host does not appear on the guest own timeline', () => {
  const host = player('Host', 100);
  const guest = player('Brought along');
  makeOutside(guest);
  charge(game(), guest, 35, { chargedTo: host });
  assert.equal(timelineBalance(guest), 0, 'the guest keeps no balance and was billed to nobody');
  assert.equal(timelineBalance(guest), balanceOf(guest));
  assert.equal(timelineBalance(host), balanceOf(host), 'the host carries it');
  assert.equal(timelineBalance(host), 65);
});

test('cash and kitty-funded charges stay off the timeline, as they do off the ledger', () => {
  const p = player('Cash night', 100);
  const g = game();
  charge(g, p, 35);
  db.prepare('UPDATE charges SET settles_cash = 1 WHERE gameweek_id = ?').run(g);
  assert.equal(timelineBalance(p), 100, 'paid on the night, never off a balance');
  assert.equal(timelineBalance(p), balanceOf(p));

  const k = player('Kitty carried', 100);
  const g2 = game();
  charge(g2, k, 35);
  db.prepare('UPDATE charges SET settled_from_kitty = 1 WHERE gameweek_id = ?').run(g2);
  assert.equal(timelineBalance(k), 100, 'the pot carried it');
  assert.equal(timelineBalance(k), balanceOf(k));
});

test('a charge settled on another contract leaves this timeline alone', () => {
  db.prepare("INSERT OR IGNORE INTO contracts (id,name,rates,cost_per_gw,sort) VALUES ('other','Other','{}',0,2)").run();
  const p = player('Settles elsewhere', 100);
  const g = game();
  charge(g, p, 35);
  db.prepare("UPDATE charges SET settle_contract_id = 'other' WHERE gameweek_id = ?").run(g);
  assert.equal(timelineBalance(p), 100, 'it comes off the other contract, not this one');
  assert.equal(timelineBalance(p), balanceOf(p));
});

/* ===== A top-up is not profit =====
   The Kitty screen's collect button used to write a kitty income row and stop
   there, so the pot grew by money that was never profit and the member still
   owed every fil of it. A top-up refills the balance the cashier funded; only
   the surplus or shortfall on a game belongs in the kitty. */

const { contributionsRepo } = await import('../server/repos/contributions.js');
const kittyTotal = () => round2(db.prepare(
  `SELECT COALESCE(SUM(CASE WHEN kind = 'income' THEN amount ELSE -amount END), 0) n
   FROM kitty`).get().n);

test('collecting a top-up credits the balance and leaves the kitty alone', () => {
  const p = player('Owes a top-up', -120);
  const before = kittyTotal();
  assert.equal(balanceOf(p), -120);

  contributionsRepo.create({ player_id: p, contract_id: CONTRACT, amount: 120,
    date: '2026-09-13', comments: 'Top-up collected' });

  assert.equal(balanceOf(p), 0, 'the debt is cleared, which is the point of paying');
  assert.equal(kittyTotal(), before, 'money passing through to a balance is not profit');
});

test('the cashier is never listed as owing the club', () => {
  const cashier = player('The cashier', -400);
  db.prepare("UPDATE players SET special_role = 'cashier' WHERE id = ?").run(cashier);
  const row = ledgersRepo.get(cashier, CONTRACT);
  assert.equal(row.special_role, 'cashier',
    'the flag must reach the ledger row, or every screen has to look it up again');
  assert.ok(row.present_balance < 0, 'their float shows as a negative balance');
  // Which is exactly why the collect list filters on it: the club owes them.
  assert.throws(() => contributionsRepo.create({ player_id: cashier,
    contract_id: CONTRACT, amount: 400, date: '2026-09-13' }),
  /Cashier cannot contribute/, 'and they cannot pay it in either');
});

/* ===== Guest cash is revenue, not a receipt in the pot =====
   It used to be banked as its own kitty income line, which read as though the
   pot had received it. It had not — the guest hands the cash to the cashier,
   who has already paid for the pitch. It counts towards the game's profit and
   nowhere else. */

const kittyRowsFor = (gwId) => db.prepare(
  'SELECT id, label, amount, kind FROM kitty WHERE scope = ? ORDER BY id').all(gwId);

test('a guest payment lands in the game line, not a line of its own', () => {
  const member = player('Member');
  const guest = player('Paying guest');
  makeOutside(guest);
  const gw = playGame({ pitch: 100, water: 15, players: [
    { player_id: member, amount: 40 }, { player_id: guest, amount: 35, paid: 1 },
  ] });

  assert.equal(kittyOf(gw.id), 40 + 35 - 100 - 15, 'profit is everything in, less what it cost');
  const rows = kittyRowsFor(gw.id);
  assert.equal(rows.length, 1, 'one line per gameweek — the profit or the loss');
  assert.ok(rows[0].id.startsWith('k_gw_'), 'and it is the game row');
  assert.match(rows[0].label, /incl\. 35 guest cash/,
    'the line says the guest cash is in there, since it is not obvious otherwise');
});

test('a guest who has not paid yet leaves the game short by exactly that much', () => {
  const member = player('Member two');
  const guest = player('Slow guest');
  makeOutside(guest);
  const gw = playGame({ pitch: 100, players: [
    { player_id: member, amount: 40 }, { player_id: guest, amount: 35 },
  ] });
  assert.equal(kittyOf(gw.id), 40 - 100, 'uncollected cash is not profit yet');

  const charge = gameweeksRepo.get(gw.id).charges.find(c => c.player_id === guest);
  gameweeksRepo.setChargePaid(gw.id, charge.id, { paid: true });
  assert.equal(kittyOf(gw.id), 40 + 35 - 100, 'collecting it moves the pot by the cash, once');
  assert.equal(kittyRowsFor(gw.id).length, 1, 'and still without adding a row');
});

test('no charge ever owns a kitty row of its own', () => {
  const guest = player('Another guest');
  makeOutside(guest);
  const gw = playGame({ pitch: 30, players: [{ player_id: guest, amount: 35, paid: 1 }] });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM kitty WHERE id LIKE 'k_charge_%'").get().n, 0,
    'guest cash is revenue in the game line, never a receipt in the pot');
  assert.equal(kittyOf(gw.id), 35 - 30);
});

process.on('exit', () => {
  try { fs.rmSync(path.dirname(scratch), { recursive: true, force: true }); } catch { /* temp dir */ }
});
