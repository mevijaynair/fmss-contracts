#!/usr/bin/env node
/**
 * test-auth.js — who gets in, and as what.
 *
 * Sign-in decides what the whole app is allowed to do, and it is the one place
 * where a mistake is not a wrong number on a screen but somebody seeing or
 * changing what they should not. It had no tests at all.
 *
 * The case that prompted these: the cashier signing in under their own name
 * landed in the read-only player view — one ledger and nothing else — which
 * looks exactly like an app with no data in it. They are now elevated to
 * admin, and the rules around that need pinning down, because a club PIN is a
 * far weaker key than the admin password and is handed out over WhatsApp.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';

const scratch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fmss-auth-')), 'a.db');
process.env.FMSS_DB_PATH = scratch;
process.env.FMSS_AUTH_PASSWORD = 'test-admin-password';

const { db, initSchema, DB_FILE } = await import('../server/db.js');
if (path.resolve(DB_FILE) !== path.resolve(scratch)) {
  console.error(`Refusing to run: would use ${DB_FILE}, not the scratch database.`);
  process.exit(1);
}
const { auth } = await import('../server/auth.js');
const { authUsersRepo } = await import('../server/repos/auth_users.js');
initSchema();
db.exec('PRAGMA foreign_keys = ON');

import { createHash, randomBytes } from 'node:crypto';

let n = 0;
/**
 * A player with a login and a PIN this test knows.
 *
 * Written straight to auth_users rather than through createPlayerLogin, which
 * invents its own PIN — and which, until this change, refused outright to give
 * the cashier a login at all.
 */
function member(name, { role = null, pin = '1234', changed = true } = {}) {
  const id = `p${++n}`;
  db.prepare("INSERT INTO players (id,name,aliases,created_at,special_role) VALUES (?,?,'[]',?,?)")
    .run(id, name, new Date().toISOString(), role);
  const salt = randomBytes(8).toString('hex');
  const hash = createHash('sha256').update(pin + salt).digest('hex');
  db.prepare(`INSERT INTO auth_users
    (id, pin, pin_salt, requires_pin_change, login_attempts, role, player_id, is_active, created_at)
    VALUES (?,?,?,?,0,'player',?,1,?)`)
    .run(`a${n}`, hash, salt, changed ? 0 : 1, id, new Date().toISOString());
  return id;
}

const signIn = (id, pin) => auth.loginPlayer(db, authUsersRepo, id, pin);

test('an ordinary member signs in as a player', () => {
  const p = member('Ordinary');
  assert.equal(signIn(p, '1234').role, 'player');
});

test('the cashier signs in as an admin', () => {
  // They run the club's money; the player view is one ledger and nothing else,
  // which is indistinguishable from an app with no data in it.
  const c = member('Club cashier', { role: 'cashier' });
  const out = signIn(c, '1234');
  assert.equal(out.role, 'admin', 'the cashier gets the whole app');
});

test('the elevated cashier keeps their own player identity', () => {
  // Otherwise "my ledger", "my contributions" and their own snapshot — every
  // route that asks whose account this is — stop working for them.
  const c = member('Still a player', { role: 'cashier' });
  const payload = JSON.parse(
    Buffer.from(signIn(c, '1234').token.split('.')[1], 'base64url').toString());
  assert.equal(payload.role, 'admin');
  assert.equal(payload.playerId, c, 'their player id travels with the admin token');
});

test('a cashier still on the PIN they were issued is NOT elevated', () => {
  // Club PINs go out over WhatsApp and are known to whoever passed them on. A
  // printed PIN must never be enough to unlock the admin side.
  const c = member('Fresh cashier', { role: 'cashier', changed: false });
  assert.equal(signIn(c, '1234').role, 'player');
});

test('resetting the cashier PIN closes admin again until they choose a new one', () => {
  const c = member('Reset me', { role: 'cashier' });
  assert.equal(signIn(c, '1234').role, 'admin');
  db.prepare('UPDATE auth_users SET requires_pin_change = 1 WHERE player_id = ?').run(c);
  assert.equal(signIn(c, '1234').role, 'player', 'a reset PIN is an issued PIN again');
});

test('no other special role is elevated', () => {
  // Deliberately one role and not a general "is this person staff" flag.
  const p = member('Somebody else', { role: 'captain' });
  assert.equal(signIn(p, '1234').role, 'player');
});

test('a wrong PIN gets in as nothing at all', () => {
  const c = member('Cashier again', { role: 'cashier' });
  assert.throws(() => signIn(c, '9999'), /Wrong name or PIN/);
});

test('the admin password still works, and a wrong one does not', () => {
  assert.equal(auth.loginAdmin(db, 'test-admin-password').token.length > 20, true);
  assert.throws(() => auth.loginAdmin(db, 'not-the-password'), /Invalid password/);
});

test('an admin token and an elevated cashier token both verify as admin', () => {
  const c = member('Verify me', { role: 'cashier' });
  for (const t of [auth.loginAdmin(db, 'test-admin-password').token, signIn(c, '1234').token]) {
    assert.equal(auth.verify(`Bearer ${t}`).role, 'admin');
  }
});

process.on('exit', () => {
  try { fs.rmSync(path.dirname(scratch), { recursive: true, force: true }); } catch { /* temp dir */ }
});
