// auth.js — single-password authentication via JWT.
// No username: just a password. Login returns a JWT; subsequent requests include it
// in the Authorization header (Bearer token). Logout clears the client-side token.

import jwt from 'jsonwebtoken';

const SECRET = process.env.FMSS_AUTH_PASSWORD || 'change-me-in-env';
const TOKEN_EXPIRY = '7d';

export const auth = {
  // Generate a JWT for a successful login.
  login(password) {
    if (password !== SECRET) {
      throw new Error('Invalid password');
    }
    const token = jwt.sign({ authenticated: true }, SECRET, { expiresIn: TOKEN_EXPIRY });
    return { token, expiresIn: TOKEN_EXPIRY };
  },

  // Verify a token from the Authorization header.
  verify(authHeader) {
    if (!authHeader?.startsWith('Bearer ')) {
      throw new Error('Missing or invalid Authorization header');
    }
    const token = authHeader.slice(7);
    try {
      jwt.verify(token, SECRET);
      return true;
    } catch (e) {
      throw new Error('Invalid or expired token');
    }
  },
};

// Middleware: check Authorization header, attach to req.
export function authMiddleware(req, res, next) {
  try {
    auth.verify(req.headers.authorization);
    next();
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
}
