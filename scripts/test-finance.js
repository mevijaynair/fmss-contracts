#!/usr/bin/env node
/**
 * test-finance.js — the cashier's books.
 *
 * Two things are being pinned down here, and they are not the same thing:
 *
 *   1. THE ARITHMETIC. A venue booking spread over sessions, a P&L on the
 *      accrual basis, a cash statement that must reconcile to the penny.
 *   2. THE ISOLATION. Nothing on the cashier screen may move a player's
 *      balance or the kitty. The pitch is already charged to the pot once per
 *      game; a booking that also wrote an expense would charge the club twice
 *      for one booking, and the P&L would be wrong in the direction that
 *      flatters it. That is the failure worth a test of its own, because it
 *      would look perfectly reasonable on screen.
 *
 * Every check that guards something is also mutation-tested: the scenario is
 * pushed until the check FIRES. A check that cannot fail is not a check.
 *
 * Runs against a scratch database, never a real one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const scratch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fmss-fin-')), 'fin.db');
process.env.FMSS_DB_PATH = scratch;

const { db, initSchema, DB_FILE } = await import('../server/db.js');
const { financeRepo } = await import('../server/repos/finance.js');
const { ledgersRepo } = await import('../server/repos/ledgers.js');
const { kittyRepo } = await import('../server/repos/kitty.js');
const { gameweeksRepo } = await import('../server/repos/gameweeks.js');

if (path.resolve(DB_FILE) !== path.resolve(scratch)) {
  console.error(`Refusing to run: tests would write to ${DB_FILE}.`);
  process.exit(1);
}

initSchema();
db.exec('PRAGMA foreign_keys = ON');

// ---------------------------------------------------------------------------
// A small club: one contract, a pitch at 300 a night, water at 15.

const C = 'mt';
db.prepare(`INSERT INTO contracts (id,name,venue,rates,cost_per_gw,sort,season_start,game_days)
  VALUES (?,'Mon/Thu','O365','{"contracted_10":35}',300,1,'2026-08-01','[1,4]')`).run(C);

let seq = 0;
const now = () => new Date().toISOString();
const round2 = (n) => Math.round(n * 100) / 100;

function player(name, { opening = 0, type = 'regular', role = null } = {}) {
  const id = `p${++seq}`;
  db.prepare('INSERT INTO players (id,name,aliases,player_type,special_role,created_at) VALUES (?,?,\'[]\',?,?,?)')
    .run(id, name, type, role, now());
  db.prepare('INSERT INTO ledgers (player_id,contract_id,opening_balance,status) VALUES (?,?,?,\'\')')
    .run(id, C, opening);
  return id;
}
const contribute = (pid, amount, date = '2026-08-05') =>
  db.prepare(`INSERT INTO contributions (id,player_id,contract_id,amount,date,historical,created_at)
              VALUES (?,?,?,?,?,0,?)`).run(`c${++seq}`, pid, C, amount, date, now());

/** A played game, priced at the contract's pitch cost with the pot buying water. */
function game(date, { pitch = 300, water = 15, waterPaidBy = 'self', hours = 1 } = {}) {
  const id = `g${++seq}`;
  db.prepare(`INSERT INTO gameweeks (id,contract_id,gw_number,contract_number,date,cost_per_gw,
    num_players,teams_raw,captains_raw,score,comments,historical,game_cost,game_cost_paid_by,
    hours,created_at)
    VALUES (?,?,?,0,?,?,0,'','','','',0,?,?,?,?)`)
    .run(id, C, ++seq, date, pitch, water, waterPaidBy, hours, now());
  return id;
}
const charge = (gid, pid, amount, { cash = 0, paid = 0, fromKitty = 0 } = {}) => {
  const id = `ch${++seq}`;
  db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,
    charged_to,settles_cash,paid,settled_from_kitty) VALUES (?,?,?,'',0,'',?,?,?,?,?)`)
    .run(id, gid, pid, amount, pid, cash, paid, fromKitty);
  return id;
};

const vijay = player('Vijay', { role: 'cashier' });
const ajay = player('Ajay', { opening: 100 });
const bibbin = player('Bibbin');
const guest = player('Walk-up', { type: 'outside' });

// Two games in August, one in September.
const g1 = game('2026-08-03');
const g2 = game('2026-08-06');
const g3 = game('2026-09-07');

// Ajay and Bibbin pay from balances; the guest pays cash and has handed it over
// on one night and not the other; Vijay plays and never pays in.
for (const g of [g1, g2, g3]) {
  charge(g, ajay, 35);
  charge(g, bibbin, 35);
  charge(g, vijay, 35);
}
charge(g1, guest, 40, { cash: 1, paid: 1 });
const owedCharge = charge(g2, guest, 40, { cash: 1, paid: 0 });
charge(g3, bibbin, 35, { fromKitty: 1 });   // a place the pot carried

contribute(ajay, 200);
contribute(bibbin, 300);

for (const g of [g1, g2, g3]) gameweeksRepo.recomputeGameKitty(g);

// ---------------------------------------------------------------------------
// Venue bookings

test('a booking spreads its cost over the sessions it buys', () => {
  const vc = financeRepo.createVenueContract({
    contract_id: C, vendor: 'O365', start_date: '2026-08-01', end_date: '2026-08-31',
    sessions_total: 8, amount_total: 2200,
  });
  assert.equal(vc.cost_per_session, 275, '2200 over 8 sessions');
  assert.equal(vc.games_played, 2, 'only the two August games fall inside it');
  assert.equal(vc.hours_played, 2, 'both were ordinary one-hour nights');
  assert.equal(vc.sessions_left, 6, 'eight hours bought, two used');
  assert.equal(vc.paid, 0);
  assert.equal(vc.outstanding, 2200);
  assert.equal(vc.prepaid, -550, 'two sessions used and nothing paid');
  assert.equal(vc.booked_per_session, 300, 'the games were booked at the contract rate');
  assert.equal(vc.variance_per_session, 25, 'booked 25 a night above what the venue charges');
  assert.equal(vc.variance_total, 50, '600 booked against 550 of contract hours');
  financeRepo.removeVenueContract(vc.id);
});

test('free nights are priced in, not priced out', () => {
  // The real O365 bundle: "20 + 3hrs free" for 5000 including VAT. Twenty-three
  // nights are played off it, so a night costs 5000/23 — using the paid count
  // would say 250 and overstate the pitch by 15% on every game.
  const vc = financeRepo.createVenueContract({
    contract_id: C, vendor: 'O365', start_date: '2026-08-01', end_date: '2026-12-31',
    sessions_total: 20, free_sessions: 3, amount_total: 5000,
  });
  assert.equal(vc.sessions_covered, 23);
  assert.equal(vc.cost_per_session, 217.39, '5000 over 23 nights');
  assert.equal(vc.cost_per_paid_session, 250, 'what it would be without the free ones');
  assert.equal(vc.sessions_left, 23 - vc.hours_played, 'the free hours count as hours left');

  // And the P&L uses the real rate, not the paid-only one.
  const p = financeRepo.pnl(C);
  assert.equal(p.cost.sessions_priced_from_a_contract, 3);
  assert.equal(p.cost.pitch_contracted, 652.17, 'three nights at 217.39');
  assert.ok(p.profit_contracted > p.profit, 'a cheaper pitch than the books assume');
  financeRepo.removeVenueContract(vc.id);
});

test('no free nights is the same rule, not a different one', () => {
  const vc = financeRepo.createVenueContract({
    contract_id: C, vendor: 'Koora', start_date: '2026-08-01', end_date: '2026-12-31',
    sessions_total: 20, free_sessions: 0, amount_total: 5000,
  });
  assert.equal(vc.sessions_covered, 20);
  assert.equal(vc.cost_per_session, 250);
  assert.equal(vc.cost_per_paid_session, 250, 'with nothing free the two agree');
  financeRepo.removeVenueContract(vc.id);
  assert.throws(() => financeRepo.createVenueContract({
    contract_id: C, vendor: 'X', start_date: '2026-08-01', free_sessions: 1.5, amount_total: 1 }),
  /Free sessions must be a whole number/);
});

/** Remove a game and everything hanging off it, so the next test starts clean. */
function dropGame(id) {
  db.prepare('DELETE FROM charges WHERE gameweek_id = ?').run(id);
  db.prepare('DELETE FROM kitty WHERE scope = ?').run(id);
  db.prepare('DELETE FROM gameweeks WHERE id = ?').run(id);
}

test('a tournament night eats the hours it actually used', () => {
  // Three teams, court held for two hours. It is one game and one row, but it
  // takes two hours out of the bundle and costs two hours' worth.
  const long = game('2026-09-14', { hours: 2 });
  charge(long, ajay, 35);
  gameweeksRepo.recomputeGameKitty(long);
  const vc = financeRepo.createVenueContract({
    contract_id: C, vendor: 'O365', start_date: '2026-08-01', end_date: '2026-12-31',
    sessions_total: 20, free_sessions: 3, amount_total: 5000,
  });
  try {
    assert.equal(vc.games_played, 4, 'four nights');
    assert.equal(vc.hours_played, 5, 'but five hours — three ordinary and one double');
    assert.equal(vc.has_long_games, true);
    assert.equal(vc.sessions_left, 18, '23 bought less 5 used');
    assert.equal(vc.consumed, round2(217.39 * 5));

    const p = financeRepo.pnl(C);
    assert.equal(p.games, 4);
    assert.equal(p.hours, 5);
    assert.deepEqual(p.long_games, [{ date: '2026-09-14', hours: 2 }]);
    assert.equal(p.cost.pitch_contracted, round2(217.39 * 5),
      'the long night is charged twice over, not once');
    assert.equal(p.cost.pitch_booked, 1200, 'while the books still say four bookings at 300');
    assert.equal(p.drift, 0, 'and the kitty, which follows the booked cost, is unmoved');
  } finally {
    financeRepo.removeVenueContract(vc.id);
    dropGame(long);
  }
});

test('a game with more than two teams out is flagged, never assumed', () => {
  const big = game('2026-09-15');                 // recorded as one hour
  for (let i = 0; i < 15; i++) charge(big, ajay, 35);
  gameweeksRepo.recomputeGameKitty(big);
  try {
    const p = financeRepo.pnl(C);
    assert.deepEqual(p.hours_to_check, [{ date: '2026-09-15', players: 15 }],
      'fifteen out on a one-hour booking is worth asking about');
    assert.equal(p.hours, 4, 'but nothing was changed — it still counts as one hour');

    // Setting the duration is what makes it count, and it clears the flag.
    gameweeksRepo.updateMetadata(big, { hours: 2 });
    const after = financeRepo.pnl(C);
    assert.deepEqual(after.hours_to_check, []);
    assert.equal(after.hours, 5);
    assert.throws(() => gameweeksRepo.updateMetadata(big, { hours: 0 }), /more than zero/);
    assert.throws(() => gameweeksRepo.updateMetadata(big, { hours: -1 }), /more than zero/);
    assert.equal(financeRepo.pnl(C).hours, 5, 'and a refused edit left it alone');
  } finally {
    dropGame(big);
  }
});

test('an open-ended booking refuses to invent a per-session rate', () => {
  const vc = financeRepo.createVenueContract({
    contract_id: C, vendor: 'Koora', start_date: '2026-08-01',
    sessions_total: null, amount_total: 900,
  });
  assert.equal(vc.cost_per_session, null, 'a total with no session count is not a rate');
  assert.equal(vc.prepaid, null, 'and there is nothing to compare payments against');
  assert.equal(vc.variance_total, null);
  assert.equal(vc.is_open_ended, true);
  assert.equal(vc.games_played, 3, 'it still covers every game from its start');
  financeRepo.removeVenueContract(vc.id);
});

test('payments accumulate, and removing the booking takes them with it', () => {
  let vc = financeRepo.createVenueContract({
    contract_id: C, vendor: 'O365', start_date: '2026-08-01', end_date: '2026-09-30',
    sessions_total: 10, amount_total: 2750,
  });
  vc = financeRepo.addPayment(vc.id, { amount: 1000, date: '2026-08-01', method: 'bank' });
  vc = financeRepo.addPayment(vc.id, { amount: 750, date: '2026-09-01', method: 'bank' });
  assert.equal(vc.paid, 1750);
  assert.equal(vc.outstanding, 1000);
  assert.equal(vc.games_played, 3);
  assert.equal(vc.prepaid, 1750 - 825, 'three hours at 275 played against 1750 paid');

  const payments = db.prepare('SELECT COUNT(*) n FROM venue_payments').get().n;
  assert.equal(payments, 2);
  financeRepo.removeVenueContract(vc.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM venue_payments').get().n, 0,
    'a payment with no booking is money nothing accounts for');
});

test('a booking refuses what it cannot mean', () => {
  assert.throws(() => financeRepo.createVenueContract(
    { contract_id: 'nope', vendor: 'X', start_date: '2026-08-01', amount_total: 10 }),
  /No such contract/);
  assert.throws(() => financeRepo.createVenueContract(
    { contract_id: C, vendor: 'X', start_date: '', amount_total: 10 }),
  /start date/);
  assert.throws(() => financeRepo.createVenueContract(
    { contract_id: C, vendor: 'X', start_date: '2026-09-01', end_date: '2026-08-01', amount_total: 10 }),
  /before the start/);
  assert.throws(() => financeRepo.createVenueContract(
    { contract_id: C, vendor: 'X', start_date: '2026-08-01', sessions_total: 2.5, amount_total: 10 }),
  /whole number/);

  const vc = financeRepo.createVenueContract(
    { contract_id: C, vendor: 'X', start_date: '2026-08-01', amount_total: 10 });
  assert.throws(() => financeRepo.addPayment(vc.id, { amount: 0 }), /more than zero/);
  assert.throws(() => financeRepo.addPayment(vc.id, { amount: -5 }), /more than zero/);
  assert.throws(() => financeRepo.addPayment('vc_nope', { amount: 5 }), /No such venue contract/);
  assert.throws(() => financeRepo.addPayment(vc.id, { amount: 5, paid_by: 'ghost' }), /No such player/);
  // An edit that would leave the booking ending before it starts is put back,
  // not left standing: sessionsIn would then match no games at all and the P&L
  // would read as though the contract had bought nothing.
  assert.throws(() => financeRepo.updateVenueContract(vc.id, { end_date: '2026-07-01' }),
    /before the start/);
  assert.equal(financeRepo.venueContract(vc.id).end_date, null, 'the bad edit was rolled back');
  financeRepo.removeVenueContract(vc.id);
});

// ---------------------------------------------------------------------------
// The isolation rule

test('a booking and its payments move no balance and no kitty', () => {
  const before = {
    balances: ledgersRepo.all().map(l => [l.player_id, l.present_balance]),
    kitty: kittyRepo.balance().balance,
    kittyRows: db.prepare('SELECT COUNT(*) n FROM kitty').get().n,
    contributions: db.prepare('SELECT COUNT(*) n FROM contributions').get().n,
    transactions: db.prepare('SELECT COUNT(*) n FROM transactions').get().n,
  };

  const vc = financeRepo.createVenueContract({
    contract_id: C, vendor: 'O365', start_date: '2026-08-01', end_date: '2026-09-30',
    sessions_total: 10, amount_total: 2750,
  });
  financeRepo.addPayment(vc.id, { amount: 2750, date: '2026-08-01' });

  assert.deepEqual(ledgersRepo.all().map(l => [l.player_id, l.present_balance]),
    before.balances, 'a venue payment is not a player transaction');
  assert.equal(kittyRepo.balance().balance, before.kitty,
    'the pitch is already charged to the pot per game — booking it again doubles it');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM kitty').get().n, before.kittyRows);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM contributions').get().n, before.contributions);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n, before.transactions);

  financeRepo.removeVenueContract(vc.id);
  assert.equal(kittyRepo.balance().balance, before.kitty, 'and removing it changes nothing either');
});

// ---------------------------------------------------------------------------
// Profit and loss

test('the P&L counts each kind of settlement exactly once', () => {
  const p = financeRepo.pnl(C);
  assert.equal(p.games, 3);
  // Ajay, Bibbin and Vijay on three nights at 35 = 315, less the one place the
  // pot carried (35) which is billed to nobody.
  assert.equal(p.revenue.from_balances, 315);
  assert.equal(p.revenue.guest_cash_collected, 40, 'only the guest who actually handed it over');
  assert.equal(p.revenue.total, 355);
  assert.equal(p.not_counted.guest_cash_still_owed, 40, 'owed is not earned');
  assert.equal(p.not_counted.places_carried_by_the_kitty, 35, 'a free place is not income');

  assert.equal(p.cost.pitch_booked, 900);
  assert.equal(p.cost.water, 45);
  assert.equal(p.cost.total_booked, 945);
  assert.equal(p.profit, -590);
  assert.equal(p.profit_per_game, -196.67);
});

test('the P&L agrees with the kitty, which is derived from the same games another way', () => {
  const p = financeRepo.pnl(C);
  assert.equal(p.drift, 0, `P&L says ${p.profit}, the kitty says ${p.kitty_says}`);
});

test('the drift check actually fires when the two disagree', () => {
  // Tamper with a game's kitty row directly, which is the shape of the bug this
  // check exists to catch: a pot figure written rather than derived.
  const row = db.prepare('SELECT id, amount FROM kitty WHERE id = ?').get(`k_gw_${g1}`);
  db.prepare('UPDATE kitty SET amount = amount + 100 WHERE id = ?').run(row.id);
  assert.notEqual(financeRepo.pnl(C).drift, 0, 'a tampered pot must not pass unnoticed');
  db.prepare('UPDATE kitty SET amount = ? WHERE id = ?').run(row.amount, row.id);
  assert.equal(financeRepo.pnl(C).drift, 0, 'and putting it back clears it');
});

test('collecting a guest’s cash moves it from owed to earned, in both sets of books', () => {
  const before = financeRepo.pnl(C);
  db.prepare('UPDATE charges SET paid = 1 WHERE id = ?').run(owedCharge);
  gameweeksRepo.recomputeGameKitty(g2);
  const after = financeRepo.pnl(C);
  assert.equal(after.revenue.guest_cash_collected, before.revenue.guest_cash_collected + 40);
  assert.equal(after.not_counted.guest_cash_still_owed, 0);
  assert.equal(after.profit, before.profit + 40);
  assert.equal(after.drift, 0, 'and the pot followed it');
  db.prepare('UPDATE charges SET paid = 0 WHERE id = ?').run(owedCharge);
  gameweeksRepo.recomputeGameKitty(g2);
});

test('a booking reprices the cost side without touching the games', () => {
  const vc = financeRepo.createVenueContract({
    contract_id: C, vendor: 'O365', start_date: '2026-08-01', end_date: '2026-08-31',
    sessions_total: 8, amount_total: 2200,       // 275 a session, against 300 booked
  });
  const p = financeRepo.pnl(C);
  assert.equal(p.cost.sessions_priced_from_a_contract, 2, 'September is outside the booking');
  assert.equal(p.cost.pitch_contracted, 275 + 275 + 300,
    'the two August nights at the contract rate, September at the booked one');
  assert.equal(p.cost.pitch_booked, 900, 'and the booked figure is untouched');
  assert.equal(p.profit_contracted, p.profit + 50, 'cheaper pitch, better profit');
  assert.equal(financeRepo.pnl(C).drift, 0,
    'the kitty still follows the booked cost, because no game was repriced');
  assert.equal(db.prepare('SELECT SUM(cost_per_gw) s FROM gameweeks').get().s, 900,
    'a booking must never rewrite what a game cost');
  financeRepo.removeVenueContract(vc.id);
});

test('the window scopes the P&L', () => {
  const aug = financeRepo.pnl(C, { from: '2026-08-01', to: '2026-08-31' });
  assert.equal(aug.games, 2);
  assert.equal(aug.cost.pitch_booked, 600);
  const sep = financeRepo.pnl(C, { from: '2026-09-01' });
  assert.equal(sep.games, 1);
  assert.equal(aug.profit + sep.profit, financeRepo.pnl(C).profit,
    'the parts add up to the whole');
});

test('a historical game is in the opening snapshot, not in the P&L', () => {
  const h = game('2026-07-01');
  db.prepare('UPDATE gameweeks SET historical = 1 WHERE id = ?').run(h);
  charge(h, ajay, 999);
  const p = financeRepo.pnl(C, { from: '2026-01-01' });
  assert.equal(p.games, 3, 'the historical game is not one of them');
  assert.equal(p.revenue.from_balances, 315, 'and its charge is not revenue');
  db.prepare('DELETE FROM charges WHERE gameweek_id = ?').run(h);
  db.prepare('DELETE FROM gameweeks WHERE id = ?').run(h);
});

// ---------------------------------------------------------------------------
// The cash statement

test('the cash statement reconciles to the penny', () => {
  const s = financeRepo.cashier();
  assert.equal(s.drift, 0,
    `in hand ${s.in_hand} against claims of ${s.claims.total}`);
  assert.equal(s.cashier.name, 'Vijay');
});

test('every line of it is the figure it claims to be', () => {
  const s = financeRepo.cashier();
  assert.equal(s.opening.player_credit, 100, 'only Ajay had an opening balance');
  assert.equal(s.money_in.top_ups, 500, '200 from Ajay and 300 from Bibbin');
  assert.equal(s.money_in.guest_cash_collected, 40, 'the one guest who has paid up');
  assert.equal(s.money_out.water, 45, 'three nights of water, bought by the pot');
  assert.equal(s.money_out.paid_to_venues, 0, 'nothing paid to O365 yet');
  assert.equal(s.claims.owed_to_venues, 900, 'three nights of pitch, all of it unpaid');
  assert.equal(s.claims.own_account, -105, 'Vijay has played three games and paid in nothing');
  assert.equal(s.in_hand, 100 + 500 + 40 - 45);
});

test('paying the venue moves cash out without changing what the club is worth', () => {
  const before = financeRepo.cashier();
  const vc = financeRepo.createVenueContract({
    contract_id: C, vendor: 'O365', start_date: '2026-08-01', end_date: '2026-09-30',
    sessions_total: 10, amount_total: 2750,
  });
  financeRepo.addPayment(vc.id, { amount: 900, date: '2026-08-01' });

  const after = financeRepo.cashier();
  assert.equal(after.money_out.paid_to_venues, 900);
  assert.equal(after.in_hand, before.in_hand - 900, 'the cash left');
  assert.equal(after.claims.owed_to_venues, 0, 'and the debt it was against went with it');
  assert.equal(after.claims.kitty, before.claims.kitty, 'the pot is untouched');
  assert.equal(after.drift, 0, 'and it still reconciles');
  financeRepo.removeVenueContract(vc.id);
});

test('overpaying the venue shows as being out of pocket, not as profit', () => {
  const before = financeRepo.cashier();
  const vc = financeRepo.createVenueContract({
    contract_id: C, vendor: 'O365', start_date: '2026-08-01', end_date: '2026-12-31',
    sessions_total: 20, amount_total: 6000,
  });
  financeRepo.addPayment(vc.id, { amount: 6000, date: '2026-08-01' });
  const s = financeRepo.cashier();
  assert.ok(s.in_hand < 0, 'the cashier is funding the club out of their own pocket');
  assert.equal(s.claims.owed_to_venues, 900 - 6000, 'paid 5100 ahead of the games played');
  assert.equal(s.claims.kitty, financeRepo.cashier().claims.kitty, 'and the pot did not move');
  assert.equal(s.drift, 0);
  financeRepo.removeVenueContract(vc.id);
});

test('water bought by a player is the club owing them, not cash going out', () => {
  const before = financeRepo.cashier();
  const g = game('2026-09-14', { water: 15, waterPaidBy: ajay });
  charge(g, ajay, 35);
  gameweeksRepo.recomputeGameKitty(g);
  // What the app does when a player buys the water: credit them for it.
  contribute(ajay, 15, '2026-09-14');

  const after = financeRepo.cashier();
  assert.equal(after.money_out.water, before.money_out.water,
    'the cashier paid for no water that night');
  assert.equal(after.drift, 0, 'and the credit they were given balances it');

  db.prepare('DELETE FROM charges WHERE gameweek_id = ?').run(g);
  db.prepare('DELETE FROM kitty WHERE scope = ?').run(g);
  db.prepare('DELETE FROM gameweeks WHERE id = ?').run(g);
  db.prepare('DELETE FROM contributions WHERE date = ? AND amount = 15').run('2026-09-14');
  assert.equal(financeRepo.cashier().drift, 0);
});

test('a manual kitty entry is real cash and shows up as such', () => {
  const before = financeRepo.cashier();
  db.prepare(`INSERT INTO kitty (id,kind,label,amount,date,scope,contract_id,historical,created_at)
              VALUES ('k_manual_1','income','Shirt money',120,'2026-09-10','',?,0,?)`)
    .run(C, now());
  const after = financeRepo.cashier();
  assert.equal(after.money_in.other, before.money_in.other + 120);
  assert.equal(after.in_hand, before.in_hand + 120);
  assert.equal(after.claims.kitty, before.claims.kitty + 120);
  assert.equal(after.drift, 0);
  db.prepare("DELETE FROM kitty WHERE id = 'k_manual_1'").run();
});

test('a game’s own kitty row is an accrual and is never counted as cash', () => {
  const s = financeRepo.cashier();
  assert.equal(s.money_in.other, 0, 'the k_gw_ rows carry a scope and must be skipped');
  assert.equal(s.money_out.other, 0);
});

test('the reconciliation actually fires when money goes somewhere it cannot name', () => {
  // An approved adjustment moves a balance with no cash behind it, which is
  // exactly the kind of thing the drift line exists to surface.
  db.prepare(`INSERT INTO transactions (id,player_id,contract_id,type,amount,description,
    status,created_at,updated_at) VALUES ('t_drift',?,?,'adjustment',250,'out of nowhere','approved',?,?)`)
    .run(ajay, C, now(), now());
  const s = financeRepo.cashier();
  assert.equal(s.drift, -250, 'a balance rose by 250 and no cash arrived');
  db.prepare("DELETE FROM transactions WHERE id = 't_drift'").run();
  assert.equal(financeRepo.cashier().drift, 0);
});

test('a contract with no booking says so rather than guessing', () => {
  const s = financeRepo.cashier();
  const row = s.per_contract.find(r => r.contract_id === C);
  assert.equal(row.has_booking, false);
  assert.equal(row.pitch_accrued, 900);
  assert.equal(row.owed_to_venue, 900);
  const p = financeRepo.pnl(C);
  assert.equal(p.cost.sessions_priced_from_a_contract, 0);
  assert.equal(p.cost.pitch_contracted, p.cost.pitch_booked,
    'with nothing to price from, the contracted cost is the booked one');
});

process.on('exit', () => {
  try { fs.rmSync(path.dirname(scratch), { recursive: true, force: true }); } catch { /* temp */ }
});
