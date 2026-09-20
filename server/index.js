// index.js — Express entry point. Serves the API and the static frontend.
// Two-tier app: admin (password-only) + players (email+password). JWT auth.
// /api/login and /api/health are public; all other API endpoints require a valid Bearer token.

// Load .env file (simple approach without dotenv dependency)
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
function loadEnv() {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(__dir, '..', '.env');
  if (existsSync(envPath)) {
    try {
      const lines = readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (key) process.env[key] = val.replace(/^['"]|['"]$/g, '');
        }
      }
      console.log('[.env] Loaded environment from .env file');
    } catch (e) {
      console.error('[.env] Error loading .env:', e.message);
    }
  }
}
loadEnv();

import express from 'express';
import { initSchema, seed, applyRoles, db } from './db.js';
import { auth, authMiddleware } from './auth.js';
import { authUsersRepo } from './repos/auth_users.js';
import { checkLoginAllowed, recordLoginFailure, clearLoginFailures, clientIp } from './rate-limit.js';
import { noteLogin } from './devices.js';
import api from './routes/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3100;   // 3100 keeps FMSS clear of SAMS (3000)

initSchema();
seed();                       // loads data/seed.json on a fresh DB
applyRoles();                 // idempotent business rules (Vijay = cashier)

const app = express();

// Caddy terminates TLS and proxies to localhost, so without this every request
// arrives as 127.0.0.1 and a per-IP limit would throttle the whole club as one
// caller — the first attacker would lock everybody out. 'loopback' trusts the
// X-Forwarded-For set by a proxy on this machine and nothing else, so a header
// sent by a remote client cannot forge an address.
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));

// Public endpoints (no auth required)
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Public: player name list for the login name-picker (no balances, no PINs).
app.get('/api/login/players', (_req, res) => {
  try {
    res.json(authUsersRepo.publicPlayerList(db));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', (req, res) => {
  const { player_id, pin, password } = req.body || {};
  // One key per thing being guessed at. 'admin' is a real account here even
  // though it has no row of its own on this path — it is the master key, and
  // it had no limit of any kind before.
  const accountKey = player_id ? `player:${player_id}` : 'admin';

  // Asked before the secret is looked at, so a locked-out caller cannot tell
  // a wrong PIN from a right one, or a real name from an invented one.
  const blocked = checkLoginAllowed(req, accountKey);
  if (blocked) {
    res.set('Retry-After', String(blocked.retryAfter));
    return res.status(429).json({
      error: `Too many attempts. Try again in ${Math.ceil(blocked.retryAfter / 60)} minute(s).`,
    });
  }

  try {
    let result;
    if (player_id) {
      if (!pin) return res.status(400).json({ error: 'PIN is required' });
      result = auth.loginPlayer(db, authUsersRepo, player_id, pin);
    } else {
      if (!password) return res.status(400).json({ error: 'password is required' });
      result = auth.loginAdmin(db, password);
    }

    clearLoginFailures(req, accountKey);
    // Deliberately only what the browser needs to continue. The role is NOT
    // returned: the cashier signing in as themselves gets the admin side, and
    // announcing that in the login response would tell anyone probing the form
    // which single name is worth attacking. The client reads its role from
    // /me, which needs the token it has just been given.
    // Whether this account has signed in from here before. Told only to
    // somebody who has just proved they hold the account, and it says nothing
    // about who they are — so it leaks nothing to a prober while giving the
    // one person who would recognise an unfamiliar sign-in the chance to.
    const { isNew } = noteLogin(db, result.userId, clientIp(req));
    res.json({
      token: result.token,
      expiresIn: result.expiresIn,
      requiresPinChange: result.requiresPinChange === true,
      newDevice: isNew,
    });
  } catch (e) {
    recordLoginFailure(req, accountKey);
    // A rate-limit refusal is a 429 wherever it came from, so the two limiters
    // are indistinguishable from outside. Everything else is a plain 401 with
    // the same wording for a wrong name and a wrong PIN.
    const status = Number(e?.status) || 401;
    if (status === 429) res.set('Retry-After', '900');
    res.status(status).json({ error: e.message });
  }
});

// Protected endpoints (auth required)
app.use('/api', authMiddleware, api);
app.use(express.static(PUBLIC_DIR));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Exported so a test can shut it down; without a handle on it the process
// stays alive after the assertions finish and the run has to be killed.
export const server = app.listen(PORT, () => {
  console.log(`FMSS running → http://localhost:${PORT}`);
});
