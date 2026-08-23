// results_import.js — import a season of match results from the tracking sheet.
//
// Input is the sheet pasted as TSV, with the columns:
//   Date | Teams | Captains | Score
//
// The Teams cell is a quoted, multi-line block using colour labels rather than
// the emoji the WhatsApp parser expects, e.g.
//
//   "Red: Hasan Sarath Nihas Tush Shone Jeetu
//
//    Blue: Aws Zaki Rakesh Saheer Toby Sikku"
//
// and the labels vary in the wild — "Red:", "Blue:", "Team Legacy Blue: :",
// "Team Sinners Red: :". Captains arrive either in their own column
// ("Shone nihas", "no capt", or blank) or inline as "Shone(C)" / "Vijay (c)".
// Scores are free text: "Reds win", "Blues win by 4", "Draw 6-6", "Reds win 9-5".
//
// IMPORTANT — this import is deliberately financial-nil. Player participation
// only exists in the `charges` table, so importing history has to write charge
// rows; every one is written at amount 0. The import records who played, which
// team they were on and who captained. It never moves a balance.

import { buildIndex, matchToken } from './parser.js';

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};

// "Team Legacy Blue: :" / "Red:" / "Blues -" → canonical colour.
const TEAM_LABEL = /^(?:team\s+\S+\s+)?(red|blue|white|black|green|yellow|orange|purple)s?\s*[:\-]+\s*[:\-]*\s*/i;

// Words that are never player names in this sheet.
const STOP = new Set(['no', 'capt', 'capts', 'captain', 'captains', 'game', 'none',
  'vs', 'v', 'and', '&', 'team', 'teams', '-', 'na', 'n/a']);

/** Split TSV text into rows of cells, honouring quoted fields with embedded newlines. */
export function parseDelimited(text, delim = '\t') {
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  const src = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delim) { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  row.push(cell);
  if (row.some(c => c.trim())) rows.push(row);
  return rows.filter(r => r.some(c => c.trim()));
}

