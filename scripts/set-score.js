#!/usr/bin/env node
/**
 * set-score.js — record a game's result from the command line.
 *
 * The Season panel is the normal way to do this. This exists for correcting a
 * game found by result-gaps.js when it is quicker to name the date than to go
 * looking for it, and it runs the same applyScore the panel does — so the
 * readable text, the numeric scoreline and the game_results row every statistic
 * reads all stay in step.
 *
 * It prints what it would do and changes nothing unless you pass --apply.
 *
 *   node scripts/set-score.js sat 2026-07-25 "Blue win 12-9"
 *   node scripts/set-score.js sat 2026-07-25 "Blue win 12-9" --apply
 */
import { db, initSchema, DB_FILE } from '../server/db.js';
import { gameweeksRepo } from '../server/repos/gameweeks.js';

const [contractId, date, score] = process.argv.slice(2);
const apply = process.argv.includes('--apply');
if (!contractId || !date || !score) {
  console.error('Usage: set-score.js <contract> <YYYY-MM-DD> "<score>" [--apply]');
  process.exit(1);
}
initSchema();
console.log(`Database: ${DB_FILE}`);
console.log(`Mode: ${apply ? 'APPLY' : 'report only (pass --apply to change anything)'}\n`);

const game = db.prepare('SELECT id, date, score, scoreline, historical FROM gameweeks WHERE contract_id = ? AND date = ?')
  .get(contractId, date);
if (!game) { console.error(`No ${contractId} game on ${date}.`); process.exit(1); }

const show = (label) => {
  const g = db.prepare('SELECT score, scoreline FROM gameweeks WHERE id = ?').get(game.id);
  const r = db.prepare(`SELECT team_a_name, team_b_name, goals_team_a, goals_team_b, result
    FROM game_results WHERE gameweek_id = ?`).get(game.id);
  console.log(`${label}`);
  console.log(`  score    : ${JSON.stringify(g.score)}`);
  console.log(`  scoreline: ${JSON.stringify(g.scoreline)}`);
  console.log(`  result   : ${r ? `${r.team_a_name} ${r.goals_team_a} – ${r.team_b_name} ${r.goals_team_b} (${r.result})` : 'none'}`);
};

show('BEFORE');
if (!apply) {
  console.log(`\nWould set the score to ${JSON.stringify(score)}. Re-run with --apply.`);
  process.exit(0);
}

// Recording a result moves no money — it writes the score, the scoreline and the
// result row, nothing else — but the check is cheap and proves it.
const totals = () => Object.fromEntries(db.prepare('SELECT id FROM contracts').all().map(c => [
  c.id, Math.round(db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM charges ch
    JOIN gameweeks g ON g.id = ch.gameweek_id WHERE g.contract_id = ?`).get(c.id).t * 100) / 100,
]));
const before = totals();

gameweeksRepo.updateMetadata(game.id, { score });

const after = totals();
for (const [k, v] of Object.entries(before)) {
  if (Math.abs((after[k] ?? 0) - v) > 0.005) {
    console.error(`\nRefusing to continue: ${k} charges moved ${v} → ${after[k]}`);
    process.exit(1);
  }
}
console.log('');
show('AFTER');
console.log(`\nCharges unchanged on every contract: ${JSON.stringify(after)}`);
