#!/usr/bin/env node
/**
 * audit.js — an INDEPENDENT audit of the database. Read-only.
 *
 * WHY THIS EXISTS, when there is already a test suite and verify-balances.
 *
 * Both of those are written against the same repos they check. That is the
 * right shape for a unit test, but it has a blind spot: a rule the code applies
 * consistently and wrongly passes every time, because the thing being asked is
 * also the thing answering. The sharpest version of that failure this project
 * has seen was a QR encoder in the sister app, whose 237-check suite decoded
 * each symbol with the same module that wrote it — every check green, not one
 * code scannable.
 *
 * So nothing below imports a query from server/repos to decide what is true.
 * Every figure is recomputed here from raw SQL and from the settlement rules as
 * they are written down in prose at the top of ledgers.js, and only then
 * compared against what the app reports. When the two disagree, at least one of
 * them is wrong and it is worth finding out which — the first run of this file
 * found three imported score lines that ITS OWN parser could not read and the
 * app could, which is the failure working in the useful direction.
 *
 * Six sections:
 *   1. Structural integrity — SQLite's own check, foreign keys, orphans.
 *   2. Every charge is settled exactly one way.
 *   3. Balances and cash, recomputed per player, not just per contract.
 *   4. The kitty is derived from charges, so it must still match them.
 *   5. Player records, recomputed from the result rows.
 *   6. What is still missing, reported rather than judged.
 *
 * Run:  npm run audit
 * Exit: 0 clean, 1 if anything failed. Warnings do not fail the run — they are
 *       differences that want a human, not defects.
 */
import { db, initSchema, DB_FILE } from '../server/db.js';
import { ledgersRepo } from '../server/repos/ledgers.js';
import { statsRepo } from '../server/repos/stats.js';

initSchema();
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const near = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 0.005;

let fails = 0;
let warns = 0;
let checks = 0;
const FAIL = (label, detail) => {
  fails++;
  console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
};
const WARN = (label, detail) => {
  warns++;
  console.log(`  WARN  ${label}${detail ? `\n          ${detail}` : ''}`);
};
const ok = (label, cond, detail) => { checks++; if (!cond) FAIL(label, detail); };

// Sections are quiet when they pass — a clean run should be short enough to
// read, or nobody will read it.
let sectionStart = 0;
const section = title => {
  sectionStart = fails;
  console.log(`\n${title}`);
};
const sectionDone = n => {
  if (fails === sectionStart) console.log(`  ok    ${n} check(s) passed`);
};

console.log(`Database: ${DB_FILE}`);
console.log('Read-only — nothing below writes.');

/* ===================================================== 1. Structural health */
section('1. Structural integrity');

const integrity = db.prepare('PRAGMA integrity_check').all().map(r => r.integrity_check);
ok('sqlite integrity_check', integrity.length === 1 && integrity[0] === 'ok', integrity.join('; '));

const fkBroken = db.prepare('PRAGMA foreign_key_check').all();
ok('no broken foreign keys', fkBroken.length === 0,
  fkBroken.slice(0, 5).map(r => `${r.table} rowid ${r.rowid} -> ${r.parent}`).join('; '));

