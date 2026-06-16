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

mkdirSync(DATA_DIR, { recursive: true });

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

CREATE TABLE IF NOT EXISTS charge_audit (
  id                 TEXT PRIMARY KEY,
  charge_id          TEXT REFERENCES charges(id),
  original_amount    REAL,
  new_amount         REAL,
  reason             TEXT,
  changed_by         TEXT,
  auto_recalculate   INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_charge ON charge_audit(charge_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON charge_audit(created_at);
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
  ];
  for (const mig of migrations) mig();
}

export function seed({ force = false } = {}) {
  initSchema();
  const n = db.prepare('SELECT COUNT(*) AS n FROM contracts').get().n;
  if (n > 0 && !force) {
    console.log('Seed skipped — data already exists. Use --reseed to wipe & reload.');
    return;
  }
  if (force) {
    for (const t of ['charges', 'gameweeks', 'contributions', 'kitty', 'ledgers',
                      'players', 'contracts', 'meta']) {
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
