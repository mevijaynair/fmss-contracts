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
const { shareRepo } = await import('../server/repos/share.js');

if (path.resolve(DB_FILE) !== path.resolve(scratch)) {
  console.error(`Refusing to run: tests would write to ${DB_FILE}, not the scratch database.`);
  process.exit(1);
}

initSchema();
db.exec('PRAGMA foreign_keys = ON');

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

test('two charges in one game can be corrected together', () => {
  // applyChargeEdits walks the edits in a loop, and the audit row it writes
  // per edit was keyed on the millisecond. Two edits land inside the same one,
  // so the second insert died on a UNIQUE violation and took the whole edit
  // back with it: correcting one charge worked, correcting two never did.
  const a = player('Edit me', 200);
  const b = player('Edit me too', 200);
  const g = game();
  const ca = `ch${++seq}`;
  const cb = `ch${++seq}`;
  for (const [id, pid] of [[ca, a], [cb, b]]) {
    db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,charged_to,paid)
                VALUES (?,?,?,'',0,'',30,?,0)`).run(id, g, pid, pid);
  }
  assert.equal(balanceOf(a), 170);

  // Freeze the clock. Whether two edits land in the same millisecond is a race
  // on a fast machine, and a test that only catches the bug when it happens to
  // lose that race is a test that passes on the day it matters. Held still,
  // the collision is certain — which is the point: the key must not depend on
  // how quickly the loop runs.
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    gameweeksRepo.applyChargeEdits(g, [
      { chargeId: ca, newAmount: 27 }, { chargeId: cb, newAmount: 27 },
    ], { reason: 'both at once', changedBy: 'test' });
  } finally {
    Date.now = realNow;
  }

  assert.equal(balanceOf(a), 173, 'the first correction stuck');
  assert.equal(balanceOf(b), 173, 'and so did the second');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM charge_audit WHERE charge_id IN (?,?)')
    .get(ca, cb).n, 2, 'both edits left a trail');
});

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

// A fresh night for each game, because the club cannot be in two places at
// once and the repo now enforces it. These all used one hard-coded date, which
// was fine while nothing checked and is exactly the state the check exists to
// prevent.
let playDay = 0;
function playGame({ pitch = 100, water = 0, players = [], ...rest }) {
  const date = new Date(Date.UTC(2026, 1, 1 + playDay++)).toISOString().slice(0, 10);
  return gameweeksRepo.create(
    { contract_id: CONTRACT, date, cost_per_gw: pitch, game_cost: water, ...rest },
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

/* ===== Where a payment should go =====
   The cashier takes money in a car park and has to decide, there and then,
   which balance it belongs on. The suggestion is only worth having if it is
   right about the two things that cost real money to get wrong: what is owed,
   and where they actually play. */

// A second contract to be split against, with games on it.
const OTHER = 'testc_split';
db.prepare(`INSERT OR IGNORE INTO contracts (id,name,rates,cost_per_gw,sort)
            VALUES (?,'Saturdays','{"contracted_12":40,"noncontract":45}',0,9)`).run(OTHER);

/**
 * Games on a given contract, dated relative to TODAY.
 *
 * The suggestion weighs the last eight weeks, so a fixed date in the test
 * calendar would age out and silently turn every weight to zero — the tests
 * would still pass, against the fallback, and stop testing the rule they were
 * written for.
 */
function playsOn(contract, playerId, games, amount = 40, daysAgo = 7) {
  for (let i = 0; i < games; i++) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo - i);
    const gid = `sg${++seq}`;
    db.prepare(`INSERT INTO gameweeks (id,contract_id,gw_number,contract_number,date,cost_per_gw,
      num_players,teams_raw,captains_raw,score,comments,historical,created_at)
      VALUES (?,?,?,0,?,0,0,'','','','',0,?)`)
      .run(gid, contract, ++seq, d.toISOString().slice(0, 10), new Date().toISOString());
    db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount)
      VALUES (?,?,?,'',0,'contracted_12',?)`).run(`sc${++seq}`, gid, playerId, amount);
  }
}

/** Put a player on the other contract with an opening balance and some games. */
function alsoOn(playerId, opening, games = 0, amount = 40, daysAgo = 7) {
  db.prepare(`INSERT OR REPLACE INTO ledgers (player_id,contract_id,opening_balance,status)
              VALUES (?,?,?,'')`).run(playerId, OTHER, opening);
  playsOn(OTHER, playerId, games, amount, daysAgo);
}

test('a payment is suggested against what is owed before anything else', () => {
  const p = player('Short on Saturdays', 200);       // 200 up on the main contract
  alsoOn(p, -150, 0);                                // 150 down on the other
  const s = contributionsRepo.suggestSplit(p, 150);
  const sat = s.lines.find(l => l.contract_id === OTHER);
  assert.equal(sat.suggested, 150, 'the whole payment clears the shortfall');
  assert.equal(s.lines.find(l => l.contract_id === CONTRACT).suggested, 0,
    'nothing goes where nothing is needed');
  assert.equal(sat.balance_after, 0);
});

test('what is left over is weighted by how fast each night is consumed', () => {
  // Nothing owed on either side, so this is purely the second rule. Their
  // games have to be paid for out of the opening balances or the debt rule
  // fires first and the test stops testing what it says it does.
  //
  // Level on both, so filling them to the same level splits the money by how
  // fast each is spent: three games at 30 against one at 40, i.e. 90 to 40.
  const p = player('Plays mostly Mondays', 90);
  playsOn(CONTRACT, p, 3, 30);                       // three on the main contract
  alsoOn(p, 40, 1);                                  // one on the other
  const s = contributionsRepo.suggestSplit(p, 200);
  const main = s.lines.find(l => l.contract_id === CONTRACT).suggested;
  const other = s.lines.find(l => l.contract_id === OTHER).suggested;
  assert.equal(s.owed_total, 0, 'nothing is owed, so this is the burn rate alone');
  assert.equal(main + other, 200, 'all of it is allocated');
  assert.equal(main, 138, '90 parts in 130');
  assert.equal(other, 62, '40 parts in 130');
});

test('the night that runs out first gets the money', () => {
  // The case that made the rule: Toby held 487 on Mon/Thu — twenty-two games
  // of cover — and nothing on Saturdays. Sharing his 200 by how often he plays
  // sent most of it to the night he could not run out of, and left the empty
  // one nearly as empty.
  const p = player('Flush on one night', 490);
  playsOn(CONTRACT, p, 3, 30);                       // 400 left, covers many
  alsoOn(p, 0, 2, 40);                               // plays here too, holds nothing
  // Their Saturday games are unpaid, so clear that first, then the rest.
  const s = contributionsRepo.suggestSplit(p, 200);
  const main = s.lines.find(l => l.contract_id === CONTRACT);
  const other = s.lines.find(l => l.contract_id === OTHER);
  assert.equal(main.suggested, 0,
    `nothing should go to a night with ${main.games_after} games of cover already`);
  assert.equal(other.suggested, 200, 'it all goes where the cover has run out');
  assert.equal(main.balance_after, main.balance, 'the covered night is left exactly as it was');
  assert.ok(other.games_after >= 1,
    'and the empty one can field a game again, which it could not before');
});

