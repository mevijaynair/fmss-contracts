import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money, fmtDate, contractSeg, openModal, closeModal } from '../util.js';

let contractId = 'sat';

// Guests and irregulars are real players but distort a leaderboard: someone who
// turned up once should not sit beside a regular on a rate table. Hide players
// below this many appearances; the control in the Results header changes it.
let minGames = 6;


async function render() {
  try {
    const gws = await api.results(contractId);
    const all = Array.isArray(gws) ? gws : [];
    const stats = buildStats(all);
    if (!all.length) { showEmpty(); return; }
    showPeriodBar(all, stats);
    showLeaderboards(stats);
    showTable(stats);
    showPartnerships(all);
    showTrends(all);
  } catch (e) { toast(`Error: ${e.message}`, true); }
}
// ---- Period scoping -------------------------------------------------------
// All-time totals flatten a season into one number. Everything below can be
// narrowed to a year or a quarter so form can be compared across time.

let period = 'all';               // 'all' | '2026' | '2026-Q1'

const qOf = (d) => 'Q' + (Math.floor(new Date(d).getMonth() / 3) + 1);
const yOf = (d) => String(new Date(d).getFullYear());

function inPeriod(date) {
  if (period === 'all') return true;
  if (/^\d{4}$/.test(period)) return yOf(date) === period;
  const [y, q] = period.split('-');
  return yOf(date) === y && qOf(date) === q;
}

/** Every year/quarter the data actually covers, newest first. */
function periodOptions(gws) {
  const years = new Set();
  const quarters = new Set();
  for (const g of gws) {
    if (!g.date) continue;
    years.add(yOf(g.date));
    quarters.add(`${yOf(g.date)}-${qOf(g.date)}`);
  }
  return {
    years: [...years].sort().reverse(),
    quarters: [...quarters].sort().reverse(),
  };
}

// ---- Outcome resolution ---------------------------------------------------
// One place decides what a game was for a given player, so every metric agrees.

function outcomeFor(gw, charge) {
  const res = gw.result || {};
  if (!res.known || !(res.is_draw || res.winner_team)) return null;
  if (res.is_draw) return 'draw';
  if (!charge.team) return null;                 // side unknown — cannot judge
  return charge.team === res.winner_team ? 'win' : 'loss';
}

/** Per player: an ordered list of their games, oldest first. */
function timelines(gws) {
  const byPlayer = {};
  const sorted = [...gws].filter(g => inPeriod(g.date))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  for (const gw of sorted) {
    for (const c of gw.charges || []) {
      (byPlayer[c.player_id] ??= { name: c.player_name, games: [] }).games.push({
        date: gw.date,
        team: c.team,
        captain: !!c.is_captain,
        outcome: outcomeFor(gw, c),
        gwId: gw.id,
        result: gw.result || {},
      });
    }
  }
  return byPlayer;
}

// ---- Streaks and form -----------------------------------------------------

/**
 * Streaks over games with a KNOWN outcome. Undecided games are skipped rather
 * than breaking a run — a missing score should not end someone's streak.
 */
function streaks(games) {
  const decided = games.filter(g => g.outcome);
  let curW = 0, curUnbeaten = 0, bestW = 0, bestUnbeaten = 0, run = 0, runU = 0;

  for (const g of decided) {
    if (g.outcome === 'win') { run++; runU++; }
    else if (g.outcome === 'draw') { run = 0; runU++; }
    else { run = 0; runU = 0; }
    bestW = Math.max(bestW, run);
    bestUnbeaten = Math.max(bestUnbeaten, runU);
  }
  // Current run = the tail of the list.
  for (let i = decided.length - 1; i >= 0; i--) {
    if (decided[i].outcome === 'win') curW++; else break;
  }
  for (let i = decided.length - 1; i >= 0; i--) {
    if (decided[i].outcome === 'loss') break; else curUnbeaten++;
  }
  return { currentWin: curW, longestWin: bestW, currentUnbeaten: curUnbeaten, longestUnbeaten: bestUnbeaten };
}

