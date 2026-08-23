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
    showTrends(stats);
  } catch (e) { toast(`Error: ${e.message}`, true); }
}

function parseResult(scoreline, score) {
  const text = (scoreline || score || '').trim();
  if (!text) return null;
  const m = text.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (m) return parseInt(m[1]) > parseInt(m[2]) ? 'win' : parseInt(m[1]) < parseInt(m[2]) ? 'loss' : 'draw';
  if (text.toLowerCase().includes('won')) return 'win';
  if (text.toLowerCase().includes('lost')) return 'loss';
  if (text.toLowerCase().includes('draw')) return 'draw';
  return null;
}

function aggregate(gws) {
  const map = {};
  gws.forEach(gw => {
    const q = ['Q1', 'Q2', 'Q3', 'Q4'][Math.floor(new Date(gw.date).getMonth() / 3)];
    const result = parseResult(gw.scoreline, gw.score);
    (gw.charges || []).forEach(c => {
      if (!map[c.player_id]) map[c.player_id] = {
        name: c.player_name, games: 0, wins: 0, captainGames: 0, captainWins: 0,
        charged: 0, paid: 0, defaults: 0, q: { Q1: {}, Q2: {}, Q3: {}, Q4: {} }
      };
      const p = map[c.player_id];
      p.games++; p.charged += c.amount;
      if (c.paid) p.paid += c.amount; else p.defaults++;
      if (result === 'win') p.wins++;
      if (c.is_captain) {
        p.captainGames++;
        if (result === 'win') p.captainWins++;
      }
      if (!p.q[q].games) p.q[q] = { games: 0, wins: 0, charged: 0 };
      p.q[q].games++; p.q[q].charged += c.amount;
      if (result === 'win') p.q[q].wins++;
    });
  });
  Object.values(map).forEach(p => {
    p.payRate = p.games > 0 ? Math.round((p.games - p.defaults) / p.games * 100) : 0;
    p.winRate = p.games > 0 ? Math.round((p.wins / p.games) * 100) : 0;
    p.captainWinRate = p.captainGames > 0 ? Math.round((p.captainWins / p.captainGames) * 100) : 0;
  });
  return map;
}

// Mount point inside the Results card, created once.
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
  slot('results-trends').innerHTML = '';
  $('emptyImportBtn')?.addEventListener('click', showImportResultsModal);
}

function showLeaderboards(stats) {
  const everyone = Object.values(stats);
  const all = everyone.filter(p => p.games >= minGames);
  const hidden = everyone.length - all.length;
  const byGames = [...all].sort((a, b) => b.games - a.games);
  const byWins = [...all].sort((a, b) => b.wins - a.wins);
  const byCaptain = [...all].filter(p => p.captainGames > 0).sort((a, b) => b.captainWins - a.captainWins);

  const board = (title, tone, data, field) => `
    <div class="sams-card">
      <div class="card-header"><h3 class="card-title">${title}</h3></div>
      <div class="res-board">
        ${data.length ? data.slice(0, 8).map((p, i) => `
          <div class="res-row" data-player="${esc(p.name)}">
            <span class="res-name">${i + 1}. ${esc(p.name)}</span>
            <span class="res-val ${tone}">${p[field]}</span>
          </div>`).join('')
        : '<p class="hint">No data yet.</p>'}
      </div>
    </div>`;

  const opts = [1, 3, 6, 10];
  slot('results-lb').innerHTML = `
    <div class="filter-bar" style="grid-template-columns: 1fr auto;">
      <div class="hint">
        Ranking <strong>${all.length}</strong> player(s) with ${minGames}+ appearance(s)${
          hidden ? ` &middot; ${hidden} occasional player(s) hidden` : ''}
      </div>
      <span class="seg" id="resMinGames">
        ${opts.map(n => `<button data-min="${n}" class="${n === minGames ? 'active' : ''}">${n === 1 ? 'All' : n + '+'}</button>`).join('')}
      </span>
    </div>
    <div class="auto-grid" style="--col-min: 260px;">
      ${board('🎮 Most Games', '', byGames, 'games')}
      ${board('🏆 Most Wins', 'is-win', byWins, 'wins')}
      ${board('👑 Best Captains', 'is-capt', byCaptain, 'captainWins')}
    </div>`;

  slot('results-lb').querySelectorAll('#resMinGames button').forEach(b =>
    b.addEventListener('click', () => { minGames = Number(b.dataset.min); render(); }));

  slot('results-lb').querySelectorAll('[data-player]').forEach(d => {
    d.addEventListener('click', () => {
      const p = all.find(x => x.name === d.dataset.player);
      if (p) showPlayerDetail(p);
    });
  });
}

function showPlayerDetail(p) {
  const row = (k, v, cls = '') =>
    `<div class="res-q-row"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;
  openModal(esc(p.name), `
    <h4 class="mini-h">Career</h4>
    ${row('🎮 Games played', p.games)}
    ${row('🏆 Wins', `${p.wins} (${p.winRate}%)`, 'is-win')}
    <h4 class="mini-h mt">Captaincy</h4>
    ${row('👑 Games led', p.captainGames)}
    ${row('🏆 Wins as captain', `${p.captainWins} (${p.captainWinRate}%)`, 'is-win')}
    <h4 class="mini-h mt">Payments</h4>
    ${row('Charged', money(p.charged), 'is-money')}
    ${row('Paid', `${money(p.paid)} (${p.payRate}%)`, 'is-money')}
    <h4 class="mini-h mt">By quarter</h4>
    ${['Q1', 'Q2', 'Q3', 'Q4'].map(q =>
      row(q, `${p.q[q].games || 0} games · ${p.q[q].wins || 0}W`)).join('')}`);
}

function showTrends(stats) {
  const q = { Q1: { games: 0, wins: 0, rev: 0 }, Q2: { games: 0, wins: 0, rev: 0 }, Q3: { games: 0, wins: 0, rev: 0 }, Q4: { games: 0, wins: 0, rev: 0 } };
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
      <span class="card-sub">Games, wins and revenue by quarter</span></div>
    <div class="auto-grid" style="--col-min: 190px;">
      ${['Q1', 'Q2', 'Q3', 'Q4'].map(s => {
        const wr = q[s].games > 0 ? Math.round((q[s].wins / q[s].games) * 100) : 0;
        return `<div class="res-quarter ${q[s].games ? '' : 'is-empty'}">
          <div class="res-q-label">${s}</div>
          <div class="res-q-row"><span class="k">🎮 Games</span><span class="v">${q[s].games}</span></div>
          <div class="res-q-row"><span class="k">🏆 Wins</span><span class="v is-win">${q[s].wins} (${wr}%)</span></div>
          <div class="res-q-row is-total"><span class="k">💰 Revenue</span><span class="v is-money">${money(q[s].rev)}</span></div>
        </div>`;
      }).join('')}
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