test('a contract they have not played in eight weeks is not funded', () => {
  // Square on both nights, so nothing is owed and the only question left is
  // where the money is any use.
  const p = player('Stopped going Saturdays', 30);
  playsOn(CONTRACT, p, 1, 30);
  alsoOn(p, 80, 2, 40, 200);                         // last played there 200 days ago
  const s = contributionsRepo.suggestSplit(p, 120);
  assert.equal(s.owed_total, 0);
  assert.equal(s.lines.find(l => l.contract_id === OTHER).suggested, 0,
    'money should not be stranded on a night they have stopped turning up to');
  assert.equal(s.lines.find(l => l.contract_id === CONTRACT).suggested, 120);
});

test('when the payment cannot clear both, neither night is left behind', () => {
  const p = player('Short on both', -100);
  alsoOn(p, -300, 0);
  const s = contributionsRepo.suggestSplit(p, 200);  // owed 400, paying 200
  const main = s.lines.find(l => l.contract_id === CONTRACT).suggested;
  const other = s.lines.find(l => l.contract_id === OTHER).suggested;
  assert.equal(main + other, 200);
  assert.ok(main > 0 && other > 0, 'both get something');
  // In proportion: a quarter of the debt is here, three quarters there.
  assert.ok(Math.abs(main - 50) <= 1 && Math.abs(other - 150) <= 1,
    `expected roughly 50/150, got ${main}/${other}`);
});

test('the suggested parts always add up to the payment, exactly', () => {
  // The form refuses to submit unless they do, so a rounding slip here is not
  // a cosmetic problem — it is a payment that cannot be recorded at all. Odd
  // amounts against three-way weights are where thirds go wrong.
  const p = player('Rounding', 0);
  playsOn(CONTRACT, p, 2, 30);
  alsoOn(p, -33, 1);

  // And the case that actually breaks naive rounding: the same balance and the
  // same burn on both nights, so an odd payment splits into two shares exactly
  // half a dirham over. Rounding the two independently hands out a dirham that
  // nobody paid, and the form then refuses a payment it should have taken.
  const even = player('Mirrored on both', 60);
  playsOn(CONTRACT, even, 1, 30);
  alsoOn(even, 60, 1, 30);

  // Thirds are where rounding really breaks: 100 three ways is 33.33 each, and
  // rounding them independently pays out 99. The club has two contracts today
  // and this code does not know that, so the third one is worth having here.
  const THIRD = 'testc_split3';
  db.prepare(`INSERT OR IGNORE INTO contracts (id,name,rates,cost_per_gw,sort)
              VALUES (?,'Fridays','{"contracted_12":30}',0,10)`).run(THIRD);
  const three = player('On three nights', 60);
  playsOn(CONTRACT, three, 1, 30);
  alsoOn(three, 60, 1, 30);
  db.prepare(`INSERT OR REPLACE INTO ledgers (player_id,contract_id,opening_balance,status)
              VALUES (?,?,60,'')`).run(three, THIRD);
  playsOn(THIRD, three, 1, 30);

  for (const who of [p, even, three]) {
    for (const amount of [1, 3, 7, 33, 99, 100, 101, 137, 299, 300, 1001]) {
      const s = contributionsRepo.suggestSplit(who, amount);
      const sum = s.lines.reduce((t, l) => t + l.suggested, 0);
      assert.equal(sum, amount, `${amount} split to ${s.lines.map(l => l.suggested).join('+')}`);
      assert.ok(s.lines.every(l => Number.isInteger(l.suggested)), 'in whole dirhams');
      assert.ok(s.lines.every(l => l.suggested >= 0), 'and never negative');
    }
  }
});

test('one contract means no split to make', () => {
  const p = player('Mondays only', 0);
  playsOn(CONTRACT, p, 1, 30);
  const s = contributionsRepo.suggestSplit(p, 300);
  assert.equal(s.lines.length, 1);
  assert.equal(s.lines[0].suggested, 300);
  assert.ok(s.single, 'the form can skip the panel entirely');
  assert.match(s.headline, /only plays/);
});

test('the suggestion quotes what their games actually cost, not the card rate', () => {
  // The card says 40 a game on the other contract; twelve turned out and they
  // were charged 25. Telling them 300 covers 7 games when it covers 12 is the
  // kind of wrong that gets noticed at the next game.
  const p = player('Charged less than the card', 0);
  alsoOn(p, 0, 2, 25);
  const s = contributionsRepo.suggestSplit(p, 300);
  const line = s.lines.find(l => l.contract_id === OTHER);
  assert.equal(line.cost_per_game, 25, 'from what they have been charged');
});

test('the cashier is refused a suggestion, not given a bad one', () => {
  const c = player('Another cashier', 0);
  db.prepare("UPDATE players SET special_role = 'cashier' WHERE id = ?").run(c);
  const s = contributionsRepo.suggestSplit(c, 500);
  assert.equal(s.lines.length, 0);
  assert.match(s.refused, /cashier/i);
});

test('paying into a contract they have no ledger row on still lands somewhere', () => {
  // Balances are read from the ledger table. Without a row the payment was
  // logged, no balance moved, and nothing said why.
  const p = player('New to Saturdays', 0);
  assert.equal(ledgersRepo.get(p, OTHER), undefined, 'no row to begin with');
  contributionsRepo.create({ player_id: p, contract_id: OTHER, amount: 90, date: '2026-09-22' });
  assert.equal(ledgersRepo.get(p, OTHER)?.present_balance, 90,
    'the row is created and the money shows on it');
});

test('a move between someone\'s own contracts goes either way', () => {
  // The engine only ever ran one direction — covering a shortfall out of the
  // other night's credit. Somebody who has stopped playing Saturdays wants the
  // opposite, and it must be the same reconciled two-legged write.
  const p = player('Moving it back', 0);
  alsoOn(p, 250, 0);
  const before = ledgersRepo.forPlayer(p).reduce((s, l) => s + l.present_balance, 0);

  const out = ledgersRepo.coverFromOtherContract(p, { from: OTHER, to: CONTRACT, amount: 250,
    kind: 'move' });
  assert.equal(ledgersRepo.get(p, OTHER).present_balance, 0);
  assert.equal(ledgersRepo.get(p, CONTRACT).present_balance, 250);
  assert.equal(ledgersRepo.forPlayer(p).reduce((s, l) => s + l.present_balance, 0), before,
    'what they hold altogether cannot change');

  const legs = db.prepare('SELECT description FROM transactions WHERE id LIKE ?')
    .all(`t_${out.id}%`).map(r => r.description);
  assert.ok(legs.every(d => /Moved from/.test(d)),
    `a move should not read as a cover: ${legs.join(' | ')}`);

  // And back again, which the old wording could not have described at all.
  ledgersRepo.coverFromOtherContract(p, { from: CONTRACT, to: OTHER, amount: 100, kind: 'move' });
  assert.equal(ledgersRepo.get(p, CONTRACT).present_balance, 150);
  assert.equal(ledgersRepo.get(p, OTHER).present_balance, 100);
});