// Orphans the foreign-key check cannot see, because the column is nullable and
// an empty string is not NULL.
const ORPHANS = [
  ['no charge is missing its game',
    'SELECT COUNT(*) c FROM charges ch LEFT JOIN gameweeks g ON g.id = ch.gameweek_id WHERE g.id IS NULL'],
  ['no charge is missing its player',
    'SELECT COUNT(*) c FROM charges ch LEFT JOIN players p ON p.id = ch.player_id WHERE p.id IS NULL'],
  ['no charge is billed to a player who does not exist',
    `SELECT COUNT(*) c FROM charges ch LEFT JOIN players p ON p.id = ch.charged_to
     WHERE ch.charged_to IS NOT NULL AND ch.charged_to <> '' AND p.id IS NULL`],
  ['no charge is settled on a contract that does not exist',
    `SELECT COUNT(*) c FROM charges ch LEFT JOIN contracts ct ON ct.id = ch.settle_contract_id
     WHERE ch.settle_contract_id IS NOT NULL AND ct.id IS NULL`],
  ['no result row outlives its game',
    'SELECT COUNT(*) c FROM game_results gr LEFT JOIN gameweeks g ON g.id = gr.gameweek_id WHERE g.id IS NULL'],
  ['no kitty row names a contract that does not exist',
    `SELECT COUNT(*) c FROM kitty k LEFT JOIN contracts ct ON ct.id = k.contract_id
     WHERE k.contract_id IS NOT NULL AND ct.id IS NULL`],
  ['no ledger belongs to a player who does not exist',
    'SELECT COUNT(*) c FROM ledgers l LEFT JOIN players p ON p.id = l.player_id WHERE p.id IS NULL'],
  ['no game has two result rows',
    'SELECT COUNT(*) c FROM (SELECT gameweek_id FROM game_results GROUP BY gameweek_id HAVING COUNT(*) > 1)'],
  ['no player is charged twice for one game',
    `SELECT COUNT(*) c FROM (SELECT gameweek_id, player_id FROM charges
       GROUP BY gameweek_id, player_id HAVING COUNT(*) > 1)`],
];
for (const [label, sql] of ORPHANS) {
  const n = db.prepare(sql).get().c;
  ok(label, n === 0, n ? `${n} row(s)` : '');
}
sectionDone(2 + ORPHANS.length);

/* ============================================ 2. Every charge has ONE home ===
   The settlement model says a charge is settled exactly one way: off a balance,
   in cash, or out of the kitty. A row that is two of those at once is money
   counted twice or not at all — and no balance check would notice, because both
   sides of it would agree with each other. */
section('2. Charge settlement is unambiguous');

const CONTRADICTIONS = [
  ['no charge is both cash and kitty-funded', 'settles_cash = 1 AND settled_from_kitty = 1'],
  ['no kitty-funded charge also names a settling contract',
    'settled_from_kitty = 1 AND settle_contract_id IS NOT NULL'],
  ['no cash charge also names a settling contract',
    'settles_cash = 1 AND settle_contract_id IS NOT NULL'],
  ['no charge carries a negative amount', 'amount < 0'],
];
for (const [label, where] of CONTRADICTIONS) {
  const n = db.prepare(`SELECT COUNT(*) c FROM charges WHERE ${where}`).get().c;
  ok(label, n === 0, n ? `${n} charge(s)` : '');
}
sectionDone(CONTRADICTIONS.length);

/* ================================================= 3. The money, recomputed ==
   The rules, taken from the prose at the top of ledgers.js rather than from its
   SQL, and written out again here:

     present balance = opening
                     + contributions on this contract that are not imported
                     - charges that LAND here
                     + approved transactions that are neither of those

   A charge lands on the SETTLER — charged_to if set, else the player — on the
   contract named by settle_contract_id if set, else the game's own. It lands
   nowhere at all if the game is imported, if the kitty carried it, or if it was
   settled in cash. And "in cash" is a question about the settler, not about
   whoever happened to be on the pitch. */
section('3. Balances and cash, recomputed from SQL');

const SETTLER = "COALESCE(NULLIF(ch.charged_to, ''), ch.player_id)";
const SETTLE_ON = 'COALESCE(ch.settle_contract_id, g.contract_id)';
const IS_CASH = `(ch.settles_cash = 1 OR COALESCE(s.player_type, 'regular') = 'outside')`;
const LANDS = `g.historical = 0 AND ch.settled_from_kitty = 0 AND NOT ${IS_CASH}`;

const contracts = db.prepare('SELECT id, name FROM contracts ORDER BY sort').all();

