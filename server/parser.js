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
// The same colours as a word on its own, for the line that leads with an emoji
// and then spells the team out as well: "❤️ REDS – Rony (C), ...".
const COLOUR_WORD = /^(reds?|blues?|whites?|blacks?|greens?|yellows?)$/i;
/** "REDS" -> "Red", the way the word-led team line already writes it. */
const teamName = (w) => w[0].toUpperCase() + w.slice(1).toLowerCase().replace(/s$/, '');
// Punctuation that hangs off a name in a pasted roster: the comma after
// "Khilji,", the en dash in "REDS – Rony", the full stop ending a line.
const EDGE_PUNCT = /^[\s\-–—:,.;|]+|[\s\-–—:,.;|]+$/g;

// Tokens that are never player names.
const STOP = new Set(['vs', 'v/s', 'v', '&', 'and', 'team', 'teams', 'capt', 'captain',
  'no', 'game', 'smf', 'am', 'pm', 'sports', 'indoor', 'city', 'at', 'to']);

/**
 * A name reduced to what two spellings of it have in common.
 *
 * Spaces come out. A roster is split on whitespace, so a player called
 * "Rohit 2" arrives as the two tokens "Rohit" and "2" and can never be
 * matched at all — while "Rohit" on its own goes to the other man of that
 * name. Folding the space away lets the one token anybody actually types,
 * "Rohit2", find him.
 */
