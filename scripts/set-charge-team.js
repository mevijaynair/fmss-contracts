#!/usr/bin/env node
/**
 * set-charge-team.js — put a player on the right side of a game.
 *
 * Which team is on a charge decides whether that game was a win or a loss for
 * that player, so a wrong one is a wrong record — and because every other side
 * in the game is judged against it, a value that matches no side at all makes
 * the player a loser of every game they were in.
 *
 * That is not hypothetical: Jaison's charge for Mon/Thu on 13 August read
 * "Team 1" rather than Red. It survived only because that game was a 5–5 draw,
 * where every side gets the same answer. It also made the game look like a
 * three-sided tournament to the Results screen, which holds those out of the
 * match tables entirely.
 *
 * Changing a team moves no money, and this refuses to run if it does.
 *
 *   node scripts/set-charge-team.js <contract> <YYYY-MM-DD> <player> <team>
 *   node scripts/set-charge-team.js mon_thu 2026-08-13 Jaison Red --apply
 */
import { db, initSchema, DB_FILE } from '../server/db.js';

const [contractId, date, playerName, team] = process.argv.slice(2);
const apply = process.argv.includes('--apply');
if (!contractId || !date || !playerName || !team) {
  console.error('Usage: set-charge-team.js <contract> <YYYY-MM-DD> <player> <team> [--apply]');
  process.exit(1);
}
initSchema();
console.log(`Database: ${DB_FILE}`);
console.log(`Mode: ${apply ? 'APPLY' : 'report only (pass --apply to change anything)'}\n`);

const game = db.prepare('SELECT id, date, score FROM gameweeks WHERE contract_id = ? AND date = ?')
  .get(contractId, date);
if (!game) { console.error(`No ${contractId} game on ${date}.`); process.exit(1); }

const rows = db.prepare(`SELECT ch.id, ch.team, ch.is_captain, ch.amount, p.name
  FROM charges ch JOIN players p ON p.id = ch.player_id
  WHERE ch.gameweek_id = ? AND LOWER(p.name) = LOWER(?)`).all(game.id, playerName);
if (rows.length !== 1) {
  console.error(rows.length
    ? `${rows.length} charges for "${playerName}" in that game — refusing to guess.`
    : `No charge for "${playerName}" in that game.`);
  process.exit(1);
}
const row = rows[0];

const sides = () => db.prepare(`SELECT ch.team, COUNT(*) n, GROUP_CONCAT(p.name, ', ') who
  FROM charges ch JOIN players p ON p.id = ch.player_id
  WHERE ch.gameweek_id = ? AND TRIM(ch.team) <> '' GROUP BY ch.team ORDER BY ch.team`).all(game.id);
const show = (label) => {
  console.log(label);
  for (const s of sides()) console.log(`  ${String(s.team).padEnd(8)} (${s.n})  ${s.who}`);
};

show('BEFORE');
console.log(`\n${row.name}: "${row.team}" -> "${team}"${row.is_captain ? '  (captain)' : ''}`);
if (!apply) { console.log('\nRe-run with --apply to make the change.'); process.exit(0); }

// A team is not money. Prove it, and roll back if it ever becomes money.
const totals = () => Object.fromEntries(db.prepare('SELECT id FROM contracts').all().map(c => [
  c.id, Math.round(db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM charges ch
    JOIN gameweeks g ON g.id = ch.gameweek_id WHERE g.contract_id = ?`).get(c.id).t * 100) / 100,
]));

db.exec('BEGIN IMMEDIATE');
try {
  const before = totals();
  db.prepare('UPDATE charges SET team = ? WHERE id = ?').run(team, row.id);
  const after = totals();
  for (const [k, v] of Object.entries(before)) {
    if (Math.abs((after[k] ?? 0) - v) > 0.005) {
      throw new Error(`${k} charges moved ${v} -> ${after[k]} — a team change must not touch money`);
    }
  }
  db.exec('COMMIT');
  console.log('');
  show('AFTER');
  console.log(`\nCharges unchanged on every contract: ${JSON.stringify(after)}`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error(`\nRolled back: ${e.message}`);
  process.exit(1);
}