test('a move is refused when the source cannot afford it', () => {
  const p = player('Not enough there', 0);
  alsoOn(p, 40, 0);
  assert.throws(() => ledgersRepo.coverFromOtherContract(p,
    { from: OTHER, to: CONTRACT, amount: 100, kind: 'move' }),
  /only has 40/, 'moving money out of a balance must not put it in the red');
  assert.equal(ledgersRepo.get(p, OTHER).present_balance, 40, 'and nothing moved');
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

/* ===== What the Season list says a game is missing =====
   The filters there are only as good as these three flags, and each one is a
   question the screen must not answer for itself: "has a result" in particular
   is not "the score box has something in it", because every game is created
   with a 0-0 scoreline and a text naming no side cannot be attributed. */

const listed = (gwId) => gameweeksRepo.all(CONTRACT).find(g => g.id === gwId);

test('a game with sides, a captain each and a score is not missing anything', () => {
  const g = game();
  sided(g, player('Cap red'), 'Red', { captain: 1 });
  sided(g, player('Cap blue'), 'Blue', { captain: 1 });
  scored(g, 'Red win 5-3');
  const row = listed(g);
  assert.deepEqual(
    [row.has_teams, row.has_captains, row.has_result], [true, true, true]);
});

test('one captain across two sides is half a record, not a full one', () => {
  const g = game();
  sided(g, player('Only captain'), 'Red', { captain: 1 });
  sided(g, player('No captain'), 'Blue');
  scored(g, 'Red win 5-3');
  assert.equal(listed(g).has_captains, false, 'every side wants someone in the armband');
});

test('an empty score and a default scoreline both count as no result', () => {
  const g = game();
  sided(g, player('A side'), 'Red', { captain: 1 });
  sided(g, player('B side'), 'Blue', { captain: 1 });
  assert.equal(listed(g).has_result, false, 'nothing was recorded');

  db.prepare("UPDATE gameweeks SET scoreline = '0-0' WHERE id = ?").run(g);
  assert.equal(listed(g).has_result, false,
    'every game is created with 0-0 — it is a placeholder, not a nil-nil draw');
});

test('a score naming a side that did not play cannot be a result', () => {
  const g = game();
  sided(g, player('Greens one'), 'Green', { captain: 1 });
  sided(g, player('Greens two'), 'White', { captain: 1 });
  scored(g, 'Red win 5-3');
  assert.equal(listed(g).has_result, false, 'no Red played, so nobody won it');
});

test('a game with no sides on any charge is missing all three', () => {
  const g = game();
  charge(g, player('Turned up'), 0);
  scored(g, 'Red win 5-3');
  const row = listed(g);
  assert.deepEqual([row.has_teams, row.has_captains, row.has_result], [false, false, false],
    'without sides there is no captain to have and no winner to attribute');
});

// ---------------------------------------------------------------------------
// Playing one contract's game out of another contract's pot.
//
// Somebody with Saturdays credit and nothing on Mon/Thu can pay for a Mon/Thu
// place from the balance they actually hold, instead of opening a Mon/Thu
// account at zero and going straight into the red.

test('a charge funded from another contract comes off that contract balance', () => {
  const other = 'otherc';
  db.prepare("INSERT OR IGNORE INTO contracts (id,name,rates,cost_per_gw,sort) VALUES (?,'Other','{}',0,2)")
    .run(other);
  const p = player('Two pots', 0);
  db.prepare('INSERT INTO ledgers (player_id,contract_id,opening_balance,status) VALUES (?,?,?,\'\')')
    .run(p, other, 300);

  const g = game();
  charge(g, p, 35);
  const ch = db.prepare('SELECT id FROM charges WHERE gameweek_id = ?').get(g).id;
  gameweeksRepo.setChargeSettlement(g, ch, { mode: 'balance', settle_contract_id: other });

  assert.equal(balanceOf(p), 0, 'their account on the game\'s own contract is untouched');
  assert.equal(ledgersRepo.get(p, other).present_balance, 265,
    'the money comes off the pot that is actually paying');
});

test('funding from another contract is not turned into a cash debt', () => {
  const other = 'otherc';
  const p = player('Not a debtor', 0);
  db.prepare('INSERT INTO ledgers (player_id,contract_id,opening_balance,status) VALUES (?,?,?,\'\')')
    .run(p, other, 200);
  const g = game();
  charge(g, p, 35);
  const ch = db.prepare('SELECT id FROM charges WHERE gameweek_id = ?').get(g).id;
  gameweeksRepo.setChargeSettlement(g, ch, { mode: 'balance', settle_contract_id: other });

  assert.ok(!ledgersRepo.cashOutstanding(CONTRACT).some(r => r.player_id === p),
    'it came off a balance — nobody is holding the club money for it');
  assert.equal(ledgersRepo.get(p, other).cash_owed, 0);
});

test('paying from another pot is priced at the out-of-contract rate', () => {
  // The contract rates are what prepaying into THIS contract buys. Somebody
  // dipping in from elsewhere has not, so they pay what a guest pays.
  //
  // Reviewed and kept on 2026-09-20, against two alternatives: the contract
  // rate for any member, and the contract rate when the game takes them less
  // than 25 below zero. The club chose to keep the premium. It is 8 a game —
  // five cross-dips have ever happened, so 40 across the season — and the
  // reasoning that won is that the Saturday regulars should not subsidise
  // somebody who has never paid into Saturdays. Recorded because this is now
  // a decision rather than an inherited default, and the next person to think
  // it looks harsh should know it was already argued.
  db.prepare(`UPDATE contracts SET rates = '{"contracted_10":30,"contracted_12":27,
    "captain_10":25,"captain_12":20,"noncontract":35}' WHERE id = ?`).run(CONTRACT);
  const g = game();
  const priced = gameweeksRepo.rateForCharge({
    gameweekId: g, isCaptain: false, fromOtherContract: true, players: 12,
  });
  assert.equal(priced.rate_type, 'noncontract');
  assert.equal(priced.amount, 35, 'not the 27 a contracted player pays');
});

test('naming a captain after the night offers the discount they are owed', () => {
  // Game Day applies the captain rate on the night. Setting the armband
  // afterwards did not, so the five games still missing a captain could not
  // be corrected without leaving whoever was named paying the full contract
  // rate — overcharged by exactly the discount, and labelled as one rate
  // while carrying another.
  db.prepare(`UPDATE contracts SET rates = '{"contracted_10":30,"contracted_12":27,
    "captain_10":25,"captain_12":20,"noncontract":35}' WHERE id = ?`).run(CONTRACT);
  const p = player('Named later', 200);
  const g = game();
  const c = `ch${++seq}`;
  db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,charged_to,paid)
              VALUES (?,?,?,'Red',0,'contracted_10',30,?,0)`).run(c, g, p, p);
  gameweeksRepo.recomputeGameKitty(g);
  assert.equal(balanceOf(p), 170);

  // Told, not done.
  const asked = gameweeksRepo.updateCharge(g, c, { team: 'Red', is_captain: true });
  assert.equal(asked.charges.find(x => x.id === c).is_captain, 1, 'the armband is set');
  assert.equal(balanceOf(p), 170, 'and the money has not moved');
  assert.deepEqual(
    { was: asked.captain_rate.was, would_be: asked.captain_rate.would_be, applied: asked.captain_rate.applied },
    { was: 30, would_be: 25, applied: false }, 'but the discount is offered');

  // Done when asked for.
  gameweeksRepo.updateCharge(g, c, { team: 'Red', is_captain: false });
  gameweeksRepo.updateCharge(g, c, { team: 'Red', is_captain: true, reprice: true });
  assert.equal(balanceOf(p), 175, 'five back — the captain rate');
  assert.equal(db.prepare('SELECT rate_type FROM charges WHERE id = ?').get(c).rate_type,
    'captain_10', 'and the label says what they actually paid');

  // A guest's cash is not on the contract's card, so there is nothing to offer.
  const walkup = player('Walk-up captain');
  makeOutside(walkup);
  const gc = `ch${++seq}`;
  db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,charged_to,paid)
              VALUES (?,?,?,'Blue',0,'noncontract',35,?,0)`).run(gc, g, walkup, walkup);
  const guestOut = gameweeksRepo.updateCharge(g, gc, { team: 'Blue', is_captain: true });
  assert.equal(guestOut.captain_rate, null,
    'the captain discount is something being in the contract buys');
});

