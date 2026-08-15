// auth_users.js — player login accounts with PIN security + audit trail.
// PINs are now hashed with per-user salt. On first login, players must change
// their PIN. Old PINs tracked to prevent reuse. All auth events logged.

import { randomBytes, createHash } from 'node:crypto';

function generateId() {
  return randomBytes(8).toString('hex');
}

function generatePin() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

// Hash PIN with salt using SHA-256
function hashPin(pin, salt) {
  return createHash('sha256').update(pin + salt).digest('hex');
}

// Audit log a security event (login, PIN change, etc.)
function auditLog(db, event) {
  const { user_id, player_id, action, details, ip_address, user_agent } = event;
  db.prepare(
    `INSERT INTO audit_log (id, user_id, player_id, action, details, ip_address, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    generateId(), user_id, player_id, action,
    details ? JSON.stringify(details) : null,
    ip_address, user_agent, new Date().toISOString()
  );
}

export const authUsersRepo = {
  // ---- login lookups ----

  // Find an active player login by player_id (with full record for PIN verify).
  getPlayerLogin(db, playerId) {
    return db.prepare(
      `SELECT id, player_id, pin, pin_salt, requires_pin_change, is_active FROM auth_users
       WHERE player_id = ? AND role = 'player' AND is_active = 1`
    ).get(playerId);
  },

  // ---- PIN management ----

  // Verify a PIN against a stored hash. Returns { valid, requires_change }.
  verifyPin(pinString, login) {
    if (!login || !login.pin_salt) return { valid: false, requires_change: false };
    const hash = hashPin(pinString, login.pin_salt);
    const valid = hash === login.pin;
    return { valid, requires_change: login.requires_pin_change === 1 };
  },

  // Check if a PIN was used recently (prevent reuse).
  wasRecentlyUsed(db, userId, newPin) {
    const newHash = db.prepare('SELECT pin_salt FROM auth_users WHERE id = ?').get(userId)?.pin_salt;
    if (!newHash) return false;
    const newHashValue = hashPin(newPin, newHash);
    const recent = db.prepare(
      'SELECT COUNT(*) n FROM pin_history WHERE user_id = ? AND old_pin_hash = ?'
    ).get(userId, newHashValue);
    return recent?.n > 0;
  },

  // Change a player's PIN (after verification). Saves old PIN to history.
  changePinForUser(db, userId, playerId, oldPinString, newPinString) {
    const login = db.prepare('SELECT id, pin, pin_salt FROM auth_users WHERE id = ?').get(userId);
    if (!login) throw new Error('User not found');

    // Verify old PIN
    if (oldPinString && hashPin(oldPinString, login.pin_salt) !== login.pin) {
      throw new Error('Current PIN incorrect');
    }

    // Check new PIN isn't the same
    if (oldPinString && hashPin(newPinString, login.pin_salt) === login.pin) {
      throw new Error('New PIN must be different from current PIN');
    }

    // Check history for reuse
    if (this.wasRecentlyUsed(db, userId, newPinString)) {
      throw new Error('PIN was used recently — choose a new one');
    }

    // Save old PIN to history before updating
    db.prepare(
      'INSERT INTO pin_history (id, user_id, old_pin_hash, changed_at) VALUES (?, ?, ?, ?)'
    ).run(generateId(), userId, login.pin, new Date().toISOString());

    // Generate new salt and hash
    const newSalt = randomBytes(8).toString('hex');
    const newHash = hashPin(newPinString, newSalt);

    db.prepare(
      `UPDATE auth_users SET pin = ?, pin_salt = ?, requires_pin_change = 0, pin_changed_at = ?
       WHERE id = ?`
    ).run(newHash, newSalt, new Date().toISOString(), userId);

    auditLog(db, {
      user_id: userId, player_id: playerId, action: 'pin_change',
      details: { reason: oldPinString ? 'player_requested' : 'admin_assigned' }
    });
  },

  // ---- onboarding ----

  // Create a login for a single player with a random PIN and requires_pin_change=1.
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
    const salt = randomBytes(8).toString('hex');
    const hash = hashPin(pin, salt);

    db.prepare(
      `INSERT INTO auth_users (id, email, password_hash, pin, pin_salt, requires_pin_change, role, player_id, is_active, created_at)
       VALUES (?, NULL, '', ?, ?, 1, 'player', ?, 1, ?)`
    ).run(generateId(), hash, salt, playerId, new Date().toISOString());

    auditLog(db, { player_id: playerId, action: 'account_created', details: { method: 'admin_bulk' } });
    return { player_id: playerId, name: player.name, pin };
  },

  // One-click: generate logins for every non-cashier player without one.
  generateAllPlayerLogins(db, playersRepo) {
    const players = playersRepo.all();
    const created = [];
    for (const p of players) {
      if (p.special_role === 'cashier') continue;
      if (this.getPlayerLogin(db, p.id)) continue;

      const pin = generatePin();
      const salt = randomBytes(8).toString('hex');
      const hash = hashPin(pin, salt);

      db.prepare(
        `INSERT INTO auth_users (id, email, password_hash, pin, pin_salt, requires_pin_change, role, player_id, is_active, created_at)
         VALUES (?, NULL, '', ?, ?, 1, 'player', ?, 1, ?)`
      ).run(generateId(), hash, salt, p.id, new Date().toISOString());

      auditLog(db, { player_id: p.id, action: 'account_created', details: { method: 'admin_bulk' } });
      created.push({ player_id: p.id, name: p.name, pin });
    }
    return this.listPlayerLogins(db, playersRepo);
  },

  // Reset a player's PIN to a new random value; requires the player to set it on next login.
  resetPin(db, playersRepo, playerId) {
    const login = this.getPlayerLogin(db, playerId);
    if (!login) throw new Error('No login for that player');

    const newPin = generatePin();
    const newSalt = randomBytes(8).toString('hex');
    const newHash = hashPin(newPin, newSalt);

    db.prepare(
      `UPDATE auth_users SET pin = ?, pin_salt = ?, requires_pin_change = 1
       WHERE player_id = ?`
    ).run(newHash, newSalt, playerId);

    auditLog(db, { player_id: playerId, action: 'pin_reset', details: { by: 'admin' } });
    const player = playersRepo.get(playerId);
    return { player_id: playerId, name: player?.name, pin: newPin };
  },

  // Track failed login attempts for rate-limiting.
  recordFailedLogin(db, userId) {
    db.prepare(
      `UPDATE auth_users SET login_attempts = login_attempts + 1, last_failed_login = ?
       WHERE id = ?`
    ).run(new Date().toISOString(), userId);
    auditLog(db, { user_id: userId, action: 'login_failed' });
  },

  // Reset failed attempts counter on successful login.
  recordSuccessfulLogin(db, userId) {
    db.prepare(
      `UPDATE auth_users SET login_attempts = 0 WHERE id = ?`
    ).run(userId);
    auditLog(db, { user_id: userId, action: 'login_success' });
  },

  // Check if account is rate-limited (too many failed attempts in last 15 min).
  isRateLimited(db, userId) {
    const max_attempts = 5;
    const lockout_minutes = 15;
    const lockout_until = new Date(Date.now() - lockout_minutes * 60000).toISOString();

    const user = db.prepare(
      `SELECT login_attempts, last_failed_login FROM auth_users WHERE id = ?`
    ).get(userId);

    if (!user || user.login_attempts < max_attempts) return false;
    if (!user.last_failed_login) return false;
    return user.last_failed_login > lockout_until;
  },

  // Deactivate / reactivate a player's login.
  setActive(db, playerId, active) {
    db.prepare('UPDATE auth_users SET is_active = ? WHERE player_id = ?')
      .run(active ? 1 : 0, playerId);
    auditLog(db, { player_id: playerId, action: active ? 'account_activated' : 'account_deactivated' });
  },

  // ---- listings ----

  // Every player + login status + PIN (for admin panel, shareable).
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

  // ---- audit trail ----

  // Get audit log for a player (what they can see: their own actions).
  auditTrailForPlayer(db, playerId, limit = 50) {
    return db.prepare(
      `SELECT id, action, details, created_at FROM audit_log
       WHERE player_id = ? OR (player_id IS NULL AND action IN ('login_success', 'login_failed', 'pin_change'))
       ORDER BY created_at DESC LIMIT ?`
    ).all(playerId, limit);
  },

  // Get audit log for admin (all actions).
  auditTrailForAdmin(db, filter = {}, limit = 100) {
    let query = 'SELECT * FROM audit_log WHERE 1=1';
    const params = [];

    if (filter.action) {
      query += ' AND action = ?';
      params.push(filter.action);
    }
    if (filter.player_id) {
      query += ' AND player_id = ?';
      params.push(filter.player_id);
    }
    if (filter.user_id) {
      query += ' AND user_id = ?';
      params.push(filter.user_id);
    }
    if (filter.since) {
      query += ' AND created_at >= ?';
      params.push(filter.since);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    return db.prepare(query).all(...params);
  },
};
