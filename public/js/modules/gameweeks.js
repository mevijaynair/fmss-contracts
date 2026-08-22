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
      <div style="flex: 1;">
        <input type="checkbox" id="sel_${c.id}" style="margin-right: 0.5rem;" data-player="${c.player_id}" data-amount="${c.amount}" data-contract="${gw.contract_id}">
        <label for="sel_${c.id}" style="font-weight: 600; cursor: pointer;">${esc(c.player_name)} — ${money(c.amount)}</label>
      </div>
      <div style="display: flex; gap: 0.3rem;">
        <button class="btn btn-sm" data-mark-paid="${c.id}" style="padding: 0.2rem 0.4rem; font-size: 0.7rem;">Mark Paid</button>
      </div>
    </div>
  `).join('');

  openModal(
    `Record Payments — ${esc(fmtDate(gw.date))}`,
    `<div style="margin-bottom: 1rem; padding: 1rem; background: var(--bg-subtle); border-radius: 6px;">
      <div style="font-weight: 600; margin-bottom: 0.5rem;">💰 Quick Add to Ledger</div>
      <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.8rem;">Select players who paid (by cash, transfer, etc.) → add to their balance</div>
      <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem;">
        <select id="payment_method" style="flex: 1; min-width: 150px; padding: 0.4rem; border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.9rem;">
          <option value="cash">💵 Cash</option>
          <option value="transfer">🏦 Bank Transfer</option>
          <option value="upi">📱 UPI/Online</option>
          <option value="other">📝 Other</option>
        </select>
        <button class="btn" id="add_to_ledger" style="padding: 0.4rem 1rem; font-size: 0.9rem;">✓ Add to Ledger</button>
      </div>
    </div>
    <div style="max-height: 50vh; overflow-y: auto; margin-bottom: 1rem;">
      ${pendingHtml}
    </div>`
  );

  // Add selected payments to ledger
  const addBtn = document.getElementById('add_to_ledger');
  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      const selected = Array.from(document.querySelectorAll('input[id^="sel_"]:checked')).map(cb => ({
        player_id: cb.dataset.player,
        amount: Number(cb.dataset.amount),
        contract_id: cb.dataset.contract,
        method: document.getElementById('payment_method')?.value || 'cash'
      }));

      if (selected.length === 0) { toast('Select at least one player', true); return; }

      try {
        for (const payment of selected) {
          await api.createContribution({
            player_id: payment.player_id,
            contract_id: payment.contract_id,
            amount: payment.amount,
            comments: `Paid by ${payment.method} on ${fmtDate(gw.date)}`
          });
        }
        const total = selected.reduce((s, p) => s + p.amount, 0);
        toast(`✓ Added ${money(total)} from ${selected.length} player(s) to ledger`, false);
        setTimeout(() => render(), 1000);
      } catch (e) {
        toast(`Error: ${e.message}`, true);
      }
    });
  }

  // Mark individual as paid (legacy)
  document.querySelectorAll('[data-mark-paid]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const chargeId = btn.dataset.markPaid;
      toast('✓ Marked paid (use Quick Add for balance update)', false);
      setTimeout(() => render(), 1000);
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
