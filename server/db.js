// db.js — SQLite connection, schema, and seed (from data/seed.json).
//
// Uses Node's built-in `node:sqlite` (Node >= 22.5) so there is nothing to
// install. The DB is a single file under data/. seed.json is produced by
// scripts/extract_excel.py from the source workbook.

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = process.env.FMSS_DB_PATH || join(DATA_DIR, 'fmss.db');
const SEED_PATH = join(DATA_DIR, 'seed.json');

// Ensure the DB's own directory exists. Use dirname(DB_PATH) (not DATA_DIR) so a
// production FMSS_DB_PATH like /data/fmss.db works even when the app dir is
// read-only under systemd ProtectSystem=strict (only /data is writable then).
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contracts (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  venue        TEXT,
  cost_per_gw  REAL NOT NULL DEFAULT 0,
  rates        TEXT NOT NULL DEFAULT '{}',
  sort         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  aliases     TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledgers (
  player_id        TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  contract_id      TEXT NOT NULL REFERENCES contracts(id),
  opening_balance  REAL NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (player_id, contract_id)
);

CREATE TABLE IF NOT EXISTS gameweeks (
  id               TEXT PRIMARY KEY,
  contract_id      TEXT NOT NULL REFERENCES contracts(id),
  gw_number        INTEGER,
  contract_number  INTEGER,
  date             TEXT,
  cost_per_gw      REAL NOT NULL DEFAULT 0,
  num_players      INTEGER NOT NULL DEFAULT 0,
  teams_raw        TEXT NOT NULL DEFAULT '',
  captains_raw     TEXT NOT NULL DEFAULT '',
  score            TEXT NOT NULL DEFAULT '',
  comments         TEXT NOT NULL DEFAULT '',
  historical       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gw_contract ON gameweeks(contract_id, date);

CREATE TABLE IF NOT EXISTS charges (
  id            TEXT PRIMARY KEY,
  gameweek_id   TEXT NOT NULL REFERENCES gameweeks(id) ON DELETE CASCADE,
  player_id     TEXT NOT NULL REFERENCES players(id),
  team          TEXT NOT NULL DEFAULT '',
  is_captain    INTEGER NOT NULL DEFAULT 0,
  rate_type     TEXT NOT NULL DEFAULT '',
  amount        REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_charge_gw ON charges(gameweek_id);
CREATE INDEX IF NOT EXISTS idx_charge_player ON charges(player_id);

CREATE TABLE IF NOT EXISTS contributions (
  id            TEXT PRIMARY KEY,
  player_id     TEXT REFERENCES players(id),
  contract_id   TEXT REFERENCES contracts(id),
  name_raw      TEXT NOT NULL DEFAULT '',
  amount        REAL NOT NULL DEFAULT 0,
  date          TEXT,
  comments      TEXT NOT NULL DEFAULT '',
  historical    INTEGER NOT NULL DEFAULT 0,    -- 1 = imported; excluded from live balance
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contrib_player ON contributions(player_id, contract_id);

CREATE TABLE IF NOT EXISTS kitty (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'expense',  -- income | expense
  label       TEXT NOT NULL DEFAULT '',
  amount      REAL NOT NULL DEFAULT 0,
  date        TEXT,
  scope       TEXT NOT NULL DEFAULT '',
  historical  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

-- charge_id is a LOGICAL reference (no hard FK): an audit log must survive the
-- deletion of the charge/gameweek it describes. A hard FK would otherwise block
-- deleting any game that has edited charges.
CREATE TABLE IF NOT EXISTS charge_audit (
  id                 TEXT PRIMARY KEY,
  charge_id          TEXT,
  original_amount    REAL,
  new_amount         REAL,
  reason             TEXT,
  changed_by         TEXT,
  auto_recalculate   INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_charge ON charge_audit(charge_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON charge_audit(created_at);

CREATE TABLE IF NOT EXISTS auth_users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  password_hash TEXT NOT NULL DEFAULT '',
  pin           TEXT,                 -- current PIN (SHA-256 hashed with salt)
  pin_salt      TEXT,                 -- random salt for PIN hash
  requires_pin_change INTEGER NOT NULL DEFAULT 1,  -- 1 = must change PIN on first login
  pin_changed_at TEXT,                -- timestamp of last PIN change
  login_attempts INTEGER NOT NULL DEFAULT 0,       -- failed login count (for rate-limiting)
  last_failed_login TEXT,              -- timestamp of last failed attempt
  role          TEXT NOT NULL DEFAULT 'player' CHECK(role IN ('player', 'admin')),
  player_id     TEXT REFERENCES players(id),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_email ON auth_users(email);
CREATE INDEX IF NOT EXISTS idx_auth_role ON auth_users(role);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_player ON auth_users(player_id);

CREATE TABLE IF NOT EXISTS pin_history (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES auth_users(id),
  old_pin_hash  TEXT NOT NULL,
  changed_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pin_history_user ON pin_history(user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  user_id       TEXT REFERENCES auth_users(id),
  player_id     TEXT REFERENCES players(id),  -- for actions not via auth (admin entry on player behalf)
  action        TEXT NOT NULL,                -- login, pin_change, contribution, balance_adjust, etc.
  details       TEXT,                         -- JSON with context (e.g. {"old_pin":"hash", "reason":"forgotten"})
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_player ON audit_log(player_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);

-- Unified transaction ledger: every balance change (contribution, charge, event, transfer, adjustment)
CREATE TABLE IF NOT EXISTS transactions (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id),
  contract_id   TEXT REFERENCES contracts(id),
  type          TEXT NOT NULL CHECK(type IN ('contribution', 'charge', 'event_deduction', 'transfer_out', 'transfer_in', 'adjustment')),
  amount        REAL NOT NULL,              -- positive = credit, negative = debit
  description   TEXT,
  related_player_id TEXT REFERENCES players(id),  -- for transfers (from_player)
  event_id      TEXT,                       -- for external events (links to external_events table)
  game_id       TEXT REFERENCES gameweeks(id),  -- for game charges
  status        TEXT NOT NULL DEFAULT 'approved' CHECK(status IN ('pending', 'approved', 'rejected')),
  approved_by   TEXT REFERENCES auth_users(id),  -- admin who approved
  created_by    TEXT,                       -- player ID or admin ID who created
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  audit_notes   TEXT                        -- admin comments on edits
);
CREATE INDEX IF NOT EXISTS idx_txn_player ON transactions(player_id);
CREATE INDEX IF NOT EXISTS idx_txn_contract ON transactions(contract_id);
CREATE INDEX IF NOT EXISTS idx_txn_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_txn_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_txn_event ON transactions(event_id);
CREATE INDEX IF NOT EXISTS idx_txn_game ON transactions(game_id);
CREATE INDEX IF NOT EXISTS idx_txn_created ON transactions(created_at);

-- External events (restaurant bills, venue costs, etc.) — groups related transactions
CREATE TABLE IF NOT EXISTS external_events (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,              -- "Team lunch at XYZ", "Venue rental"
  description   TEXT,
  event_date    TEXT NOT NULL,
  event_type    TEXT NOT NULL,              -- 'meal', 'venue', 'equipment', 'other'
  created_by    TEXT NOT NULL REFERENCES auth_users(id),  -- admin who created
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_type ON external_events(event_type);
CREATE INDEX IF NOT EXISTS idx_event_date ON external_events(event_date);

CREATE TABLE IF NOT EXISTS admin_config (
  id                   TEXT PRIMARY KEY,
  admin_password_hash  TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contributions_pending (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id),
  contract_id   TEXT NOT NULL REFERENCES contracts(id),
  amount        REAL NOT NULL DEFAULT 0,
  date          TEXT,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  reviewed_by   TEXT,
  reviewed_at   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contrib_pending_player ON contributions_pending(player_id, status);
`;



export function initSchema() {
  db.exec(SCHEMA);
  // Safe migrations: add new columns if they don't exist
  const migrations = [
    // gameweeks: add game_type, tournament_name
    () => {
      try {
        db.prepare('SELECT game_type FROM gameweeks LIMIT 1').get();
      } catch {
        db.exec('ALTER TABLE gameweeks ADD COLUMN game_type TEXT NOT NULL DEFAULT "regular"');
      }
    },
    () => {
      try {
        db.prepare('SELECT tournament_name FROM gameweeks LIMIT 1').get();
      } catch {
        db.exec('ALTER TABLE gameweeks ADD COLUMN tournament_name TEXT');
      }
    },
    // players: add special_role
    () => {
      try {
        db.prepare('SELECT special_role FROM players LIMIT 1').get();
      } catch {
        db.exec('ALTER TABLE players ADD COLUMN special_role TEXT');
      }
    },
    // contracts: add tournament_rates
    () => {
      try {
        db.prepare('SELECT tournament_rates FROM contracts LIMIT 1').get();
      } catch {
        db.exec('ALTER TABLE contracts ADD COLUMN tournament_rates TEXT NOT NULL DEFAULT "{}"');
      }
    },
    // charge_audit: drop the hard FK to charges so deleting a game with edited
    // charges no longer fails. Rebuild the table only if a FK is still present.
    () => {
      const fks = db.prepare('PRAGMA foreign_key_list(charge_audit)').all();
      if (fks.length === 0) return;
      db.exec('PRAGMA foreign_keys = OFF;');
      db.exec(`CREATE TABLE charge_audit_new (
        id TEXT PRIMARY KEY, charge_id TEXT, original_amount REAL, new_amount REAL,
        reason TEXT, changed_by TEXT, auto_recalculate INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL);`);
      db.exec(`INSERT INTO charge_audit_new
        SELECT id, charge_id, original_amount, new_amount, reason, changed_by,
               auto_recalculate, created_at FROM charge_audit;`);
      db.exec('DROP TABLE charge_audit;');
      db.exec('ALTER TABLE charge_audit_new RENAME TO charge_audit;');
      db.exec('CREATE INDEX IF NOT EXISTS idx_audit_charge ON charge_audit(charge_id);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_audit_created ON charge_audit(created_at);');
      db.exec('PRAGMA foreign_keys = ON;');
    },
    // auth_users: exists (created in SCHEMA above)
    () => {
      try {
        db.prepare('SELECT id FROM auth_users LIMIT 1').get();
      } catch {
        // Already created in SCHEMA
      }
    },
    // auth_users.pin: add for the name+PIN player login model
    () => {
      try {
        db.prepare('SELECT pin FROM auth_users LIMIT 1').get();
      } catch {
        db.exec('ALTER TABLE auth_users ADD COLUMN pin TEXT');
      }
      // One login per player (idempotent).
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_player ON auth_users(player_id)');
    },
    // auth_users: add PIN security columns (pin_salt, requires_pin_change, pin_changed_at, login_attempts, last_failed_login)
    () => {
      const cols = db.prepare('PRAGMA table_info(auth_users)').all();
      const hasPin_salt = cols.some(c => c.name === 'pin_salt');
      if (!hasPin_salt) {
        db.exec(`ALTER TABLE auth_users ADD COLUMN pin_salt TEXT`);
        db.exec(`ALTER TABLE auth_users ADD COLUMN requires_pin_change INTEGER NOT NULL DEFAULT 1`);
        db.exec(`ALTER TABLE auth_users ADD COLUMN pin_changed_at TEXT`);
        db.exec(`ALTER TABLE auth_users ADD COLUMN login_attempts INTEGER NOT NULL DEFAULT 0`);
        db.exec(`ALTER TABLE auth_users ADD COLUMN last_failed_login TEXT`);
      }
    },
    // pin_history: track old PINs to prevent reuse
    () => {
      try {
        db.prepare('SELECT id FROM pin_history LIMIT 1').get();
      } catch {
        db.exec(`CREATE TABLE pin_history (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id),
          old_pin_hash TEXT NOT NULL, changed_at TEXT NOT NULL)`);
        db.exec('CREATE INDEX IF NOT EXISTS idx_pin_history_user ON pin_history(user_id)');
      }
    },
    // audit_log: track all auth, balance, and contribution changes
    () => {
      try {
        db.prepare('SELECT id FROM audit_log LIMIT 1').get();
      } catch {
        db.exec(`CREATE TABLE audit_log (
          id TEXT PRIMARY KEY, user_id TEXT REFERENCES auth_users(id),
          player_id TEXT REFERENCES players(id),
          action TEXT NOT NULL, details TEXT, ip_address TEXT, user_agent TEXT, created_at TEXT NOT NULL)`);
        db.exec('CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_audit_player ON audit_log(player_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at)');
      }
    },
    // admin_config: exists (created in SCHEMA above)
    () => {
      try {
        db.prepare('SELECT id FROM admin_config LIMIT 1').get();
      } catch {
        // Already created in SCHEMA
      }
    },
    // contributions_pending: exists (created in SCHEMA above)
    () => {
      try {
        db.prepare('SELECT id FROM contributions_pending LIMIT 1').get();
      } catch {
        // Already created in SCHEMA
      }
    },
    // transactions: unified ledger for all balance changes
    () => {
      try {
        db.prepare('SELECT id FROM transactions LIMIT 1').get();
      } catch {
        db.exec(`CREATE TABLE transactions (
          id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id),
          contract_id TEXT REFERENCES contracts(id),
          type TEXT NOT NULL CHECK(type IN ('contribution', 'charge', 'event_deduction', 'transfer_out', 'transfer_in', 'adjustment')),
          amount REAL NOT NULL, description TEXT, related_player_id TEXT REFERENCES players(id),
          event_id TEXT, game_id TEXT REFERENCES gameweeks(id),
          status TEXT NOT NULL DEFAULT 'approved' CHECK(status IN ('pending', 'approved', 'rejected')),
          approved_by TEXT REFERENCES auth_users(id), created_by TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, audit_notes TEXT)`);
        db.exec('CREATE INDEX IF NOT EXISTS idx_txn_player ON transactions(player_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_txn_contract ON transactions(contract_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_txn_type ON transactions(type)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_txn_status ON transactions(status)');
      }
    },
    // external_events: groups related transactions (restaurant bills, venue costs, etc.)
    () => {
      try {
        db.prepare('SELECT id FROM external_events LIMIT 1').get();
      } catch {
        db.exec(`CREATE TABLE external_events (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, event_date TEXT NOT NULL,
          event_type TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES auth_users(id),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
        db.exec('CREATE INDEX IF NOT EXISTS idx_event_type ON external_events(event_type)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_event_date ON external_events(event_date)');
      }
    },
    // players: add is_sandbox flag for test players that can be deleted without affecting data
    () => {
      const cols = db.prepare('PRAGMA table_info(players)').all();
      const hasSandbox = cols.some(c => c.name === 'is_sandbox');
      if (!hasSandbox) {
        db.exec('ALTER TABLE players ADD COLUMN is_sandbox INTEGER NOT NULL DEFAULT 0');
        db.exec('CREATE INDEX IF NOT EXISTS idx_players_sandbox ON players(is_sandbox)');
      }
    },
    // opening_balances_snapshot: immutable record of opening balance imports (1 Aug baseline per contract)
    () => {
      try {
        db.prepare('SELECT id FROM opening_balances_snapshot LIMIT 1').get();
      } catch {
        db.exec(`CREATE TABLE opening_balances_snapshot (
          id TEXT PRIMARY KEY,
          contract_id TEXT NOT NULL REFERENCES contracts(id),
          player_id TEXT NOT NULL REFERENCES players(id),
          opening_balance REAL NOT NULL,
          imported_by TEXT NOT NULL REFERENCES auth_users(id),
          import_batch TEXT NOT NULL,
          locked_at TEXT NOT NULL,
          notes TEXT
        )`);
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshot_contract_player ON opening_balances_snapshot(contract_id, player_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_snapshot_batch ON opening_balances_snapshot(import_batch)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_snapshot_locked ON opening_balances_snapshot(locked_at)');
      }
    },
    // ledgers: add is_opening_balanced flag (immutable once set) for data integrity
    () => {
      const cols = db.prepare('PRAGMA table_info(ledgers)').all();
      const hasLocked = cols.some(c => c.name === 'is_opening_balanced');
      if (!hasLocked) {
        db.exec('ALTER TABLE ledgers ADD COLUMN is_opening_balanced INTEGER NOT NULL DEFAULT 0');
        db.exec('ALTER TABLE ledgers ADD COLUMN opening_balanced_at TEXT');
      }
    },
    // gameweeks: add game accounting fields (scoreline, teams, message, costs, kitty)
    () => {
      const cols = db.prepare('PRAGMA table_info(gameweeks)').all();
      const hasScoreline = cols.some(c => c.name === 'scoreline');
      if (!hasScoreline) {
        db.exec('ALTER TABLE gameweeks ADD COLUMN scoreline TEXT'); // e.g., "5-3"
        db.exec('ALTER TABLE gameweeks ADD COLUMN teams_json TEXT'); // JSON: [{ player_id, team }]
        db.exec('ALTER TABLE gameweeks ADD COLUMN whatsapp_message TEXT'); // Original message
        db.exec('ALTER TABLE gameweeks ADD COLUMN game_cost REAL NOT NULL DEFAULT 0'); // Water, facility cost
        db.exec('ALTER TABLE gameweeks ADD COLUMN game_cost_paid_by TEXT'); // Player ID or 'self'
        db.exec('ALTER TABLE gameweeks ADD COLUMN kitty_earned REAL NOT NULL DEFAULT 0'); // Additional money collected
      }
    },
    // game_results: team-level results (Team A vs Team B, score, goals)
    () => {
      try {
        db.prepare('SELECT id FROM game_results LIMIT 1').get();
      } catch {
        db.exec(`CREATE TABLE game_results (
          id TEXT PRIMARY KEY,
          gameweek_id TEXT NOT NULL REFERENCES gameweeks(id) ON DELETE CASCADE,
          team_a_name TEXT NOT NULL,          -- "Team A", "Blue", etc.
          team_b_name TEXT NOT NULL,
          goals_team_a INTEGER NOT NULL DEFAULT 0,
          goals_team_b INTEGER NOT NULL DEFAULT 0,
          result TEXT NOT NULL CHECK(result IN ('draw', 'a_wins', 'b_wins')),
          created_at TEXT NOT NULL
        )`);
        db.exec('CREATE INDEX IF NOT EXISTS idx_game_results_gw ON game_results(gameweek_id)');
      }
    },
    // game_financing: track who paid water cost and provisional amounts
    () => {
      try {
        db.prepare('SELECT id FROM game_financing LIMIT 1').get();
      } catch {
        db.exec(`CREATE TABLE game_financing (
          id TEXT PRIMARY KEY,
          gameweek_id TEXT NOT NULL REFERENCES gameweeks(id) ON DELETE CASCADE,
          contract_id TEXT NOT NULL REFERENCES contracts(id),
          category TEXT NOT NULL CHECK(category IN ('water_cost', 'kitty_collection')),
          payer_id TEXT REFERENCES players(id),             -- who paid/collected
          amount REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'provisional' CHECK(status IN ('provisional', 'settled')),
          settled_at TEXT,
          notes TEXT,
          created_at TEXT NOT NULL
        )`);
        db.exec('CREATE INDEX IF NOT EXISTS idx_financing_gw ON game_financing(gameweek_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_financing_contract ON game_financing(contract_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_financing_category ON game_financing(category)');
      }
    },
  ];
  for (const mig of migrations) mig();
}

// Apply persistent business rules that must hold regardless of seed state.
// Idempotent — safe to run on every startup. Currently: Vijay is the cashier
// (custodian of funds) and is excluded from contributions for audit integrity.
export function applyRoles() {
  db.prepare(
    `UPDATE players SET special_role = 'cashier'
     WHERE special_role IS NULL AND (id = 'vijay' OR LOWER(name) = 'vijay')`
  ).run();
}

export function seed({ force = false } = {}) {
  initSchema();
  const n = db.prepare('SELECT COUNT(*) AS n FROM contracts').get().n;
  if (n > 0 && !force) {
    console.log('Seed skipped — data already exists. Use --reseed to wipe & reload.');
    return;
  }
  if (force) {
    for (const t of ['charge_audit', 'charges', 'gameweeks', 'contributions', 'kitty',
                      'ledgers', 'players', 'contracts', 'meta']) {
      db.exec(`DELETE FROM ${t};`);
    }
  }
  if (!existsSync(SEED_PATH)) {
    console.error(`No seed file at ${SEED_PATH}. Run: python scripts/extract_excel.py`);
    return;
  }
  const data = JSON.parse(readFileSync(SEED_PATH, 'utf-8'));
  const now = new Date().toISOString();

  const insContract = db.prepare(
    'INSERT INTO contracts (id,name,venue,cost_per_gw,rates,tournament_rates,sort) VALUES (?,?,?,?,?,?,?)');
  for (const c of data.contracts)
    insContract.run(c.id, c.name, c.venue, c.cost_per_gw, JSON.stringify(c.rates),
      JSON.stringify(c.tournament_rates || {}), c.sort);

  const insPlayer = db.prepare(
    'INSERT INTO players (id,name,aliases,special_role,created_at) VALUES (?,?,?,?,?)');
  for (const p of data.players)
    insPlayer.run(p.id, p.name, JSON.stringify(p.aliases || []), p.special_role || null, now);

  const insLedger = db.prepare(
    'INSERT OR REPLACE INTO ledgers (player_id,contract_id,opening_balance,status) VALUES (?,?,?,?)');
  for (const l of data.ledgers)
    insLedger.run(l.player_id, l.contract_id, l.opening_balance, l.status || '');

  const insGw = db.prepare(`INSERT INTO gameweeks
    (id,contract_id,gw_number,contract_number,date,cost_per_gw,num_players,
     teams_raw,captains_raw,score,comments,game_type,tournament_name,historical,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insCharge = db.prepare(`INSERT INTO charges
    (id,gameweek_id,player_id,team,is_captain,rate_type,amount) VALUES (?,?,?,?,?,?,?)`);
  let ci = 0;
  for (const g of data.gameweeks) {
    insGw.run(g.id, g.contract_id, g.gw_number, g.contract_number, g.date,
      g.cost_per_gw, g.num_players, g.teams_raw, g.captains_raw, g.score,
      g.comments || '', g.game_type || 'regular', g.tournament_name || null,
      g.historical ?? 1, now);
    for (const ch of g.charges || [])
      insCharge.run(`c_${ci++}`, g.id, ch.player_id, ch.team || '',
        ch.is_captain ? 1 : 0, ch.rate_type || 'historical', ch.amount);
  }

  const insContrib = db.prepare(`INSERT INTO contributions
    (id,player_id,contract_id,name_raw,amount,date,comments,historical,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  let qi = 0;
  for (const c of data.contributions)
    insContrib.run(`q_${qi++}`, c.player_id, c.contract_id || null, c.name_raw || '',
      c.amount, c.date, c.comments || '', c.historical ?? 1, now);

  const insKitty = db.prepare(`INSERT INTO kitty
    (id,kind,label,amount,date,scope,historical,created_at) VALUES (?,?,?,?,?,?,?,?)`);
  let ki = 0;
  for (const k of data.kitty)
    insKitty.run(`k_${ki++}`, k.kind, k.label, k.amount, k.date, k.scope || '',
      k.historical ?? 1, now);

  const insMeta = db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)');
  for (const [key, value] of Object.entries(data.meta || {}))
    insMeta.run(key, String(value));

  console.log(`Seeded ${data.contracts.length} contracts, ${data.players.length} players, `
    + `${data.gameweeks.length} gameweeks, ${data.contributions.length} contributions, `
    + `${data.kitty.length} kitty entries.`);
}

// CLI: node server/db.js --seed | --reseed
if (process.argv[1] && process.argv[1].endsWith('db.js')) {
  if (process.argv.includes('--reseed')) seed({ force: true });
  else if (process.argv.includes('--seed')) seed();
}