test('the captain discount does not survive paying from another pot', () => {
  const g = game();
  const asCaptain = gameweeksRepo.rateForCharge({
    gameweekId: g, isCaptain: true, fromOtherContract: false, players: 12,
  });
  const dipping = gameweeksRepo.rateForCharge({
    gameweekId: g, isCaptain: true, fromOtherContract: true, players: 12,
  });
  assert.equal(asCaptain.amount, 20, 'a contracted captain pays the captain rate');
  assert.equal(dipping.amount, 35,
    'the captain rate is a contract benefit, so it goes with the contract');
});

test('re-pricing only happens when asked, and only when the pot actually changes', () => {
  const other = 'otherc';
  const p = player('Priced by hand', 0);
  db.prepare('INSERT INTO ledgers (player_id,contract_id,opening_balance,status) VALUES (?,?,?,\'\')')
    .run(p, other, 500);
  const g = game();
  charge(g, p, 99);                                  // a figure somebody typed
  const ch = db.prepare('SELECT id FROM charges WHERE gameweek_id = ?').get(g).id;

  gameweeksRepo.setChargeSettlement(g, ch, { mode: 'balance', settle_contract_id: other });
  assert.equal(db.prepare('SELECT amount FROM charges WHERE id = ?').get(ch).amount, 99,
    'without reprice, a hand-set amount stands');

  const moved = gameweeksRepo.setChargeSettlement(g, ch,
    { mode: 'balance', settle_contract_id: null, reprice: true });
  assert.ok(moved.repriced, 'coming back onto this contract re-prices');
  assert.equal(moved.repriced.from, 99);

  const again = gameweeksRepo.setChargeSettlement(g, ch,
    { mode: 'balance', settle_contract_id: null, reprice: true });
  assert.equal(again.repriced, null,
    'asking again when nothing moved must not keep re-pricing');
});

test('the settlement mode actually reaches the charge', () => {
  // The route dropped `mode`, so the Season control reported a change it had
  // not made and snapped back on the next read.
  const p = player('Mode mover', 100);
  const g = game();
  charge(g, p, 30);
  const ch = db.prepare('SELECT id FROM charges WHERE gameweek_id = ?').get(g).id;
  gameweeksRepo.setChargeSettlement(g, ch, { mode: 'kitty' });
  assert.equal(db.prepare('SELECT settled_from_kitty k FROM charges WHERE id = ?').get(ch).k, 1);
  assert.equal(balanceOf(p), 100, 'the club pot carried it, so their balance is untouched');
  gameweeksRepo.setChargeSettlement(g, ch, { mode: 'balance' });
  assert.equal(balanceOf(p), 70, 'and back off their balance again');
});

test('a charge that uses no balance may not name one', () => {
  // settle_contract_id says WHICH BALANCE pays. cashOutstanding groups by it,
  // so leaving it on a cash charge files the debt under a contract that has
  // nothing to do with the game — a guest at a Mon/Thu game turned up as
  // Saturdays cash owed, where nobody chasing that game would ever see them.
  const other = 'otherc';
  const guest = player('Cash walk-up', 0);
  makeOutside(guest);
  const g = game();
  charge(g, guest, 35);
  const ch = db.prepare('SELECT id FROM charges WHERE gameweek_id = ?').get(g).id;

  gameweeksRepo.setChargeSettlement(g, ch, { mode: 'cash', settle_contract_id: other });
  assert.equal(db.prepare('SELECT settle_contract_id s FROM charges WHERE id = ?').get(ch).s, null,
    'a cash charge settles no balance, so it names none');
  assert.ok(ledgersRepo.cashOutstanding(CONTRACT).some(r => r.player_id === guest),
    'and is chased on the contract whose game it was');
  assert.ok(!ledgersRepo.cashOutstanding(other).some(r => r.player_id === guest));

  gameweeksRepo.setChargeSettlement(g, ch, { mode: 'kitty', settle_contract_id: other });
  assert.equal(db.prepare('SELECT settle_contract_id s FROM charges WHERE id = ?').get(ch).s, null,
    'nor does one the club pot carries');
});

test('what a guest owes in cash is never raised by a rate card', () => {
  // A walk-up who agreed 20 on the night owes 20. Re-pricing answers "which
  // contract's rates apply", which is a question about a balance — it must not
  // reach a charge that settles none, least of all as a side effect of
  // clearing a funding contract they were never going to use.
  const other = 'otherc';
  const guest = player('Agreed twenty', 0);
  makeOutside(guest);
  const g = game();
  charge(g, guest, 20);
  const ch = db.prepare('SELECT id FROM charges WHERE gameweek_id = ?').get(g).id;
  gameweeksRepo.setChargeSettlement(g, ch,
    { mode: 'balance', settle_contract_id: other, reprice: true });
  gameweeksRepo.setChargeSettlement(g, ch, { mode: 'cash', reprice: true });
  assert.equal(db.prepare('SELECT amount FROM charges WHERE id = ?').get(ch).amount, 20,
    'they owe what was agreed, not what the card says');
});

test('an imported game keeps its value when its settlement is edited', () => {
  // Games behind a closed baseline carry a charge worth 0 — an attendance
  // record, not a bill, with the opening balances already netting them out.
  // Re-pricing one put 35 on it: money invented behind a closed baseline.
  const p = player('Was there in 2025', 0);
  const g = game(1);                                  // historical
  charge(g, p, 0);
  const ch = db.prepare('SELECT id FROM charges WHERE gameweek_id = ?').get(g).id;
  gameweeksRepo.setChargeSettlement(g, ch,
    { mode: 'balance', settle_contract_id: 'otherc', reprice: true });
  assert.equal(db.prepare('SELECT amount FROM charges WHERE id = ?').get(ch).amount, 0,
    'the baseline says nobody was charged for this, and that stands');
  assert.equal(balanceOf(p), 0, 'and no balance moved');
});

test('a game funded from elsewhere still credits the contract it was played on', () => {
  const other = 'otherc';
  const p = player('Dipper', 0);
  db.prepare('INSERT OR IGNORE INTO ledgers (player_id,contract_id,opening_balance,status) VALUES (?,?,?,\'\')')
    .run(p, other, 400);
  const g = game();
  charge(g, p, 35);
  const ch = db.prepare('SELECT id FROM charges WHERE gameweek_id = ?').get(g).id;
  gameweeksRepo.setChargeSettlement(g, ch, { mode: 'balance', settle_contract_id: other });

  const row = db.prepare('SELECT contract_id, amount, kind FROM kitty WHERE id = ?').get(`k_gw_${g}`);
  assert.equal(row.contract_id, CONTRACT,
    'the night was this contract\'s, whatever pot paid for the place');
  assert.equal(ledgersRepo.get(p, other).present_balance, 365, 'and the money came off that pot');
});