/** Last five decided results, most recent last. */
function form(games) {
  return games.filter(g => g.outcome).slice(-5).map(g => g.outcome[0].toUpperCase());
}

// ---- Player rollup --------------------------------------------------------

function buildStats(gws) {
  const tl = timelines(gws);
  const out = {};

  for (const [id, { name, games }] of Object.entries(tl)) {
    const s = {
      id, name, games: games.length,
      wins: 0, draws: 0, losses: 0, unknown: 0,
      gf: 0, ga: 0, captainGames: 0, captainWins: 0,
      first: games[0]?.date || null, last: games[games.length - 1]?.date || null,
    };
    for (const g of games) {
      if (g.captain) s.captainGames++;
      if (!g.outcome) { s.unknown++; continue; }
      const w = Number(g.result.goalsWin) || 0;
      const l = Number(g.result.goalsLose) || 0;
      if (g.outcome === 'win') { s.wins++; s.gf += w; s.ga += l; if (g.captain) s.captainWins++; }
      else if (g.outcome === 'loss') { s.losses++; s.gf += l; s.ga += w; }
      else { s.draws++; s.gf += w; s.ga += w; }
    }
    s.decided = s.wins + s.draws + s.losses;
    s.winRate = s.decided ? Math.round((s.wins / s.decided) * 100) : null;
    s.gd = s.gf - s.ga;
    s.gdPerGame = s.decided ? +(s.gd / s.decided).toFixed(2) : null;
    s.captainWinRate = s.captainGames ? Math.round((s.captainWins / s.captainGames) * 100) : null;
    Object.assign(s, streaks(games));
    s.form = form(games);
    out[id] = s;
  }
  return out;
}

// ---- Partnerships ---------------------------------------------------------

/**
 * Who wins together. For every pair that shared a team, how often that team won.
 * Only decided games count, and a floor is applied — two players who happened to
 * share one winning side are not a great partnership.
 */
function partnerships(gws, { minGames = 4 } = {}) {
  const pair = {};
  for (const gw of gws) {
    if (!inPeriod(gw.date)) continue;
    const res = gw.result || {};
    if (!res.known || !(res.is_draw || res.winner_team)) continue;

    const byTeam = {};
    for (const c of gw.charges || []) {
      if (!c.team) continue;
      (byTeam[c.team] ??= []).push(c);
    }
    for (const [team, mates] of Object.entries(byTeam)) {
      const won = res.is_draw ? null : team === res.winner_team;
      for (let i = 0; i < mates.length; i++) {
        for (let j = i + 1; j < mates.length; j++) {
          const [a, b] = [mates[i], mates[j]].sort((x, y) => x.player_id.localeCompare(y.player_id));
          const key = `${a.player_id}|${b.player_id}`;
          const p = (pair[key] ??= { a: a.player_name, b: b.player_name, games: 0, wins: 0, draws: 0 });
          p.games++;
          if (won === true) p.wins++;
          else if (won === null) p.draws++;
        }
      }
    }
  }
  return Object.values(pair)
    .filter(p => p.games >= minGames)
    .map(p => ({ ...p, winRate: Math.round((p.wins / p.games) * 100) }))
    .sort((x, y) => y.winRate - x.winRate || y.games - x.games);
}

// ---- Club-level trend series ---------------------------------------------

/**
 * One row per quarter the club actually played: games, how many had a usable
 * result, goals, and the average winning margin. Ignores the period filter on
 * purpose — a trend needs the whole history to be a trend.
 */