/** "6 December 2025" / "6 Dec 2025" / "2025-12-06" / "06/12/2025" → "YYYY-MM-DD". */
export function parseSheetDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;

  m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})$/);
  if (m) {
    const month = Object.keys(MONTHS).find(k => k.startsWith(m[2].toLowerCase().slice(0, 3)));
    if (month) return `${m[3]}-${String(MONTHS[month]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }

  m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const month = Object.keys(MONTHS).find(k => k.startsWith(m[1].toLowerCase().slice(0, 3)));
    if (month) return `${m[3]}-${String(MONTHS[month]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }

  // Day-first, matching the sheet's convention.
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;

  return null;
}

/**
 * Classify a free-text score.
 * Returns { text, teamA, teamB, goalsA, goalsB, winner, margin, known }.
 * `winner` is the colour named as winning, lowercased, or 'draw', or null.
 */
export function parseScoreText(raw) {
  const text = String(raw || '').trim();
  const out = { text, goalsA: null, goalsB: null, winner: null, margin: null, known: false };
  if (!text) return out;

  const exact = text.match(/(\d+)\s*[-–—:]\s*(\d+)/);
  if (exact) {
    out.goalsA = +exact[1];
    out.goalsB = +exact[2];
    out.margin = Math.abs(out.goalsA - out.goalsB);
    out.known = true;
  }

  const by = text.match(/\bby\s+(\d+)\b/i);
  if (by && out.margin === null) { out.margin = +by[1]; out.known = true; }

  if (/\bdraw\b|\btie[ds]?\b/i.test(text)) { out.winner = 'draw'; out.known = true; return out; }
  if (out.goalsA !== null && out.goalsA === out.goalsB) { out.winner = 'draw'; return out; }

  const colour = text.match(/\b(red|blue|white|black|green|yellow|orange|purple)s?\b/i);
  if (colour && /\bwin|\bwon|\bbeat/i.test(text)) { out.winner = colour[1].toLowerCase(); out.known = true; }
  else if (colour && out.goalsA !== null) { out.winner = colour[1].toLowerCase(); }

  return out;
}

/** Pull "(C)" / "(c)" off a token. → { token, isCaptain } */
function stripCaptain(tok) {
  const m = tok.match(/^(.*?)\s*\(\s*c\s*\)\s*$/i);
  return m ? { token: m[1], isCaptain: true } : { token: tok, isCaptain: false };
}

/** Split a Teams cell into [{ team, tokens:[{token,isCaptain}] }]. */
export function splitTeamsCell(cell) {
  const blocks = [];
  let current = null;
  for (const rawLine of String(cell || '').split('\n')) {
    let line = rawLine.trim();
    if (!line) continue;
    const m = line.match(TEAM_LABEL);
    if (m) {
      const team = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      current = { team, tokens: [] };
      blocks.push(current);
      line = line.slice(m[0].length);
    }
    if (!current) { current = { team: 'Team 1', tokens: [] }; blocks.push(current); }
    for (const t of line.split(/[\s,]+/)) {
      const clean = t.trim();
      if (!clean) continue;
      const { token, isCaptain } = stripCaptain(clean);
      const bare = token.replace(/[^\p{L}\p{N}+'-]/gu, '');
      if (!bare || STOP.has(bare.toLowerCase())) continue;
      current.tokens.push({ token: bare, isCaptain });
    }
  }
  return blocks.filter(b => b.tokens.length);
}

/**
 * Parse the pasted sheet into importable games.
 * Nothing is written here — the caller decides after showing the preview.
 */
/**
 * A shared-balance account like "AWS + Ali" is ONE billing entity but TWO people.
 * That distinction only matters here: for money they are correctly a single
 * ledger, but for appearances, wins and captaincy they must not be merged —
 * doing so credits one person with the other's games, and when both play the
 * same match the second is dropped as a duplicate.
 *
 * So results import refuses to resolve a token to a shared account. Those names
 * are reported as unmatched, which surfaces them in the preview instead of
 * quietly attributing the game to the wrong person. Splitting them into separate
 * players linked by balance_group_id is the real fix, and is the admin's call.
 */
function isSharedAccount(player) {
  return /\s[+&/]\s/.test(String(player?.name || ''));
}

export function parseResultsSheet(text, players) {
  const index = buildIndex(players);
  const rows = parseDelimited(text);
  if (!rows.length) return { games: [], skipped: [], unmatched: [] };

  // Drop a header row if present.
  const first = rows[0].map(c => c.trim().toLowerCase());
  const body = (first[0] === 'date' || first.includes('teams')) ? rows.slice(1) : rows;

  const games = [];
  const skipped = [];
  const unmatchedCounts = new Map();

  body.forEach((cells, i) => {
    const lineNo = i + 1;
    const [dateRaw = '', teamsRaw = '', captainsRaw = '', scoreRaw = ''] = cells;
    const date = parseSheetDate(dateRaw);

    if (!date) { skipped.push({ line: lineNo, raw: dateRaw.trim(), reason: 'unrecognised date' }); return; }
    if (/no\s*game/i.test(teamsRaw) || !teamsRaw.trim()) {
      skipped.push({ line: lineNo, raw: dateRaw.trim(), reason: 'no game' });
      return;
    }

    const blocks = splitTeamsCell(teamsRaw);
    if (!blocks.length) { skipped.push({ line: lineNo, raw: dateRaw.trim(), reason: 'no players found' }); return; }

    // Captains column: names, or "no capt"/blank.
    const captainTokens = /no\s*capt/i.test(captainsRaw)
      ? []
      : String(captainsRaw || '').split(/[\s,]+/).map(t => t.trim()).filter(t => t && !STOP.has(t.toLowerCase()));
    const captainIds = new Set();
    for (const t of captainTokens) {
      const p = matchToken(t, players, index);
      if (p && !isSharedAccount(p)) captainIds.add(p.id);
      else bump(unmatchedCounts, t, p ? 'shared account — split into individuals' : 'not on roster');
    }

    const seen = new Set();
    const rowsOut = [];
    for (const b of blocks) {
      for (const { token, isCaptain } of b.tokens) {
        const p = matchToken(token, players, index);
        if (!p) { bump(unmatchedCounts, token, 'not on roster'); continue; }
        if (isSharedAccount(p)) {
          // One ledger, two people — see isSharedAccount.
          bump(unmatchedCounts, token, `resolves to the shared account "${p.name}" — split it into individual players to count them separately`);
          continue;
        }
        // A player can only appear once per game — see gameweeksRepo.create.
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        rowsOut.push({
          player_id: p.id,
          player_name: p.name,
          token,
          team: b.team,
          is_captain: isCaptain || captainIds.has(p.id),
        });
      }
    }

    if (!rowsOut.length) { skipped.push({ line: lineNo, raw: dateRaw.trim(), reason: 'no players matched' }); return; }

    const score = parseScoreText(scoreRaw);
    const teamNames = [...new Set(blocks.map(b => b.team))];

    games.push({
      line: lineNo,
      date,
      teams: teamNames,
      score_text: score.text,
      score,
      players: rowsOut,
      matched_count: rowsOut.length,
      captain_count: rowsOut.filter(r => r.is_captain).length,
      teams_raw: teamsRaw.trim(),
    });
  });

  const unmatched = [...unmatchedCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([token, v]) => ({ token, count: v.count, reason: v.reason }));

  return { games, skipped, unmatched };
}

function bump(map, token, reason = 'not on roster') {
  const k = token.trim();
  if (!k) return;
  const cur = map.get(k) || { count: 0, reason };
  cur.count += 1;
  cur.reason = reason;          // most specific reason wins
  map.set(k, cur);
}