// ---------------------------------------------------------------------------
// The shared snapshots.
//
// These are the only figures in the system that leave it. Once a picture is in
// forty people's chats it cannot be corrected, and nobody receiving it can
// check it against the app. So what it says has to be what the app says.

test('the club snapshot shows exactly the Standing sheet squad', () => {
  const snap = shareRepo.club({ weeks: 3 });
  const mine = snap.contracts.find(c => c.id === CONTRACT);
  const sheet = periodReportRepo.report(CONTRACT, { since: null, includeDormant: false });
  assert.deepEqual(mine.squad.map(r => r.name), sheet.rows.map(r => r.name),
    'the picture and the sheet must list the same people, in the same order');
  assert.deepEqual(mine.squad.map(r => r.balance), sheet.rows.map(r => r.present_balance));
});

test('a player marked as left is on no snapshot', () => {
  const p = player('Departed', 400);
  playersRepo.update(p, { hide_from_sheet: true });
  const mine = shareRepo.club({ weeks: 3 }).contracts.find(c => c.id === CONTRACT);
  assert.ok(!mine.squad.some(r => r.name === 'Departed'),
    'retiring someone must take them off the picture too, not just the sheet');
  assert.ok(!shareRepo.club({ weeks: 3 }).still_to_pay.top_up.some(r => r.name === 'Departed'),
    'nor on the list of people asked to pay');
  playersRepo.update(p, { hide_from_sheet: false });
});

test('the cashier is never named as owing the club', () => {
  const c = player('Club cashier', 0);
  db.prepare("UPDATE players SET special_role = 'cashier' WHERE id = ?").run(c);
  charge(game(), c, 500);                       // deep in the red, by design
  const snap = shareRepo.club({ weeks: 3 });
  assert.ok(balanceOf(c) < 0, 'the cashier really is negative — that is the float');
  assert.ok(!snap.still_to_pay.top_up.some(r => r.name === 'Club cashier'),
    'their balance is money they fronted, and publishing it as a debt is wrong');
  assert.ok(!snap.contracts.find(x => x.id === CONTRACT).to_collect
    .some(r => r.name === 'Club cashier'));
  db.prepare('UPDATE players SET special_role = NULL WHERE id = ?').run(c);
});

test('"pending" never mixes cash owed with an empty balance', () => {
  const guest = player('Cash guest', 0);
  makeOutside(guest);
  charge(game(), guest, 40, { paid: 0 });       // real cash, not yet handed over
  const member = player('Spent up', 10);
  charge(game(), member, 50);                   // balance gone, owes nothing in cash

  const snap = shareRepo.club({ weeks: 3 });
  const mine = snap.contracts.find(c => c.id === CONTRACT);
  assert.ok(mine.to_collect.some(r => r.name === 'Cash guest' && r.amount === 40),
    'cash the club is waiting on belongs in to_collect');
  assert.ok(!mine.to_collect.some(r => r.name === 'Spent up'),
    'an empty balance is not cash owed — nobody is holding the club money');
  assert.ok(snap.still_to_pay.top_up.some(r => r.name === 'Spent up'),
    'but they do need to top up before playing again');
  assert.ok(!snap.still_to_pay.top_up.some(r => r.name === 'Cash guest'),
    'a guest keeps no balance, so they can never be in the red');
  assert.ok(snap.still_to_pay.cash.some(r => r.name === 'Cash guest' && r.amount === 40),
    'the guest is on the cash list instead');
});

test('the picture asks each person for money once, across everything', () => {
  // It used to list debtors per contract. So Jeetu was shown as -159 on one
  // line and -441 on another and never as the -600 he owes, and somebody in
  // credit on one night was named as a debtor for a shortfall their own
  // money already covers.
  const other = 'testc6';
  db.prepare(`INSERT OR IGNORE INTO contracts (id,name,rates,cost_per_gw,sort)
              VALUES (?,'Other night','{}',0,6)`).run(other);

  // Short on both: one line, the total.
  const deep = player('Short twice', 0);
  ledgersRepo.ensure(deep, other);
  db.prepare('UPDATE ledgers SET opening_balance = -100 WHERE player_id = ? AND contract_id = ?')
    .run(deep, other);
  db.prepare('UPDATE ledgers SET opening_balance = -60 WHERE player_id = ? AND contract_id = ?')
    .run(deep, CONTRACT);

  // Short on one, in credit on the other, and better off overall: not asked.
  const evens = player('Evens out', 300);
  ledgersRepo.ensure(evens, other);
  db.prepare('UPDATE ledgers SET opening_balance = -50 WHERE player_id = ? AND contract_id = ?')
    .run(evens, other);

  const pay = shareRepo.club({ weeks: 3 }).still_to_pay;
  const asked = pay.top_up.filter(r => r.name === 'Short twice');
  assert.equal(asked.length, 1, 'one line, not one per contract');
  assert.equal(asked[0].total, -160, 'and the figure is what they actually owe');
  assert.equal(asked[0].parts.length, 2, 'with the split, so they know which night');
  assert.ok(!pay.top_up.some(r => r.name === 'Evens out'),
    'their own money covers it — asking them to pay is asking twice');
});

test('the split is one entry per contract they are on, zero included', () => {
  // The picture lays the split out as columns — name, each contract, total —
  // and it matches a cell to a column by contract_id. Dropping the contracts
  // they happen to be level on would leave a hole, and a hole in a column
  // layout is not read as "nothing": the next figure along slides under the
  // wrong heading. A contract they are genuinely not on has no entry, which
  // is what lets the picture show a dash there instead of a nought.
  const other = 'testc7';
  db.prepare(`INSERT OR IGNORE INTO contracts (id,name,rates,cost_per_gw,sort)
              VALUES (?,'Third night','{}',0,7)`).run(other);

  const both = player('Level on one', 0);
  ledgersRepo.ensure(both, other);       // joined, never paid in, never played
  db.prepare('UPDATE ledgers SET opening_balance = -70 WHERE player_id = ? AND contract_id = ?')
    .run(both, CONTRACT);

  const onlyHere = player('One night only', -40);

  const pay = shareRepo.club({ weeks: 3 }).still_to_pay;
  const split = pay.top_up.find(r => r.name === 'Level on one');
  assert.equal(split.total, -70, 'the nought changes nothing about what they owe');
  const zero = split.parts.find(p => p.contract_id === other);
  assert.ok(zero, 'the contract they are level on still has a cell');
  assert.equal(zero.balance, 0, 'showing the nought it actually is');

  const lone = pay.top_up.find(r => r.name === 'One night only');
  assert.ok(!lone.parts.some(p => p.contract_id === other),
    'a contract they were never on has no cell, so the picture can say so');
  assert.ok(split.parts.every(p => p.contract_id && p.contract),
    'every cell names its contract by id, not by the order it came back in');
});

test('an ordinary charge is not reported as pending', () => {
  // Charges settled off a prepaid balance are never marked paid. Reading
  // `paid = 0` as "outstanding" would publish the whole season as a debt.
  const p = player('Prepaid', 500);
  charge(game(), p, 35, { paid: 0 });
  const mine = shareRepo.club({ weeks: 3 }).contracts.find(c => c.id === CONTRACT);
  assert.ok(!mine.to_collect.some(r => r.name === 'Prepaid'),
    'they paid up front; there is nothing to collect');
});