function trendSeries(gws) {
  const buckets = {};
  for (const gw of gws) {
    if (!gw.date) continue;
    const key = `${yOf(gw.date)}-${qOf(gw.date)}`;
    const b = (buckets[key] ??= { key, games: 0, decided: 0, goals: 0, margins: [], players: 0, draws: 0 });
    b.games++;
    b.players += (gw.charges || []).length;
    const res = gw.result || {};
    if (res.known && (res.is_draw || res.winner_team)) {
      b.decided++;
      if (res.is_draw) b.draws++;
      b.goals += (Number(res.goalsWin) || 0) + (Number(res.goalsLose) || 0);
      if (!res.is_draw) b.margins.push(Number(res.margin) || 0);
    }
  }
  return Object.values(buckets)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(b => ({
      ...b,
      avgPlayers: b.games ? +(b.players / b.games).toFixed(1) : 0,
      avgGoals: b.decided ? +(b.goals / b.decided).toFixed(1) : null,
      avgMargin: b.margins.length ? +(b.margins.reduce((s, m) => s + m, 0) / b.margins.length).toFixed(1) : null,
      drawPct: b.decided ? Math.round((b.draws / b.decided) * 100) : null,
    }));
}
function slot(name) {
  let el = document.querySelector(`[data-${name}]`);
  if (!el) {
    el = document.createElement('div');
    el.setAttribute(`data-${name}`, '');
    $('resultsContainer')?.appendChild(el);
  }
  return el;
}
function showEmpty() {
  slot('results-lb').innerHTML = `
    <div class="empty-state">
      <div class="es-icon">📋</div>
      <div class="es-title">No games recorded for this contract yet</div>
      <div class="es-sub">Charge a game from Game Day, or bring in past results with Import.</div>
      <button class="btn btn-sm" id="emptyImportBtn">📥 Import Results</button>
    </div>`;
  ['results-period','results-table','results-pairs','results-trends']
    .forEach(k => { slot(k).innerHTML = ''; });
  $('emptyImportBtn')?.addEventListener('click', showImportResultsModal);
}
const pct = (v) => (v === null || v === undefined ? '—' : v + '%');
const signed = (n) => (n > 0 ? '+' + n : String(n));

// Last-five form as coloured letters, oldest first.
const formDots = (f) => f.length
  ? `<span class="form-run">${f.map(r =>
      `<span class="form-dot is-${r.toLowerCase()}" title="${r}">${r}</span>`).join('')}</span>`
  : '<span class="hint">—</span>';

function showPeriodBar(gws, stats) {
  const { years, quarters } = periodOptions(gws);
  const btn = (val, label) =>
    `<button data-period="${val}" class="${period === val ? 'active' : ''}">${label}</button>`;
  const ranked = Object.values(stats).filter(p => p.games >= minGames).length;
  const hidden = Object.keys(stats).length - ranked;

  slot('results-period').innerHTML = `
    <div class="filter-bar" style="grid-template-columns: 1fr auto auto;">
      <div class="hint">
        Ranking <strong>${ranked}</strong> player(s) with ${minGames}+ appearance(s)${
          hidden ? ` &middot; ${hidden} occasional hidden` : ''}
      </div>
      <span class="seg" id="resPeriod">
        ${btn('all', 'All time')}
        ${years.map(y => btn(y, y)).join('')}
        ${quarters.slice(0, 4).map(q => btn(q, q.replace('-', ' '))).join('')}
      </span>
      <span class="seg" id="resMinGames">
        ${[1, 3, 6, 10].map(n =>
          `<button data-min="${n}" class="${n === minGames ? 'active' : ''}">${n === 1 ? 'All' : n + '+'}</button>`).join('')}
      </span>
    </div>`;

  slot('results-period').querySelectorAll('#resPeriod button').forEach(b =>
    b.addEventListener('click', () => { period = b.dataset.period; render(); }));
  slot('results-period').querySelectorAll('#resMinGames button').forEach(b =>
    b.addEventListener('click', () => { minGames = Number(b.dataset.min); render(); }));
}

