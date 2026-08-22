import { api } from '../api.js';
import { toast } from '../store.js';
import { $, esc, money, fmtDate } from '../util.js';

let contractId = 'sat';

async function render() {
  try {
    const gws = await api.gameweeks(contractId);
    const stats = aggregate(gws);
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

function showLeaderboards(stats) {
  const all = Object.values(stats);
  const byGames = [...all].sort((a, b) => b.games - a.games);
  const byWins = [...all].sort((a, b) => b.wins - a.wins);
  const byCaptain = [...all].filter(p => p.captainGames > 0).sort((a, b) => b.captainWins - a.captainWins);

  const html = `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1.5rem;margin-bottom:2rem;">
    <div><h3 style="border-bottom:2px solid var(--sport);padding-bottom:0.5rem;">🎮 Most Games</h3>
      ${byGames.slice(0, 5).map((p, i) => `<div style="padding:0.75rem;background:var(--bg-subtle);border-radius:6px;margin-bottom:0.5rem;cursor:pointer;" data-player="${p.name}">
        <div style="display:flex;justify-content:space-between;font-weight:600;"><span>${i+1}. ${esc(p.name)}</span><span style="color:var(--sport);">${p.games}</span></div>
        <div style="font-size:0.8rem;color:var(--text-muted);">Wins: ${p.wins} | Paid: ${p.payRate}%</div>
      </div>`).join('')}
    </div>
    <div><h3 style="border-bottom:2px solid #4caf50;padding-bottom:0.5rem;">🏆 Most Wins</h3>
      ${byWins.slice(0, 5).map((p, i) => `<div style="padding:0.75rem;background:rgba(76,175,80,0.1);border-radius:6px;margin-bottom:0.5rem;cursor:pointer;" data-player="${p.name}">
        <div style="display:flex;justify-content:space-between;font-weight:600;"><span>${i+1}. ${esc(p.name)}</span><span style="color:#4caf50;">${p.wins}W</span></div>
        <div style="font-size:0.8rem;color:var(--text-muted);">Rate: ${p.winRate}% | ${p.games} games</div>
      </div>`).join('')}
    </div>
    <div><h3 style="border-bottom:2px solid #ff9800;padding-bottom:0.5rem;">👑 Best Captains</h3>
      ${byCaptain.slice(0, 5).map((p, i) => `<div style="padding:0.75rem;background:rgba(255,152,0,0.1);border-radius:6px;margin-bottom:0.5rem;cursor:pointer;" data-player="${p.name}">
        <div style="display:flex;justify-content:space-between;font-weight:600;"><span>${i+1}. ${esc(p.name)}</span><span style="color:#ff9800;">${p.captainWins}W</span></div>
        <div style="font-size:0.8rem;color:var(--text-muted);">Rate: ${p.captainWinRate}% | Led: ${p.captainGames}</div>
      </div>`).join('')}
    </div>
  </div>`;

  let c = document.querySelector('[data-results-lb]');
  if (!c) { c = document.createElement('div'); c.setAttribute('data-results-lb', ''); const v = document.querySelector('[data-view="results"]'); if (v) v.appendChild(c); }
  c.innerHTML = html;

  c.querySelectorAll('[data-player]').forEach(d => {
    d.addEventListener('click', () => {
      const p = Object.values(stats).find(x => x.name === d.dataset.player);
      if (p) alert(`${p.name}\n━━━━━━━━━━━━━━━\n📊 Games: ${p.games} | Wins: ${p.wins} (${p.winRate}%)\n💰 Charged: ${money(p.charged)} | Paid: ${money(p.paid)} (${p.payRate}%)\n👑 Captain: ${p.captainGames} games, ${p.captainWins}W (${p.captainWinRate}%)\nQ1: ${p.q.Q1.games||0} games\nQ2: ${p.q.Q2.games||0} games\nQ3: ${p.q.Q3.games||0} games\nQ4: ${p.q.Q4.games||0} games`);
    });
  });
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

  const html = `<div style="padding:1.5rem;background:var(--bg-subtle);border-radius:8px;"><h3 style="margin-bottom:1rem;">📊 Seasonal Trends</h3><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;">
    ${['Q1', 'Q2', 'Q3', 'Q4'].map(s => {
      const wr = q[s].games > 0 ? Math.round((q[s].wins / q[s].games) * 100) : 0;
      return `<div style="padding:1rem;background:white;border-radius:6px;border-left:4px solid var(--sport);">
        <div style="font-weight:600;font-size:1.1rem;color:var(--sport);margin-bottom:0.5rem;">${s}</div>
        <div style="font-size:0.9rem;margin-bottom:0.3rem;">🎮 ${q[s].games} games</div>
        <div style="font-size:0.9rem;margin-bottom:0.3rem;">🏆 ${q[s].wins}W (${wr}%)</div>
        <div style="font-size:0.9rem;color:var(--text-muted);">💰 ${money(q[s].rev)}</div>
      </div>`;
    }).join('')}
  </div></div>`;

  let c = document.querySelector('[data-results-trends]');
  if (!c) { c = document.createElement('div'); c.setAttribute('data-results-trends', ''); const v = document.querySelector('[data-view="results"]'); if (v) v.appendChild(c); }
  c.innerHTML = html;
}

export function initResults() {
  const seg = $('resContractSeg');
  if (seg) {
    seg.innerHTML = '<button class="seg-btn active" data-c="sat">Saturdays</button><button class="seg-btn" data-c="mon_thu">Mon/Thu</button><button class="btn btn-sm" style="margin-left:auto;" id="importResultsBtn">📥 Import</button>';
    seg.querySelectorAll('[data-c]').forEach(b => b.addEventListener('click', () => {
      contractId = b.dataset.c;
      seg.querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      render();
    }));
    $('importResultsBtn')?.addEventListener('click', showImportResultsModal);
  }
}

function showImportResultsModal() {
  const { openModal, closeModal } = window;
  if (!window.openModal) {
    const modal = document.querySelector('#modal');
    openModal = (title, html) => {
      document.querySelector('#modalTitle').textContent = title;
      document.querySelector('#modalContent').innerHTML = html;
      modal.hidden = false;
    };
    closeModal = () => { modal.hidden = true; };
  }

  openModal('Import Match Results', `
    <div style="margin-bottom: 1.5rem;">
      <label style="display: block; font-weight: 600; margin-bottom: 0.5rem;">Paste Results (Tab-Separated)</label>
      <p class="hint" style="margin: 0 0 0.8rem; font-size: 0.85rem;">
        Format: Date | Players (comma-sep) | Score/Result | Team A | Team B<br>
        Example: 2026-08-22 | Vijay, Toby, Rojy | Reds win 7-5 | Reds | Blues
      </p>
      <textarea id="ir_data" placeholder="2026-08-22	Vijay, Toby, Rojy	Reds win 7-5	Reds	Blues
2026-08-29	Jithin, Kartik, Rakesh	Blues 9-6	Blues	Reds" style="width: 100%; min-height: 200px; padding: 0.8rem; font-family: monospace; font-size: 0.9rem; border: 1px solid var(--border-color); border-radius: 8px;"></textarea>
    </div>
    <button class="btn full-w" id="ir_import">Import Results</button>
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
      closeModal?.();
      render();
    } catch (e) {
      toast(`Error: ${e.message}`, true);
    }
  });
}

export function loadResults() { return render(); }