test('a player snapshot agrees with every one of their ledgers', () => {
  const p = player('Across the board', 300);
  contribute(p, 120);
  charge(game(), p, 45);
  const snap = shareRepo.player(p, { weeks: 520 });   // wide enough to catch it all
  for (const line of snap.contracts) {
    assert.equal(line.balance, ledgersRepo.get(p, line.contract_id).present_balance,
      'the picture must not disagree with the ledger it was drawn from');
  }
});

test('a player snapshot never nets credit on one contract against debt on another', () => {
  const p = player('Two sided', 200);
  charge(game(), p, 260);                       // -60 here
  const snap = shareRepo.player(p, { weeks: 520 });
  assert.equal(snap.contracts.length, 1, 'only one contract exists in this harness');
  assert.equal(snap.total_balance, snap.contracts.reduce((s, c) => s + c.balance, 0),
    'the total is a sum of the lines, and every line is still shown separately');
  assert.ok(snap.contracts.every(c => 'balance' in c && 'cash_owed' in c),
    'credit and cash owed stay in their own fields — they are different money');
});

test('a charge settled by someone else says whose game it was', () => {
  const host = player('The host', 500);
  const brought = player('Their guest', 0);
  charge(game(), brought, 35, { chargedTo: host });
  const snap = shareRepo.player(host, { weeks: 520 });
  const line = snap.recent.find(e => e.type === 'charge');
  assert.match(line.label, /Their guest/,
    'two identical lines on one date read as a double charge unless named');
});

// ---------------------------------------------------------------------------
// One night, one game — and moving one that was filed wrongly.

test('the club cannot be in two places on one night', () => {
  const other = 'testc2';
  db.prepare(`INSERT OR IGNORE INTO contracts (id,name,rates,cost_per_gw,sort)
              VALUES (?,'Other','{}',100,2)`).run(other);
  const p = player('Double booked', 500);
  gameweeksRepo.create({ contract_id: CONTRACT, date: '2026-10-01', cost_per_gw: 100 },
    [{ player_id: p, amount: 10 }]);
  // Same contract, same night.
  assert.throws(() => gameweeksRepo.create({ contract_id: CONTRACT, date: '2026-10-01' }, []),
    /already a .* game on 2026-10-01/);
  // And the other contract, which is the case that actually happened: a
  // Saturday game filed under Mon/Thu, with a Saturday game entered beside it.
  assert.throws(() => gameweeksRepo.create({ contract_id: other, date: '2026-10-01' }, []),
    /cannot be in two places/);
  // A different night is fine.
  gameweeksRepo.create({ contract_id: other, date: '2026-10-02', cost_per_gw: 100 }, []);
});

test('moving a game to another contract moves the ledger it settles against', () => {
  const other = 'testc3';
  db.prepare(`INSERT OR IGNORE INTO contracts (id,name,rates,cost_per_gw,sort)
              VALUES (?,'Elsewhere','{}',200,3)`).run(other);
  const p = player('Moved about', 400);
  const gw = gameweeksRepo.create(
    { contract_id: CONTRACT, date: '2026-10-05', cost_per_gw: 100 },
    [{ player_id: p, amount: 40 }]);

  assert.equal(ledgersRepo.get(p, CONTRACT).present_balance, 360, 'charged on the old contract');
  const totalBefore = round2(ledgersRepo.forPlayer(p)
    .reduce((s, l) => s + l.present_balance, 0));

  gameweeksRepo.moveToContract(gw.id, other);

  assert.equal(ledgersRepo.get(p, CONTRACT).present_balance, 400, 'the charge left the old one');
  assert.equal(ledgersRepo.get(p, other).present_balance, -40, 'and landed on the new one');
  assert.equal(round2(ledgersRepo.forPlayer(p).reduce((s, l) => s + l.present_balance, 0)),
    totalBefore, 'moving between their pockets must not change what is in them');
  assert.equal(gameweeksRepo.get(gw.id).cost_per_gw, 200,
    'and the pitch is what the new contract costs');

  // The amounts are untouched: a night already played and partly settled is
  // not repriced by being refiled.
  assert.equal(gameweeksRepo.get(gw.id).charges[0].amount, 40);

  // Refusals.
  assert.throws(() => gameweeksRepo.moveToContract(gw.id, 'nope'), /No such contract/);
  assert.throws(() => gameweeksRepo.moveToContract('nope', other), /No such game/);
  // Onto a night the club is already playing.
  const clash = gameweeksRepo.create(
    { contract_id: CONTRACT, date: '2026-10-06', cost_per_gw: 100 }, []);
  db.prepare("UPDATE gameweeks SET date = '2026-10-05' WHERE id = ?").run(clash.id);
  assert.throws(() => gameweeksRepo.moveToContract(clash.id, other), /already a .* game/);
  db.prepare("UPDATE gameweeks SET date = '2026-10-06' WHERE id = ?").run(clash.id);
});

test('paying for somebody does not put their game on your list', () => {
  // Vijay covered Rahul's guest fee on 12 September. Reading charged_to as
  // well as player_id put Rahul's game on Vijay's "your last games" — the same
  // night listed twice, the second on a side he was not on, with a button
  // beside it inviting him to report it as wrong.
  const host = player('Pays for people', 500);
  const visitor = player('Brought along');
  makeOutside(visitor);
  const g = game();
  charge(g, host, 30);
  charge(g, visitor, 40, { chargedTo: host });

  const mine = statsRepo.playerGames(host, 10);
  assert.equal(mine.length, 1, 'one night, one row');
  assert.equal(mine[0].charged, 30, 'and it is what THEY were charged');

  // The guest's own list still has it — they played it.
  assert.equal(statsRepo.playerGames(visitor, 10).length, 1);

  // And the record, which has always keyed on player_id, agrees.
  assert.equal(statsRepo.matchRecord(host).games, 1);
});

// ---------------------------------------------------------------------------
// One record, two people.

test('a name already on the roster is refused, whichever end it comes from', () => {
  playersRepo.create({ name: 'Dinesh' });
  assert.throws(() => playersRepo.create({ name: 'dinesh' }), /cannot tell the two apart/,
    'case is not a distinction a team sheet can make');
  assert.throws(() => playersRepo.create({ name: ' Dinesh ' }), /cannot tell the two apart/);
  // Renaming onto an existing name is the same hazard from the other end.
  const other = playersRepo.create({ name: 'Ganesh' });
  assert.throws(() => playersRepo.update(other.id, { name: 'Dinesh' }), /already how/);
  assert.throws(() => playersRepo.update(other.id, { aliases: ['Dinesh'] }), /already how/,
    'an alias resolves a token just as a name does');
  // And renaming somebody to what they are already called is not a clash.
  assert.equal(playersRepo.update(other.id, { name: 'Ganesh' }).name, 'Ganesh');
  // Deliberate duplicates stay possible for a caller that means it.
  const twin = playersRepo.create({ name: 'Dinesh', allowDuplicateName: true });
  assert.equal(playersRepo.nameCollisions().filter(c => c.name === 'dinesh').length, 1,
    'and then it is reported rather than hidden');
  playersRepo.delete(twin.id);
});

