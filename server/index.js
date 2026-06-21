// index.js — Express entry point. Serves the API and the static frontend.
// Two-tier app: admin (password-only) + players (email+password). JWT auth.
// /api/login and /api/health are public; all other API endpoints require a valid Bearer token.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initSchema, seed, applyRoles, db } from './db.js';
import { auth, authMiddleware } from './auth.js';
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
app.post('/api/login', (req, res) => {
  try {
    const { email, password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'password is required' });
    }

    let result;
    if (email) {
      // Player login
      result = auth.loginPlayer(db, email, password);
    } else {
      // Admin login
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
