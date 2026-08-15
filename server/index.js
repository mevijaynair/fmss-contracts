// index.js — Express entry point. Serves the API and the static frontend.
// Two-tier app: admin (password-only) + players (email+password). JWT auth.
// /api/login and /api/health are public; all other API endpoints require a valid Bearer token.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initSchema, seed, applyRoles, db } from './db.js';
import { auth, authMiddleware } from './auth.js';
import { authUsersRepo } from './repos/auth_users.js';
import api from './routes/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3100;   // 3100 keeps FMSS clear of SAMS (3000)

initSchema();
seed();                       // loads data/seed.json on a fresh DB
applyRoles();                 // idempotent business rules (Vijay = cashier)

const app = express();
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
  try {
    const { player_id, pin, password } = req.body;

    let result;
    if (player_id) {
      // Player login: name (player_id) + PIN
      if (!pin) return res.status(400).json({ error: 'PIN is required' });
      result = auth.loginPlayer(db, player_id, pin);
    } else {
      // Admin login: password only
      if (!password) return res.status(400).json({ error: 'password is required' });
      result = auth.loginAdmin(password);
    }

    res.json(result);
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// Protected endpoints (auth required)
app.use('/api', authMiddleware, api);
app.use(express.static(PUBLIC_DIR));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`FMSS running → http://localhost:${PORT}`);
});