test('splitting one record into two moves games without moving money', () => {
  // The club has two men called Rohit. Every "Rohit" in a pasted sheet went to
  // whichever record matched first, so one person's games landed on the other.
  const one = playersRepo.create({ name: 'Rohit' });
  db.prepare('UPDATE ledgers SET opening_balance = 300 WHERE player_id = ? AND contract_id = ?')
    .run(one.id, CONTRACT);
  contribute(one.id, 100);
  const gA = game(); const gB = game(); const gC = game();
  const cA = `ch${++seq}`; const cB = `ch${++seq}`; const cC = `ch${++seq}`;
  for (const [cid, gid] of [[cA, gA], [cB, gB], [cC, gC]]) {
    db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,charged_to,paid)
                VALUES (?,?,?,'',0,'',30,?,0)`).run(cid, gid, one.id, one.id);
    // As a real game is: its pot entry already derived from its charges. The
    // split recomputes them, and without this the recompute would be creating
    // entries that had never existed rather than confirming them — which the
    // guard correctly refuses.
    gameweeksRepo.recomputeGameKitty(gid);
  }
  const before = balanceOf(one.id);
  const kittyBefore = kittyRepo.balance().balance;
  assert.equal(before, 310, '300 opening + 100 in − 3 games at 30');

  const { created } = playersRepo.splitInto(one.id, {
    name: 'Rohit K', chargeIds: [cB, cC],
  });

  assert.equal(balanceOf(one.id), 370, 'kept the opening, the payment and one game');
  assert.equal(balanceOf(created.id), -60, 'took two games and nothing else');
  assert.equal(round2(balanceOf(one.id) + balanceOf(created.id)), before,
    'a split reassigns; it never creates or destroys');
  assert.equal(kittyRepo.balance().balance, kittyBefore, 'and the pot is untouched');
  assert.equal(playersRepo.nameCollisions().filter(c => c.name === 'rohit').length, 0,
    'the two are now distinguishable in a team sheet');
});

test('a guest added to a recorded game is priced as a guest, not at nothing', () => {
  // Every other route works the rate out from the player — Game Day on the
  // night, the parser server-side. Adding somebody to a game already
  // recorded relied on the caller sending an amount, and defaulted to 0 and
  // "manual", so a walk-up added that way was charged nothing at all.
  db.prepare(`UPDATE contracts SET rates = '{"contracted_10":30,"contracted_12":27,
    "captain_10":25,"captain_12":20,"noncontract":35}' WHERE id = ?`).run(CONTRACT);
  const g = game();
  const walkup = player('Added walk-up');
  makeOutside(walkup);
  const member = player('Added member', 500);

  gameweeksRepo.addCharge(g, { player_id: walkup, team: 'Red' });
  gameweeksRepo.addCharge(g, { player_id: member, team: 'Blue' });
  const charges = gameweeksRepo.get(g).charges;
  const of = (pid) => charges.find(c => c.player_id === pid);
  assert.equal(of(walkup).amount, 35, 'the guest rate');
  assert.equal(of(walkup).rate_type, 'noncontract');
  assert.equal(of(member).amount, 30, 'and the contract rate for a member');
  assert.equal(of(member).rate_type, 'contracted_10');

  // A captain gets the captain rate.
  const capt = player('Added captain', 500);
  gameweeksRepo.addCharge(g, { player_id: capt, team: 'Blue', is_captain: true });
  assert.equal(gameweeksRepo.get(g).charges.find(c => c.player_id === capt).amount, 25);

  // An explicit 0 still records the appearance without charging — a real
  // thing somebody asks for, and it must survive the defaulting.
  const free = player('Played for nothing', 500);
  gameweeksRepo.addCharge(g, { player_id: free, team: 'Red', amount: 0 });
  assert.equal(gameweeksRepo.get(g).charges.find(c => c.player_id === free).amount, 0);
  assert.equal(balanceOf(free), 500);

  // A guest with a rate agreed with them beats the card.
  const agreed = player('Agreed 50');
  makeOutside(agreed);
  db.prepare('UPDATE players SET outside_cost = 50 WHERE id = ?').run(agreed);
  gameweeksRepo.addCharge(g, { player_id: agreed, team: 'Red' });
  assert.equal(gameweeksRepo.get(g).charges.find(c => c.player_id === agreed).amount, 50);
});

test('two players can be added to a game back to back', () => {
  // Same millisecond-as-a-key fault the audit rows had. Adding two people to
  // a game is well inside one millisecond, and the second insert would die on
  // a UNIQUE violation. Clock frozen so the collision is certain rather than
  // a race the test might win.
  const g = game();
  const a = player('Added one', 100);
  const b = player('Added two', 100);
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_001;
  try {
    gameweeksRepo.addCharge(g, { player_id: a, amount: 30 });
    gameweeksRepo.addCharge(g, { player_id: b, amount: 30 });
  } finally {
    Date.now = realNow;
  }
  assert.equal(balanceOf(a), 70);
  assert.equal(balanceOf(b), 70);
});

test('a shortfall can be covered out of the same person\'s other balance', () => {
  // Six people are in the red on one night while holding more than that on
  // the other. Chasing them is chasing money the club already has.
  const other = 'testc4';
  db.prepare(`INSERT OR IGNORE INTO contracts (id,name,rates,cost_per_gw,sort)
              VALUES (?,'Other night','{}',0,4)`).run(other);
  const p = player('Rich here, short there', 400);
  ledgersRepo.ensure(p, other);
  const g = game();
  db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,charged_to,paid)
              VALUES (?,?,?,'',0,'',64,?,0)`).run(`ch${++seq}`, g, p, p);
  db.prepare('UPDATE charges SET settle_contract_id = ? WHERE gameweek_id = ?').run(other, g);
  assert.equal(ledgersRepo.get(p, other).present_balance, -64);
  assert.equal(ledgersRepo.get(p, CONTRACT).present_balance, 400);
  const total = round2(ledgersRepo.forPlayer(p).reduce((s, l) => s + l.present_balance, 0));

  const out = ledgersRepo.coverFromOtherContract(p,
    { from: CONTRACT, to: other, amount: 64 });

  assert.equal(ledgersRepo.get(p, other).present_balance, 0, 'square on the night they owed');
  assert.equal(ledgersRepo.get(p, CONTRACT).present_balance, 336, 'taken from where it was');
  assert.equal(round2(ledgersRepo.forPlayer(p).reduce((s, l) => s + l.present_balance, 0)),
    total, 'the same money, in the other pocket — the total cannot move');

  // Undoing puts both legs back.
  ledgersRepo.undoCover(out.id);
  assert.equal(ledgersRepo.get(p, other).present_balance, -64);
  assert.equal(ledgersRepo.get(p, CONTRACT).present_balance, 400);
});

test('covering refuses what the other balance cannot pay for', () => {
  const other = 'testc5';
  db.prepare(`INSERT OR IGNORE INTO contracts (id,name,rates,cost_per_gw,sort)
              VALUES (?,'Nowhere','{}',0,5)`).run(other);
  const p = player('Short everywhere', 10);
  ledgersRepo.ensure(p, other);
  assert.throws(() => ledgersRepo.coverFromOtherContract(p,
    { from: CONTRACT, to: other, amount: 64 }), /only has 10/);
  assert.equal(ledgersRepo.get(p, CONTRACT).present_balance, 10, 'and nothing moved');
  assert.throws(() => ledgersRepo.coverFromOtherContract(p,
    { from: CONTRACT, to: CONTRACT, amount: 5 }), /the other contract/);
  assert.throws(() => ledgersRepo.coverFromOtherContract(p,
    { from: CONTRACT, to: other, amount: 0 }), /Nothing to cover/);
  assert.throws(() => ledgersRepo.coverFromOtherContract(p,
    { from: CONTRACT, to: 'nope', amount: 5 }), /No such contract/);
});

test('the unpaid nights behind a cash debt are listed, not just counted', () => {
  const g1 = game(); const g2 = game();
  const walkup = player('Owes for two');
  makeOutside(walkup);
  charge(g1, walkup, 35);
  charge(g2, walkup, 40);
  const nights = ledgersRepo.cashOutstandingGames(CONTRACT)
    .filter(r => r.player_id === walkup);
  assert.equal(nights.length, 2, 'both nights, not a count of two');
  assert.deepEqual(nights.map(n => n.amount).sort((a, b) => a - b), [35, 40]);
  // Settling one takes it off the list.
  db.prepare('UPDATE charges SET paid = 1 WHERE gameweek_id = ? AND player_id = ?')
    .run(g1, walkup);
  assert.equal(ledgersRepo.cashOutstandingGames(CONTRACT)
    .filter(r => r.player_id === walkup).length, 1);
});

test('moving somebody to the guest list is free when it moves nothing', () => {
  // The ordinary case, and the one this exists for: a walk-up sitting in the
  // ledger at zero who was never a member.
  const p = playersRepo.create({ name: 'Turns up sometimes' });
  assert.equal(playersRepo.setKind(p.id, 'outside').player_type, 'outside');
  assert.equal(playersRepo.setKind(p.id, 'regular').player_type, 'regular', 'and back again');
  // Somebody whose games were all cash already: also free, because nothing
  // about how they settle changes.
  const c = playersRepo.create({ name: 'Always pays cash' });
  const g = game();
  db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,charged_to,settles_cash,paid)
              VALUES (?,?,?,'',0,'noncontract',35,?,1,1)`).run(`ch${++seq}`, g, c.id, c.id);
  gameweeksRepo.recomputeGameKitty(g);
  assert.equal(playersRepo.setKind(c.id, 'outside').player_type, 'outside');
});

