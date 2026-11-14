#!/usr/bin/env node
/**
 * reprice-games.js — put a run of nights back onto the card they belong to.
 *
 * WHY THIS EXISTS. Prices have a date on them. The Koora booking dropped from
 * 346 a night to 315 on 17 October 2026, and the player rates moved with it —
 * but three Saturdays had already been entered at the old card. Correcting
 * them by hand is twenty-odd charges typed into a screen one at a time, which
 * is how a balance ends up wrong in a way nobody can find afterwards.
 *
 * So: a tool that applies the rate card in force on each night to the charges
 * of that night, says exactly what it would do, and only then does it.
 *
 *   node scripts/reprice-games.js --contract sat --from 2026-10-17
 *   node scripts/reprice-games.js --contract sat --from 2026-10-17 --apply
 *
 * WHAT IT WILL NOT TOUCH, unless told:
 *   - a cash charge that is already paid. The money is in a pocket; moving the
 *     figure it was collected against invents an over- or under-payment that
 *     nobody agreed to. Reported, and skipped, unless --allow-paid-cash.
 *   - a guest with a price agreed with them (players.outside_cost). That is a
 *     fact about a person, not a card.
 *   - anything at all without --apply.
 *
 * THE RECONCILIATION. Every balance it moves is checked afterwards against
 * arithmetic done from raw SQL rather than through the repo that did the
 * writing, and the whole run is rolled back if a single figure is off by more
 * than half a fil. A migration that cannot prove it landed is not finished.
 */
import { db, initSchema, DB_FILE } from '../server/db.js';
import { gameweeksRepo } from '../server/repos/gameweeks.js';
import { contractsRepo } from '../server/repos/contracts.js';

initSchema();

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const CONTRACT = arg('contract');
const FROM = arg('from');
const TO = arg('to', '9999-12-31');
const APPLY = flag('apply');
const ALLOW_PAID_CASH = flag('allow-paid-cash');
// Pitch only: correct what the GROUND charged and leave every player's
// charge exactly as it is. The two halves of a night are separate
// decisions — the Mon/Thu bundle turned out to cost 217 a night rather
// than the 275 the games were booked at, which is the club's own money and
// nobody else's, and repricing the players on the same pass would move
// balances nobody asked to have moved.
const PITCH_ONLY = flag('pitch-only');