for (const c of contracts) {
  const claimed = ledgersRepo.forContract(c.id);
  const claimedTotal = r2(claimed.reduce((s, l) => s + (l.present_balance ?? 0), 0));

  const mine = new Map();
  const add = (who, n) => mine.set(who, (mine.get(who) ?? 0) + n);

  for (const l of db.prepare(
    'SELECT player_id, opening_balance FROM ledgers WHERE contract_id = ?').all(c.id)) {
    add(l.player_id, l.opening_balance || 0);
  }
  for (const row of db.prepare(`SELECT player_id, COALESCE(SUM(amount),0) t FROM contributions
      WHERE contract_id = ? AND historical = 0 AND player_id IS NOT NULL
      GROUP BY player_id`).all(c.id)) {
    add(row.player_id, row.t);
  }
  for (const row of db.prepare(`SELECT player_id, COALESCE(SUM(amount),0) t FROM transactions
      WHERE contract_id = ? AND status = 'approved'
        AND type NOT IN ('contribution', 'charge') GROUP BY player_id`).all(c.id)) {
    add(row.player_id, row.t);
  }
  for (const row of db.prepare(`
      SELECT ${SETTLER} AS who, COALESCE(SUM(ch.amount), 0) AS t
      FROM charges ch
      JOIN gameweeks g ON g.id = ch.gameweek_id
      LEFT JOIN players s ON s.id = ${SETTLER}
      WHERE ${SETTLE_ON} = ? AND ${LANDS}
      GROUP BY who`).all(c.id)) {
    add(row.who, -row.t);
  }
  const myTotal = r2([...mine.values()].reduce((s, v) => s + v, 0));

  checks++;
  if (near(myTotal, claimedTotal)) {
    console.log(`  ok    ${c.name}: club total ${claimedTotal} agrees`);
  } else {
    FAIL(`${c.name}: club total`, `app says ${claimedTotal}, recomputed ${myTotal}`);
  }

  // Per player too — a total that nets out can hide two opposite errors.
  let differing = 0;
  let firstDiff = '';
  for (const l of claimed) {
    const want = r2(mine.get(l.player_id) ?? 0);
    if (near(want, l.present_balance)) continue;
    differing++;
    firstDiff ||= `${l.player_name || l.player_id}: app ${l.present_balance}, recomputed ${want}`;
  }
  ok(`${c.name}: every player's balance agrees`, differing === 0,
    differing ? `${differing} player(s) differ; first — ${firstDiff}` : '');

  // Cash in hand: the same shape with the opposite predicate.
  const myCash = r2(db.prepare(`
    SELECT COALESCE(SUM(ch.amount), 0) t FROM charges ch
    JOIN gameweeks g ON g.id = ch.gameweek_id
    LEFT JOIN players s ON s.id = ${SETTLER}
    WHERE ${SETTLE_ON} = ? AND g.historical = 0 AND ch.settled_from_kitty = 0
      AND ${IS_CASH} AND ch.paid = 0`).get(c.id).t);
  const claimedCash = r2(ledgersRepo.cashOutstanding(c.id)
    .reduce((s, row) => s + (row.owed ?? 0), 0));
  checks++;
  if (near(myCash, claimedCash)) {
    console.log(`  ok    ${c.name}: cash still to collect ${myCash} agrees`);
  } else {
    FAIL(`${c.name}: cash still to collect`, `app says ${claimedCash}, recomputed ${myCash}`);
  }
}

/* ============================================ 4. The kitty is derived, not kept
   The kitty is a VIEW of the charges. So every generated row must still match
   the thing that generated it, and none may survive it. */
section('4. Kitty rows still match what generated them');

const gwKittyOrphans = db.prepare(`
  SELECT k.id FROM kitty k
  WHERE k.id LIKE 'k_gw_%' AND NOT EXISTS (
    SELECT 1 FROM gameweeks g WHERE k.id = 'k_gw_' || g.id)`).all();
