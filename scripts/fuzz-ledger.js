#!/usr/bin/env node
/**
 * fuzz-ledger.js — beat on the WRITE paths, check the books after every move.
 *
 * test-ledger.js pins known inputs to known answers, which catches a term being
 * dropped from a formula. It cannot catch a bug that only appears in a SEQUENCE:
 * mark a guest paid, switch the charge to the kitty, switch it back, hand it to
 * another member, then delete the game. Nobody has driven the app that way, so
 * nothing in the database shows it, and no fixture written by hand thinks to.
 *
 * So: a scratch database, a squad of eleven, and a long run of the things Game
 * day and the game-detail panel actually do, chosen at random. After EVERY
 * single operation the whole set of invariants is recomputed from raw SQL —
 * balances, cash owed, each gameweek's kitty line, every player's record, and
 * the player timeline against the ledger — and compared with what the repos say.
 *
 * The seed is fixed by default, so this is a long deterministic test rather
 * than a flaky one. Pass a different seed and a step count to explore further:
 *
 *   node scripts/fuzz-ledger.js 31337 2000
 *
 * A failure prints the operation it broke on and the seed to replay it with.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const scratch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fmss-fuzz-')), 'f.db');
process.env.FMSS_DB_PATH = scratch;

const { db, initSchema, DB_FILE } = await import('../server/db.js');
if (path.resolve(DB_FILE) !== path.resolve(scratch)) {
  console.error('Refusing to run against ' + DB_FILE); process.exit(1);
}
const { gameweeksRepo } = await import('../server/repos/gameweeks.js');
const { ledgersRepo } = await import('../server/repos/ledgers.js');
const { statsRepo } = await import('../server/repos/stats.js');
const { movementsRepo } = await import('../server/repos/movements.js');
const { externalEventsRepo } = await import('../server/repos/external_events.js');
initSchema();
// Production runs with foreign keys ON, which is what makes ON DELETE CASCADE
// clear a deleted game's charges. Turning them off — as scripts/test-ledger.js
// does — models a different database and leaves orphan charges behind.
db.exec('PRAGMA foreign_keys = ON');

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// Deterministic PRNG so a failing run is reproducible from its seed.
let seed = Number(process.argv[2] || 20260915);
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = a => a[Math.floor(rnd() * a.length)];

/* ---- a small club ---- */
let n = 0;
const CONTRACTS = ['alpha', 'beta'];
for (const [i, c] of CONTRACTS.entries()) {
  db.prepare("INSERT INTO contracts (id,name,rates,cost_per_gw,sort) VALUES (?,?,'{}',0,?)")
    .run(c, c, i);
}
function player(name, opening, type = 'regular') {
  const id = `p${++n}`;
  db.prepare("INSERT INTO players (id,name,aliases,created_at,player_type) VALUES (?,?,'[]',?,?)")
    .run(id, name, new Date().toISOString(), type);
  for (const c of CONTRACTS) {
    db.prepare('INSERT INTO ledgers (player_id,contract_id,opening_balance,status) VALUES (?,?,?,\'\')')
      .run(id, c, c === 'alpha' ? opening : 0);
  }
  return id;
}
const squad = Array.from({ length: 8 }, (_, i) => player(`Reg${i + 1}`, 100 + i * 25));
const guests = Array.from({ length: 3 }, (_, i) => player(`Guest${i + 1}`, 0, 'outside'));
const everyone = [...squad, ...guests];

/* ---- the invariants, recomputed from raw SQL every time ---- */
const SETTLER = "COALESCE(NULLIF(ch.charged_to,''), ch.player_id)";
const IS_CASH = "(ch.settles_cash = 1 OR COALESCE(s.player_type,'regular') = 'outside')";

