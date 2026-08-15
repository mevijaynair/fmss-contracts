// auth.js — role-based authentication via JWT.
// Admin: password-only login (stored in FMSS_AUTH_PASSWORD env var).
// Players: name (player_id) + PIN login (stored in auth_users.pin).
// Both return JWT with role + player_id; subsequent requests include token in Authorization header.

import jwt from 'jsonwebtoken';

const SECRET = process.env.FMSS_AUTH_PASSWORD || 'change-me-in-env';
const TOKEN_EXPIRY = '7d';

export const auth = {
  // Player login: player_id + PIN
  loginPlayer(db, playerId, pin) {
    const user = db.prepare(
      `SELECT id, player_id, pin FROM auth_users
       WHERE player_id = ? AND role = 'player' AND is_active = 1`
    ).get(playerId);

    if (!user || String(user.pin) !== String(pin)) {
      throw new Error('Wrong name or PIN');
    }

    const payload = {
      userId: user.id,
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
