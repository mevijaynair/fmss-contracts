import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money, fmtDate, contractSeg, openModal, closeModal } from '../util.js';

let contractId = 'sat';

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
  const all = Object.values(stats);
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

  slot('results-lb').innerHTML = `
    <div class="auto-grid" style="--col-min: 260px;">
      ${board('🎮 Most Games', '', byGames, 'games')}
      ${board('🏆 Most Wins', 'is-win', byWins, 'wins')}
      ${board('👑 Best Captains', 'is-capt', byCaptain, 'captainWins')}
    </div>`;

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
      <label class="mini-h">Paste Results (Tab-Separated)</label>
      <p class="hint">
        Format: Date &rarr; Players (comma-sep) &rarr; Score/Result &rarr; Team A &rarr; Team B<br>
        Example: 2026-08-22 &rarr; Vijay, Toby, Rojy &rarr; Reds win 7-5 &rarr; Reds &rarr; Blues
      </p>
      <textarea id="ir_data" class="import-area" placeholder="2026-08-22	Vijay, Toby, Rojy	Reds win 7-5	Reds	Blues
2026-08-29	Jithin, Kartik, Rakesh	Blues 9-6	Blues	Reds"></textarea>
    </div>
    <button class="btn full-w mt" id="ir_import">Import Results</button>
  `);

  $('ir_import').addEventListener('click', async () => {
    const data = $('ir_data').value.trim();
    if (!data) { toast('Paste data', true); return; }

    try {
      const lines = data.split('\n').filter(l => l.trim());
      let imported = 0;

      for (const line of lines) {
        const parts = line.split('\t').map(p => p.trim());
        if (parts.length < 3) continue;

        const [dateStr, playersStr, resultStr] = parts;
        const result = parseResult(resultStr, '');

        // Log: would store to backend
        // For now, just count successful parses
        if (dateStr && playersStr && result) imported++;
      }

      toast(`✓ Parsed ${imported} results (backend integration needed for persistence)`, false);
      closeModal();
      render();
    } catch (e) {
      toast(`Error: ${e.message}`, true);
    }
  });
}

export function loadResults() {
  contractSeg($('resContractSeg'), store.contracts, contractId, (id) => { contractId = id; render(); });
  return render();
}
