// auth.js — role-based authentication (admin password + player email+password) via JWT.
// Admin: password-only login (stored in FMSS_AUTH_PASSWORD env var).
// Players: email+password login (stored in auth_users table with hashed passwords).
// Both return JWT with role + player_id; subsequent requests include token in Authorization header.

import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';

const SECRET = process.env.FMSS_AUTH_PASSWORD || 'change-me-in-env';
const TOKEN_EXPIRY = '7d';

// Simple hash for password storage (not bcrypt, to avoid npm dependencies).
// In production, use bcrypt for better security.
function hashPassword(password) {
  return createHash('sha256').update(password).digest('hex');
}

function verifyPasswordHash(password, hash) {
  return hashPassword(password) === hash;
}

export const auth = {
  // Player login: email + password
  loginPlayer(db, email, password) {
    const user = db.prepare(
      'SELECT id, email, password_hash, player_id FROM auth_users WHERE email = ? AND role = ? AND is_active = 1'
    ).get(email, 'player');

    if (!user) {
      throw new Error('Invalid email or password');
    }

    if (!verifyPasswordHash(password, user.password_hash)) {
      throw new Error('Invalid email or password');
    }

    const payload = {
      userId: user.id,
      email: user.email,
      role: 'player',
      playerId: user.player_id,
    };
    const token = jwt.sign(payload, SECRET, { expiresIn: TOKEN_EXPIRY });
    return { token, expiresIn: TOKEN_EXPIRY };
  },

  // Admin login: password-only
  loginAdmin(password) {
    if (password !== SECRET) {
      throw new Error('Invalid password');
    }
    const payload = {
      role: 'admin',
      adminMode: true,
    };
    const token = jwt.sign(payload, SECRET, { expiresIn: TOKEN_EXPIRY });
    return { token, expiresIn: TOKEN_EXPIRY };
  },

  // Verify a token from the Authorization header and return the decoded payload.
  verify(authHeader) {
    if (!authHeader?.startsWith('Bearer ')) {
      throw new Error('Missing or invalid Authorization header');
    }
    const token = authHeader.slice(7);
    try {
      return jwt.verify(token, SECRET);
    } catch (e) {
      throw new Error('Invalid or expired token');
    }
  },
};

// Middleware: check Authorization header, decode token, attach user info to req.
export function authMiddleware(req, res, next) {
  try {
    const payload = auth.verify(req.headers.authorization);
    req.user = {
      id: payload.userId,
      role: payload.role,
      playerId: payload.playerId || null,
      email: payload.email || null,
    };
    next();
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
}
