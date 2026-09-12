#!/usr/bin/env node
/**
 * result-gaps.js — which games have no usable result.
 *
 * A game counts towards nobody's record unless its outcome can be resolved: a
 * game_results row, or a score line that names the winning side. This lists the
 * ones that fall through both, so they can be filled in from the Season panel.
 *
 * Read-only.
 *
 *   node scripts/result-gaps.js            # every contract
 *   node scripts/result-gaps.js sat        # one of them
 */
import { db, initSchema, DB_FILE } from '../server/db.js';
import { normaliseScore, winningTeam } from '../server/results_import.js';

initSchema();
const only = process.argv[2] || null;
console.log(`Database: ${DB_FILE}\n`);

const contracts = db.prepare('SELECT id, name FROM contracts ORDER BY sort').all()
  .filter(c => !only || c.id === only);

for (const c of contracts) {
  const games = db.prepare(`SELECT g.id, g.date, g.score, g.historical, g.num_players,
      gr.gameweek_id AS has_row
    FROM gameweeks g LEFT JOIN game_results gr ON gr.gameweek_id = g.id
    WHERE g.contract_id = ? ORDER BY g.date`).all(c.id);

  const gaps = [];
  for (const g of games) {
    if (g.has_row) continue;                       // already structured
    const teams = db.prepare(
      "SELECT DISTINCT team FROM charges WHERE gameweek_id = ? AND team <> ''")
      .all(g.id).map(r => r.team);
    const sc = normaliseScore(g.score);
    if (sc.known && (sc.winner === 'draw' || winningTeam(sc.winner, teams))) continue;
    gaps.push({ ...g, teams });
  }

  console.log(`${c.name} — ${gaps.length} of ${games.length} games have no usable result`);
  for (const g of gaps) {
    // Say WHY each one cannot be read, because the fix differs: a missing score
    // needs typing in, an unreadable one needs rewording, and a game with no
    // teams on its charges cannot be judged at all.
    const why = !String(g.score || '').trim() ? 'no score recorded'
      : !g.teams.length ? 'no teams on the charges — a winner cannot be attributed'
        : 'score text does not name a winner the teams match';
    console.log(`  ${g.date}${g.historical ? '  (imported)' : ''}  — ${why}`);
    if (String(g.score || '').trim()) console.log(`      score reads: ${JSON.stringify(g.score)}`);
    if (g.teams.length) console.log(`      teams: ${g.teams.join(' / ')}`);
  }
  console.log('');
}
