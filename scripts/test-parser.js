#!/usr/bin/env node
/**
 * test-parser.js — who a pasted name resolves to.
 *
 * This is the only place in the app where a human's typing decides whose
 * balance moves. Game Day takes a WhatsApp roster, matches each token to a
 * player, and charges them; a match to the wrong person is money taken off
 * somebody who was not there, and nothing downstream can tell.
 *
 * Nothing covered it until "Rohit2" was found resolving to "Rohit" — a
 * different man, one character away.
 *
 * The rules being held here, all of them learned from a real mis-match:
 *   - a number in a name is a different person, never a typo
 *   - a dropped or inserted letter is a typo (Jeethu/Jeetu)
 *   - a swapped letter is NOT (Nihal/Nihas are two people)
 *   - a short form is a prefix (Tush/Tushar) or an alias (Roji/Rojy)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, matchToken, parseTeams } from '../server/parser.js';

const ROSTER = [
  { id: 'rohit', name: 'Rohit', aliases: [] },
  { id: 'rohit_2', name: 'Rohit 2', aliases: [], player_type: 'outside', outside_cost: 35 },
  { id: 'tushar', name: 'Tushar', aliases: [] },
  { id: 'jeetu', name: 'Jeetu', aliases: [] },
  { id: 'nihas', name: 'Nihas', aliases: [] },
  { id: 'nihal', name: 'Nihal', aliases: [] },
  { id: 'rojy', name: 'Rojy', aliases: ['Roji'] },
  // Rony and Rojy are one swapped letter apart and both play — the roster is
  // only honest about that if both are in it.
  { id: 'rony', name: 'Rony', aliases: [] },
  { id: 'aws_ali', name: 'AWS', aliases: [] },
];
const index = buildIndex(ROSTER);
const who = (token) => matchToken(token, ROSTER, index)?.id ?? null;

test('a number in a name means a different person, typed either way round', () => {
  // The whole reason this file exists. A roster is split on whitespace, so
  // "Rohit 2" arrives as two tokens and never matched anything; meanwhile
  // "Rohit2" was one character off "Rohit" and quietly charged him.
  assert.equal(who('Rohit2'), 'rohit_2');
  assert.equal(who('rohit2'), 'rohit_2');
  assert.equal(who('ROHIT2'), 'rohit_2');
  assert.equal(who('Rohit 2'), 'rohit_2', 'with the space too, however it is pasted');
  assert.equal(who('Rohit'), 'rohit', 'and the original keeps his own games');

  // The case the guard is actually for: a number the club has not got. It must
  // come back as a name to add, not fall to the nearest man without one — the
  // prefix rule would otherwise hand "Rohit3" straight to Rohit.
  assert.equal(who('Rohit3'), null);
  assert.equal(who('Rohit 3'), null);
});

test('a bare number is nobody', () => {
  // The leftover token when somebody types the name with a space in it. It
  // must not attach itself to whoever happens to be nearest.
  assert.equal(who('2'), null);
  assert.equal(who('12'), null);
});

test('a dropped or inserted letter is still the same person', () => {
  assert.equal(who('Jeethu'), 'jeetu');
  assert.equal(who('Tushr'), 'tushar');
});

test('a swapped letter is not — those are two different people', () => {
  // Nihal and Nihas are one substitution apart and both play. Merging them
  // credited one with the other's games, and meant the second never showed up
  // as an unknown name to be added.
  assert.equal(who('Nihal'), 'nihal');
  assert.equal(who('Nihas'), 'nihas');
});

test('short forms and aliases still resolve', () => {
  assert.equal(who('Tush'), 'tushar');
  assert.equal(who('Roji'), 'rojy');
  assert.equal(who('aws'), 'aws_ali');
});

test('a name nobody has is left unmatched rather than guessed at', () => {
  assert.equal(who('Fernando'), null);
  assert.equal(who(''), null);
});

test('times and handles are still thrown away', () => {
  // The junk filter used to drop anything with a digit in it, which is what
  // swallowed Rohit2. Relaxing it must not let the rest of a message in — and
  // a handle is never a name however much it looks like one, because the @ is
  // stripped before matching and "@rojy" would otherwise be Rojy.
  const out = parseTeams('Kickoff 8pm, 7:30 at the dome, ask @rojy\nRed: Rohit2, Tush',
    ROSTER, {}, { contracted_12: 27, noncontract: 35 });
  const tokens = out.rows.map(r => r.token);
  for (const junk of ['8pm', '7:30', '@rojy']) {
    assert.ok(!tokens.includes(junk), `${junk} was taken for a player`);
  }
  assert.ok(!out.rows.some(r => r.player_id === 'rojy'),
    'the handle must not charge the player it names');
  assert.ok(out.rows.some(r => r.player_id === 'rohit_2'), 'and the real name still lands');
});

test('a team spelled out after its emoji is the team, not a player', () => {
  // "❤️ REDS – Rony (C), ..." opens a team on the emoji and then says REDS as
  // well. That word matched nobody, so it arrived in Game Day as a player to
  // be added, charged the guest rate — and counted in the headcount, which is
  // what decides whether the night is billed at the 10- or 12-player rate. Two
  // of them (one per team) can misprice everybody.
  const out = parseTeams(
    '❤️ REDS – Rony (C), Tushar, Jeetu\n💙 BLUES – Rohit (C), Nihas, Rojy',
    ROSTER, {}, { contracted_12: 27, captain_12: 20, noncontract: 35 });

  assert.deepEqual(out.unmatched.map(u => u.token), [],
    'the colour words must not arrive as names to add');
  assert.equal(out.rows.length, 6, 'six players, not eight');
  assert.deepEqual([...new Set(out.rows.map(r => r.team))], ['Red', 'Blue']);
  assert.equal(out.num_players, 6, 'and the headcount is the players');
});

test('the captain is found when the marker has a comma after it', () => {
  // "Rony (C), Khilji" splits on whitespace into "Rony" and "(C)," — and
  // "(C)," is not the standalone marker because of the comma, so the captain
  // flag was dropped on the floor. Nobody pasting a roster the way the club
  // writes it had ever been given the captain's rate.
  // Both buckets on the card: six players is the 10-player column, and the
  // test should be about the armband, not about a half-filled rate card.
  const rates = { contracted_10: 30, captain_10: 25,
    contracted_12: 27, captain_12: 20, noncontract: 35 };
  for (const text of [
    '❤️ REDS – Rony (C), Tushar, Jeetu, Rojy, Nihas, Nihal',
    'Red: Rony (C) - Tushar Jeetu Rojy Nihas Nihal',
    '❤Rony(C) Tushar Jeetu Rojy Nihas Nihal',
    '❤️ Rony C, Tushar, Jeetu, Rojy, Nihas, Nihal',
  ]) {
    const out = parseTeams(text, ROSTER, {}, rates);
    const rony = out.rows.find(r => r.player_id === 'rony');
    assert.ok(rony, `Rony missing from: ${text}`);
    assert.ok(rony.is_captain, `captain not seen in: ${text}`);
    assert.equal(rony.amount, 25, `captain rate not applied in: ${text}`);
    assert.equal(out.rows.filter(r => r.is_captain).length, 1, `too many captains: ${text}`);
  }
});

test('an out-of-contract captain still pays the guest rate', () => {
  // The captain rate is a discount the contract pays for. Somebody outside it
  // does not get it by wearing the armband.
  const out = parseTeams('Red: Rohit2 (C), Tushar',
    ROSTER, {}, { contracted_10: 30, captain_10: 25, noncontract: 35 });
  const guest = out.rows.find(r => r.player_id === 'rohit_2');
  assert.ok(guest.is_captain, 'he did wear the armband');
  assert.equal(guest.rate_type, 'noncontract');
  assert.equal(guest.amount, 35, 'and pays the guest rate for it');
});

test('a whole roster lands on the right people', () => {
  const out = parseTeams(
    'Red: Rohit2, Tush, Jeetu\nBlue: Rohit, Nihal, Roji',
    ROSTER, {}, { contracted_12: 27, noncontract: 35 });
  const rows = out.rows || out.charges || [];
  assert.ok(rows.length >= 6, `expected six players, got ${rows.length}`);

  const byId = Object.fromEntries(rows.filter(r => r.player_id).map(r => [r.player_id, r]));
  assert.ok(byId.rohit_2, 'the guest is on the sheet');
  assert.ok(byId.rohit, 'and so is the member');
  assert.notEqual(byId.rohit_2.team, byId.rohit.team,
    'they were named on opposite teams and must stay there');
  assert.equal(rows.filter(r => r.player_id === 'rohit').length, 1,
    'the member is charged once, not twice');
});
