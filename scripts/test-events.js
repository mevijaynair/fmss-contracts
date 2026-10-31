#!/usr/bin/env node
/**
 * test-events.js — a whip-round, and where the money for it actually is.
 *
 * A collection is the one thing in this app where the same amount can be in
 * four different places at once: notes in a pocket, a transfer that has
 * landed, a share settled off somebody's contract balance, and a promise. The
 * screen used to report the first three as one number called "cash in", which
 * is the number you cannot act on — at the end of the night somebody has to
 * produce an envelope, and only two of those four are in it.
 *
 * The rule that matters most here is the one the club's profit figure depends
 * on: a share paid off a contract balance costs the club NOTHING. That money
 * was prepaid and is already held. Booking it as a kitty expense would show a
 * loss on a collection that broke even — the same double-count finance.js
 * exists to prevent for venue payments.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

const scratch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fmss-ev-')), 'e.db');
process.env.FMSS_DB_PATH = scratch;

const { db, initSchema, DB_FILE } = await import('../server/db.js');
if (path.resolve(DB_FILE) !== path.resolve(scratch)) {
  console.error('Refusing to run against ' + DB_FILE); process.exit(1);
}
const { externalEventsRepo: ev } = await import('../server/repos/external_events.js');
const { ledgersRepo } = await import('../server/repos/ledgers.js');
const { kittyRepo } = await import('../server/repos/kitty.js');
initSchema();
db.exec('PRAGMA foreign_keys = ON');

const now = new Date().toISOString();
db.prepare(`INSERT INTO contracts (id,name,cost_per_gw)
            VALUES ('sat','Saturdays',300)`).run();

// Four people who can cover their share off a balance, and four who cannot.
const SQUAD = [
  ['alfa', 'Alfa', 500], ['bravo', 'Bravo', 500], ['charlie', 'Charlie', 500],
  ['delta', 'Delta', 500], ['echo', 'Echo', 0], ['foxtrot', 'Foxtrot', 0],
  ['golf', 'Golf', 0], ['hotel', 'Hotel', 0], ['india', 'India', 0],
];
for (const [id, name, opening] of SQUAD) {
  db.prepare('INSERT INTO players (id,name,aliases,created_at) VALUES (?,?,\'[]\',?)')
    .run(id, name, now);
  db.prepare('INSERT INTO ledgers (player_id,contract_id,opening_balance) VALUES (?,?,?)')
    .run(id, 'sat', opening);
}

const balanceOf = (pid) =>
  (ledgersRepo.forPlayer(pid) || []).find(r => r.contract_id === 'sat')?.present_balance ?? 0;

/**
 * Every send-off any test makes, so each one starts from the same eight
 * balances.
 *
 * Without this the debits pile up and the failure lands on whichever test runs
 * fourth rather than on the one that caused it — which is exactly what
 * happened while writing these.
 */
const made = [];
afterEach(() => { while (made.length) ev.deleteEvent(db, made.pop()); });

/** A send-off: eight shares of 100, paid four different ways. */
function sendOff() {
  const e = ev.createEvent(db, null, null, {
    title: 'Send-off', event_type: 'other', event_date: '2026-10-31',
    contract_id: 'sat', budget_amount: 800, tiers: { adult: 100 },
  });
  const add = (p, extra) => ev.addAttendee(db, e.id, { player_id: p, tier: 'adult', ...extra });
  // Off their balance — hands over nothing.
  for (const p of ['alfa', 'bravo', 'charlie', 'delta']) add(p, { pay_method: 'balance' });
  // Notes, in hand.
  for (const p of ['echo', 'foxtrot']) {
    const a = add(p, { pay_method: 'cash', received_via: 'cash' });
    ev.setAttendeePaid(db, a.id, true);
  }
  // A transfer that has landed.
  const g = add('golf', { pay_method: 'cash', received_via: 'bank' });
  ev.setAttendeePaid(db, g.id, true);
  // A transfer that has not, and notes that have been promised but not handed
  // over. Both are "still to come", and they have to be told apart from money
  // that is actually in the room — which is the whole point of the paid flag.
  add('hotel', { pay_method: 'cash', received_via: 'bank' });
  add('india', { pay_method: 'cash', received_via: 'cash' });
  made.push(e.id);
  return e.id;
}

test('the four places the money can be are counted apart', () => {
  const id = sendOff();
  const s = ev.summary(db, id);
  assert.equal(s.headcount, 9);
  assert.equal(s.due_total, 900, 'nine shares of 100');
  assert.equal(s.in_pocket, 200, 'two paid in notes — not the one who promised to');
  assert.equal(s.in_bank, 100, 'one transfer has landed — not the one awaited');
  assert.equal(s.balance_charged, 400, 'four came off balances');
  assert.equal(s.cash_outstanding, 200, 'a transfer awaited and notes promised');
  // The whole of it, and nothing counted twice.
  assert.equal(s.in_pocket + s.in_bank + s.balance_charged + s.cash_outstanding,
    s.due_total, 'the four parts are the whole');
});

