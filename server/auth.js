// auth.js — role-based authentication via JWT.
// Admin: password-only login (stored in FMSS_AUTH_PASSWORD env var).
// Players: name (player_id) + PIN login (stored in auth_users.pin).
// Both return JWT with role + player_id; subsequent requests include token in Authorization header.

import jwt from 'jsonwebtoken';

const TOKEN_EXPIRY = '7d';

// Get SECRET dynamically so it reads the current env (loaded by index.js)
function getSecret() {
  return process.env.FMSS_AUTH_PASSWORD || 'change-me-in-env';
}

export const auth = {
  // Player login: player_id + PIN (with rate-limiting and PIN change enforcement)
  loginPlayer(db, authUsersRepo, playerId, pin) {
    const user = db.prepare(
      `SELECT id, player_id, pin, pin_salt, requires_pin_change FROM auth_users
       WHERE player_id = ? AND role = 'player' AND is_active = 1`
    ).get(playerId);

    if (!user) {
      throw new Error('Wrong name or PIN');
    }

    // Rate-limit: too many failed attempts?
    if (authUsersRepo.isRateLimited(db, user.id)) {
      throw new Error('Too many failed login attempts. Try again in 15 minutes.');
    }

    // Verify PIN (hashed comparison)
    const { valid, requires_change } = authUsersRepo.verifyPin(pin, user);
    if (!valid) {
      authUsersRepo.recordFailedLogin(db, user.id);
      throw new Error('Wrong name or PIN');
    }

    authUsersRepo.recordSuccessfulLogin(db, user.id);

    const payload = {
      userId: user.id,
      role: 'player',
      playerId: user.player_id,
      requiresPinChange: requires_change === 1,
    };
    const token = jwt.sign(payload, getSecret(), { expiresIn: TOKEN_EXPIRY });
    return { token, expiresIn: TOKEN_EXPIRY, requiresPinChange: requires_change === 1 };
  },

  // Admin login: password-only
  loginAdmin(password) {
    if (password !== getSecret()) {
      throw new Error('Invalid password');
    }
    const payload = {
      role: 'admin',
      adminMode: true,
    };
    const token = jwt.sign(payload, getSecret(), { expiresIn: TOKEN_EXPIRY });
    return { token, expiresIn: TOKEN_EXPIRY };
  },

  // Verify a token from the Authorization header and return the decoded payload.
  verify(authHeader) {
    if (!authHeader?.startsWith('Bearer ')) {
      throw new Error('Missing or invalid Authorization header');
    }
    const token = authHeader.slice(7);
    try {
      return jwt.verify(token, getSecret());
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
