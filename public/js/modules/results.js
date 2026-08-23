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
    // /results, not /gameweeks — the gameweeks LIST returns num_players and a
    // `charged` total but no `charges` array (only /gameweeks/:id has that), so
    // aggregating off it always produced an empty leaderboard.
    const gws = await api.results(contractId);
    const stats = aggregate(Array.isArray(gws) ? gws : []);
    if (!Object.keys(stats).length) { showEmpty(); return; }
    showLeaderboards(stats);
    showTable(stats);
    showTrends(stats);
  } catch (e) { toast(`Error: ${e.message}`, true); }
}

// Aggregate per player, TEAM-AWARE. The server resolves each game to a winning
// team and concrete goals; a win is credited only to that side. Previously one
// result was applied to every player, so the losing team was credited too.
function aggregate(gws) {
  const map = {};
  const blank = (name) => ({
    name, games: 0, wins: 0, draws: 0, losses: 0, unknown: 0,
    gf: 0, ga: 0, captainGames: 0, captainWins: 0,
    charged: 0, paid: 0, defaults: 0,
    q: { Q1: {}, Q2: {}, Q3: {}, Q4: {} },
  });

  gws.forEach(gw => {
    const q = ['Q1', 'Q2', 'Q3', 'Q4'][Math.floor(new Date(gw.date).getMonth() / 3)];
    const res = gw.result || {};
    const decided = res.known && (res.is_draw || res.winner_team);

    (gw.charges || []).forEach(c => {
      if (!map[c.player_id]) map[c.player_id] = blank(c.player_name);
      const p = map[c.player_id];
      p.games++;
      p.charged += Number(c.amount) || 0;
      if (c.paid) p.paid += Number(c.amount) || 0; else p.defaults++;

      let outcome = null;
      if (decided) {
        outcome = res.is_draw ? 'draw' : (c.team === res.winner_team ? 'win' : 'loss');
        const w = Number(res.goalsWin) || 0;
        const l = Number(res.goalsLose) || 0;
        if (outcome === 'draw') { p.gf += w; p.ga += w; }
        else if (outcome === 'win') { p.gf += w; p.ga += l; }
        else { p.gf += l; p.ga += w; }
      }

      if (outcome === 'win') p.wins++;
      else if (outcome === 'loss') p.losses++;
      else if (outcome === 'draw') p.draws++;
      else p.unknown++;

      if (c.is_captain) {
        p.captainGames++;
        if (outcome === 'win') p.captainWins++;
      }

      if (!p.q[q].games) p.q[q] = { games: 0, wins: 0, charged: 0 };
      p.q[q].games++;
      p.q[q].charged += Number(c.amount) || 0;
      if (outcome === 'win') p.q[q].wins++;
    });
  });

  Object.values(map).forEach(p => {
    // Rates use games with a KNOWN result. Counting a blank score cell as a loss
    // would punish players for missing data.
    p.decided = p.wins + p.draws + p.losses;
    p.winRate = p.decided ? Math.round((p.wins / p.decided) * 100) : null;
    p.gd = p.gf - p.ga;
    p.captainWinRate = p.captainGames ? Math.round((p.captainWins / p.captainGames) * 100) : null;
    p.payRate = p.games ? Math.round((p.games - p.defaults) / p.games * 100) : 0;
  });
  return map;
}

const pct = (v) => (v === null ? '—' : v + '%');
const signed = (n) => (n > 0 ? '+' + n : String(n));

