#!/usr/bin/env node
/**
 * test-scores.js — how a free-text result is read.
 *
 * Thirty of the thirty-eight Saturday games have no structured result row, so
 * this parser IS the record for most of that contract's history. Every string
 * below marked LIVE is one that actually appears in the production database;
 * they are here so a change to the parser cannot quietly restate the club's
 * past. The rest are the shapes that have gone wrong or could.
 *
 * The rule the assertions encode: state what the text says, and no more. A
 * winner named without numbers is a win with UNKNOWN goals, never an invented
 * scoreline — see normaliseScore for why that mattered.
 *
 * Run: npm run test:scores
 */
import { normaliseScore } from '../server/results_import.js';

let pass = 0;
let fail = 0;

/**
 * @param {string} text      the score as somebody typed it
 * @param {object} want      { winner, win, lose, margin } — win/lose omitted
 *                           means the goals must come back UNKNOWN
 * @param {string} note      why this case is here
 */
function check(text, want, note = '') {
  const got = normaliseScore(text);
  const problems = [];

  if (got.winner !== want.winner) {
    problems.push(`winner ${JSON.stringify(got.winner)}, expected ${JSON.stringify(want.winner)}`);
  }
  const wantsGoals = want.win !== undefined;
  if (got.goalsKnown !== wantsGoals) {
    problems.push(wantsGoals
      ? `goals came back unknown, expected ${want.win}-${want.lose}`
      : `invented goals ${got.goalsWin}-${got.goalsLose}, expected none`);
  } else if (wantsGoals && (got.goalsWin !== want.win || got.goalsLose !== want.lose)) {
    problems.push(`goals ${got.goalsWin}-${got.goalsLose}, expected ${want.win}-${want.lose}`);
  }
  if (want.margin !== undefined && got.margin !== want.margin) {
    problems.push(`margin ${got.margin}, expected ${want.margin}`);
  }
  // A winner or a draw must always be reported as resolvable.
  if ((want.winner !== null) !== got.known) {
    problems.push(`known=${got.known} for winner ${JSON.stringify(want.winner)}`);
  }

  if (!problems.length) { pass++; return; }
  fail++;
  console.error(`  X ${JSON.stringify(text)}${note ? `  — ${note}` : ''}`);
  for (const p of problems) console.error(`      ${p}`);
}

console.log('Scorelines written out in full (LIVE)');
check('Blue win 10-5', { winner: 'blue', win: 10, lose: 5, margin: 5 });
check('Blue win 12-9', { winner: 'blue', win: 12, lose: 9 });
check('Blue win 13-9', { winner: 'blue', win: 13, lose: 9 });
check('Blue win 14-13', { winner: 'blue', win: 14, lose: 13, margin: 1 });
check('Blue win 4-0', { winner: 'blue', win: 4, lose: 0 });
check('Blue win 5-3', { winner: 'blue', win: 5, lose: 3 });
check('Blue win 7-5', { winner: 'blue', win: 7, lose: 5 });
check('Blue win 7-6', { winner: 'blue', win: 7, lose: 6 });
check('Blue win 8-6', { winner: 'blue', win: 8, lose: 6 });
check('Blues win 12-7', { winner: 'blue', win: 12, lose: 7 });
check('Blues win 7-1.', { winner: 'blue', win: 7, lose: 1 });
check('Blues win score 10-6', { winner: 'blue', win: 10, lose: 6 });
check('Red win 10-4', { winner: 'red', win: 10, lose: 4 });
check('Red win 12-6', { winner: 'red', win: 12, lose: 6 });
check('Red win 13-9', { winner: 'red', win: 13, lose: 9 });
check('Red win 17-11', { winner: 'red', win: 17, lose: 11 });
check('Red win 6-5', { winner: 'red', win: 6, lose: 5 });
check('Red win 7-6', { winner: 'red', win: 7, lose: 6 });
check('Reds win 5-4', { winner: 'red', win: 5, lose: 4 });
check('Reds win 9-5', { winner: 'red', win: 9, lose: 5 });
check('Blue:  Blues win 6-1 first game.', { winner: 'blue', win: 6, lose: 1 },
  'the side is named twice before the score');