if (!CONTRACT || !FROM) {
  console.error('Usage: node scripts/reprice-games.js --contract <id> --from <YYYY-MM-DD> [--to <date>] [--apply]');
  process.exit(2);
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => (n < 0 ? '-' : '+') + Math.abs(r2(n)).toFixed(2);

console.log(`Database: ${DB_FILE}`);
console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${CONTRACT} from ${FROM} to ${TO}`
  + (PITCH_ONLY ? '  (pitch only — no charge is touched)' : '') + '\n');

const contract = contractsRepo.get(CONTRACT);
if (!contract) { console.error(`No such contract: ${CONTRACT}`); process.exit(2); }

const games = db.prepare(
  `SELECT id, date, cost_per_gw, game_cost, game_cost_paid_by, COALESCE(hours,1) AS hours
   FROM gameweeks WHERE contract_id = ? AND historical = 0 AND date >= ? AND date <= ?
   ORDER BY date`).all(CONTRACT, FROM, TO);
if (!games.length) { console.log('No games in that range.'); process.exit(0); }

// ---- what each night should look like, decided before anything is written.
const plan = [];
for (const g of games) {
  const card = contractsRepo.cardOn(CONTRACT, g.date);
  const charges = gameweeksRepo.get(g.id).charges;
  const n = charges.length;
  const targetPitch = r2((Number(card?.pitch_per_game) || 0) * (Number(g.hours) || 1));
  const lines = [];
  for (const ch of charges) {
    // The guest's own agreed price is a fact about the person, not the card.
    const agreed = db.prepare(
      "SELECT outside_cost FROM players WHERE id = ?").get(ch.player_id)?.outside_cost;
    const bespoke = ch.settler_type === 'outside' && Number(agreed) > 0;
    const fromOther = ch.settler_type === 'outside'
      || ch.settle_contract_id !== CONTRACT;
    const priced = bespoke
      ? { rate_type: 'noncontract', amount: Number(agreed) }
      : gameweeksRepo.rateForCharge({
        gameweekId: g.id, isCaptain: !!ch.is_captain, fromOtherContract: fromOther, players: n,
      });
    const blocked = PITCH_ONLY || (ch.is_cash && ch.paid && !ALLOW_PAID_CASH
      && r2(priced.amount) !== r2(ch.amount));
    lines.push({
      charge_id: ch.id,
      who: ch.player_name,
      settler: ch.settled_by,
      mode: ch.settle_mode,
      was: r2(ch.amount),
      now: blocked ? r2(ch.amount) : r2(priced.amount),
      rate_type: blocked ? ch.rate_type : priced.rate_type,
      blocked,
      bespoke,
    });
  }
  plan.push({ game: g, players: n, card, targetPitch, lines });
}

// ---- say it, in full, before doing any of it.
let movedTotal = 0;
const perSettler = new Map();
for (const p of plan) {
  const changed = p.lines.filter(l => l.now !== l.was);
  const pitchMoves = r2(p.targetPitch) !== r2(p.game.cost_per_gw);
  console.log(`${p.game.date}  ${p.players} players  `
    + `card from ${p.card?.effective_from || '(none)'}`);
  console.log(`   pitch ${p.game.cost_per_gw} ${pitchMoves ? `-> ${p.targetPitch}` : '(unchanged)'}`
    + `   water ${p.game.game_cost}`);
  if (!changed.length) console.log('   every charge already on the card');
  for (const l of changed) {
    console.log(`   ${l.who.padEnd(14)} ${l.mode.padEnd(8)} ${String(l.was).padStart(6)}`
      + ` -> ${String(l.now).padStart(6)}  ${l.rate_type}`);
    // A balance-settled charge moves a balance; cash and kitty do not.
    if (l.mode === 'balance') {
      perSettler.set(l.settler, r2((perSettler.get(l.settler) || 0) + (l.was - l.now)));
      movedTotal = r2(movedTotal + (l.was - l.now));
    }
  }
  if (!PITCH_ONLY) {
    for (const l of p.lines.filter(x => x.blocked)) {
      console.log(`   SKIPPED ${l.who} — cash already collected at ${l.was};`
        + ' pass --allow-paid-cash to move it anyway');
    }
  }
  console.log('');
}

console.log('Balance effect, per player (positive = they get money back):');
for (const [id, delta] of [...perSettler].sort((a, b) => b[1] - a[1])) {
  const name = db.prepare('SELECT name FROM players WHERE id = ?').get(id)?.name || id;
  console.log(`  ${name.padEnd(16)} ${money(delta).padStart(9)}`);
}
console.log(`  ${'TOTAL'.padEnd(16)} ${money(movedTotal).padStart(9)}`);

if (!APPLY) {
  console.log('\nDry run — nothing was written. Re-run with --apply to commit it.');
  process.exit(0);
}

// ---- apply, and prove it landed.
const balanceOf = (playerId, contractId) => {
  // Recomputed here from raw SQL rather than through the ledger repo: the repo
  // is what did the writing, so asking it whether the writing was right is the
  // one question it cannot answer independently.
  const row = db.prepare(`
    SELECT COALESCE(l.opening_balance,0)
      + COALESCE((SELECT SUM(q.amount) FROM contributions q
                  WHERE q.player_id = l.player_id AND q.contract_id = l.contract_id
                    AND q.historical = 0), 0)
      - COALESCE((SELECT SUM(ch.amount) FROM charges ch
                  JOIN gameweeks g ON g.id = ch.gameweek_id
                  LEFT JOIN players sp ON sp.id = COALESCE(ch.charged_to, ch.player_id)
                  WHERE COALESCE(ch.charged_to, ch.player_id) = l.player_id
                    AND COALESCE(ch.settle_contract_id, g.contract_id) = l.contract_id
                    AND g.historical = 0 AND ch.settled_from_kitty = 0
                    AND NOT (ch.settles_cash = 1
                             OR COALESCE(sp.player_type,'regular') = 'outside')), 0)
      + COALESCE((SELECT SUM(t.amount) FROM transactions t
                  WHERE t.player_id = l.player_id AND t.contract_id = l.contract_id
                    AND t.status = 'approved'
                    AND t.type NOT IN ('contribution','charge')), 0) AS bal
    FROM ledgers l WHERE l.player_id = ? AND l.contract_id = ?`).get(playerId, contractId);
  return r2(row?.bal ?? 0);
};

const before = new Map([...perSettler.keys()].map(id => [id, balanceOf(id, CONTRACT)]));
const kittyBefore = r2(db.prepare(
  "SELECT COALESCE(SUM(CASE WHEN kind='income' THEN amount ELSE -amount END),0) t FROM kitty")
  .get().t);

db.exec('BEGIN IMMEDIATE');
try {
  for (const p of plan) {
    const edits = p.lines.filter(l => l.now !== l.was)
      .map(l => ({ chargeId: l.charge_id, newAmount: l.now }));
    if (r2(p.targetPitch) !== r2(p.game.cost_per_gw)) {
      db.prepare('UPDATE gameweeks SET cost_per_gw = ? WHERE id = ?')
        .run(p.targetPitch, p.game.id);
    }
    if (edits.length) {
      gameweeksRepo.applyChargeEdits(p.game.id, edits, {
        reason: `Repriced onto the card in force from ${p.card?.effective_from || 'the contract'}`,
        changedBy: 'reprice-games',
      });
    }
    for (const l of p.lines.filter(x => x.now !== x.was)) {
      db.prepare('UPDATE charges SET rate_type = ? WHERE id = ?').run(l.rate_type, l.charge_id);
    }
    // The pitch may have moved without a single charge changing, and the kitty
    // row is derived from both.
    gameweeksRepo.recomputeKitty(p.game.id);
  }

  // ---- did it land where the dry run said it would?
  const problems = [];
  for (const [id, delta] of perSettler) {
    const want = r2((before.get(id) || 0) + delta);
    const got = balanceOf(id, CONTRACT);
    if (Math.abs(want - got) > 0.005) {
      problems.push(`${id}: expected ${want}, found ${got}`);
    }
  }
  // Every night's kitty row, recomputed from the charges by the rule written
  // down in finance.js: what was collected, less the pitch, less the water the
  // club itself bought.
  for (const p of plan) {
    // Guest cash counts once it has actually been handed over, never before:
    // until then the night is short by exactly that much and the cashier is
    // out of pocket for it. Same rule as recomputeGameKitty, written out here
    // from the prose rather than called, so this is a second opinion.
    const collected = r2(db.prepare(`
      SELECT COALESCE(SUM(CASE
        WHEN ch.settled_from_kitty = 1 THEN 0
        WHEN (ch.settles_cash = 1 OR COALESCE(sp.player_type,'regular') = 'outside')
          THEN CASE WHEN ch.paid = 1 THEN ch.amount ELSE 0 END
        ELSE ch.amount END), 0) s
      FROM charges ch LEFT JOIN players sp ON sp.id = COALESCE(ch.charged_to, ch.player_id)
      WHERE ch.gameweek_id = ?`).get(p.game.id).s);
    const water = (p.game.game_cost_paid_by || 'self') === 'self' ? Number(p.game.game_cost) || 0 : 0;
    const pitch = r2(db.prepare('SELECT cost_per_gw c FROM gameweeks WHERE id = ?')
      .get(p.game.id).c);
    const want = r2(collected - pitch - water);
    const row = db.prepare("SELECT kind, amount FROM kitty WHERE id = ?").get(`k_gw_${p.game.id}`);
    const got = row ? r2(row.kind === 'income' ? row.amount : -row.amount) : 0;
    if (Math.abs(want - got) > 0.005) {
      problems.push(`kitty ${p.game.date}: expected ${want}, found ${got}`);
    }
  }

  if (problems.length) {
    db.exec('ROLLBACK');
    console.log('\nROLLED BACK — the figures did not land where the dry run said:');
    for (const line of problems) console.log(`  ${line}`);
    process.exit(1);
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('\nROLLED BACK —', e.message);
  process.exit(1);
}

const kittyAfter = r2(db.prepare(
  "SELECT COALESCE(SUM(CASE WHEN kind='income' THEN amount ELSE -amount END),0) t FROM kitty")
  .get().t);
console.log('\nApplied, and every balance reconciles.');
console.log(`Kitty ${kittyBefore} -> ${kittyAfter}  (${money(kittyAfter - kittyBefore)})`);