function normalize(s) {
  return String(s).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/[^a-z0-9+ ]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/** Just the digits of a name — "rohit2" -> "2", "rohit" -> "". */
const digitsOf = (s) => s.replace(/\D/g, '');

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
export function buildIndex(players) {
  const exact = new Map();
  for (const p of players) {
    // playersRepo hands back a parsed array, but the column stores JSON text. If a
    // caller passes a raw DB row, spreading that string yields one key per
    // CHARACTER, and single-letter keys behave as wildcards in the prefix match
    // below ("tush" starts with "t") — silently resolving to the wrong player.
    let aliases = p.aliases || [];
    if (typeof aliases === 'string') {
      try { aliases = JSON.parse(aliases); } catch { aliases = []; }
    }
    if (!Array.isArray(aliases)) aliases = [];

    for (const key of [p.name, ...aliases]) {
      const n = normalize(key);
      if (n && !exact.has(n)) exact.set(n, p);
    }
  }
  return exact;
}

export function matchToken(token, players, index) {
  const n = normalize(token);
  if (!n) return null;
  if (index.has(n)) return index.get(n);

  // A number in a name is how two people who share one are told apart, so it
  // is never a typo and never a short form. Without this, "Rohit2" is one
  // character off "Rohit" and the prefix rule below hands the game — and the
  // charge — to the wrong man, silently. Same in reverse: plain "Rohit" must
  // not fall through to "Rohit 2".
  const sameNumber = (key) => digitsOf(key) === digitsOf(n);

  // prefix / contains for nicknames ("Tush" ⊂ "Tushar")
  for (const [key, p] of index) {
    if (!sameNumber(key)) continue;
    if (key.startsWith(n) || n.startsWith(key)) {
      if (Math.abs(key.length - n.length) <= 3) return p;
    }
  }
  // Fuzzy: a single-edit typo, but ONLY an inserted or dropped character, never a
  // substitution. Same-length near-misses are usually two different people, not a
  // misspelling — "Nihal" vs "Nihas" is one substitution apart and they are
  // separate players, so merging them credited one with the other's games and
  // meant Nihal never showed up as an unknown name to be added.
  // Insertions/deletions stay allowed because that is what the real variants look
  // like: Hasan/Hassan, Jeethu/Jeetu, Nimeesh/Nimesh. Deliberate short forms are
  // handled by aliases (Roji, Khalid, Sahir), which are matched exactly above.
  if (n.length >= 4) {
    for (const [key, p] of index) {
      if (!sameNumber(key)) continue;                     // a different person
      if (key.length === n.length) continue;              // substitution — too risky
      if (Math.abs(key.length - n.length) === 1 && levenshtein(n, key) <= 1) return p;
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
    /**
     * A blank line between two blocks of names is how a roster with no
     * colours separates the sides, and it was being thrown away.
     *
     *   Toby(c) Hari Jaison Vijay Arjun Neel
     *                                          <- this
     *   Vinod(c) Rojy Devansh Saleel Bibbin Abhi
     *
     * All twelve came out on one side, and nothing downstream survives that:
     * the result row then names a second team nobody is on, so every player
     * in the game is recorded as having won it. That is 8 October, where six
     * of them lost.
     *
     * Only a block with something already in it is closed, so a blank line
     * under a header — "Game tonight 8pm" — separates nothing.
     */
    if (!line) {
      if (current.tokens.length) { push(); current = { team: '', tokens: [] }; }
      continue;
    }

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
    /**
     * Hand the words collected so far to the current team.
     *
     * A colour word at the head of a block names the team rather than a
     * player. "❤️ REDS – Rony (C), ..." opens a team on the emoji and then
     * says REDS as well; without this that word becomes a token, fails to
     * match anybody, and arrives in Game Day as a player to be added — one
     * per team, charged the guest rate, and counted in the headcount, which
     * is what decides whether everyone is billed at the 10- or 12-player
     * rate. Two junk rows can therefore misprice the entire night.
     */
    const flush = () => {
      if (buf.trim()) {
        for (const tok of buf.trim().split(/\s+/)) {
          const bare = tok.replace(EDGE_PUNCT, '');
          const openingWord = current.tokens.every(t => STOP.has(normalize(t)));
          if (openingWord && COLOUR_WORD.test(bare)) {
            current.team = teamName(bare);
            continue;
          }
          current.tokens.push(tok);
        }
      }
      buf = '';
    };
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
 * @param players  roster [{id,name,aliases,introduced_by,player_type,outside_cost}]
 * @param statusOf map player_id -> ledger status string (for in/out of contract)
 * @param rates    contract rate card
 */
export function parseTeams(text, players, statusOf = {}, rates = {}) {
  const index = buildIndex(players);
  const blocks = splitTeams(text);
  const rows = [];
  const unmatchedTokens = new Set();
  let teamCount = 0;

  for (const block of blocks) {
    // Named at the END of the block, once it is known whether anybody in it is
    // actually on the roster. A block of nothing but words — "Game tonight 8pm"
    // above a blank line — would otherwise take "Team 1" and push the two real
    // sides to Team 2 and Team 3, which is three sides, and three sides is a
    // tournament: held out of every match table on the Results screen.
    const blockStart = rows.length;
    let anyMatched = false;
    let pendingCaptainFor = null;     // index of last real token (for trailing "(C)")
    for (let raw of block.tokens) {
      // The comma comes off FIRST. "Rony (C), Khilji" splits into "Rony" and
      // "(C)," — and "(C)," is not the standalone marker (the comma), so it
      // fell through to the inline branch, which stripped the "(C)" and left
      // a bare comma that was then discarded as empty. The captaincy went
      // with it, every time a roster was written the way the club writes it,
      // so nobody has ever been given the captain's rate from a paste.
      raw = raw.replace(EDGE_PUNCT, '');
      if (!raw) continue;

      // standalone captain marker → applies to the previous player
      if (/^\(?c\)?$/i.test(raw)) { if (pendingCaptainFor != null) rows[pendingCaptainFor].is_captain = true; continue; }

      let isCapt = false;
      const cap = raw.match(/\(c\)/i);
      if (cap) { isCapt = true; raw = raw.replace(/\(c\)/ig, '').replace(EDGE_PUNCT, ''); }
      if (!raw) continue;

      const norm = normalize(raw);
      // A handle is never a name, whoever it looks like: normalize strips the
      // @, so "@sam" would otherwise match the player Sam and charge him for
      // a game he was only mentioned in.
      if (!norm || STOP.has(norm) || /@/.test(raw)) continue;

      const player = matchToken(raw, players, index);

      // Times and dates are not names — "8pm", "7:30", "20th". They used to be
      // dropped by the digit alone, which also dropped the one player whose
      // name has a number in it: "Rohit2" left the roster silently, not even
      // reported as an unknown name, so he played and was never charged. A
      // token with a digit is junk unless it is somebody.
      if (!player && /\d/.test(raw)) continue;

      if (player) anyMatched = true;
      const r = {
        token: raw,
        team: block.team,        // filled in below for a block with no name
        is_captain: isCapt,
        player_id: player ? player.id : null,
        display_name: player ? player.name : raw,
        matched: !!player,
        // Enhanced: relationship metadata
        introduced_by: player?.introduced_by || null,
        player_type: player?.player_type || 'regular',  // 'regular' or 'outside'
        outside_cost: player?.outside_cost || null,
      };

      if (!player) {
        unmatchedTokens.add(raw);
      }

      rows.push(r);
      pendingCaptainFor = rows.length - 1;
    }

    // A block that named itself keeps that name whatever is in it. One that
    // did not is a side only if somebody on the roster is in it; otherwise its
    // words belong to no side, which is what they are.
    if (!block.team && rows.length > blockStart) {
      const name = anyMatched ? `Team ${++teamCount}` : '';
      for (let i = blockStart; i < rows.length; i++) rows[i].team = name;
    }
  }

  /**
   * Last resort: two armbands and one side is not a game.
   *
   * A roster with no colours AND no blank line between the sides leaves
   * everybody in one block, and the cost of that is not cosmetic — a game
   * with one side has no opponent, so the result credits all twelve players
   * with the win. One captain per side is the one thing about a football
   * team this app can rely on, so where exactly two are marked and only one
   * side came out, the second armband starts the second side.
   *
   * Guarded by the shape of the result: the club writes the captain first,
   * and a split that leaves five against one means they did not, so it is
   * refused and the block is left as it was. Wrong-but-unchanged beats
   * wrong-and-rearranged.
   */
  const captainAt = rows.map((r, i) => (r.is_captain ? i : -1)).filter(i => i >= 0);
  if (new Set(rows.map(r => r.team).filter(Boolean)).size === 1 && captainAt.length === 2) {
    const cut = captainAt[1];
    const a = cut;
    const b = rows.length - cut;
    if (a >= 2 && b >= 2 && Math.abs(a - b) <= 2) {
      rows.forEach((r, i) => { r.team = i < cut ? 'Team 1' : 'Team 2'; });
    }
  }

  // Rate assignment — bucket by headcount (10-player vs 12-player rate column).
  const numPlayers = rows.length;
  const bucket = numPlayers >= 11 ? '12' : '10';
  for (const r of rows) {
    const status = (statusOf[r.player_id] || '').toLowerCase();
    const inContract = r.matched && !status.startsWith('out') && r.player_type !== 'outside';
    r.in_contract = inContract;

    // Contract status is decided BEFORE captaincy. The captain rate is a discount
    // the contract pays for, so someone outside it does not get it by wearing the
    // armband — previously an out-of-contract captain was billed the captain rate,
    // which is cheaper than the guest rate they should have paid.
    if (!inContract) {
      r.rate_type = 'noncontract';
      // A guest with an agreed personal rate uses it; otherwise the standard one.
      r.amount = Number(r.outside_cost) > 0
        ? Number(r.outside_cost)
        : (rates.noncontract ?? 0);
    } else if (r.is_captain) {
      r.rate_type = `captain_${bucket}`;
      r.amount = rates[`captain_${bucket}`] ?? rates[`contracted_${bucket}`] ?? rates.noncontract ?? 0;
    } else {
      r.rate_type = `contracted_${bucket}`;
      r.amount = rates[`contracted_${bucket}`] ?? rates.noncontract ?? 0;
    }
  }

  // Build unmatched list with similar player suggestions
  const unmatchedWithSuggestions = Array.from(unmatchedTokens).map(token => {
    const suggestions = [];
    for (const player of players) {
      if (levenshtein(normalize(token), normalize(player.name)) <= 1) {
        suggestions.push({ id: player.id, name: player.name });
      }
    }
    return { token, suggestions };
  });

  // Same player listed twice (typically pasted under both teams after the message
  // was edited, or because they swapped sides). Left unflagged this silently
  // double-charges them for one game, so mark the repeats for the preview. The
  // server refuses the commit outright — this is just so the admin sees why.
  const timesSeen = new Map();
  for (const r of rows) {
    if (!r.player_id) continue;
    timesSeen.set(r.player_id, (timesSeen.get(r.player_id) || 0) + 1);
  }
  const seenOnce = new Set();
  for (const r of rows) {
    if (!r.player_id || timesSeen.get(r.player_id) < 2) continue;
    r.duplicate = true;                 // every row for that player
    r.duplicate_repeat = seenOnce.has(r.player_id);  // all but the first
    seenOnce.add(r.player_id);
  }
  const duplicates = [...timesSeen.entries()]
    .filter(([, n]) => n > 1)
    .map(([player_id, count]) => ({
      player_id,
      count,
      display_name: (rows.find(r => r.player_id === player_id) || {}).display_name || player_id,
    }));

  // A contract with no rate card charges everyone 0 without complaining. That is
  // indistinguishable from a free game, so say so explicitly and let the caller
  // refuse to commit rather than silently writing a game worth nothing.
  const configuredRates = Object.values(rates || {}).filter(v => Number(v) > 0).length;
  const allZero = rows.length > 0 && rows.every(r => !Number(r.amount));

  return {
    num_players: numPlayers,
    bucket,
    rates_configured: configuredRates,
    rates_missing: configuredRates === 0,
    all_amounts_zero: allZero,
    // Falsy filtered: a row whose block named no side and matched nobody has
    // no team, and an empty string is not a side to be counted as one.
    teams: [...new Set(rows.map(r => r.team).filter(Boolean))],
    rows,
    unmatched: unmatchedWithSuggestions,
    // Players appearing more than once. Non-empty means the game cannot be
    // committed until the extra rows are removed.
    duplicates,
    hasDuplicates: duplicates.length > 0,
    // Flag for outside players in this game
    hasOutsidePlayers: rows.some(r => r.player_type === 'outside'),
    outsidePlayerCount: rows.filter(r => r.player_type === 'outside').length,
  };
}