console.log('The score first, the winner after (LIVE)');
check('8-7 BLUES', { winner: 'blue', win: 8, lose: 7 });
check('7-5 to Blues', { winner: 'blue', win: 7, lose: 5 });
check('12-9 to the blues', { winner: 'blue', win: 12, lose: 9 });

console.log('Draws (LIVE)');
check('Draw 11-11', { winner: 'draw', win: 11, lose: 11, margin: 0 });
check('Draw 4-4', { winner: 'draw', win: 4, lose: 4 });
check('Draw 6-6', { winner: 'draw', win: 6, lose: 6 });
// Was read as a 0–0 draw: the dash sits between a name and a number, so the
// scoreline pattern never matched and the goals were dropped on the floor.
check('Red 5 - Blue 5 (draw)', { winner: 'draw', win: 5, lose: 5 },
  'goals written against each side');

console.log('A margin, but no scoreline (LIVE) — the goals must stay unknown');
check('Blues win by 2 Goals', { winner: 'blue', margin: 2 });
check('Blues win by 3', { winner: 'blue', margin: 3 });
check('Blues win by 4', { winner: 'blue', margin: 4 });
check('Reds Win by 2', { winner: 'red', margin: 2 });
check('Reds win by 1', { winner: 'red', margin: 1 });
check('Reds win by 2 goals', { winner: 'red', margin: 2 });
check('Reds win by 4', { winner: 'red', margin: 4 });
check('Reds win by 8', { winner: 'red', margin: 8 });
// "1 goal" states the margin as plainly as "by 1" does, but only "by N" was
// understood — so a one-goal win was recorded as a three-goal one.
check('Reds win 1 goal', { winner: 'red', margin: 1 }, 'margin written without "by"');

console.log('A winner and nothing else (LIVE) — no goals may be invented');
check('Blues win', { winner: 'blue', margin: null });
check('Reds win', { winner: 'red', margin: null });
check('Reds win Tourney', { winner: 'red', margin: null });
check('whites win, blues runners up, and whites', { winner: 'white', margin: null },
  'two sides named, only one of them won');

console.log('Both sides scored against their own name (LIVE)');
// Read as a MARGIN of 10, so the 9 was discarded and the game recorded 10–0.
check('Red wins by 10 to blues 9', { winner: 'red', win: 10, lose: 9, margin: 1 },
  '"by 10 to 9" is a scoreline, not a margin');

console.log('Phrasings that name the loser first');
// The old parser took the first colour it saw and handed it the higher number,
// so every one of these recorded the result backwards.
check('Red lost to Blue 9-12', { winner: 'blue', win: 12, lose: 9 });
check('Red 9-12 Blue', { winner: 'blue', win: 12, lose: 9 });
check('Blue beat Red 12-9', { winner: 'blue', win: 12, lose: 9 });
check('Blue 3 Red 1', { winner: 'blue', win: 3, lose: 1 });
check('Red 1 Blue 3', { winner: 'blue', win: 3, lose: 1 });

console.log('Nothing readable');
check('', { winner: null });
check('   ', { winner: null });
check('great game everyone', { winner: null });
check('0-0', { winner: 'draw', win: 0, lose: 0 });
// No side is named, so there is nobody to award it to.
check('7-5', { winner: null, margin: 2 });
// A number that is not a score must not become one.
check('Reds win by 2 to make it 3 in a row', { winner: 'red', margin: 2 },
  'only the margin is a real number here');

console.log('');
if (fail) {
  console.error(`X test-scores: ${pass} passed, ${fail} failed\n`);
  process.exit(1);
}
console.log(`✓ test-scores: ${pass} passed\n`);