test('it is refused when it would turn paid football into a debt', () => {
  // Whether a charge is cash is read from the settler's KIND, so making a
  // member a guest retrospectively converts every game they settled off a
  // balance into cash they owe — their balance jumps and they become a
  // debtor for football they have already paid for.
  const p = playersRepo.create({ name: 'Proper member' });
  db.prepare('UPDATE ledgers SET opening_balance = 200 WHERE player_id = ? AND contract_id = ?')
    .run(p.id, CONTRACT);
  const g = game();
  db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,charged_to,paid)
              VALUES (?,?,?,'',0,'contracted_12',30,?,0)`).run(`ch${++seq}`, g, p.id, p.id);
  gameweeksRepo.recomputeGameKitty(g);
  assert.equal(balanceOf(p.id), 170);
  const kitty = kittyRepo.balance().balance;

  assert.throws(() => playersRepo.setKind(p.id, 'outside'),
    /30 of football settled off a balance/);
  assert.equal(balanceOf(p.id), 170, 'balance untouched');
  assert.equal(kittyRepo.balance().balance, kitty, 'pot untouched');
  assert.equal(playersRepo.get(p.id).player_type, 'regular', 'and they are still a member');

  // The cashier can never be a guest — they fund the contracts.
  const cash = playersRepo.create({ name: 'The money' });
  playersRepo.update(cash.id, { special_role: 'cashier' });
  assert.throws(() => playersRepo.setKind(cash.id, 'outside'), /cannot be a guest/);
});

test('the second person can be a guest, which is the usual reason there are two', () => {
  // The club's second Rohit is a walk-up who pays cash and happens to share a
  // name with a member. Without saying so in the split, it produced another
  // member and the guest had to be made by hand afterwards — which is where
  // the games get left behind.
  const one = playersRepo.create({ name: 'Sunil' });
  const g1 = game(); const g2 = game();
  const mine = `ch${++seq}`; const theirs = `ch${++seq}`;
  // Both already settled in cash, which is what a walk-up's games look like.
  db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,charged_to,settles_cash,paid)
              VALUES (?,?,?,'',0,'noncontract',35,?,1,1)`).run(mine, g1, one.id, one.id);
  db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,charged_to,settles_cash,paid)
              VALUES (?,?,?,'',0,'noncontract',35,?,1,1)`).run(theirs, g2, one.id, one.id);
  for (const g of [g1, g2]) gameweeksRepo.recomputeGameKitty(g);

  const { created } = playersRepo.splitInto(one.id, {
    name: 'Sunil 2', chargeIds: [theirs], playerType: 'outside',
  });
  assert.equal(playersRepo.get(created.id).player_type, 'outside', 'a guest, as asked');
  assert.equal(statsRepo.playerGames(created.id, 5).length, 1, 'with their game');
  assert.equal(statsRepo.playerGames(one.id, 5).length, 1, 'and the member keeps theirs');
});

test('turning a balance-funded game into a guest game is refused, and says why', () => {
  // A guest keeps no balance, so a game that came off one becomes cash they
  // owe. That is a real change and a legitimate one — but it is a change of
  // SETTLEMENT, which belongs on the game, not hidden inside renaming people.
  const one = playersRepo.create({ name: 'Pradeep', aliases: [] });
  db.prepare('UPDATE ledgers SET opening_balance = 200 WHERE player_id = ? AND contract_id = ?')
    .run(one.id, CONTRACT);
  const g = game();
  const c = `ch${++seq}`;
  db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,charged_to,paid)
              VALUES (?,?,?,'',0,'contracted_12',30,?,0)`).run(c, g, one.id, one.id);
  gameweeksRepo.recomputeGameKitty(g);
  assert.equal(balanceOf(one.id), 170);

  assert.throws(() => playersRepo.splitInto(one.id,
    { name: 'Pradeep 2', chargeIds: [c], playerType: 'outside' }),
  /switch it to cash on the game first/);
  assert.equal(balanceOf(one.id), 170, 'and nothing moved');
  assert.ok(!playersRepo.get('pradeep_2'), 'nor was the record left behind');
});

test('a split that would move money is refused whole', () => {
  const p = playersRepo.create({ name: 'Unsplittable' });
  const other = playersRepo.create({ name: 'Somebody Else Entirely' });
  const g = game();
  const mine = `ch${++seq}`; const theirs = `ch${++seq}`;
  db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,charged_to,paid)
              VALUES (?,?,?,'',0,'',30,?,0)`).run(mine, g, p.id, p.id);
  db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,charged_to,paid)
              VALUES (?,?,?,'',0,'',30,?,0)`).run(theirs, g, other.id, other.id);

  // Reaching into somebody else's charge through the selection.
  assert.throws(() => playersRepo.splitInto(p.id, { name: 'Thief', chargeIds: [theirs] }),
    /not Unsplittable's to move/);
  assert.equal(balanceOf(other.id), -30, 'and their charge stayed where it was');
  assert.ok(!playersRepo.get('thief'), 'no new record was created');

  // A name that cannot be told apart from the original.
  assert.throws(() => playersRepo.splitInto(p.id, { name: 'Unsplittable', chargeIds: [mine] }),
    /indistinguishable/);
  // Nothing selected is not a split.
  assert.throws(() => playersRepo.splitInto(p.id, { name: 'Nobody' }), /Nothing selected/);
});

process.on('exit', () => {
  try { fs.rmSync(path.dirname(scratch), { recursive: true, force: true }); } catch { /* temp dir */ }
});