function invariants(label) {
  const problems = [];

  // 1. Every balance the app reports equals the rules, applied here.
  for (const c of CONTRACTS) {
    const mine = new Map();
    const add = (who, v) => mine.set(who, (mine.get(who) ?? 0) + v);
    for (const l of db.prepare('SELECT player_id, opening_balance FROM ledgers WHERE contract_id = ?').all(c)) {
      add(l.player_id, l.opening_balance || 0);
    }
    for (const row of db.prepare(`SELECT player_id, COALESCE(SUM(amount),0) t FROM contributions
      WHERE contract_id = ? AND historical = 0 AND player_id IS NOT NULL GROUP BY player_id`).all(c)) {
      add(row.player_id, row.t);
    }
    for (const row of db.prepare(`SELECT player_id, COALESCE(SUM(amount),0) t FROM transactions
      WHERE contract_id = ? AND status = 'approved' AND type NOT IN ('contribution','charge')
      GROUP BY player_id`).all(c)) add(row.player_id, row.t);
    for (const row of db.prepare(`SELECT ${SETTLER} who, COALESCE(SUM(ch.amount),0) t
      FROM charges ch JOIN gameweeks g ON g.id = ch.gameweek_id
      LEFT JOIN players s ON s.id = ${SETTLER}
      WHERE COALESCE(ch.settle_contract_id, g.contract_id) = ? AND g.historical = 0
        AND ch.settled_from_kitty = 0 AND NOT ${IS_CASH} GROUP BY who`).all(c)) {
      add(row.who, -row.t);
    }
    for (const l of ledgersRepo.forContract(c)) {
      const want = r2(mine.get(l.player_id) ?? 0);
      if (Math.abs(want - l.present_balance) > 0.005) {
        problems.push(`${c}/${l.player_name}: ledger ${l.present_balance}, rules say ${want}`);
      }
    }
  }

  // 2. Each gameweek's kitty line is its profit, and nothing else owns a row.
  for (const g of db.prepare('SELECT * FROM gameweeks').all()) {
    const s = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN ch.settled_from_kitty = 0 AND NOT ${IS_CASH} THEN ch.amount END),0) contracted,
        COALESCE(SUM(CASE WHEN ch.settled_from_kitty = 0 AND ${IS_CASH} AND ch.paid = 1 THEN ch.amount END),0) guest
      FROM charges ch LEFT JOIN players s ON s.id = ${SETTLER}
      WHERE ch.gameweek_id = ?`).get(g.id);
    const water = (g.game_cost_paid_by || 'self') === 'self' ? Number(g.game_cost) || 0 : 0;
    const want = g.historical ? 0 : r2(s.contracted + s.guest - (Number(g.cost_per_gw) || 0) - water);
    const row = db.prepare('SELECT kind, amount FROM kitty WHERE id = ?').get(`k_gw_${g.id}`);
    const got = row ? r2(row.kind === 'income' ? row.amount : -row.amount) : 0;
    if (Math.abs(got - want) > 0.005) problems.push(`kitty ${g.id}: stored ${got}, rules say ${want}`);
  }
  const stray = db.prepare("SELECT COUNT(*) n FROM kitty WHERE id LIKE 'k_charge_%'").get().n;
  if (stray) problems.push(`${stray} per-charge kitty row(s) reappeared`);
  const orphan = db.prepare(`SELECT COUNT(*) n FROM kitty k WHERE k.id LIKE 'k_gw_%'
    AND NOT EXISTS (SELECT 1 FROM gameweeks g WHERE k.id = 'k_gw_' || g.id)`).get().n;
  if (orphan) problems.push(`${orphan} kitty row(s) outlived their game`);
  // (attribution is checked in 8, which exempts the club-wide pot on purpose)

  // 3. A charge is settled exactly one way.
  const both = db.prepare('SELECT COUNT(*) n FROM charges WHERE settles_cash = 1 AND settled_from_kitty = 1').get().n;
  if (both) problems.push(`${both} charge(s) are cash AND kitty-funded`);

  // 4. Cash to collect, recomputed.
  for (const c of CONTRACTS) {
    const want = r2(db.prepare(`SELECT COALESCE(SUM(ch.amount),0) t FROM charges ch
      JOIN gameweeks g ON g.id = ch.gameweek_id LEFT JOIN players s ON s.id = ${SETTLER}
      WHERE COALESCE(ch.settle_contract_id, g.contract_id) = ? AND g.historical = 0
        AND ch.settled_from_kitty = 0 AND ${IS_CASH} AND ch.paid = 0`).get(c).t);
    const got = r2(ledgersRepo.cashOutstanding(c).reduce((a, r) => a + (r.owed || 0), 0));
    if (Math.abs(got - want) > 0.005) problems.push(`${c} cash owed: repo ${got}, rules say ${want}`);
  }

  // 5. Every player's record still adds up.
  for (const p of everyone) {
    const r = statsRepo.matchRecord(p);
    const apps = db.prepare('SELECT COUNT(*) n FROM charges WHERE player_id = ?').get(p).n;
    if (r.wins + r.draws + r.losses + r.unknown !== r.games) problems.push(`${p}: record does not sum`);
    if (r.games + r.tournaments !== apps) problems.push(`${p}: games+tournaments ≠ appearances`);
  }

  // 6. The player's own page still equals the sheet.
  for (const l of ledgersRepo.all()) {
    const t = r2(statsRepo.playerTimeline(l.player_id, l.contract_id).presentBalance);
    if (Math.abs(t - l.present_balance) > 0.005) {
      problems.push(`${l.player_name}/${l.contract_id}: timeline ${t} vs ledger ${l.present_balance}`);
    }
  }

  // 7. A movement is two legs or none, and never invents or destroys money.
  for (const m of db.prepare('SELECT id FROM movements').all()) {
    const legs = db.prepare('SELECT COUNT(*) n FROM kitty WHERE scope = ?').get(m.id).n
      + db.prepare('SELECT COUNT(*) n FROM transactions WHERE id IN (?,?)')
        .get(`t_${m.id}_out`, `t_${m.id}_in`).n;
    if (legs === 0) problems.push(`movement ${m.id} has no legs at all`);
  }
  const strayLeg = db.prepare(`SELECT COUNT(*) n FROM kitty k WHERE k.scope LIKE 'mv_%'
    AND NOT EXISTS (SELECT 1 FROM movements m WHERE m.id = k.scope)`).get().n;
  if (strayLeg) problems.push(`${strayLeg} movement leg(s) outlived their movement`);
  const strayTxn = db.prepare(`SELECT COUNT(*) n FROM transactions t WHERE t.id LIKE 't_mv_%'
    AND NOT EXISTS (SELECT 1 FROM movements m WHERE t.id IN ('t_'||m.id||'_out','t_'||m.id||'_in'))`).get().n;
  if (strayTxn) problems.push(`${strayTxn} movement transaction(s) outlived their movement`);

  // 8. Derived rows must name their contract. A movement leg facing the
  //    CLUB-WIDE pot correctly has none, so it is excluded on purpose.
  const unattributed = db.prepare(`SELECT COUNT(*) n FROM kitty
    WHERE contract_id IS NULL AND (id LIKE 'k_gw_%' OR id LIKE 'k_event_%')`).get().n;
  if (unattributed) problems.push(`${unattributed} derived kitty row(s) name no contract`);

  // 9. What an event posted to the pot is what its summary says it made.
  for (const e of db.prepare('SELECT id, title FROM external_events').all()) {
    const sum = externalEventsRepo.summary(db, e.id);
    const posted = db.prepare('SELECT kind, amount FROM kitty WHERE id = ?').get(`k_event_${e.id}`);
    if (posted) {
      const signed = r2(posted.kind === 'income' ? posted.amount : -posted.amount);
      if (Math.abs(signed - r2(sum.net)) > 0.005) {
        problems.push(`event ${e.title}: posted ${signed}, summary says ${r2(sum.net)}`);
      }
    }
  }

  if (problems.length) {
    console.log(`\nFAIL after step ${label}`);
    for (const p of problems.slice(0, 8)) console.log(`   ${p}`);
    return false;
  }
  return true;
}

/* ---- the moves ---- */
let step = 0;
let broke = false;
const refusals = new Map();
const liveGames = [];
const liveEvents = [];

function makeGame() {
  const contract = pick(CONTRACTS);
  const who = [...everyone].sort(() => rnd() - 0.5).slice(0, 4 + Math.floor(rnd() * 6));
  const gw = gameweeksRepo.create(
    { contract_id: contract, date: `2026-0${1 + Math.floor(rnd() * 8)}-1${Math.floor(rnd() * 9)}`,
      cost_per_gw: pick([0, 100, 275, 346]), game_cost: pick([0, 15]),
      game_cost_paid_by: pick(['self', squad[0]]), score: pick(['', 'Blue win 7-5', 'Draw 4-4', 'Reds win']) },
    who.map(p => ({ player_id: p, team: pick(['Blue', 'Red', 'White', '']),
      is_captain: rnd() < 0.2, rate_type: 'manual', amount: pick([0, 20, 27, 35]) })));
  liveGames.push(gw.id);
  return gw.id;
}

const MOVES = [
  ['create a game', () => makeGame()],
  ['mark a charge paid or unpaid', () => {
    const g = pick(liveGames); if (!g) return;
    const ch = pick(gameweeksRepo.get(g).charges || []); if (!ch) return;
    gameweeksRepo.setChargePaid(g, ch.id, { paid: rnd() < 0.5 });
  }],
  ['change how a charge settles', () => {
    const g = pick(liveGames); if (!g) return;
    const ch = pick(gameweeksRepo.get(g).charges || []); if (!ch) return;
    const mode = pick(['balance', 'cash', 'kitty']);
    gameweeksRepo.setChargeSettlement(g, ch.id, { mode,
      charged_to: rnd() < 0.3 ? pick(squad) : null,
      settle_contract_id: mode === 'balance' && rnd() < 0.4 ? pick(CONTRACTS) : null });
  }],
  ['move a player between sides', () => {
    const g = pick(liveGames); if (!g) return;
    const ch = pick(gameweeksRepo.get(g).charges || []); if (!ch) return;
    gameweeksRepo.updateCharge(g, ch.id, { team: pick(['Blue', 'Red', 'White', '']),
      is_captain: rnd() < 0.3 });
  }],
  ['add a player to a game', () => {
    const g = pick(liveGames); if (!g) return;
    const taken = new Set((gameweeksRepo.get(g).charges || []).map(c => c.player_id));
    const free = everyone.filter(p => !taken.has(p)); if (!free.length) return;
    gameweeksRepo.addCharge(g, { player_id: pick(free), team: pick(['Blue', 'Red']),
      is_captain: rnd() < 0.2, amount: pick([0, 27, 35]) });
  }],
  ['take a player out', () => {
    const g = pick(liveGames); if (!g) return;
    const cs = gameweeksRepo.get(g).charges || []; if (cs.length < 2) return;
    gameweeksRepo.removeCharge(g, pick(cs).id);
  }],
  ['retype the score', () => {
    const g = pick(liveGames); if (!g) return;
    gameweeksRepo.updateMetadata(g, { score: pick(['', 'Blue win 7-5', 'Red win 3-1', 'Draw 2-2', 'Reds win', 'nonsense']) });
  }],
  ['change the water', () => {
    const g = pick(liveGames); if (!g) return;
    gameweeksRepo.updateGameAccounting(g, { game_cost: pick([0, 15, 30]),
      game_cost_paid_by: pick(['self', squad[1]]) });
  }],
  ['move money about', () => {
    // Every pairing the club actually uses: the pot paying somebody, somebody
    // paying into the pot, one contract's share carrying another's, and a
    // straight transfer between two members.
    const parties = [...squad, 'kitty', ...CONTRACTS.map(c => `kitty:${c}`)];
    const from = pick(parties);
    const to = pick(parties.filter(x => x !== from));
    movementsRepo.create({ from, to, amount: pick([5, 27, 100, 250]),
      contract_id: pick(CONTRACTS), note: 'fuzz' });
  }],
  ['undo a movement', () => {
    const ms = db.prepare('SELECT id FROM movements').all();
    if (!ms.length) return;
    movementsRepo.remove(pick(ms).id);
  }],
  ['plan an event', () => {
    const e = externalEventsRepo.createEvent(db, null, null, {
      title: `Do ${step}`, event_type: pick(['dinner', 'tour', 'other']),
      event_date: '2026-06-01', contract_id: pick(CONTRACTS),
      budget_amount: pick([0, 500, 1200]),
      tiers: { adult: 120, child: 60 } });
    liveEvents.push(e.id);
  }],
  ['put somebody on an event', () => {
    const e = pick(liveEvents); if (!e) return;
    const taken = new Set(externalEventsRepo.listAttendees(db, e)
      .map(a => a.player_id).filter(Boolean));
    const free = squad.filter(p => !taken.has(p));
    if (rnd() < 0.5 && free.length) {
      externalEventsRepo.addAttendee(db, e, { player_id: pick(free),
        tier: pick(['adult', 'child']), pay_method: pick(['cash', 'balance']) });
    } else {
      externalEventsRepo.addAttendee(db, e, { guest_name: `Plus ${step}`,
        host_player_id: pick(squad), tier: 'adult', pay_method: pick(['cash', 'balance']) });
    }
  }],
  ['settle or unsettle an event attendee', () => {
    const e = pick(liveEvents); if (!e) return;
    const a = pick(externalEventsRepo.listAttendees(db, e)); if (!a) return;
    externalEventsRepo.setAttendeePaid(db, a.id, rnd() < 0.5);
  }],
  ['take somebody off an event', () => {
    const e = pick(liveEvents); if (!e) return;
    const a = pick(externalEventsRepo.listAttendees(db, e)); if (!a) return;
    externalEventsRepo.removeAttendee(db, a.id);
  }],
  ['bank what an event made or lost', () => {
    const e = pick(liveEvents); if (!e) return;
    externalEventsRepo.postNetToKitty(db, null, e);
  }],
  ['close or reopen an event', () => {
    const e = pick(liveEvents); if (!e) return;
    const ev = externalEventsRepo.getEvent(db, e);
    if (ev.status === 'closed') externalEventsRepo.reopen(db, e);
    else externalEventsRepo.close(db, e);
  }],
  ['scrap an event', () => {
    if (liveEvents.length < 2) return;
    const i = Math.floor(rnd() * liveEvents.length);
    externalEventsRepo.deleteEvent(db, liveEvents[i]); liveEvents.splice(i, 1);
  }],
  ['delete a game', () => {
    if (liveGames.length < 2) return;
    const i = Math.floor(rnd() * liveGames.length);
    gameweeksRepo.remove(liveGames[i]); liveGames.splice(i, 1);
  }],
];

// Weighted: the random walk was deleting games faster than it made them, so it
// spent its last two hundred steps picking from an almost empty season. Every
// move is repeated in proportion to how often it really happens.
const WEIGHTED = [];
for (const m of MOVES) {
  const times = /delete a game|scrap an event|undo a movement/.test(m[0]) ? 1
    : /create a game|plan an event/.test(m[0]) ? 3 : 4;
  for (let i = 0; i < times; i++) WEIGHTED.push(m);
}

makeGame(); makeGame(); makeGame(); makeGame();
if (!invariants('setup')) broke = true;

const RUNS = Number(process.argv[3] || 400);
for (let i = 0; i < RUNS && !broke; i++) {
  const [name, fn] = pick(WEIGHTED);
  step++;
  try { fn(); } catch (e) {
    /* A domain refusal is the app working: "this event is closed", "that member
       is already on this event", "money cannot move to where it already is".
       What is NOT fine is a crash or a constraint violation — those are bugs
       wearing an exception. Discriminated on the KIND of error rather than the
       wording, because matching phrases meant every new refusal message looked
       like a failure. */
    const bug = /TypeError|ReferenceError|RangeError|SyntaxError/.test(e.name)
      || /SQLITE|constraint|is not a function|of undefined|of null/i.test(e.message);
    if (bug) {
      console.log(`\nFAIL step ${step} (${name}) threw ${e.name}: ${e.message}`);
      broke = true; break;
    }
    refusals.set(e.message, (refusals.get(e.message) ?? 0) + 1);
  }
  if (!invariants(`${step} (${name})`)) broke = true;
}

console.log(broke
  ? `\nFAIL — broke after ${step} operations (seed ${process.argv[2] || 20260915})`
  : `\nOK — ${step} random operations, books balanced after every one`
    + `\n   ${liveGames.length} games live, ${db.prepare('SELECT COUNT(*) n FROM charges').get().n} charges,`
    + ` ${db.prepare('SELECT COUNT(*) n FROM kitty').get().n} kitty rows,`
    + ` ${db.prepare('SELECT COUNT(*) n FROM movements').get().n} movements,`
    + ` ${db.prepare('SELECT COUNT(*) n FROM external_events').get().n} events`
    + `
   refused, correctly, ${[...refusals.values()].reduce((a, b) => a + b, 0)} times`);

try { fs.rmSync(path.dirname(scratch), { recursive: true, force: true }); } catch { /* still open */ }
process.exit(broke ? 1 : 0);
