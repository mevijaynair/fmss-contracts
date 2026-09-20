// auth.js — role-based authentication via JWT.
// Admin: password-only login (stored in FMSS_AUTH_PASSWORD env var).
// Players: name (player_id) + PIN login (stored in auth_users.pin).
// Both return JWT with role + player_id; subsequent requests include token in Authorization header.

import jwt from 'jsonwebtoken';

const TOKEN_EXPIRY = '7d';

// Two different secrets that used to be one.
//
// FMSS_AUTH_PASSWORD is a password a person types. FMSS_JWT_SECRET is the key
// every token is signed with. Using the password for both means changing the
// password — the ordinary, healthy thing to do with a password, and the first
// thing anybody would do if they thought it had leaked — silently invalidates
// every token in existence and signs all sixty players out at once. That is a
// good reason not to change it, which is the opposite of what a password
// wants.
//
// Falls back to the password when no separate secret is set, so nothing
// breaks on an install that has not been given one; setting FMSS_JWT_SECRET
// signs everybody out once and then the two are independent for good.
function getSecret() {
  return process.env.FMSS_JWT_SECRET || process.env.FMSS_AUTH_PASSWORD || 'change-me-in-env';
}

function getAdminPassword() {
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

    // The per-account counter kept in the database. It backs up the in-memory
    // limiter in front of this route by surviving a restart, which that one
    // cannot.
    //
    // Carries a status so it answers 429 like the other limiter rather than
    // 401, and says the same thing however it was reached. It used to say
    // "Too many failed login attempts" only for accounts that EXIST — a name
    // that does not exist fails instantly with "Wrong name or PIN" — so the
    // two messages together told an attacker which of the published names were
    // real before they had guessed a single PIN.
    if (authUsersRepo.isRateLimited(db, user.id)) {
      throw Object.assign(new Error('Too many attempts. Try again in 15 minute(s).'),
        { status: 429 });
    }

    // Verify PIN (hashed comparison)
    const { valid, requires_change } = authUsersRepo.verifyPin(pin, user);
    if (!valid) {
      authUsersRepo.recordFailedLogin(db, user.id);
      throw new Error('Wrong name or PIN');
    }

    authUsersRepo.recordSuccessfulLogin(db, user.id);

    // verifyPin already reduced the column to a boolean, so comparing it to the
    // NUMBER 1 was false for everyone, always. The flag has therefore never once
    // reached the browser — which is why nothing was built to act on it and why
    // all 54 production logins still sit at requires_pin_change = 1, on the PIN
    // they were handed.
    // The cashier runs the club's money. Signing in under their own name used
    // to drop them into the read-only player view — one ledger and nothing
    // else — which looks exactly like an app with no data in it, and is the
    // reason this was reported as the site being empty.
    //
    // Gated on having replaced the issued PIN. Club PINs are handed out over
    // WhatsApp and are known to whoever passed them on, so one must never be
    // enough to unlock the admin side; resetting the cashier's PIN closes this
    // again until they choose a new one. It stays a weaker key than the admin
    // password either way, which is why it is granted to this one role and not
    // to a general "is this person staff" flag.
    const person = db.prepare('SELECT special_role FROM players WHERE id = ?').get(user.player_id);
    const elevated = person?.special_role === 'cashier' && requires_change !== true;

    const payload = {
      userId: user.id,
      // Their own player id travels either way, so "my ledger", "my
      // contributions" and their own snapshot keep working when elevated.
      role: elevated ? 'admin' : 'player',
      ...(elevated ? { adminMode: true } : {}),
      playerId: user.player_id,
      requiresPinChange: requires_change === true,
    };
    const token = jwt.sign(payload, getSecret(), { expiresIn: TOKEN_EXPIRY });
    // `role` is for callers inside the server — the tests, and anything that
    // needs to reason about what just happened. It must NOT be put in the HTTP
    // response: announcing that one particular name signs in as an admin tells
    // anyone probing the login form exactly which of the sixty published names
    // is worth attacking. /api/login returns three fields by hand for that
    // reason; do not spread this object into it.
    return {
      token, expiresIn: TOKEN_EXPIRY,
      requiresPinChange: requires_change === true,
      role: payload.role,
      userId: user.id,
    };
  },

  // Admin login: password-only
  loginAdmin(db, password) {
    if (password !== getAdminPassword()) {
      // Recorded, because until now a failed admin login left no trace
      // anywhere: a player's failures are counted on their row, and the
      // master key's were not counted at all. Somebody working through
      // guesses at the one password that opens everything is precisely what
      // there should be a record of. The attempt is logged; what was typed
      // never is.
      try {
        db.prepare(`INSERT INTO audit_log (id, user_id, action, details, created_at)
                    VALUES (?, 'admin', 'admin_login_failed', NULL, ?)`)
          .run(`al_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
            new Date().toISOString());
      } catch { /* a login must not fail because its audit row did */ }
      throw new Error('Invalid password');
    }
    // Carry the shared admin's id so req.user.id is a real auth_users row.
    // Without it the token had no identity at all, and everything that records
    // who acted — transfer approvals, audit entries — had nothing to write.
    // Falls back to null rather than failing a login if the row is somehow
    // absent: signing in matters more than attribution.
    const admin = db.prepare("SELECT id FROM auth_users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get();
    const payload = {
      userId: admin?.id ?? null,
      role: 'admin',
      adminMode: true,
    };
    const token = jwt.sign(payload, getSecret(), { expiresIn: TOKEN_EXPIRY });
    return { token, expiresIn: TOKEN_EXPIRY, userId: admin?.id ?? null };
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
