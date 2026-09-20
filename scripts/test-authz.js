#!/usr/bin/env node
/**
 * test-authz.js — what a player token can actually reach.
 *
 * The app is on the public internet with a login page that publishes the
 * roster, so "can a signed-in player reach something that is not theirs" is a
 * question with a real answer and it should not be answered by reading the
 * routes file and hoping.
 *
 * This starts the REAL server against a scratch database and drives it over
 * HTTP with a real player token. Every route is enumerated from the source, so
 * a route added later is covered the day it is written rather than the day
 * somebody remembers to add a test for it.
 *
 * Two rules:
 *   - no write reaches the database without admin, unless it is explicitly
 *     one of a player's own (their contribution, their PIN, their transfer)
 *   - nothing anywhere answers with a 500, which would mean the request got
 *     past authorisation and broke something inside
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const scratch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fmss-authz-')), 'z.db');
process.env.FMSS_DB_PATH = scratch;
process.env.FMSS_AUTH_PASSWORD = 'test-admin-password';
process.env.PORT = '38121';

const { db, initSchema, DB_FILE } = await import('../server/db.js');
if (path.resolve(DB_FILE) !== path.resolve(scratch)) {
  console.error(`Refusing to run against ${DB_FILE}`); process.exit(1);
}
initSchema();

// A player with a PIN this test knows.
db.prepare("INSERT OR IGNORE INTO players (id,name,aliases,created_at) VALUES ('tp','Test Player','[]',?)")
  .run(new Date().toISOString());
const salt = randomBytes(8).toString('hex');
const hash = createHash('sha256').update('1234' + salt).digest('hex');
db.prepare(`INSERT OR REPLACE INTO auth_users
  (id,pin,pin_salt,requires_pin_change,login_attempts,role,player_id,is_active,created_at)
  VALUES ('au_tp',?,?,0,0,'player','tp',1,?)`).run(hash, salt, new Date().toISOString());

const { server } = await import('../server/index.js');   // starts listening on PORT
const BASE = `http://127.0.0.1:${process.env.PORT}`;
// Give the listener a moment; the import resolves before listen fires.
for (let i = 0; i < 50; i++) {
  try { await fetch(`${BASE}/api/health`); break; } catch { await new Promise(r => setTimeout(r, 40)); }
}

const login = async (body) => (await fetch(`${BASE}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json();

const playerToken = (await login({ player_id: 'tp', pin: '1234' })).token;
assert.ok(playerToken, 'the test player could not sign in');

/** Every route the API declares, read from the source. */
function routes() {
  const src = fs.readFileSync(path.join(ROOT, 'server/routes/index.js'), 'utf8');
  const re = /^r\.(get|post|put|delete|patch)\(\s*'([^']+)'/gm;
  const out = []; let m;
  while ((m = re.exec(src))) out.push({ method: m[1].toUpperCase(), path: m[2] });
  return out;
}

// Routes a PLAYER is supposed to be able to use. Everything else must refuse.
// Listed by hand on purpose: widening a player's reach should be a decision
// someone makes here, not something that happens by writing a route.
const PLAYER_MAY = [
  'GET /me', 'GET /contracts', 'GET /players', 'GET /ledgers',
  'GET /my/contributions', 'POST /my/contributions',
  'GET /gameweeks', 'GET /gameweeks/:id', 'GET /gameweeks/:id/full',
  'GET /gameweeks/:id/impact', 'GET /results', 'GET /audit/charges',
  'GET /players/:id/ledgers', 'GET /players/:id/ledgers/combined',
  'GET /players/:id/transactions', 'GET /players/:id/record',
  'GET /players/:id/timeline', 'GET /players/:id/stats',
  'GET /share/player/:id',
  'POST /my/pin', 'GET /my/audit',
  'GET /transfers', 'POST /transfers', 'GET /my/transfers',
  'GET /kitty', 'GET /movements', 'GET /contributions',
  'GET /my/ledgers', 'GET /dashboard',
];