function showLeaderboards(stats) {
  const everyone = Object.values(stats);
  const all = everyone.filter(p => p.games >= minGames);
  const hidden = everyone.length - all.length;

  // Rate boards need a floor of decided games, or someone 1-from-1 tops the chart.
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
        : '<p class="hint">Not enough games yet.</p>'}
      </div>
    </div>`;

  const opts = [1, 3, 6, 10];
  slot('results-lb').innerHTML = `
    <div class="filter-bar" style="grid-template-columns: 1fr auto;">
      <div class="hint">Ranking <strong>${all.length}</strong> player(s) with ${minGames}+ appearance(s)${
        hidden ? ` &middot; ${hidden} occasional player(s) hidden` : ''}</div>
      <span class="seg" id="resMinGames">
        ${opts.map(n => `<button data-min="${n}" class="${n === minGames ? 'active' : ''}">${n === 1 ? 'All' : n + '+'}</button>`).join('')}
      </span>
    </div>
    <div class="auto-grid" style="--col-min: 250px;">
      ${board('🎮 Most Games', 'appearances', '',
        [...all].sort((a, b) => b.games - a.games), p => p.games)}
      ${board('📈 Best Win Rate', 'of games with a result', 'is-win',
        [...rated].sort((a, b) => b.winRate - a.winRate || b.decided - a.decided),
        p => `${pct(p.winRate)} <span class="hint">${p.wins}/${p.decided}</span>`)}
      ${board('👑 Best Captain Rate', '2+ games as captain', 'is-capt',
        [...capts].sort((a, b) => b.captainWinRate - a.captainWinRate || b.captainGames - a.captainGames),
        p => `${pct(p.captainWinRate)} <span class="hint">${p.captainWins}/${p.captainGames}</span>`)}
      ${board('⚽ Goal Difference', 'across decided games', '',
        [...rated].sort((a, b) => b.gd - a.gd), p => signed(p.gd))}
    </div>`;

  slot('results-lb').querySelectorAll('#resMinGames button').forEach(b =>
    b.addEventListener('click', () => { minGames = Number(b.dataset.min); render(); }));
  slot('results-lb').querySelectorAll('[data-player]').forEach(d =>
    d.addEventListener('click', () => {
      const p = all.find(x => x.name === d.dataset.player);
      if (p) showPlayerDetail(p);
    }));
}

// Full standings — the numbers behind the boards.
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
    ['gf', 'GF', p => p.gf],
    ['ga', 'GA', p => p.ga],
    ['gd', 'GD', p => signed(p.gd)],
    ['captainGames', 'Capt', p => p.captainGames],
    ['captainWinRate', 'Capt %', p => pct(p.captainWinRate)],
    ['unknown', 'No result', p => p.unknown || '—'],
  ];
  rows.sort((a, b) => {
    const va = a[sortKey];
    const vb = b[sortKey];
    if (typeof va === 'string') return sortDir * String(va).localeCompare(String(vb));
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
        </tr>`).join('') || '<tr><td colspan="12" class="hint">No players.</td></tr>'}</tbody>
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
    <h4 class="mini-h">Record</h4>
    ${row('🎮 Played', p.games)}
    ${row('✅ Won', `${p.wins} (${pct(p.winRate)} of ${p.decided} decided)`, 'is-win')}
    ${row('🤝 Drawn', p.draws)}
    ${row('❌ Lost', p.losses)}
    ${p.unknown ? row('❔ No result recorded', p.unknown) : ''}
    <h4 class="mini-h mt">Goals</h4>
    ${row('Scored / conceded', `${p.gf} / ${p.ga}`)}
    ${row('Goal difference', signed(p.gd), p.gd >= 0 ? 'is-win' : '')}
    <h4 class="mini-h mt">Captaincy</h4>
    ${row('👑 Games led', p.captainGames)}
    ${row('Won as captain', `${p.captainWins} (${pct(p.captainWinRate)})`, 'is-win')}
    <h4 class="mini-h mt">Payments</h4>
    ${row('Charged', money(p.charged), 'is-money')}
    ${row('Paid', `${money(p.paid)} (${p.payRate}%)`, 'is-money')}`);
}

function showTrends(stats) {
  const q = { Q1: { games: 0, wins: 0, rev: 0 }, Q2: { games: 0, wins: 0, rev: 0 },
              Q3: { games: 0, wins: 0, rev: 0 }, Q4: { games: 0, wins: 0, rev: 0 } };
  Object.values(stats).forEach(p => {
    ['Q1', 'Q2', 'Q3', 'Q4'].forEach(s => {
      if (p.q[s].games) {
        q[s].games += p.q[s].games;
        q[s].wins += p.q[s].wins || 0;
        q[s].rev += p.q[s].charged || 0;
      }
    });
  });

  slot('results-trends').innerHTML = `<div class="sams-card">
    <div class="card-header"><h3 class="card-title">📊 Seasonal Comparison</h3>
      <span class="card-sub">Player-appearances by quarter</span></div>
    <div class="auto-grid" style="--col-min: 190px;">
      ${['Q1', 'Q2', 'Q3', 'Q4'].map(s => {
        const wr = q[s].games > 0 ? Math.round((q[s].wins / q[s].games) * 100) : 0;
        return `<div class="res-quarter ${q[s].games ? '' : 'is-empty'}">
          <div class="res-q-label">${s}</div>
          <div class="res-q-row"><span class="k">🎮 Appearances</span><span class="v">${q[s].games}</span></div>
          <div class="res-q-row"><span class="k">🏆 Winning ones</span><span class="v is-win">${q[s].wins} (${wr}%)</span></div>
          <div class="res-q-row is-total"><span class="k">💰 Revenue</span><span class="v is-money">${money(q[s].rev)}</span></div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
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
  slot('results-table').innerHTML = '';
  slot('results-trends').innerHTML = '';
  $('emptyImportBtn')?.addEventListener('click', showImportResultsModal);
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