test('a bank transfer is not notes in a pocket', () => {
  // The distinction the collector needs and the old summary could not make:
  // both of these are "cash" to the ledger, because neither touches one.
  const id = sendOff();
  const s = ev.summary(db, id);
  assert.notEqual(s.in_pocket, s.cash_collected,
    'the combined figure must not be what either column reports');
  assert.equal(s.cash_collected, s.in_pocket + s.in_bank,
    'and the two still add back up to it');
});

test('a share paid off a balance costs the club nothing', () => {
  // The rule the profit figure depends on. The pot is accrual — what the club
  // earned and spent — and prepaid money it already holds is neither.
  const before = kittyRepo.balance().balance;
  const id = sendOff();
  const s = ev.summary(db, id);

  assert.equal(kittyRepo.balance().balance, before,
    'adding the guest list must not move the pot by itself');
  assert.equal(s.club_supplies, 400,
    'but it must SAY how much cash the club has to produce');

  // Banking the result posts the surplus against the budget, and nothing else.
  // 900 collected against a 900 spend is a break-even, so nothing is posted.
  ev.updateEvent(db, id, { actual_amount: 900 });
  ev.postNetToKitty(db, kittyRepo, id);
  assert.equal(kittyRepo.balance().balance, before,
    'a collection that breaks even leaves the pot exactly where it was');
});

test('only the balance payers are actually debited', () => {
  const id = sendOff();
  assert.equal(balanceOf('alfa'), 400, '500 opening, 100 taken');
  assert.equal(balanceOf('echo'), 0, 'paid in notes — the ledger is untouched');
  assert.equal(balanceOf('golf'), 0, 'paid by transfer — likewise');
  assert.equal(balanceOf('hotel'), 0, 'and owing it changes no balance either');
  assert.equal(ev.getEventTransactions(db, id).length, 4, 'four debits, not nine');
});

test('switching how somebody pays moves the money with them', () => {
  const id = sendOff();
  const alfa = ev.listAttendees(db, id).find(a => a.player_id === 'alfa');

  // Off the balance and into the bank: the debit must go.
  ev.updateAttendee(db, alfa.id, { pay_method: 'cash', received_via: 'bank' });
  assert.equal(balanceOf('alfa'), 500, 'the debit is reversed, not left behind');
  let s = ev.summary(db, id);
  assert.equal(s.balance_charged, 300);
  assert.equal(s.cash_outstanding, 300, 'and it is now a transfer nobody has sent');

  // Mark it in, and it lands in the bank column rather than the pocket.
  ev.setAttendeePaid(db, alfa.id, true);
  s = ev.summary(db, id);
  assert.equal(s.in_bank, 200);
  assert.equal(s.in_pocket, 200, 'the notes are untouched by any of this');

  // And back again.
  ev.updateAttendee(db, alfa.id, { pay_method: 'balance' });
  assert.equal(balanceOf('alfa'), 400, 'charged once, not twice');
  assert.equal(ev.summary(db, id).balance_charged, 400);
});

test('a collection cannot be closed while money is still out', () => {
  const id = sendOff();
  assert.throws(() => ev.close(db, id), /has not come in yet/,
    'Hotel has not sent his transfer');

  for (const who of ['hotel', 'india']) {
    const a = ev.listAttendees(db, id).find(x => x.player_id === who);
    ev.setAttendeePaid(db, a.id, true);
  }
  ev.close(db, id);
  assert.equal(ev.getEvent(db, id).status, 'closed');
});

test('deleting a collection puts every balance back', () => {
  const before = SQUAD.map(([id]) => balanceOf(id));
  const id = sendOff();
  assert.notDeepEqual(SQUAD.map(([p]) => balanceOf(p)), before, 'it did something');
  ev.deleteEvent(db, id);
  assert.deepEqual(SQUAD.map(([p]) => balanceOf(p)), before,
    'and taking it away undoes all of it');
  assert.equal(ev.getEventTransactions(db, id).length, 0);
});

test('an unrecognised way of paying is filed, not refused', () => {
  // This decides which column a figure prints in. A typo in it must never be
  // able to stop a collection being written down.
  const id = sendOff();
  const a = ev.addAttendee(db, id, {
    guest_name: 'Someone', tier: 'adult', pay_method: 'cash', received_via: 'cheque',
  });
  assert.equal(a.received_via, 'cash');
  assert.equal(ev.summary(db, id).cash_outstanding, 300);
});

test.after(() => { try { fs.rmSync(path.dirname(scratch), { recursive: true }); } catch { /* scratch */ } });