const fill = (p) => p.replace(/:contractId/g, 'mon_thu').replace(/:playerId/g, 'tp')
  .replace(/:chargeId/g, 'x').replace(/:groupId/g, 'x').replace(/:id/g, 'tp');

const call = (r, token) => fetch(`${BASE}/api${fill(r.path)}`, {
  method: r.method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { body: '{}' }),
});

test('every route requires a token', async () => {
  const open = [];
  for (const r of routes()) {
    const res = await call(r, null);
    if (res.status !== 401) open.push(`${r.method} ${r.path} -> ${res.status}`);
  }
  assert.deepEqual(open, [], 'these answered without any token');
});

test('a player token cannot reach anything not meant for players', async () => {
  const reached = [];
  for (const r of routes()) {
    if (PLAYER_MAY.includes(`${r.method} ${r.path}`)) continue;
    const res = await call(r, playerToken);
    // 401/403 refused; 400/404/422 got past authorisation but the request was
    // rejected on its own terms before touching anything — also fine for a
    // route a player should not be using, as long as it is not 2xx.
    if (res.status < 400) reached.push(`${r.method} ${r.path} -> ${res.status}`);
  }
  assert.deepEqual(reached, [], 'a player reached these');
});

test('nothing answers a player with a server error', async () => {
  // A 500 means the request got past authorisation and broke something inside,
  // which is where the interesting bugs live.
  const broke = [];
  for (const r of routes()) {
    const res = await call(r, playerToken);
    if (res.status >= 500) broke.push(`${r.method} ${r.path} -> ${res.status}`);
  }
  assert.deepEqual(broke, [], 'these blew up');
});

test('a player dashboard carries only their own money', async () => {
  // The same route serves the club-wide figures to an admin. If it ever stops
  // branching, every player learns what the club holds and what everyone owes.
  const mine = await (await fetch(`${BASE}/api/dashboard`,
    { headers: { Authorization: `Bearer ${playerToken}` } })).json();
  assert.equal(mine.role, 'player');
  assert.equal(mine.player_id, 'tp');
  const text = JSON.stringify(mine);
  for (const clubWide of ['total_', 'kitty', 'in_debt', 'watchlist', 'held_in_credit']) {
    assert.ok(!text.includes(clubWide), `a player dashboard should not carry ${clubWide}`);
  }
});

test('a player cannot read another player by asking for them', async () => {
  db.prepare("INSERT OR IGNORE INTO players (id,name,aliases,created_at) VALUES ('other','Someone Else','[]',?)")
    .run(new Date().toISOString());
  const res = await fetch(`${BASE}/api/share/player/other`, {
    headers: { Authorization: `Bearer ${playerToken}` } });
  assert.equal(res.status, 403, 'somebody else\'s snapshot is not theirs to read');
});

test('a forged token is refused', async () => {
  // Same payload, signed with the wrong key.
  const jwt = (await import('jsonwebtoken')).default;
  const forged = jwt.sign({ userId: 'au_tp', role: 'admin' }, 'not-the-secret');
  const res = await fetch(`${BASE}/api/players`, { headers: { Authorization: `Bearer ${forged}` } });
  assert.equal(res.status, 401);
});

test('a player cannot promote themselves by editing the token payload', async () => {
  // The role lives inside a signature, so changing it invalidates the whole
  // thing. Worth pinning: it is the single assumption the whole model rests on.
  const [h, p, s] = playerToken.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  payload.role = 'admin';
  const tampered = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
  const res = await fetch(`${BASE}/api/players`, { headers: { Authorization: `Bearer ${tampered}` } });
  assert.equal(res.status, 401);
});

test('the login response never says what role you got', async () => {
  // Announcing it would name the one player worth attacking.
  const out = await login({ player_id: 'tp', pin: '1234' });
  assert.deepEqual(Object.keys(out).sort(), ['expiresIn', 'requiresPinChange', 'token']);
});

