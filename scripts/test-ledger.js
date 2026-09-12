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
const charge = (gid, pid, amount) =>
  db.prepare('INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount,charged_to,paid) VALUES (?,?,?,\'\',0,\'\',?,?,0)')
    .run(`ch${++seq}`, gid, pid, amount, pid);
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

process.on('exit', () => {
  try { fs.rmSync(path.dirname(scratch), { recursive: true, force: true }); } catch { /* temp dir */ }
});