function showLeaderboards(stats) {
  const all = Object.values(stats).filter(p => p.games >= minGames);
  const rated = all.filter(p => p.decided >= Math.max(3, Math.floor(minGames / 2)));
  const capts = all.filter(p => p.captainGames >= 2);

  const board = (title, sub, tone, data, fmt) => `
    <div class="sams-card">
      <div class="card-header"><h3 class="card-title">${title}</h3>
        <span class="card-sub">${sub}</span></div>
      <div class="res-board">
        ${data.length ? data.slice(0, 8).map((p, i) => `
          <div class="res-row" data-player="${esc(p.name)}">
            <span class="res-name">${i + 1}. ${esc(p.name)}</span>
            <span class="res-val ${tone}">${fmt(p)}</span>
          </div>`).join('')
        : '<p class="hint">Not enough games in this period.</p>'}
      </div>
    </div>`;

  slot('results-lb').innerHTML = `
    <div class="auto-grid" style="--col-min: 250px;">
      ${board('🎮 Most Games', 'appearances', '',
        [...all].sort((a, b) => b.games - a.games), p => p.games)}
      ${board('📈 Best Win Rate', 'of games with a result', 'is-win',
        [...rated].sort((a, b) => b.winRate - a.winRate || b.decided - a.decided),
        p => `${pct(p.winRate)} <span class="hint">${p.wins}/${p.decided}</span>`)}
      ${board('🔥 Longest Win Streak', 'consecutive wins', 'is-win',
        [...all].filter(p => p.longestWin > 1).sort((a, b) => b.longestWin - a.longestWin),
        p => `${p.longestWin}${p.currentWin > 1 ? ` <span class="hint">on ${p.currentWin} now</span>` : ''}`)}
      ${board('🛡️ Longest Unbeaten', 'wins and draws', '',
        [...all].filter(p => p.longestUnbeaten > 1).sort((a, b) => b.longestUnbeaten - a.longestUnbeaten),
        p => p.longestUnbeaten)}
      ${board('👑 Best Captain Rate', '2+ games as captain', 'is-capt',
        [...capts].sort((a, b) => b.captainWinRate - a.captainWinRate || b.captainGames - a.captainGames),
        p => `${pct(p.captainWinRate)} <span class="hint">${p.captainWins}/${p.captainGames}</span>`)}
      ${board('⚽ Goal Difference', 'per decided game', '',
        [...rated].sort((a, b) => b.gdPerGame - a.gdPerGame),
        p => `${signed(p.gd)} <span class="hint">${signed(p.gdPerGame)}/g</span>`)}
    </div>`;

  slot('results-lb').querySelectorAll('[data-player]').forEach(d =>
    d.addEventListener('click', () => {
      const p = all.find(x => x.name === d.dataset.player);
      if (p) showPlayerDetail(p);
    }));
}

let sortKey = 'games';
let sortDir = -1;