ok('no kitty row for a deleted game', gwKittyOrphans.length === 0,
  gwKittyOrphans.slice(0, 5).map(k => k.id).join(', '));

const chargeKittyOrphans = db.prepare(`
  SELECT k.id FROM kitty k
  WHERE k.id LIKE 'k_charge_%' AND NOT EXISTS (
    SELECT 1 FROM charges ch WHERE k.id = 'k_charge_' || ch.id)`).all();
ok('no kitty row for a deleted charge', chargeKittyOrphans.length === 0,
  chargeKittyOrphans.slice(0, 5).map(k => k.id).join(', '));

// The sign lives in `kind`, never in `amount` — a negative expense is an income
// written the wrong way round and would be counted twice over.
const negativeKitty = db.prepare('SELECT COUNT(*) c FROM kitty WHERE amount < 0').get().c;
ok('no kitty row carries a negative amount', negativeKitty === 0, `${negativeKitty} row(s)`);

const badKind = db.prepare(
  "SELECT COUNT(*) c FROM kitty WHERE kind NOT IN ('income','expense')").get().c;
ok('every kitty row is income or expense', badKind === 0, `${badKind} row(s)`);
sectionDone(4);

for (const c of contracts) {
  const net = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN kind = 'income' THEN amount ELSE -amount END), 0) n
    FROM kitty WHERE contract_id = ? OR (contract_id IS NULL AND scope = ?)`).get(c.id, c.id);
  console.log(`  info  ${c.name}: kitty nets ${r2(net.n)}`);
}

/* ================================================== 5. Analytics, recomputed ==
   The record every rate and streak on the Results screen is built from. This
   was wrong in production twice, both times because the code agreed with
   itself. Recomputed here with no shared helper. */
section('5. Player records, recomputed from the result rows');

const results = new Map();
for (const g of db.prepare(
  'SELECT gameweek_id, team_a_name, team_b_name, result FROM game_results').all()) {
  results.set(g.gameweek_id, g);
}
const scoreText = new Map();
for (const g of db.prepare(
  "SELECT id, score FROM gameweeks WHERE TRIM(COALESCE(score,'')) <> ''").all()) {
  scoreText.set(g.id, g.score);
}

/* An independent reading of a score line — NOT results_import.js.
   The club writes results four ways, and all four have appeared in the data:
     "Blue win 7-5"   "won by Blue"   "8-7 BLUES"   "12-9 to the blues"
   A first version of this handled only the first and reported seventeen players
   as wrong. The app was right and this was not, which is worth remembering: an
   independent check that is merely weaker produces false alarms, and a check
   nobody believes gets switched off. */
function readScore(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(draw|drew|tie|tied|even)\b/.test(t)) return 'draw';
  const m = t.match(/\b([a-z]+)\s*(?:team\s*)?(?:win|wins|won)\b/)          // Blue win 7-5
    || t.match(/\b(?:win|wins|won)\s*(?:by|for|to)?\s*(?:the\s+)?([a-z]+)/) // won by Blue
    || t.match(/\d+\s*[-–:]\s*\d+\s*(?:to\s*)?(?:the\s+)?([a-z]+)/);        // 12-9 to the blues
  return m ? m[1] : null;
}
// "Blue" on the charge and "BLUES" in the sentence are the same side.
const sameSide = (a, b) => {
  const n = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '').replace(/s$/, '');
  return !!n(a) && n(a) === n(b);
};

const sidesOf = db.prepare(
  "SELECT DISTINCT team FROM charges WHERE gameweek_id = ? AND TRIM(team) <> ''");

const players = db.prepare(`SELECT DISTINCT p.id, p.name FROM players p
  JOIN charges ch ON ch.player_id = p.id ORDER BY p.name`).all();

let compared = 0;
let mismatched = 0;
const detail = [];
for (const p of players) {
  const rows = db.prepare(`SELECT ch.team, g.id AS gw FROM charges ch
    JOIN gameweeks g ON g.id = ch.gameweek_id WHERE ch.player_id = ?`).all(p.id);

  let w = 0;
  let d = 0;
  let l = 0;
  let unknown = 0;
  for (const row of rows) {
    const team = String(row.team || '').trim();
    if (!team) { unknown++; continue; }

    // The result row is the record; the sentence is the fallback. Same order of
    // preference the app states, worked out here from scratch.
    const gr = results.get(row.gw);
    let winner = null;
    if (gr) {
      winner = gr.result === 'draw' ? 'draw'
        : (gr.result === 'a_wins' ? gr.team_a_name : gr.team_b_name);
    } else if (scoreText.has(row.gw)) {
      winner = readScore(scoreText.get(row.gw));
    }

    if (!winner) { unknown++; continue; }
    if (winner === 'draw') { d++; continue; }
    if (sameSide(team, winner)) { w++; continue; }
    // Only a loss if the game really had another side to lose to.
    if (sidesOf.all(row.gw).length >= 2) l++; else unknown++;
  }

  const app = statsRepo.matchRecord(p.id);
  compared++;
  if (app.wins === w && app.draws === d && app.losses === l) continue;
  mismatched++;
  if (detail.length < 10) {
    detail.push(`${p.name}: app ${app.wins}W ${app.draws}D ${app.losses}L`
      + ` / recomputed ${w}W ${d}D ${l}L (${unknown} this could not resolve)`);
  }
}
checks++;
if (mismatched) {
  WARN(`${mismatched} of ${compared} player records differ from an independent recompute`,
    detail.join('\n          '));
} else {
  console.log(`  ok    all ${compared} player records agree`);
}

// Whatever the rates are computed over, they cannot exceed the games played.
let rateBad = 0;
for (const p of players) {
  const a = statsRepo.matchRecord(p.id);
  if (a.wins + a.draws + a.losses + a.unknown !== a.games) rateBad++;
  if (a.captainWins > a.captainDecided || a.captainDecided > a.captainGames) rateBad++;
  if (a.captainGames > a.games) rateBad++;
}
ok('every record adds up to the games played', rateBad === 0, `${rateBad} inconsistency(ies)`);

/* ================================================== 6. What is still missing */
section('6. Known gaps');

const unscored = db.prepare(`SELECT c.name, g.date, g.historical FROM gameweeks g
  JOIN contracts c ON c.id = g.contract_id
  LEFT JOIN game_results gr ON gr.gameweek_id = g.id
  WHERE gr.gameweek_id IS NULL AND TRIM(COALESCE(g.score, '')) = ''
  ORDER BY c.sort, g.date`).all();
console.log(`  info  ${unscored.length} game(s) with no result at all`);
for (const g of unscored) {
  console.log(`          ${g.name}  ${g.date}${g.historical ? '  (imported)' : ''}`);
}

const logins = db.prepare(`SELECT
    (SELECT COUNT(*) FROM players WHERE COALESCE(is_sandbox,0) = 0) AS players,
    (SELECT COUNT(*) FROM auth_users WHERE role = 'player' AND is_active = 1) AS active,
    (SELECT COUNT(*) FROM auth_users WHERE role = 'player' AND requires_pin_change = 1) AS unchanged
  `).get();
console.log(`  info  ${logins.active} of ${logins.players} players have a login;`
  + ` ${logins.unchanged} still on the PIN they were issued`);

const hidden = db.prepare(
  'SELECT name FROM players WHERE hide_from_sheet = 1 ORDER BY name').all().map(p => p.name);
console.log(`  info  hidden from the Standing sheet by hand: ${hidden.join(', ') || 'nobody'}`);

/* ---- Report ---- */
console.log('');
console.log(`${fails ? 'FAIL' : 'OK'} — ${checks} checks, ${fails} failed, ${warns} warning(s)`);
process.exit(fails ? 1 : 0);
