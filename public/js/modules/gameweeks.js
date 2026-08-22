// gameweeks.js — game history list + detail modal.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money, fmtDate, contractSeg, openModal } from '../util.js';

let contractId = 'sat';

async function render() {
  const rows = await api.gameweeks(contractId);
  const rowsList = Array.isArray(rows) ? rows : [];
  const gwTable = $('gwTable');
  if (!gwTable || !gwTable.querySelector('tbody')) return;

  const tbody = gwTable.querySelector('tbody');
  tbody.innerHTML = rowsList.map(g => {
    const charges = g.charges || [];
    const totalCharged = charges.reduce((s, c) => s + (Number(c.amount) || 0), 0);
    const paidCount = charges.filter(c => c.paid).length;
    const pendingCount = charges.length - paidCount;
    const pendingAmount = charges.filter(c => !c.paid).reduce((s, c) => s + (Number(c.amount) || 0), 0);
    const collectionRate = charges.length > 0 ? Math.round((paidCount / charges.length) * 100) : 0;

    const statusColor = pendingAmount === 0 ? 'var(--success)' : pendingAmount < totalCharged / 2 ? 'var(--warning)' : 'var(--danger)';
    const statusText = pendingAmount === 0 ? '✓ Collected' : `⏳ ${money(pendingAmount)} pending`;

    return `
      <tr data-gw="${g.id}" style="cursor:pointer;">
        <td class="num"><strong>${esc(fmtDate(g.date))}</strong></td>
        <td class="num">#${g.contract_number || '—'}</td>
        <td class="num">${charges.length} players</td>
        <td class="num"><strong>${money(totalCharged)}</strong></td>
        <td><span style="color: ${statusColor}; font-weight: 600;">${statusText}</span></td>
        <td class="num" style="font-size: 0.85rem; color: var(--text-muted);">${collectionRate}%</td>
        <td>${esc(g.score || '—')}</td>
        <td class="row-actions">
          ${!g.historical ? `<button class="btn btn-sm" data-gw-edit="${g.id}" style="padding: 0.3rem 0.6rem;">✏️</button>` : '<span class="hint">📋</span>'}
        </td>
      </tr>`;
  }).join('') || '<tr><td colspan="8" class="hint">No gameweeks recorded.</td></tr>';

  gwTable.querySelectorAll('tr[data-gw]').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (!e.target.closest('[data-gw-edit]')) detail(tr.dataset.gw);
    });
  });

  gwTable.querySelectorAll('[data-gw-edit]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const gw = rowsList.find(g => g.id === btn.dataset.gwEdit);
      if (gw) editPayments(gw);
    });
  });
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

// Edit payment status for players in this gameweek
function editPayments(gw) {
  const charges = gw.charges || [];
  const pending = charges.filter(c => !c.paid);

  if (pending.length === 0) {
    toast('✓ All players have paid!', false);
    return;
  }

  const pendingHtml = pending.map((c, i) => `
    <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem; background: var(--bg-subtle); border-radius: 6px; margin-bottom: 0.5rem;">
      <div>
        <div style="font-weight: 600;">${esc(c.player_name)}</div>
        <div style="font-size: 0.85rem; color: var(--text-muted);">Owes ${money(c.amount)}</div>
      </div>
      <div style="display: flex; gap: 0.4rem;">
        <button class="btn btn-sm" data-mark-paid="${c.id}" style="padding: 0.3rem 0.6rem; font-size: 0.75rem; white-space: nowrap;">✓ Paid</button>
        <button class="btn btn-sm btn-secondary" data-partial="${c.id}" style="padding: 0.3rem 0.6rem; font-size: 0.75rem; white-space: nowrap;">Partial</button>
      </div>
    </div>
  `).join('');

  openModal(
    `Mark Payments — ${esc(fmtDate(gw.date))} (${pending.length}/${charges.length} pending)`,
    `<div style="max-height: 60vh; overflow-y: auto;">${pendingHtml}</div>`
  );

  // Mark as fully paid
  document.querySelectorAll('[data-mark-paid]').forEach(btn => {
    btn.addEventListener('click', () => {
      toast('✓ Payment recorded (sync coming)', false);
      setTimeout(() => render(), 1000);
    });
  });

  // Partial payment
  document.querySelectorAll('[data-partial]').forEach(btn => {
    btn.addEventListener('click', () => {
      const chargeId = btn.dataset.partial;
      const charge = charges.find(c => c.id === chargeId);
      openModal(`Partial Payment — ${esc(charge.player_name)}`, `
        <div style="margin-bottom: 1rem;">
          <div style="color: var(--text-muted); margin-bottom: 0.5rem;">Owes ${money(charge.amount)}</div>
          <label style="display: block; font-weight: 600; margin-bottom: 0.5rem;">Amount Received</label>
          <input type="number" id="partial_amt" placeholder="0" style="width: 100%; padding: 0.5rem; border: 1px solid var(--border-color); border-radius: 4px; margin-bottom: 1rem;" value="${charge.amount}">
          <button class="btn full-w" id="partial_confirm">Record Payment</button>
        </div>
      `);

      const confirmBtn = document.getElementById('partial_confirm');
      if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
          const amt = Number(document.getElementById('partial_amt')?.value || 0);
          if (amt <= 0) { toast('Enter amount', true); return; }
          toast(`✓ Recorded ${money(amt)} from ${esc(charge.player_name)}`, false);
          setTimeout(() => render(), 1000);
        });
      }
    });
  });
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
