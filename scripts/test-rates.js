#!/usr/bin/env node
/**
 * test-rates.js — dated rate cards, and the pricing that reads them.
 *
 * The rate card used to be one column on the contract, so it had exactly one
 * value: today's. Change it and every game ever played is restated at the new
 * figure by anything that re-reads it, and the night the club actually changed
 * its prices is recorded nowhere. The club changed its Saturday prices on
 * 17 October 2026, which is what made that a bug rather than a shape.
 *
 * Runs against a scratch database, never a real one.
 *
 * Run:  node scripts/test-rates.js     (or npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const scratch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fmss-rates-')), 'test.db');
process.env.FMSS_DB_PATH = scratch;

const { db, initSchema, DB_FILE } = await import('../server/db.js');
const { contractsRepo } = await import('../server/repos/contracts.js');
const { gameweeksRepo } = await import('../server/repos/gameweeks.js');

if (path.resolve(DB_FILE) !== path.resolve(scratch)) {
  console.error(`Refusing to run: tests would write to ${DB_FILE}, not the scratch database.`);
  process.exit(1);
}
initSchema();
db.exec('PRAGMA foreign_keys = ON');

const CONTRACT = 'ratec';
db.prepare(`INSERT INTO contracts (id, name, venue, rates, cost_per_gw, sort, season_start)
            VALUES (?, 'Rate test', 'Somewhere',
                    '{"contracted_10":30,"noncontract":35}', 275, 1, '2026-08-01')`).run(CONTRACT);
// The seeding migration runs at initSchema, before this contract exists, so
// give it the card it would have been given.
contractsRepo.saveCard(CONTRACT, {
  effective_from: '2026-08-01', rates: { contracted_10: 30, noncontract: 35 },
  pitch_per_game: 275, notes: 'as it stood',
});

let seq = 0;
function player(name, opening = 0) {
  const id = `p${++seq}`;
  db.prepare("INSERT INTO players (id, name, aliases, created_at) VALUES (?, ?, '[]', ?)")
    .run(id, name, new Date().toISOString());
  db.prepare("INSERT INTO ledgers (player_id, contract_id, opening_balance, status) VALUES (?,?,?,'')")
    .run(id, CONTRACT, opening);
  return id;
}
function gameOn(date, players) {
  const id = `g${++seq}`;
  db.prepare(`INSERT INTO gameweeks (id,contract_id,gw_number,contract_number,date,cost_per_gw,
    num_players,teams_raw,captains_raw,score,comments,historical,created_at)
    VALUES (?,?,?,0,?,0,0,'','','','',0,?)`)
    .run(id, CONTRACT, ++seq, date, new Date().toISOString());
  for (const p of players) {
    db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,charged_to,paid)
                VALUES (?,?,?,'',0,'',0,?,0)`).run(`ch${++seq}`, id, p, p);
  }
  return id;
}

test('a contract starts with one card, and nothing falls off the front of it', () => {
  const list = contractsRepo.cards(CONTRACT);
  assert.equal(list.length, 1, 'exactly one');
  assert.equal(list[0].effective_to, null, 'the last card is still in force, so it has no end');
  assert.ok(contractsRepo.cardOn(CONTRACT, '1999-01-01'),
    'a night from before the history still gets a price rather than nothing');
});

test('cards run end to end: a gap or an overlap is not representable', () => {
  contractsRepo.saveCard(CONTRACT, {
    effective_from: '2026-10-17', rates: { contracted_10: 36, noncontract: 40 },
    pitch_per_game: 315, notes: 'the new booking',
  });
  const list = contractsRepo.cards(CONTRACT);
  assert.equal(list.length, 2);
  assert.equal(list[0].effective_to, '2026-10-16', 'it ends the day the next one starts');
  assert.equal(list[1].effective_to, null);

  for (const [day, pitch] of [['2026-08-01', 275], ['2026-10-16', 275],
    ['2026-10-17', 315], ['2027-01-01', 315]]) {
    assert.equal(contractsRepo.cardOn(CONTRACT, day).pitch_per_game, pitch,
      `${day} resolves to one card, and the right one`);
  }
});

test('a game is priced by the card in force on the night it was played', () => {
  const a = player('Played in September', 500);
  const b = player('Played in November', 500);
  const before = gameOn('2026-09-10', [a]);
  const after = gameOn('2026-11-10', [b]);

  assert.equal(gameweeksRepo.rateForCharge(
    { gameweekId: before, isCaptain: false, fromOtherContract: false, players: 10 }).amount, 30,
  'September at September prices');
  assert.equal(gameweeksRepo.rateForCharge(
    { gameweekId: after, isCaptain: false, fromOtherContract: false, players: 10 }).amount, 36,
  'November at November prices');
  assert.equal(gameweeksRepo.rateForCharge(
    { gameweekId: before, isCaptain: false, fromOtherContract: true, players: 10 }).amount, 35,
  'and the guest rate travels with its own card');
});

test('the captain discount is read from the night\'s card too', () => {
  contractsRepo.saveCard(CONTRACT, {
    effective_from: '2026-10-17',
    rates: { contracted_10: 36, captain_10: 31, contracted_12: 30, captain_12: 25, noncontract: 40 },
    pitch_per_game: 315,
  });
  const g = gameOn('2026-11-11', []);
  assert.equal(gameweeksRepo.rateForCharge(
    { gameweekId: g, isCaptain: true, fromOtherContract: false, players: 10 }).amount, 31);
  assert.equal(gameweeksRepo.rateForCharge(
    { gameweekId: g, isCaptain: true, fromOtherContract: false, players: 12 }).amount, 25);
  assert.equal(gameweeksRepo.rateForCharge(
    { gameweekId: g, isCaptain: false, fromOtherContract: false, players: 12 }).amount, 30);
});

test('saving a card points the contract at the one in force today', () => {
  const c = contractsRepo.get(CONTRACT);
  assert.equal(c.rates.contracted_10, 36, 'the current card IS the contract card');
  assert.equal(c.cost_per_gw, 315, 'the pitch with it');

  contractsRepo.saveCard(CONTRACT, {
    effective_from: '2099-01-01', rates: { contracted_10: 99 }, pitch_per_game: 999,
  });
  assert.equal(contractsRepo.get(CONTRACT).rates.contracted_10, 36,
    'a card dated next year does not move today');
  assert.equal(contractsRepo.get(CONTRACT).cost_per_gw, 315);
  contractsRepo.removeCard(
    contractsRepo.cards(CONTRACT).find(x => x.effective_from === '2099-01-01').id);
  assert.equal(contractsRepo.get(CONTRACT).cost_per_gw, 315, 'and removing it changes nothing');
});

test('editing a card edits it, rather than quietly adding a second one', () => {
  const before = contractsRepo.cards(CONTRACT).length;
  contractsRepo.saveCard(CONTRACT, {
    effective_from: '2026-10-17',
    rates: { contracted_10: 35, captain_10: 30, contracted_12: 30, captain_12: 25, noncontract: 40 },
    pitch_per_game: 315, notes: 'corrected',
  });
  assert.equal(contractsRepo.cards(CONTRACT).length, before, 'same date, same card');
  assert.equal(contractsRepo.cardOn(CONTRACT, '2026-11-01').rates.contracted_10, 35);
});

test('a contract cannot be left with no price at all', () => {
  const lone = 'lonely';
  db.prepare(`INSERT INTO contracts (id, name, rates, cost_per_gw, sort)
              VALUES (?, 'Lonely', '{}', 0, 9)`).run(lone);
  contractsRepo.saveCard(lone, {
    effective_from: '2026-01-01', rates: { contracted_10: 10 }, pitch_per_game: 100,
  });
  const card = contractsRepo.cards(lone)[0];
  assert.throws(() => contractsRepo.removeCard(card.id), /at least one rate card/);
});

test('saving the contract and saving a card cannot say different things', () => {
  // contracts.rates is a mirror. A caller that writes it means "the price
  // now", so the card in force now has to move with it — otherwise the next
  // game priced from the card contradicts the screen that just saved it.
  contractsRepo.update(CONTRACT, {
    rates: { contracted_10: 34, captain_10: 29, contracted_12: 29, captain_12: 24, noncontract: 39 },
    cost_per_gw: 312,
  });
  const live = contractsRepo.cardOn(CONTRACT, new Date().toISOString().slice(0, 10));
  assert.equal(live.rates.contracted_10, 34, 'the card moved with the contract');
  assert.equal(live.pitch_per_game, 312);
  // And the old card is untouched: this was a price now, not a rewrite of
  // every night ever played.
  assert.equal(contractsRepo.cardOn(CONTRACT, '2026-09-10').rates.contracted_10, 30);
});

test('a contract with no card at all is priced from its own columns', () => {
  // An import, a seed or a script can create a contract without ever touching
  // the card history. The alternative to this fallback is pricing its games
  // at nothing, which is the one answer that is certainly wrong.
  const bare = 'bare';
  db.prepare(`INSERT INTO contracts (id, name, rates, cost_per_gw, sort)
              VALUES (?, 'No history', '{"contracted_10":21,"noncontract":26}', 199, 8)`).run(bare);
  const card = contractsRepo.cardOn(bare, '2026-11-01');
  assert.equal(card.rates.contracted_10, 21, "the contract's own rates");
  assert.equal(card.pitch_per_game, 199);
  assert.equal(card.effective_from, null, 'and it says it is not a dated card');
  assert.equal(contractsRepo.cardOn('no-such-contract-at-all', '2026-11-01'), null);
});

test('a card without the date it comes into force is refused', () => {
  assert.throws(() => contractsRepo.saveCard(CONTRACT, { rates: { contracted_10: 1 } }),
    /comes into force/);
  assert.throws(() => contractsRepo.saveCard(CONTRACT, { effective_from: 'soon', rates: {} }),
    /comes into force/);
  assert.throws(() => contractsRepo.saveCard('nosuch', { effective_from: '2026-01-01' }),
    /Unknown contract/);
});

// --- the repricing tool ------------------------------------------------
//
// Three Saturdays had already been entered at the old card when the price
// changed. The tool that puts them back onto the right card moves real
// money, so what it does and what it refuses to do are both pinned here.


const reprice = (args) => execFileSync(process.execPath,
  ['scripts/reprice-games.js', '--contract', CONTRACT, ...args],
  { encoding: 'utf8', env: { ...process.env, FMSS_DB_PATH: scratch } });

const balOf = (pid) => {
  const r = db.prepare(`SELECT COALESCE(l.opening_balance,0)
    - COALESCE((SELECT SUM(ch.amount) FROM charges ch JOIN gameweeks g ON g.id = ch.gameweek_id
        WHERE COALESCE(ch.charged_to, ch.player_id) = l.player_id AND g.historical = 0
          AND ch.settled_from_kitty = 0 AND ch.settles_cash = 0), 0) AS bal
    FROM ledgers l WHERE l.player_id = ? AND l.contract_id = ?`).get(pid, CONTRACT);
  return Math.round((r?.bal ?? 0) * 100) / 100;
};

test('the nights below are priced from a card of their own', () => {
  // Decided here rather than inherited from whatever an earlier test last
  // saved, so the figures the tool is checked against are stated once.
  contractsRepo.saveCard(CONTRACT, {
    effective_from: '2026-11-15',
    rates: { contracted_10: 35, captain_10: 30, contracted_12: 30, captain_12: 25, noncontract: 40 },
    pitch_per_game: 315, notes: 'for the repricing tests',
  });
  assert.equal(contractsRepo.cardOn(CONTRACT, '2026-11-20').rates.contracted_10, 35);
});

test('a dry run says what it would do and writes nothing', () => {
  const a = player('Overcharged', 500);
  const g = gameOn('2026-11-20', [a]);
  db.prepare('UPDATE charges SET amount = 37, rate_type = ?  WHERE gameweek_id = ?')
    .run('contracted_10', g);
  const before = balOf(a);

  const out = reprice(['--from', '2026-11-20', '--to', '2026-11-20']);
  assert.match(out, /DRY RUN/);
  assert.match(out, /37 -> {0,4}\s*35/, 'it names the new figure');
  assert.equal(balOf(a), before, 'and moved nothing');
});

test('applying it moves the balance by exactly what it said', () => {
  const a = player('Repriced', 500);
  const g = gameOn('2026-11-21', [a]);
  db.prepare('UPDATE charges SET amount = 37 WHERE gameweek_id = ?').run(g);
  db.prepare('UPDATE gameweeks SET cost_per_gw = 346 WHERE id = ?').run(g);
  const before = balOf(a);

  const out = reprice(['--from', '2026-11-21', '--to', '2026-11-21', '--apply']);
  assert.match(out, /every balance reconciles/);
  assert.equal(balOf(a), Math.round((before + 2) * 100) / 100,
    'charged 35 where it was 37, so two dirhams come back');
  assert.equal(db.prepare('SELECT cost_per_gw c FROM gameweeks WHERE id = ?').get(g).c, 315,
    'and the pitch is the one the card says');
  const kitty = db.prepare('SELECT amount, kind FROM kitty WHERE id = ?').get(`k_gw_${g}`);
  assert.ok(kitty, 'the night still has its kitty row');
});

test('cash already collected is left alone unless you say otherwise', () => {
  const guest = player('Paid in cash', 0);
  db.prepare("UPDATE players SET player_type = 'outside' WHERE id = ?").run(guest);
  const g = gameOn('2026-11-22', [guest]);
  db.prepare('UPDATE charges SET amount = 45, paid = 1 WHERE gameweek_id = ?').run(g);

  const out = reprice(['--from', '2026-11-22', '--to', '2026-11-22', '--apply']);
  assert.match(out, /SKIPPED/, 'it says so rather than doing it quietly');
  assert.equal(db.prepare('SELECT amount a FROM charges WHERE gameweek_id = ?').get(g).a, 45,
    'the money in the pocket is what the charge still says');

  const forced = reprice(['--from', '2026-11-22', '--to', '2026-11-22',
    '--apply', '--allow-paid-cash']);
  assert.doesNotMatch(forced, /SKIPPED/);
  assert.equal(db.prepare('SELECT amount a FROM charges WHERE gameweek_id = ?').get(g).a, 40,
    'told to, it moves it');
});

test('a price agreed with a guest is not a card, and survives', () => {
  const guest = player('Has a deal', 0);
  db.prepare("UPDATE players SET player_type = 'outside', outside_cost = 25 WHERE id = ?")
    .run(guest);
  const g = gameOn('2026-11-23', [guest]);
  db.prepare('UPDATE charges SET amount = 25 WHERE gameweek_id = ?').run(g);
  reprice(['--from', '2026-11-23', '--to', '2026-11-23', '--apply']);
  assert.equal(db.prepare('SELECT amount a FROM charges WHERE gameweek_id = ?').get(g).a, 25,
    'their own price stands');
});

test("pitch only moves the club's money and nobody else's", () => {
  // The Mon/Thu bundle turned out to cost 217 a night against the 275 the
  // games were booked at. Correcting that is the club's own arithmetic; the
  // players were charged what they were charged.
  const a = player('Untouched', 500);
  const g = gameOn('2026-11-24', [a]);
  db.prepare('UPDATE charges SET amount = 37 WHERE gameweek_id = ?').run(g);
  db.prepare('UPDATE gameweeks SET cost_per_gw = 346 WHERE id = ?').run(g);
  const before = balOf(a);

  const out = reprice(['--from', '2026-11-24', '--to', '2026-11-24', '--apply', '--pitch-only']);
  assert.match(out, /pitch only/);
  assert.equal(balOf(a), before, 'not one balance moved');
  assert.equal(db.prepare('SELECT amount a FROM charges WHERE gameweek_id = ?').get(g).a, 37,
    'and the charge is what it was');
  assert.equal(db.prepare('SELECT cost_per_gw c FROM gameweeks WHERE id = ?').get(g).c, 315,
    'while the pitch is corrected');
  const k = db.prepare('SELECT kind, amount FROM kitty WHERE id = ?').get(`k_gw_${g}`);
  assert.equal(k.kind === 'income' ? k.amount : -k.amount, 37 - 315,
    "and the night's kitty row is recomputed from the new pitch");
});

process.on('exit', () => {
  try { fs.rmSync(path.dirname(scratch), { recursive: true, force: true }); } catch { /* gone */ }
});
