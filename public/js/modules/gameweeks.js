// gameweeks.js — game history list + detail modal.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money, fmtDate, contractSeg, openModal } from '../util.js';

let contractId = 'sat';

async function render() {
  const rows = await api.gameweeks(contractId);
  $('gwTable').querySelector('tbody').innerHTML = rows.map(g => `
    <tr data-gw="${g.id}" style="cursor:pointer;">
      <td class="num">${esc(fmtDate(g.date))}</td>
      <td>${g.gw_number || ''}${g.historical ? '' : ' <span class="tag tag-active">live</span>'}</td>
      <td>${g.num_players}</td>
      <td class="num">${money(g.charged)}</td>
      <td>${esc(g.score || '')}</td>
      <td class="row-actions">${g.historical ? '<span class="hint">imported</span>'
        : `<button class="link-btn" data-del="${g.id}">✕</button>`}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="hint">No games recorded.</td></tr>';

  $('gwTable').querySelectorAll('tr[data-gw]').forEach(tr =>
    tr.addEventListener('click', (e) => {
      if (!e.target.closest('button')) detail(tr.dataset.gw);
    }));
  $('gwTable').querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this game and refund its charges?')) return;
      try { await api.deleteGameweek(b.dataset.del); toast('Deleted'); render(); }
      catch (err) { toast(err.message, true); }
    }));
}

async function detail(id) {
  const g = await api.gameweek(id);
  const charges = (g.charges || []).map(c => `
    <div class="kv"><span class="k"><span class="team-dot team-${esc(c.team || 'Team 1')}"></span>${esc(c.player_name)}${c.is_captain ? '<span class="capt-badge">C</span>' : ''}</span>
      <span class="v">${money(c.amount)}</span></div>`).join('');
  openModal(`${fmtDate(g.date)} · ${esc((store.contracts.find(c=>c.id===g.contract_id)||{}).name||'')}`, `
    ${g.score ? `<p class="muted"><strong>Result:</strong> ${esc(g.score)}</p>` : ''}
    ${g.teams_raw ? `<div class="teams-raw mt">${esc(g.teams_raw)}</div>` : ''}
    <h4 class="mini-h mt">Charges (${g.num_players} players · ${money(g.charges?.reduce((s,c)=>s+c.amount,0)||0)} AED)</h4>
    ${charges || '<p class="hint">No charges.</p>'}
    ${!g.historical ? `<button class="btn mt" onclick="window.editGameweekClick('${g.id}')">Edit Game</button>` : ''}`);
}

// Edit gameweek — populate and show modal
window.editGameweekClick = async (gameweekId) => {
  try {
    const g = await api.gameweek(gameweekId);
    editGameweekModal(g);
  } catch (e) {
    toast(`Failed to load game: ${e.message}`, true);
  }
};

function editGameweekModal(g) {
  const modal = $('editGameweekModal');
  $('egTitle').textContent = `Edit ${fmtDate(g.date)}`;
  $('egGameType').value = g.game_type || 'regular';
  $('egTournamentName').value = g.tournament_name || '';
  $('egScore').value = g.score || '';
  $('egComments').value = g.comments || '';

  // Populate charges table
  const tbody = $('egChargesTable').querySelector('tbody');
  tbody.innerHTML = (g.charges || []).map(ch => `
    <tr>
      <td>${esc(ch.player_name)}</td>
      <td>${ch.team || '—'}</td>
      <td>${ch.is_captain ? '✓' : ''}</td>
      <td><input type="text" class="input-mini" value="${ch.rate_type}" disabled></td>
      <td class="num"><span class="muted">${money(ch.amount)}</span></td>
      <td class="num"><input type="number" class="input-mini" value="${ch.amount}" data-charge-id="${ch.id}" step="1"></td>
      <td class="num"><span class="charge-delta" data-charge-id="${ch.id}">0</span></td>
    </tr>
  `).join('');

  // Wire up preview
  $('egPreview').onclick = () => previewImpact(g.id);
  $('egSave').onclick = () => saveGameweekEdits(g.id);
  $('egClose').onclick = () => { modal.hidden = true; };

  modal.hidden = false;
}

async function previewImpact(gameweekId) {
  try {
    const edits = Array.from($('egChargesTable').querySelectorAll('input[type="number"]')).map(inp => ({
      chargeId: inp.dataset.chargeId,
      newAmount: Number(inp.value),
    }));

    const impact = await api.get(`/gameweeks/${gameweekId}/impact?chargeEdits=${JSON.stringify(edits)}`);
    const preview = $('egImpactPreview');
    preview.style.display = 'block';
    $('egImpactText').innerHTML = `
      <strong>${impact.changedCount} charges changed</strong><br>
      Original total: ${money(impact.originalTotal)} AED<br>
      New total: ${money(impact.newTotal)} AED<br>
      Delta: ${money(impact.totalDelta)} AED<br>
      ${impact.playerImpacts.map(pi => `<div class="hint">${pi.playerName}: ${money(pi.oldAmount)} → ${money(pi.newAmount)}</div>`).join('')}
    `;
  } catch (e) {
    toast(`Failed to calculate impact: ${e.message}`, true);
  }
}

async function saveGameweekEdits(gameweekId) {
  try {
    const edits = Array.from($('egChargesTable').querySelectorAll('input[type="number"]')).map(inp => ({
      chargeId: inp.dataset.chargeId,
      newAmount: Number(inp.value),
    }));

    await api.put(`/gameweeks/${gameweekId}`, {
      metadata: {
        game_type: $('egGameType').value,
        tournament_name: $('egTournamentName').value,
        score: $('egScore').value,
        comments: $('egComments').value,
      },
      chargeEdits: edits,
      reason: 'Web UI edit',
      autoRecalculate: $('egAutoRecalc').checked,
    });

    $('editGameweekModal').hidden = true;
    toast('Game updated with audit trail ✓');
    render();
  } catch (e) {
    toast(`Failed to save: ${e.message}`, true);
  }
}

export function initGameweeks() {}

export function loadGameweeks() {
  contractSeg($('gwContractSeg'), store.contracts, contractId, (id) => { contractId = id; render(); });
  return render();
}
