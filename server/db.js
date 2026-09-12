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

// Exported so the backup code can snapshot the real file, whether the path came
// from FMSS_DB_PATH or the default under data/.
export const DB_FILE = DB_PATH;

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
  -- Plain TEXT, like transactions.created_by: an admin signed in with the
  -- shared password has no auth_users row to point at.
  created_by    TEXT,
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
    // charges: settlement tracking. The UI has read charge.paid since the
    // settlement view was built, but the column never existed — so every game
    // reported an unknown (previously a falsely "collected") status.
    () => {
      try { db.prepare('SELECT paid FROM charges LIMIT 1').get(); }
      catch { db.exec('ALTER TABLE charges ADD COLUMN paid INTEGER NOT NULL DEFAULT 0'); }
    },
    () => {
      try { db.prepare('SELECT paid_at FROM charges LIMIT 1').get(); }
      catch { db.exec('ALTER TABLE charges ADD COLUMN paid_at TEXT'); }
    },
    () => {
      try { db.prepare('SELECT paid_method FROM charges LIMIT 1').get(); }
      catch { db.exec('ALTER TABLE charges ADD COLUMN paid_method TEXT'); }
    },
    // charges: who actually carries the cost. An outside player is billed to the
    // contracted player who brought them, so the charge and the payer differ.
    () => {
      try { db.prepare('SELECT charged_to FROM charges LIMIT 1').get(); }
      catch { db.exec('ALTER TABLE charges ADD COLUMN charged_to TEXT'); }
    },
    // NOTE ON QUOTING: string literals in DDL must use SINGLE quotes. Double
    // quotes denote an IDENTIFIER in SQL; SQLite only accepts them as strings
    // via a deprecated fallback for unresolvable identifiers. That fallback is
    // not applied when the schema is re-parsed strictly, so a double-quoted
    // DEFAULT makes VACUUM fail outright with
    //   no such column: "regular" - should this be a string literal in single-quotes?
    // which disables VACUUM-based backup and maintenance for the whole database.
    //
    // gameweeks: add game_type, tournament_name
    () => {
      try {
        db.prepare('SELECT game_type FROM gameweeks LIMIT 1').get();
      } catch {
        db.exec("ALTER TABLE gameweeks ADD COLUMN game_type TEXT NOT NULL DEFAULT 'regular'");
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
        db.exec("ALTER TABLE contracts ADD COLUMN tournament_rates TEXT NOT NULL DEFAULT '{}'");
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
    // players: add relationship fields (introduced_by, player_type, outside_cost)
    () => {
      const cols = db.prepare('PRAGMA table_info(players)').all();
      const hasIntroducedBy = cols.some(c => c.name === 'introduced_by');
      if (!hasIntroducedBy) {
        db.exec('ALTER TABLE players ADD COLUMN introduced_by TEXT REFERENCES players(id)'); // Who brought them in
        db.exec("ALTER TABLE players ADD COLUMN player_type TEXT NOT NULL DEFAULT 'regular' CHECK(player_type IN ('regular', 'outside'))");
        db.exec('ALTER TABLE players ADD COLUMN outside_cost REAL'); // 35 or 40 for outside players
        db.exec('ALTER TABLE players ADD COLUMN balance_group_id TEXT'); // Shared balance group (e.g., "aws_ali")
      }
    },

    // player_balance_groups: manage linked/shared balances (Aws & Ali as one)
    () => {
      try {
        db.prepare('SELECT id FROM player_balance_groups LIMIT 1').get();
      } catch {
        db.exec(`CREATE TABLE player_balance_groups (
          id TEXT PRIMARY KEY,
          group_name TEXT NOT NULL,
          contract_id TEXT NOT NULL REFERENCES contracts(id),
          description TEXT,
          created_at TEXT NOT NULL
        )`);
        db.exec('CREATE INDEX IF NOT EXISTS idx_balance_groups_contract ON player_balance_groups(contract_id)');
      }
    },

    // kitty_opening_balance: one-time immutable kitty balance snapshot (like player opening_balances)
    () => {
      try {
        db.prepare('SELECT id FROM kitty_opening_balance LIMIT 1').get();
      } catch {
        db.exec(`CREATE TABLE kitty_opening_balance (
          id TEXT PRIMARY KEY,
          contract_id TEXT NOT NULL UNIQUE REFERENCES contracts(id),
          snapshot_date TEXT NOT NULL,
          opening_amount REAL NOT NULL,
          imported_by TEXT,
          locked_at TEXT NOT NULL,
          notes TEXT
        )`);
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_kitty_opening_contract ON kitty_opening_balance(contract_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_kitty_opening_locked ON kitty_opening_balance(locked_at)');
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

    // external_events: turn a flat split-the-bill record into a budgeted programme
    // (an Onam night, a tour) that can be planned before it happens, priced per
    // head by tier, and closed once the money is in.
    () => {
      const cols = db.prepare('PRAGMA table_info(external_events)').all().map(c => c.name);
      const add = (sql) => db.exec(`ALTER TABLE external_events ADD COLUMN ${sql}`);
      // Which ledger a balance-charged attendee is billed against.
      if (!cols.includes('contract_id')) add('contract_id TEXT REFERENCES contracts(id)');
      // What it was expected to cost, versus what it actually cost.
      if (!cols.includes('budget_amount')) add('budget_amount REAL NOT NULL DEFAULT 0');
      if (!cols.includes('actual_amount')) add('actual_amount REAL NOT NULL DEFAULT 0');
      // Who fronted the real spend, if anyone — they get credited for it.
      if (!cols.includes('paid_by_player_id')) add('paid_by_player_id TEXT REFERENCES players(id)');
      // Per-head price list, e.g. {"adult":150,"child":75,"infant":0}. Held as
      // JSON because it is small, per-event, and only ever read whole.
      if (!cols.includes('tiers')) add("tiers TEXT NOT NULL DEFAULT '{}'");
      if (!cols.includes('status')) {
        add("status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning', 'open', 'closed'))");
      }
      if (!cols.includes('closed_at')) add('closed_at TEXT');
    },

    // external_events.created_by was NOT NULL REFERENCES auth_users(id), which an
    // admin signed in with the shared password can never satisfy — they have no
    // auth_users row, so req.user.id is undefined and every insert died on the
    // binding. transactions.created_by is plain nullable TEXT for exactly this
    // reason; match it. Rebuilt rather than altered because SQLite cannot drop a
    // NOT NULL in place.
    () => {
      const fk = db.prepare('PRAGMA foreign_key_list(external_events)').all();
      const createdBy = db.prepare('PRAGMA table_info(external_events)').all()
        .find(c => c.name === 'created_by');
      if (!createdBy || (createdBy.notnull === 0 && fk.every(f => f.from !== 'created_by'))) return;

      // RENAME re-parses the whole schema, so on a database still carrying the
      // double-quoted literals that be95df1 describes it fails on an unrelated
      // table. That is a repairable condition (scripts/fix-schema-quoting.js),
      // not a reason to take the app down at boot — leave the old shape in place
      // and say so. createEvent still works; it just cannot record a password
      // admin as the author until the database is repaired.
      try {
      db.exec('PRAGMA foreign_keys = OFF;');
      db.exec(`CREATE TABLE external_events_new (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
        event_date TEXT NOT NULL, event_type TEXT NOT NULL,
        contract_id TEXT REFERENCES contracts(id),
        budget_amount REAL NOT NULL DEFAULT 0,
        actual_amount REAL NOT NULL DEFAULT 0,
        paid_by_player_id TEXT REFERENCES players(id),
        tiers TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning', 'open', 'closed')),
        closed_at TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
      db.exec(`INSERT INTO external_events_new
        (id, title, description, event_date, event_type, contract_id, budget_amount,
         actual_amount, paid_by_player_id, tiers, status, closed_at, created_by, created_at, updated_at)
        SELECT id, title, description, event_date, event_type, contract_id, budget_amount,
               actual_amount, paid_by_player_id, tiers, status, closed_at, created_by, created_at, updated_at
        FROM external_events`);
      db.exec('DROP TABLE external_events;');
      db.exec('ALTER TABLE external_events_new RENAME TO external_events;');
      db.exec('CREATE INDEX IF NOT EXISTS idx_event_type ON external_events(event_type)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_event_date ON external_events(event_date)');
      } catch (e) {
        console.warn('[migrate] could not relax external_events.created_by:', e.message);
        try { db.exec('DROP TABLE IF EXISTS external_events_new;'); } catch { /* nothing to undo */ }
      } finally {
        db.exec('PRAGMA foreign_keys = ON;');
      }
    },

    // Season schedule. A contract plays on fixed weekdays, so the dates a game
    // SHOULD exist on are derivable — which means a missing week can be spotted
    // instead of quietly never being entered. game_days holds JS weekday numbers
    // (0 Sun … 6 Sat); season_start is the date tracking begins.
    () => {
      const cols = db.prepare('PRAGMA table_info(contracts)').all().map(c => c.name);
      if (!cols.includes('game_days')) db.exec("ALTER TABLE contracts ADD COLUMN game_days TEXT NOT NULL DEFAULT '[]'");
      if (!cols.includes('season_start')) db.exec('ALTER TABLE contracts ADD COLUMN season_start TEXT');

      // Seed from the contract's own name rather than its id, because the id is
      // spelled differently in different databases (mon_thu vs monthu).
      for (const c of db.prepare('SELECT id, name, game_days, season_start FROM contracts').all()) {
        if (c.game_days && c.game_days !== '[]' && c.season_start) continue;
        const n = (c.name || '').toLowerCase();
        const days = [];
        if (/\bsun/.test(n)) days.push(0);
        if (/\bmon/.test(n)) days.push(1);
        if (/\btue/.test(n)) days.push(2);
        if (/\bwed/.test(n)) days.push(3);
        if (/\bthu/.test(n)) days.push(4);
        if (/\bfri/.test(n)) days.push(5);
        if (/\bsat/.test(n)) days.push(6);
        db.prepare('UPDATE contracts SET game_days = ?, season_start = COALESCE(season_start, ?) WHERE id = ?')
          .run(JSON.stringify(days), '2026-08-03', c.id);
      }
    },

    // One bank transfer can be split across contracts, which writes a row per
    // contract. Without something joining them, two unrelated-looking entries
    // are all that is left of a single payment — and reconciling them back to a
    // statement means remembering that 1000 and 500 were once 1500.
    () => {
      const cols = db.prepare('PRAGMA table_info(contributions)').all().map(c => c.name);
      if (!cols.includes('split_group')) {
        db.exec('ALTER TABLE contributions ADD COLUMN split_group TEXT');
        db.exec('CREATE INDEX IF NOT EXISTS idx_contrib_split ON contributions(split_group)');
      }
    },

    // Games that predate the contract's baseline and never billed anybody were
    // tracked on the credit sheets, not in here. They carry a charge row per
    // player worth 0 — an attendance record — and the opening balance already
    // nets their money out. `historical` is the flag that means exactly that,
    // and it had never been set on them, so they read as ordinary games that
    // nobody had got round to billing.
    //
    // Deliberately narrow: only games BEFORE season_start, and only where not a
    // single charge carries an amount. A real game can never match, so this
    // cannot quietly write off money.
    () => {
      db.prepare(
        `UPDATE gameweeks SET historical = 1
         WHERE historical = 0
           AND date < (SELECT season_start FROM contracts WHERE contracts.id = gameweeks.contract_id)
           AND NOT EXISTS (
             SELECT 1 FROM charges ch WHERE ch.gameweek_id = gameweeks.id AND ch.amount > 0)`
      ).run();
    },

    // A date the fixture was not played. Without this there is no way to tell
    // "no game that week" apart from "nobody has entered it yet", and the whole
    // point of tracking the schedule is telling those two apart.
    () => {
      try {
        db.prepare('SELECT id FROM no_game_days LIMIT 1').get();
      } catch {
        db.exec(`CREATE TABLE no_game_days (
          id TEXT PRIMARY KEY,
          contract_id TEXT NOT NULL REFERENCES contracts(id),
          date TEXT NOT NULL,
          reason TEXT,
          created_at TEXT NOT NULL
        )`);
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_nogame_contract_date ON no_game_days(contract_id, date)');
      }
    },

    // opening_balances_snapshot.imported_by has the same flaw external_events
    // had: NOT NULL REFERENCES auth_users(id), which an admin signed in with the
    // shared password cannot satisfy. Nothing has ever written to this table,
    // and that is why. Same treatment, same defensive wrapper.
    () => {
      const col = db.prepare('PRAGMA table_info(opening_balances_snapshot)').all()
        .find(c => c.name === 'imported_by');
      const fk = db.prepare('PRAGMA foreign_key_list(opening_balances_snapshot)').all();
      if (!col || (col.notnull === 0 && fk.every(f => f.from !== 'imported_by'))) return;

      try {
        db.exec('PRAGMA foreign_keys = OFF;');
        db.exec(`CREATE TABLE obs_new (
          id TEXT PRIMARY KEY,
          contract_id TEXT NOT NULL REFERENCES contracts(id),
          player_id TEXT NOT NULL REFERENCES players(id),
          opening_balance REAL NOT NULL,
          imported_by TEXT,
          import_batch TEXT NOT NULL,
          locked_at TEXT NOT NULL,
          notes TEXT)`);
        db.exec(`INSERT INTO obs_new SELECT id, contract_id, player_id, opening_balance,
                 imported_by, import_batch, locked_at, notes FROM opening_balances_snapshot`);
        db.exec('DROP TABLE opening_balances_snapshot;');
        db.exec('ALTER TABLE obs_new RENAME TO opening_balances_snapshot;');
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshot_contract_player ON opening_balances_snapshot(contract_id, player_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_snapshot_batch ON opening_balances_snapshot(import_batch)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_snapshot_locked ON opening_balances_snapshot(locked_at)');
      } catch (e) {
        console.warn('[migrate] could not relax opening_balances_snapshot.imported_by:', e.message);
        try { db.exec('DROP TABLE IF EXISTS obs_new;'); } catch { /* nothing to undo */ }
      } finally {
        db.exec('PRAGMA foreign_keys = ON;');
      }
    },

    // event_attendees: one row per head, member or guest. A guest may hang off a
    // host member (a wife, kids) or stand alone if they settle directly, so
    // player_id and host_player_id are both nullable but never both absent
    // without a guest_name to identify the row.
    () => {
      try {
        db.prepare('SELECT id FROM event_attendees LIMIT 1').get();
      } catch {
        db.exec(`CREATE TABLE event_attendees (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL REFERENCES external_events(id) ON DELETE CASCADE,
          player_id TEXT REFERENCES players(id),
          guest_name TEXT,
          host_player_id TEXT REFERENCES players(id),
          tier TEXT NOT NULL DEFAULT 'adult',
          amount_due REAL NOT NULL DEFAULT 0,
          pay_method TEXT NOT NULL DEFAULT 'cash' CHECK(pay_method IN ('cash', 'balance')),
          paid INTEGER NOT NULL DEFAULT 0,
          paid_at TEXT,
          notes TEXT,
          created_at TEXT NOT NULL
        )`);
        db.exec('CREATE INDEX IF NOT EXISTS idx_att_event ON event_attendees(event_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_att_player ON event_attendees(player_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_att_host ON event_attendees(host_player_id)');
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
