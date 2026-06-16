// parser.js — turn a pasted WhatsApp team message into a structured charge preview.
//
// Handles the real-world formats seen in the workbook, e.g.
//   "🔴 Vijay Toby Rojy Prem Sikku\n🔵 Jithin Kartik Rakesh Shone Jeetu"
//   "Blue: Rony (C) - Shameer Vijay Saheer Joe\nReds: Rasif (C) - Jeetu Sarath Toby"
//   "💙Ulli(C) Hassan Jeetu Vijay\n❤Nihas(C) Keertan Sarath Saheer"
//
// Output is a preview only; the caller (Game Day) confirms before any deduction.

// Colour markers → canonical team name. Order matters (check emoji first).
const EMOJI_TEAMS = [
  [/[🔴❤🟥♥️]/u, 'Red'],
  [/[🔵💙🟦]/u, 'Blue'],
  [/[🖤⚫🟫]/u, 'Black'],
  [/[🤍⚪]/u, 'White'],
  [/[💛🟡]/u, 'Yellow'],
  [/[💚🟢]/u, 'Green'],
  [/🚩/u, 'Red'],
];
const WORD_TEAM = /^(reds?|blues?|whites?|blacks?|greens?|yellows?)\b[:\-]?/i;

// Tokens that are never player names.
const STOP = new Set(['vs', 'v/s', 'v', '&', 'and', 'team', 'teams', 'capt', 'captain',
  'no', 'game', 'smf', 'am', 'pm', 'sports', 'indoor', 'city', 'at', 'to']);

function normalize(s) {
  return String(s).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/[^a-z0-9+ ]/g, '').trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 1) return 2;             // we only care about <=1
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

// Build a normalized lookup from player name + aliases.
function buildIndex(players) {
  const exact = new Map();
  for (const p of players) {
    for (const key of [p.name, ...(p.aliases || [])]) {
      const n = normalize(key);
      if (n && !exact.has(n)) exact.set(n, p);
    }
  }
  return exact;
}

function matchToken(token, players, index) {
  const n = normalize(token);
  if (!n) return null;
  if (index.has(n)) return index.get(n);
  // prefix / contains for nicknames ("Tush" ⊂ "Tushar")
  for (const [key, p] of index) {
    if (key.startsWith(n) || n.startsWith(key)) {
      if (Math.abs(key.length - n.length) <= 3) return p;
    }
  }
  // fuzzy: single-edit typo, only for longer tokens
  if (n.length >= 4) {
    for (const [key, p] of index) {
      if (Math.abs(key.length - n.length) <= 1 && levenshtein(n, key) <= 1) return p;
    }
  }
  return null;
}

// Split the raw message into [{ team, raw }] blocks at colour markers.
function splitTeams(text) {
  const blocks = [];
  let current = { team: '', tokens: [] };
  const lines = String(text).replace(/\r/g, '').split('\n');
  const push = () => { if (current.tokens.length) blocks.push(current); };

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    // Word-led team line ("Blue: ...", "Reds - ...").
    const wm = line.match(WORD_TEAM);
    if (wm) {
      push();
      current = { team: wm[1][0].toUpperCase() + wm[1].slice(1).toLowerCase().replace(/s$/, ''), tokens: [] };
      line = line.slice(wm[0].length);
    }

    // Walk the line; an emoji marker also starts a new team.
    const chars = Array.from(line);
    let buf = '';
    const flush = () => { if (buf.trim()) current.tokens.push(...buf.trim().split(/\s+/)); buf = ''; };
    for (const ch of chars) {
      let hit = null;
      for (const [re, name] of EMOJI_TEAMS) if (re.test(ch)) { hit = name; break; }
      if (hit) { flush(); push(); current = { team: hit, tokens: [] }; }
      else buf += ch;
    }
    flush();
  }
  push();
  return blocks;
}

/**
 * Parse a WhatsApp message into a charge preview.
 * @param text     raw message
 * @param players  roster [{id,name,aliases}]
 * @param statusOf map player_id -> ledger status string (for in/out of contract)
 * @param rates    contract rate card
 */
export function parseTeams(text, players, statusOf = {}, rates = {}) {
  const index = buildIndex(players);
  const blocks = splitTeams(text);
  const rows = [];
  let teamCount = 0;

  for (const block of blocks) {
    const team = block.team || `Team ${++teamCount}`;
    let pendingCaptainFor = null;     // index of last real token (for trailing "(C)")
    for (let raw of block.tokens) {
      // standalone captain marker → applies to the previous player
      if (/^\(?c\)?$/i.test(raw)) { if (pendingCaptainFor != null) rows[pendingCaptainFor].is_captain = true; continue; }

      let isCapt = false;
      const cap = raw.match(/\(c\)/i);
      if (cap) { isCapt = true; raw = raw.replace(/\(c\)/ig, ''); }
      raw = raw.replace(/^[\-:,.]+|[\-:,.]+$/g, '').trim();
      if (!raw) continue;

      const norm = normalize(raw);
      if (!norm || STOP.has(norm) || /\d|@/.test(raw)) continue;   // skip junk/times/handles

      const player = matchToken(raw, players, index);
      const r = {
        token: raw,
        team,
        is_captain: isCapt,
        player_id: player ? player.id : null,
        display_name: player ? player.name : raw,
        matched: !!player,
      };
      rows.push(r);
      pendingCaptainFor = rows.length - 1;
    }
  }

  // Rate assignment — bucket by headcount (10-player vs 12-player rate column).
  const numPlayers = rows.length;
  const bucket = numPlayers >= 11 ? '12' : '10';
  for (const r of rows) {
    const status = (statusOf[r.player_id] || '').toLowerCase();
    const inContract = r.matched && !status.startsWith('out');
    if (r.is_captain) {
      r.rate_type = `captain_${bucket}`;
      r.amount = rates[`captain_${bucket}`] ?? rates.noncontract ?? 0;
    } else if (inContract) {
      r.rate_type = `contracted_${bucket}`;
      r.amount = rates[`contracted_${bucket}`] ?? rates.noncontract ?? 0;
    } else {
      r.rate_type = 'noncontract';
      r.amount = rates.noncontract ?? 0;
    }
  }

  return {
    num_players: numPlayers,
    bucket,
    teams: [...new Set(rows.map(r => r.team))],
    rows,
    unmatched: rows.filter(r => !r.matched).map(r => r.token),
  };
}
