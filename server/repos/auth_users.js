// auth_users.js — User account management (players + admin).

import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';

function hashPassword(password) {
  return createHash('sha256').update(password).digest('hex');
}

function generateId() {
  return randomBytes(8).toString('hex');
}

export const authUsersRepo = {
  // Create a new player account.
  createPlayer(db, { email, password, playerId }) {
    if (!email || !password || !playerId) {
      throw new Error('email, password, and playerId are required');
    }

    const id = generateId();
    const now = new Date().toISOString();
    const passwordHash = hashPassword(password);

    db.prepare(
      `INSERT INTO auth_users (id, email, password_hash, role, player_id, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, email, passwordHash, 'player', playerId, 1, now);

    return { id, email, role: 'player', playerId, createdAt: now };
  },

  // Get user by email.
  getUserByEmail(db, email) {
    return db.prepare(
      'SELECT id, email, password_hash, role, player_id, is_active, created_at FROM auth_users WHERE email = ?'
    ).get(email);
  },

  // Get user by ID.
  getUserById(db, id) {
    return db.prepare(
      'SELECT id, email, password_hash, role, player_id, is_active, created_at FROM auth_users WHERE id = ?'
    ).get(id);
  },

  // List all users (admin only).
  listUsers(db, { role = null, isActive = true } = {}) {
    let query = 'SELECT id, email, role, player_id, is_active, created_at FROM auth_users WHERE 1=1';
    const params = [];

    if (role) {
      query += ' AND role = ?';
      params.push(role);
    }

    if (isActive !== null) {
      query += ' AND is_active = ?';
      params.push(isActive ? 1 : 0);
    }

    query += ' ORDER BY created_at DESC';
    return db.prepare(query).all(...params);
  },

  // Update a user's email or password.
  updateUser(db, id, { email, password }) {
    const now = new Date().toISOString();
    const updates = [];
    const params = [];

    if (email !== undefined) {
      updates.push('email = ?');
      params.push(email);
    }

    if (password !== undefined) {
      updates.push('password_hash = ?');
      params.push(hashPassword(password));
    }

    if (updates.length === 0) {
      throw new Error('No fields to update');
    }

    params.push(id);
    const query = `UPDATE auth_users SET ${updates.join(', ')} WHERE id = ?`;
    db.prepare(query).run(...params);

    return this.getUserById(db, id);
  },

  // Deactivate a user account.
  deactivateUser(db, id) {
    db.prepare('UPDATE auth_users SET is_active = 0 WHERE id = ?').run(id);
  },

  // Activate a user account.
  activateUser(db, id) {
    db.prepare('UPDATE auth_users SET is_active = 1 WHERE id = ?').run(id);
  },

  // Check if a user exists by email.
  existsByEmail(db, email) {
    const result = db.prepare('SELECT COUNT(*) AS count FROM auth_users WHERE email = ?').get(email);
    return result.count > 0;
  },

  // Reset password for a user (admin action, returns temp password).
  resetPassword(db, userId) {
    const tempPassword = generateId().slice(0, 8); // 8-char temp password
    const passwordHash = hashPassword(tempPassword);
    db.prepare('UPDATE auth_users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
    return tempPassword;
  },

  // Bulk create player accounts from CSV data.
  // Input: array of { name, email } objects, playersRepo
  // Returns: array of created user records with temp passwords
  bulkCreatePlayers(db, playersRepo, csvData) {
    const results = [];

    for (const row of csvData) {
      const { name, email } = row;

      if (!name || !email) {
        results.push({ name, email, error: 'Missing name or email' });
        continue;
      }

      // Find player by name (case-insensitive).
      const player = playersRepo.getByName(name);
      if (!player) {
        results.push({ name, email, error: `Player "${name}" not found` });
        continue;
      }

      // Check if email already exists.
      if (this.existsByEmail(db, email)) {
        results.push({ name, email, error: 'Email already exists' });
        continue;
      }

      try {
        const tempPassword = generateId().slice(0, 8);
        const user = this.createPlayer(db, {
          email,
          password: tempPassword,
          playerId: player.id,
        });
        results.push({ ...user, tempPassword });
      } catch (err) {
        results.push({ name, email, error: err.message });
      }
    }

    return results;
  },
};
