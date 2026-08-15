// auth_users.js — player login accounts (name + PIN) and admin management.
//
// Players log in by selecting their name and entering a short PIN. PINs are
// low-stakes (they only gate viewing a player's own football balance; the admin
// approves every contribution), so they are stored in plain text on purpose:
// the admin needs to re-share a player's PIN via WhatsApp at any time. This is a
// deliberate product choice for a casual club, not an oversight.

import { randomBytes } from 'node:crypto';

function generateId() {
  return randomBytes(8).toString('hex');
}

// 4-digit PIN as a string, e.g. "0473". Avoids leading-zero loss by formatting.
function generatePin() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

export const authUsersRepo = {
  // ---- login lookups ----

  // Find an active player login by player_id.
  getPlayerLogin(db, playerId) {
    return db.prepare(
      `SELECT id, player_id, pin, is_active FROM auth_users
       WHERE player_id = ? AND role = 'player' AND is_active = 1`
    ).get(playerId);
  },

  // ---- onboarding ----

  // Create a login (with a random PIN) for a single player. Returns {player_id,
  // name, pin}. Skips the cashier. Errors if the player already has a login.
  createPlayerLogin(db, playersRepo, playerId) {
    const player = playersRepo.get(playerId);
    if (!player) throw new Error(`Player ${playerId} not found`);
    if (player.special_role === 'cashier') {
      throw new Error('Cashier logs in as admin — no player login needed');
    }
    if (this.getPlayerLogin(db, playerId)) {
      throw new Error(`${player.name} already has a login`);
    }
    const pin = generatePin();
    db.prepare(
      `INSERT INTO auth_users (id, email, password_hash, pin, role, player_id, is_active, created_at)
       VALUES (?, NULL, '', ?, 'player', ?, 1, ?)`
    ).run(generateId(), pin, playerId, new Date().toISOString());
    return { player_id: playerId, name: player.name, pin };
  },

  // One-click: create logins for every non-cashier player that doesn't have one.
  // Returns the FULL shareable list (every player login with its PIN), so the
  // admin sees one complete credentials list to distribute.
  generateAllPlayerLogins(db, playersRepo) {
    const players = playersRepo.all();
    for (const p of players) {
      if (p.special_role === 'cashier') continue;
      if (this.getPlayerLogin(db, p.id)) continue;   // keep existing PINs stable
      const pin = generatePin();
      db.prepare(
        `INSERT INTO auth_users (id, email, password_hash, pin, role, player_id, is_active, created_at)
         VALUES (?, NULL, '', ?, 'player', ?, 1, ?)`
      ).run(generateId(), pin, p.id, new Date().toISOString());
    }
    return this.listPlayerLogins(db, playersRepo);
  },

  // Reset a player's PIN to a new random value; returns the new PIN.
  resetPin(db, playersRepo, playerId) {
    const login = this.getPlayerLogin(db, playerId);
    if (!login) throw new Error('No login for that player — generate one first');
    const pin = generatePin();
    db.prepare('UPDATE auth_users SET pin = ? WHERE id = ?').run(pin, login.id);
    const player = playersRepo.get(playerId);
    return { player_id: playerId, name: player?.name, pin };
  },

  // Deactivate / reactivate a player's login.
  setActive(db, playerId, active) {
    db.prepare('UPDATE auth_users SET is_active = ? WHERE player_id = ?')
      .run(active ? 1 : 0, playerId);
  },

  // ---- listings ----

  // Every player + whether they have a login + their PIN (for the admin panel).
  // Cashier is excluded (they use the admin password).
  listPlayerLogins(db, playersRepo) {
    const logins = db.prepare(
      `SELECT player_id, pin, is_active FROM auth_users WHERE role = 'player'`
    ).all();
    const byPlayer = Object.fromEntries(logins.map(l => [l.player_id, l]));
    return playersRepo.all()
      .filter(p => p.special_role !== 'cashier')
      .map(p => {
        const l = byPlayer[p.id];
        return {
          player_id: p.id,
          name: p.name,
          has_login: !!l,
          pin: l ? l.pin : null,
          is_active: l ? !!l.is_active : false,
        };
      });
  },

  // Public: id + name for the login name-picker (no balances, no PINs).
  publicPlayerList(db) {
    return db.prepare(
      `SELECT au.player_id AS id, p.name AS name
       FROM auth_users au JOIN players p ON p.id = au.player_id
       WHERE au.role = 'player' AND au.is_active = 1
       ORDER BY p.name`
    ).all();
  },
};