test('the public name list carries nothing but names', async () => {
  const list = await (await fetch(`${BASE}/api/login/players`)).json();
  assert.ok(Array.isArray(list) && list.length);
  for (const row of list) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'name'],
      'no roles, no balances, no PIN state on the public list');
  }
});

test('guessing one account is cut off', async () => {
  const { _reset, ACCOUNT_MAX } = await import('../server/rate-limit.js')
    .then(m => ({ _reset: m._reset, ACCOUNT_MAX: m._state().ACCOUNT_MAX }));
  _reset();
  db.prepare("UPDATE auth_users SET login_attempts = 0, last_failed_login = NULL WHERE player_id = 'tp'").run();
  const codes = [];
  for (let i = 0; i < ACCOUNT_MAX + 3; i++) {
    const res = await fetch(`${BASE}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: 'tp', pin: '0000' }) });
    codes.push(res.status);
  }
  assert.ok(codes.includes(429), `never blocked: ${codes.join(',')}`);
  assert.equal(codes.at(-1), 429, 'still guessing at the end');
  // And the right PIN is refused too while the account is locked — otherwise
  // the limit is only slowing an attacker down between correct guesses.
  const good = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ player_id: 'tp', pin: '1234' }) });
  assert.equal(good.status, 429, 'a locked account is locked to everyone');
  _reset();
});

test('the master password is rate limited too', async () => {
  // It had no limit of any kind, and it opens the whole club.
  const { _reset } = await import('../server/rate-limit.js');
  _reset();
  const codes = [];
  for (let i = 0; i < 9; i++) {
    const res = await fetch(`${BASE}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-guess-' + i }) });
    codes.push(res.status);
  }
  assert.ok(codes.includes(429), `admin password never blocked: ${codes.join(',')}`);
  _reset();
});

test('working through the roster from one machine is cut off', async () => {
  // The login page publishes every name, so an attacker never has to guess who
  // exists. A per-account limit alone would allow five tries each, sixty times
  // over; the per-IP limit is what stops that.
  const { _reset, IP_MAX } = await import('../server/rate-limit.js')
    .then(m => ({ _reset: m._reset, IP_MAX: m._state().IP_MAX }));
  _reset();
  const codes = [];
  for (let i = 0; i < IP_MAX + 3; i++) {
    // A DIFFERENT account every time, so no account limit is ever reached.
    const res = await fetch(`${BASE}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: `nobody_${i}`, pin: '0000' }) });
    codes.push(res.status);
  }
  assert.ok(codes.includes(429), `spraying was never blocked: ${codes.join(',')}`);
  _reset();
});

test('a correct sign-in clears that account, but not the address', async () => {
  const { _reset } = await import('../server/rate-limit.js');
  _reset();
  // The other limiter is a counter in the database and earlier tests have been
  // hammering this account; clear that too or it refuses the correct PIN here.
  db.prepare("UPDATE auth_users SET login_attempts = 0, last_failed_login = NULL WHERE player_id = 'tp'").run();
  for (let i = 0; i < 3; i++) {
    await fetch(`${BASE}/api/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: 'tp', pin: '0000' }) });
  }
  const ok = await fetch(`${BASE}/api/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ player_id: 'tp', pin: '1234' }) });
  assert.equal(ok.status, 200, 'the right PIN still works below the limit');
  const { _state } = await import('../server/rate-limit.js');
  const keys = _state().keys;
  assert.ok(!keys.some(k => k.startsWith('acct:')), 'the account was forgiven');
  assert.ok(keys.some(k => k.startsWith('ip:')),
    'the address is NOT forgiven — one hit among a run of guesses is what an attacker produces');
  _reset();
});

test('shut the test server down', () => {
  // Without this the listener keeps the process alive and the run has to be
  // killed, which loses the summary that says whether any of this passed.
  server.close();
});

process.on('exit', () => {
  try { fs.rmSync(path.dirname(scratch), { recursive: true, force: true }); } catch { /* temp dir */ }
});
