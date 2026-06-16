// results.js — match history with full context (teams, scores, per-player costs).
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $ } from '../util.js';

export function initResults() {
  // Contract filter tabs
  const seg = $('resContractSeg');
  seg.innerHTML = '';
  for (const c of store.contracts) {
    const btn = document.createElement('button');
    btn.textContent = c.name;
    btn.className = 'seg-btn';
    btn.onclick = () => { store.activeContract = c.id; loadResults(); };
    seg.appendChild(btn);
  }
}

export async function loadResults() {
  try {
    const results = await api.get(`/results?contract=${store.activeContract}`);
    renderResults(results);
  } catch (e) {
    toast(`Failed to load results: ${e.message}`, true);
  }
}

function renderResults(games) {
  const container = $('resultsContainer');
  if (!games || games.length === 0) {
    container.innerHTML = '<div class="hint">No games recorded yet.</div>';
    return;
  }

  container.innerHTML = games.map((g, i) => {
    const isExpanded = i === 0; // First game expanded by default
    const totalCost = g.total_charged || 0;
    const costPerPlayer = g.players_count > 0 ? (totalCost / g.players_count).toFixed(1) : '—';

    return `
      <div class="result-card" data-gw="${g.id}">
        <div class="result-header" onclick="this.parentElement.classList.toggle('expanded')">
          <div class="result-meta">
            <span class="result-date">${g.date}</span>
            <span class="result-gw">GW ${g.gw_number || '—'}</span>
            ${g.game_type === 'tournament' ? `<span class="tag tag-tournament">${g.tournament_name || 'Tournament'}</span>` : ''}
          </div>
          <div class="result-summary">
            <span class="result-score">${g.score || 'No score'}</span>
            <span class="result-cost">${totalCost} AED · ${g.players_count} players</span>
          </div>
          <span class="result-toggle">▼</span>
        </div>
        <div class="result-detail" ${isExpanded ? '' : 'hidden'}>
          <table class="sams-table">
            <thead>
              <tr>
                <th>Player</th><th>Team</th><th>Captain</th>
                <th class="num">Rate</th><th class="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${g.charges.map(ch => `
                <tr>
                  <td><strong>${ch.player_name}</strong></td>
                  <td>${ch.team || '—'}</td>
                  <td>${ch.is_captain ? '✓' : ''}</td>
                  <td class="num"><span class="hint">${ch.rate_type}</span></td>
                  <td class="num" title="Click to edit">${ch.amount} <span class="btn-edit" data-charge="${ch.id}">✎</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <div class="result-footer">
            <div><span class="muted">Total</span> ${totalCost} AED · <span class="hint">${costPerPlayer} AED/player avg</span></div>
            <button class="btn btn-secondary" onclick="window.editGameweekClick('${g.id}')">Edit Game</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Wire up edit buttons
  container.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const chargeId = btn.dataset.charge;
      toast('Edit individual charges from Edit Game modal', false);
    });
  });
}