function showTable(stats) {
  const rows = Object.values(stats).filter(p => p.games >= minGames);
  const cols = [
    ['name', 'Player', p => esc(p.name), 'left'],
    ['games', 'P', p => p.games],
    ['wins', 'W', p => p.wins],
    ['draws', 'D', p => p.draws],
    ['losses', 'L', p => p.losses],
    ['winRate', 'Win %', p => pct(p.winRate)],
    ['form', 'Form', p => formDots(p.form), 'left'],
    ['currentWin', 'Streak', p => (p.currentWin > 0 ? `W${p.currentWin}` : '—')],
    ['longestWin', 'Best', p => p.longestWin || '—'],
    ['gd', 'GD', p => signed(p.gd)],
    ['gdPerGame', 'GD/g', p => (p.gdPerGame === null ? '—' : signed(p.gdPerGame))],
    ['captainGames', 'Capt', p => p.captainGames],
    ['captainWinRate', 'Capt %', p => pct(p.captainWinRate)],
    ['unknown', 'No result', p => p.unknown || '—'],
  ];
  rows.sort((a, b) => {
    const va = a[sortKey], vb = b[sortKey];
    if (typeof va === 'string') return sortDir * String(va).localeCompare(String(vb));
    if (Array.isArray(va)) return sortDir * (vb.length - va.length);
    return sortDir * (((vb ?? -1)) - ((va ?? -1)));
  });

  slot('results-table').innerHTML = `<div class="sams-card">
    <div class="card-header"><h3 class="card-title">📋 Player Standings</h3>
      <span class="card-sub">Click a column to sort &middot; ${rows.length} player(s)</span></div>
    <div style="overflow-x:auto">
      <table class="sams-table">
        <thead><tr>${cols.map(([k, label, , align]) =>
          `<th class="${align === 'left' ? '' : 'num'}" data-sort="${k}" style="cursor:pointer">${label}${
            k === sortKey ? (sortDir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(p => `<tr data-player="${esc(p.name)}" style="cursor:pointer">
          ${cols.map(([, , fmt, align]) =>
            `<td class="${align === 'left' ? '' : 'num'}">${fmt(p)}</td>`).join('')}
        </tr>`).join('') || '<tr><td colspan="14" class="hint">No players in this period.</td></tr>'}</tbody>
      </table>
    </div>
  </div>`;

  slot('results-table').querySelectorAll('[data-sort]').forEach(th =>
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (k === sortKey) sortDir = -sortDir;
      else { sortKey = k; sortDir = k === 'name' ? 1 : -1; }
      showTable(stats);
    }));
  slot('results-table').querySelectorAll('tr[data-player]').forEach(tr =>
    tr.addEventListener('click', () => {
      const p = rows.find(x => x.name === tr.dataset.player);
      if (p) showPlayerDetail(p);
    }));
}

function showPlayerDetail(p) {
  const row = (k, v, cls = '') =>
    `<div class="res-q-row"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;
  openModal(esc(p.name), `
    <h4 class="mini-h">Record${period === 'all' ? '' : ` · ${esc(period)}`}</h4>
    ${row('🎮 Played', p.games)}
    ${row('✅ Won', `${p.wins} (${pct(p.winRate)} of ${p.decided} decided)`, 'is-win')}
    ${row('🤝 Drawn', p.draws)}
    ${row('❌ Lost', p.losses)}
    ${p.unknown ? row('❔ No result recorded', p.unknown) : ''}
    <h4 class="mini-h mt">Form &amp; streaks</h4>
    ${row('Last five', formDots(p.form))}
    ${row('Current win streak', p.currentWin || '—', 'is-win')}
    ${row('Longest win streak', p.longestWin || '—', 'is-win')}
    ${row('Longest unbeaten', p.longestUnbeaten || '—')}
    <h4 class="mini-h mt">Goals</h4>
    ${row('Scored / conceded', `${p.gf} / ${p.ga}`)}
    ${row('Goal difference', `${signed(p.gd)} (${signed(p.gdPerGame ?? 0)} per game)`, p.gd >= 0 ? 'is-win' : '')}
    <h4 class="mini-h mt">Captaincy</h4>
    ${row('👑 Games led', p.captainGames)}
    ${row('Won as captain', `${p.captainWins} (${pct(p.captainWinRate)})`, 'is-win')}
    <h4 class="mini-h mt">Span</h4>
    ${row('First game', p.first ? fmtDate(p.first) : '—')}
    ${row('Latest game', p.last ? fmtDate(p.last) : '—')}`);
}

// Club trend across every quarter played — deliberately ignores the period
// filter, because a trend needs the full history to be one.
function showTrends(gws) {
  const series = trendSeries(gws);
  if (!series.length) { slot('results-trends').innerHTML = ''; return; }
  const maxGames = Math.max(...series.map(s => s.games), 1);

  slot('results-trends').innerHTML = `<div class="sams-card">
    <div class="card-header"><h3 class="card-title">📈 Club Trend by Quarter</h3>
      <span class="card-sub">Activity, scoring and how close the games were</span></div>
    <div style="overflow-x:auto">
      <table class="sams-table">
        <thead><tr><th>Quarter</th><th class="num">Games</th><th>Activity</th>
          <th class="num">Avg players</th><th class="num">Avg goals</th>
          <th class="num">Avg margin</th><th class="num">Draws</th>
          <th class="num" title="Games with a usable result">Scored</th></tr></thead>
        <tbody>${series.map(s => `
          <tr>
            <td><strong>${esc(s.key.replace('-', ' '))}</strong></td>
            <td class="num">${s.games}</td>
            <td><span class="bar" style="--w:${Math.round((s.games / maxGames) * 100)}%"></span></td>
            <td class="num">${s.avgPlayers}</td>
            <td class="num">${s.avgGoals ?? '—'}</td>
            <td class="num">${s.avgMargin ?? '—'}</td>
            <td class="num">${s.drawPct === null ? '—' : s.drawPct + '%'}</td>
            <td class="num">${s.decided}/${s.games}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <p class="hint">Average margin is how one-sided a typical game was — a falling
      number means closer matches. “Scored” is how many games have a usable result;
      the rest cannot contribute to any win rate.</p>
  </div>`;
}

// Who wins together. Useful for picking balanced sides.
function showPartnerships(gws) {
  const pairs = partnerships(gws, { minGames: 4 });
  if (!pairs.length) { slot('results-pairs').innerHTML = ''; return; }
  const top = pairs.slice(0, 8);
  const bottom = pairs.slice(-8).reverse();

  const list = (rows, tone) => rows.map(p => `
    <div class="res-row" style="cursor:default">
      <span class="res-name">${esc(p.a)} + ${esc(p.b)}</span>
      <span class="res-val ${tone}">${p.winRate}% <span class="hint">${p.wins}/${p.games}</span></span>
    </div>`).join('');

  slot('results-pairs').innerHTML = `
    <div class="auto-grid" style="--col-min: 280px;">
      <div class="sams-card">
        <div class="card-header"><h3 class="card-title">🤝 Best Partnerships</h3>
          <span class="card-sub">Same side, 4+ games together</span></div>
        <div class="res-board">${list(top, 'is-win')}</div>
      </div>
      <div class="sams-card">
        <div class="card-header"><h3 class="card-title">🧊 Struggled Together</h3>
          <span class="card-sub">Same floor, lowest win rate</span></div>
        <div class="res-board">${list(bottom, '')}</div>
      </div>
    </div>`;
}
export function initResults() {
  $('importResultsBtn')?.addEventListener('click', showImportResultsModal);
}

function showImportResultsModal() {
  openModal('Import Match Results', `
    <div class="stack-sm">
      <label class="mini-h">Paste the results sheet</label>
      <p class="hint">
        Copy the rows straight from the tracking sheet, including the header.
        Expected columns: <strong>Date &nbsp;|&nbsp; Teams &nbsp;|&nbsp; Captains &nbsp;|&nbsp; Score</strong>.<br>
        Team blocks may use <code>Red:</code> / <code>Blue:</code> labels across several lines,
        captains may sit in their own column or inline as <code>(C)</code>, and rows reading
        &ldquo;No game&rdquo; are skipped.
      </p>
      <textarea id="ir_data" class="import-area" placeholder="Date&#9;Teams&#9;Captains&#9;Score
6 December 2025&#9;&quot;Red: Hasan Sarath Nihas Tush Shone Jeetu

Blue: Aws Zaki Rakesh Saheer Toby Sikku&quot;&#9;&#9;Reds win"></textarea>
      <div class="panel panel-warn">
        <div class="panel-title">This does not touch money</div>
        <div class="panel-body">
          Imported games record who played, their team and the captain, so the
          leaderboards work. Every charge is written at <strong>0</strong> &mdash; no
          balance moves.
        </div>
      </div>
    </div>
    <label class="confirm-check">
      <input type="checkbox" id="ir_create" checked>
      <span>Add unknown names as guest players so their games count</span>
    </label>
    <div class="btn-row mt">
      <button class="btn" id="ir_preview">Preview</button>
      <button class="btn btn-secondary" id="ir_cancel">Cancel</button>
    </div>
    <div id="ir_result" class="mt"></div>
  `);

  $('ir_cancel').addEventListener('click', closeModal);
  $('ir_preview').addEventListener('click', () => runImport(false));
}

// Two-phase: preview first so unmatched names are visible before anything writes.
async function runImport(commit) {
  const text = $('ir_data')?.value.trim();
  if (!text) { toast('Paste the sheet first', true); return; }
  const out = $('ir_result');
  out.innerHTML = '<p class="hint">Working&hellip;</p>';

  let r;
  try {
    const createMissing = !!$('ir_create')?.checked;
    r = await api.post('/admin/import/results',
      { contract_id: contractId, text, commit, create_missing: createMissing });
  } catch (e) { out.innerHTML = ''; toast(`Import failed: ${e.message}`, true); return; }

  if (commit) {
    out.innerHTML = '';
    closeModal();
    const made = r.summary.players_created;
    toast(`✓ Imported ${r.summary.games_created} game(s)${made ? `, added ${made} guest player(s)` : ''}`, false);
    render();
    return;
  }

  const s = r.summary;
  const gameRows = r.games.map(g => `
    <div class="res-row" style="cursor:default;">
      <span class="res-name">${esc(g.date)} &nbsp; <span class="hint">${esc(g.teams.join(' v '))}</span></span>
      <span class="res-val">${g.duplicate_of
        ? '<span class="tag tag-due">already imported</span>'
        : `${g.matched_count} players${g.captain_count ? ` · ${g.captain_count}C` : ''}`}</span>
    </div>`).join('');

  out.innerHTML = `
    <div class="sams-card">
      <div class="card-header"><h3 class="card-title">Preview</h3>
        <span class="card-sub">${s.games_importable} of ${s.games_found} game(s) ready</span></div>
      <div class="res-board" style="max-height:230px;overflow-y:auto;">${gameRows || '<p class="hint">Nothing parsed.</p>'}</div>
    </div>

    ${r.unmatched.length ? `
      <div class="panel panel-warn mt">
        <div class="panel-title">${r.unmatched.length} name(s) could not be linked</div>
        <div class="panel-body">
          Ticking <em>&ldquo;Add unknown names as guest players&rdquo;</em> will create the
          roster ones on import; anything marked as a shared account needs splitting
          by hand first.<br><br>
          ${r.unmatched.map(u => `
            <div class="panel-row">
              <strong>${esc(u.token)}</strong>
              <span class="hint">${esc(u.reason || 'not on roster')}</span>
              <span class="hint">&times;${u.count}</span>
            </div>`).join('')}
        </div>
      </div>` : ''}

    ${r.skipped.length ? `
      <div class="panel mt">
        <div class="panel-title">${r.skipped.length} row(s) skipped</div>
        <div class="panel-body">
          ${r.skipped.map(x => `Line ${x.line}: ${esc(x.raw || '(blank)')} &mdash; ${esc(x.reason)}`).join('<br>')}
        </div>
      </div>` : ''}

    ${s.games_duplicate ? `
      <p class="hint mt">${s.games_duplicate} game(s) already exist on this contract for that date and will be skipped.</p>` : ''}

    <div class="btn-row mt">
      <button class="btn" id="ir_commit" ${s.games_importable ? '' : 'disabled'}>
        Import ${s.games_importable} game(s)
      </button>
      <button class="btn btn-secondary" id="ir_back">Back</button>
    </div>`;

  $('ir_commit')?.addEventListener('click', () => runImport(true));
  $('ir_back')?.addEventListener('click', () => { out.innerHTML = ''; });
}

export function loadResults() {
  contractSeg($('resContractSeg'), store.contracts, contractId, (id) => { contractId = id; render(); });
  return render();
}
