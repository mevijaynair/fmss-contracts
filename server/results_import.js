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

const COLOURS = ['red', 'blue', 'white', 'black', 'green', 'yellow', 'orange', 'purple', 'pink'];

// A team label is whatever sits before the first colon on a line — "Red:",
// "Team Legacy Blue: :", "Team RAVISHING:", "BOMBASTIC:". Requiring a colour word
// was wrong: squad names like RAVISHING matched nothing, so the label itself was
// read as a player AND every player collapsed onto one team, wrecking win
// attribution. Anything up to a colon is now a label.
const LABELLED_LINE = /^\s*([^:]{1,40}?)\s*:+\s*:?\s*/;

// Some rows separate the label with a dash instead: "Red -  Jeetu Hasan …".
// Restricted to lines whose prefix actually names a colour, because a bare dash
// is also used mid-list ("Rony (C) - Jeetu Kirk"), where the prefix is a player.
const DASH_LABEL = new RegExp(`^\\s*((?:team\\s+)?(?:${COLOURS.join('|')})s?)\\s*[-–—]\\s+`, 'i');

// Bare label line: no colon, but a single short word on its own line, e.g.
// "BOMBASTIC" or "BLUE" with the players beneath it. Must be one word — a line
// like "FUNny game" is a note, not a label.
const BARE_LABEL = /^\s*(?:team\s+)?([A-Za-z][A-Za-z0-9'&-]{1,24})\s*$/;
const isBareLabel = (line) => BARE_LABEL.test(line.trim());

// Colour emoji used as a team marker instead of a word, e.g. "🤍 Nihas (C) …".
// Without this the line has no label, so its players are absorbed into the
// previous team — which is how one team ended up with two captains.
const EMOJI_TEAMS = [
  [/[🔴❤️❤🟥♥️🍎🌹🚩]/u, 'Red'],
  [/[🔵💙🟦💎🌊🫐]/u, 'Blue'],
  [/[🖤⚫🟫]/u, 'Black'],
  [/[🤍⚪⬜]/u, 'White'],
  [/[💛🟡]/u, 'Yellow'],
  [/[💚🟢]/u, 'Green'],
];
function emojiTeam(line) {
  for (const [re, name] of EMOJI_TEAMS) if (re.test(line)) return name;
  return null;
}

// Captain markers used instead of "(C)": "C1", "C2", "C3", "Capt1".
const CAPTAIN_MARKER = /^(?:c|capt|captain)\s*\d+$/i;

/** Normalise a raw label to a team name — canonical colour if it names one. */
function canonicalTeam(raw) {
  const s0 = String(raw).trim();
  const low0 = s0.toLowerCase();
  // "REDRed", "Reds", "Team Legacy Blue" → pick the colour it mentions.
  for (const c of COLOURS) {
    if (new RegExp(`(^|[^a-z])${c}`, 'i').test(low0)) return c[0].toUpperCase() + c.slice(1);
  }
  // Only drop a leading "Team" when something meaningful survives, otherwise
  // "Team 1" collapses to the bare name "1".
  const stripped = s0.replace(/^team\s+/i, '').trim();
  const s = /[a-z]/i.test(stripped) ? stripped : s0;
  return s.replace(/\s+/g, ' ').slice(0, 24) || 'Team';
}

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
 * Turn a free-text result into a winner and, when the text really says so,
 * goals:
 *   "12-9"                 → blue? 12–9, goals known
 *   "Red 5 - Blue 5 (draw)" → draw 5–5, goals known
 *   "Blues win by 4"        → blue wins, margin 4, GOALS NOT KNOWN
 *   "Reds win"              → red wins, no margin, GOALS NOT KNOWN
 *
 * Returns { winner, margin, goalsWin, goalsLose, known, goalsKnown, text }.
 * `winner` is the winning colour lowercased, 'draw', or null when unreadable.
 * `known` says the OUTCOME can be resolved; `goalsKnown` says the goals were
 * actually written down.
 *
 * It used to invent a 3–0 whenever a winner was named without a scoreline, on
 * the reasoning that the game should still contribute a goal difference. Eight
 * Saturdays were recorded that way — 24 goals across 106 appearances, about a
 * third of the goal data on that contract — and although the result carried an
 * `assumed` flag to mark it, nothing anywhere ever read the flag. So the Goal
 * Difference leaderboard ranked players partly on numbers nobody had written,
 * shown exactly like the real ones. A margin-only text ("won by 4") has the
 * same problem in smaller form: the difference is real but 4–0 is a guess.
 *
 * Now the outcome is still counted — a win is a win — and the goals simply stay
 * unknown, which is what the text actually says.
 */
export function normaliseScore(raw) {
  const s = parseScoreText(raw);
  const out = {
    text: s.text, winner: s.winner, margin: s.margin,
    goalsWin: null, goalsLose: null, known: false, goalsKnown: false,
  };
  if (!s.text) return out;

  const bothGoals = s.goalsA !== null && s.goalsB !== null;

  if (s.winner === 'draw') {
    if (!bothGoals) return { ...out, winner: 'draw', margin: 0, known: true };
    const level = Math.max(s.goalsA, s.goalsB);
    return { ...out, winner: 'draw', margin: 0, goalsWin: level, goalsLose: level,
      known: true, goalsKnown: true };
  }
  if (!s.winner) return out;                       // cannot tell who won

  if (bothGoals) {
    const hi = Math.max(s.goalsA, s.goalsB);
    const lo = Math.min(s.goalsA, s.goalsB);
    return { ...out, margin: hi - lo, goalsWin: hi, goalsLose: lo,
      known: true, goalsKnown: true };
  }
  // A winner, and at most a margin. The outcome counts; the goals do not exist.
  return { ...out, margin: s.margin, known: true };
}

/**
 * A game with three or more sides is a tournament, not a match.
 *
 * Two of these are in the record — "Reds win Tourney" (21 Mar) and "whites win,
 * blues runners up, and whites" (30 May), eighteen players apiece in three
 * teams — and every metric on the Results screen treated them as head-to-heads.
 * Anything that was not the winning side was marked a LOSS, so on 30 May the
 * runners-up and the third team came out identical, in a text that says
 * outright they were not. It is a different game and it is kept apart.
 *
 * The explicit game_type wins where it is set; otherwise the shape of the game
 * decides, which is what catches the two imported ones that predate the flag.
 */
export const TOURNAMENT_MIN_TEAMS = 3;
export function isTournament(gameType, teams = []) {
  if (String(gameType || '') === 'tournament') return true;
  return new Set(teams.filter(Boolean).map(t => String(t).toLowerCase().trim())).size
    >= TOURNAMENT_MIN_TEAMS;
}

/** Which of `teams` the winning colour refers to. Null for a draw or no match. */
export function winningTeam(winner, teams = []) {
  if (!winner || winner === 'draw') return null;
  const w = String(winner).toLowerCase().replace(/s$/, '');
  return teams.find(t => String(t).toLowerCase().replace(/s$/, '') === w) || null;
}

/**
 * Classify a free-text score.
 * Returns { text, teamA, teamB, goalsA, goalsB, winner, margin, known }.
 * `winner` is the colour named as winning, lowercased, or 'draw', or null.
 */
const COLOUR = 'red|blue|white|black|green|yellow|orange|purple';
const COLOUR_RE = new RegExp(`\\b(${COLOUR})s?\\b`, 'gi');
// A colour with its own number against it: "Red 5", "Blue: 7".
const ANCHORED_RE = new RegExp(`\\b(${COLOUR})s?\\b\\s*[:\\-–—]?\\s*(\\d+)`, 'gi');
const WIN_VERB_RE = /\b(wins?|won|beats?)\b/i;

export function parseScoreText(raw) {
  const text = String(raw || '').trim();
  const out = { text, goalsA: null, goalsB: null, winner: null, margin: null, known: false };
  if (!text) return out;

  const colours = [...text.matchAll(COLOUR_RE)]
    .map(m => ({ name: m[1].toLowerCase(), at: m.index }));
  const distinct = [...new Set(colours.map(c => c.name))];

  /* ---- The goals ----
     Three shapes, most explicit first. The third exists because "Red wins by 10
     to blues 9" was being read as a MARGIN of 10 and recorded 10–0: the second
     number, which is the other side's score, was thrown away. "won by 10 to 9"
     is a scoreline, not a margin. */
  let sideGoals = null;                                   // colour → goals, when stated
  const anchored = [...text.matchAll(ANCHORED_RE)]
    .map(m => ({ name: m[1].toLowerCase(), goals: +m[2] }));
  if (anchored.length >= 2 && anchored[0].name !== anchored[1].name) {
    sideGoals = anchored.slice(0, 2);
    out.goalsA = sideGoals[0].goals;
    out.goalsB = sideGoals[1].goals;
  } else {
    // The "to" form is kept deliberately tight — only an article or a side's
    // name may sit between the two numbers. Allowing any filler turned
    // "Reds win by 2 to make it 3 in a row" into a 3–2 scoreline.
    const TO_PAIR = new RegExp(
      `(\\d+)\\s*(?:goals?\\s*)?\\bto\\b\\s*(?:the\\s+)?(?:(?:${COLOUR})s?(?:'s)?\\s*)?(\\d+)`, 'i');
    const pair = text.match(/(\d+)\s*[-–—:]\s*(\d+)/) || text.match(TO_PAIR);
    if (pair) { out.goalsA = +pair[1]; out.goalsB = +pair[2]; }
  }
  if (out.goalsA !== null && out.goalsB !== null) {
    out.margin = Math.abs(out.goalsA - out.goalsB);
    out.known = true;
  }

  /* ---- The margin, when only that was written ----
     "by 4" was understood; "1 goal" was not, so "Reds win 1 goal" — a text that
     states its margin outright — was recorded as a three-goal win. */
  if (out.margin === null) {
    const by = text.match(/\bby\s+(\d+)\b/i) || text.match(/\b(\d+)\s*goals?\b/i);
    if (by) { out.margin = +by[1]; out.known = true; }
  }

  /* ---- Who won ---- */
  if (/\bdraws?\b|\bdrew\b|\btie[ds]?\b/i.test(text)) {
    out.winner = 'draw';
    out.known = true;
    return out;
  }
  if (out.goalsA !== null && out.goalsA === out.goalsB) {
    out.winner = 'draw';
    out.known = true;
    return out;
  }
  if (!colours.length) return out;

  // 1. Each side's goals were written against its name — nothing to infer.
  if (sideGoals) {
    out.winner = (sideGoals[0].goals > sideGoals[1].goals ? sideGoals[0] : sideGoals[1]).name;
    out.known = true;
    return out;
  }

  // 2. Two sides named and a scoreline present: match them up in the order they
  //    appear. This is what makes "Red lost to Blue 9-12" come out as a Blue
  //    win. It used to take the FIRST colour mentioned and hand it the HIGHER
  //    number regardless of where either sat, so any phrasing that named the
  //    loser first recorded the result backwards.
  if (distinct.length >= 2 && out.goalsA !== null) {
    const order = distinct.map(n => ({ n, at: colours.find(c => c.name === n).at }))
      .sort((x, y) => x.at - y.at);
    out.winner = out.goalsA >= out.goalsB ? order[0].n : order[1].n;
    out.known = true;
    return out;
  }

  // 3. "Blues win", "whites win, blues runners up" — the side that owns the
  //    verb, which is the one written immediately before it.
  const verb = text.match(WIN_VERB_RE);
  if (verb) {
    const before = colours.filter(c => c.at < verb.index).pop();
    out.winner = (before ?? colours[0]).name;
    out.known = true;
    return out;
  }

  // 4. One side named beside a scoreline and no verb at all: "8-7 BLUES",
  //    "12-9 to the blues". Naming one side after a score credits it.
  if (distinct.length === 1 && out.goalsA !== null) {
    out.winner = distinct[0];
    out.known = true;
  }
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
  const startTeam = (label) => {
    current = { team: canonicalTeam(label), tokens: [] };
    blocks.push(current);
  };

  const lines = String(cell || '').split('\n');
  // A cell sometimes opens with a note rather than players — "FUNny game" above
  // the team blocks. Treated as players it invents a phantom team and turns the
  // note into a roster name, so skip anything before the first real label when
  // the cell has labels at all.
  const isLabel = (l) => LABELLED_LINE.test(l) || DASH_LABEL.test(l) || isBareLabel(l) || !!emojiTeam(l);
  const hasLabels = lines.some(l => isLabel(l.trim()));
  let seenLabel = false;

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;

    if (!seenLabel && hasLabels && !isLabel(line)) continue;
    if (isLabel(line)) seenLabel = true;

    const labelled = line.match(LABELLED_LINE) || line.match(DASH_LABEL);
    const emoji = emojiTeam(line);

    if (labelled) {
      startTeam(labelled[1]);
      line = line.slice(labelled[0].length);
    } else if (emoji) {
      // A colour emoji leads the line and its players follow.
      startTeam(emoji);
      line = line.replace(EMOJI_TEAMS.find(([re]) => re.test(line))[0], ' ');
    } else if (isBareLabel(line)) {
      startTeam(line);
      continue;
    }

    if (!current) startTeam('Team 1');

    // Captain markers appear three ways: attached ("Shone(C)"), standing alone
    // AFTER the name because the split broke it off ("Vijay (c)"), or numbered
    // BEFORE it ("C1 Vijay").
    let captainNext = false;
    for (const t of line.split(/[\s,]+/)) {
      const clean = t.trim();
      if (!clean) continue;
      const alnum = clean.replace(/[^A-Za-z0-9]/g, '');

      // A marker in brackets belongs to the name it follows — "Rony (C1)" means
      // Rony is captain, not whoever comes next. A bare marker leads its name:
      // "C1 Vijay".
      const isMarker = CAPTAIN_MARKER.test(alnum) || /^c$/i.test(alnum);
      if (isMarker) {
        const bracketed = /^[(\[]/.test(clean);
        const prev = current.tokens[current.tokens.length - 1];
        if (bracketed && prev) prev.isCaptain = true;
        else if (prev && /^c$/i.test(alnum)) prev.isCaptain = true;   // "Vijay c"
        else captainNext = true;
        continue;
      }

      const { token, isCaptain } = stripCaptain(clean);
      const bareTok = token.replace(/[^\p{L}\p{N}+'-]/gu, '');
      if (!bareTok || STOP.has(bareTok.toLowerCase())) continue;
      current.tokens.push({ token: bareTok, isCaptain: isCaptain || captainNext });
      captainNext = false;
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
      captains_raw: String(captainsRaw || '').trim(),
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
