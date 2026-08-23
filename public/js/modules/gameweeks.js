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
    // The gameweeks LIST does not carry a `charges` array — only `num_players`
    // and a `charged` total (per-charge detail lives on /gameweeks/:id). Reading
    // g.charges here made every row show "0 players / 0" and, because that left
    // pendingAmount at 0, labelled every game "✓ Collected" regardless of truth.
    const charges = Array.isArray(g.charges) ? g.charges : null;
    // Prefer charges_count over num_players — the latter counts everyone named in
    // the original message, including unmatched people who were never billed.
    const playerCount = charges ? charges.length
      : (g.charges_count ?? Number(g.num_players) ?? 0);
    const totalCharged = charges
      ? charges.reduce((s, c) => s + (Number(c.amount) || 0), 0)
      : (Number(g.charged) || 0);

    // Settlement status needs per-charge `paid` flags. Without them, say so
    // rather than implying the game is fully collected.
    const known = !!charges;
    const paidCount = known ? charges.filter(c => c.paid).length : 0;
    const pendingAmount = known
      ? charges.filter(c => !c.paid).reduce((s, c) => s + (Number(c.amount) || 0), 0)
      : 0;
    const collectionRate = known && charges.length
      ? Math.round((paidCount / charges.length) * 100) : null;

    const statusColor = !known ? 'var(--text-muted)'
      : pendingAmount === 0 ? 'var(--success)'
        : pendingAmount < totalCharged / 2 ? 'var(--warning)' : 'var(--danger)';
    const statusText = !known ? '—'
      : pendingAmount === 0 ? '✓ Collected' : `⏳ ${money(pendingAmount)} pending`;

    return `
      <tr data-gw="${g.id}" style="cursor:pointer;">
        <td class="num"><strong>${esc(fmtDate(g.date))}</strong></td>
        <td class="num">#${g.contract_number || '—'}</td>
        <td class="num">${playerCount} players</td>
        <td class="num"><strong>${money(totalCharged)}</strong></td>
        <td><span style="color: ${statusColor}; font-weight: 600;">${statusText}</span></td>
        <td class="num" style="font-size: 0.85rem; color: var(--text-muted);">${collectionRate === null ? '—' : collectionRate + '%'}</td>
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

// Gameweek detail — shows the ORIGINAL pasted text alongside the linked players,
// so names the importer could not match can be spotted and added by hand.
async function detail(id) {
  const g = await api.gameweek(id);
  const contract = (store.contracts.find(c => c.id === g.contract_id) || {}).name || '';
  const charges = g.charges || [];
  const teams = [...new Set(charges.map(c => c.team).filter(Boolean))];
  const total = charges.reduce((s, c) => s + (Number(c.amount) || 0), 0);

  // Which names in the raw text have no linked player? Rough, but it is the
  // whole point of showing the raw text — it points at what to add.
  const linked = new Set(charges.map(c => String(c.player_name || '').toLowerCase()));
  const rawWords = (g.teams_raw || '').split(/[\s,:]+/)
    .map(w => w.replace(/[^\p{L}\p{N}'-]/gu, '').trim())
    .filter(w => w.length > 2 && !/^(red|blue|white|black|green|yellow|team|vs|game|no|capt)$/i.test(w));
  const possiblyMissing = [...new Set(rawWords.filter(w =>
    ![...linked].some(n => n.includes(w.toLowerCase()) || w.toLowerCase().includes(n))))];

  const teamOptions = (sel) => ['', ...teams, 'Red', 'Blue', 'White']
    .filter((t, i, a) => a.indexOf(t) === i)
    .map(t => `<option value="${esc(t)}" ${t === sel ? 'selected' : ''}>${esc(t || '—')}</option>`).join('');

  const rows = charges.map(c => `
    <div class="panel-row" data-charge="${c.id}">
      <strong style="flex:1">${esc(c.player_name)}</strong>
      <select class="ch-team" data-charge="${c.id}" style="max-width:110px">${teamOptions(c.team)}</select>
      <label class="hint" style="display:flex;align-items:center;gap:.3rem;white-space:nowrap">
        <input type="checkbox" class="ch-capt" data-charge="${c.id}" ${c.is_captain ? 'checked' : ''}> C
      </label>
      <span class="hint" style="min-width:52px;text-align:right">${money(c.amount)}</span>
      <button class="link-btn" data-remove="${c.id}" title="Remove from this game">✕</button>
    </div>`).join('');

  const players = (store.players || []).filter(p => !charges.some(c => c.player_id === p.id));

  openModal(`${fmtDate(g.date)} · ${esc(contract)}`, `
    ${g.score ? `<p class="muted"><strong>Result:</strong> ${esc(g.score)}</p>` : ''}

    <h4 class="mini-h mt">Original text</h4>
    <pre class="raw-block">${esc(g.teams_raw || '(none recorded)')}</pre>
    ${g.captains_raw ? `<p class="hint">Captains column: ${esc(g.captains_raw)}</p>` : ''}

    ${possiblyMissing.length ? `
      <div class="panel panel-warn mt">
        <div class="panel-title">${possiblyMissing.length} name(s) in the text with no linked player</div>
        <div class="panel-body">${possiblyMissing.map(esc).join(' · ')}</div>
      </div>` : ''}

    <h4 class="mini-h mt">Players (${charges.length}${total ? ` · ${money(total)} AED` : ' · no charges'})</h4>
    <div id="gwCharges">${rows || '<p class="hint">Nobody linked yet.</p>'}</div>

    <h4 class="mini-h mt">Add a player</h4>
    <div class="quick-row">
      <select id="gwAddPlayer" style="flex:1 1 150px">
        <option value="">Select player…</option>
        ${players.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
      </select>
      <select id="gwAddTeam" style="flex:0 1 110px">${teamOptions(teams[0] || '')}</select>
      <label class="hint" style="display:flex;align-items:center;gap:.3rem"><input type="checkbox" id="gwAddCapt"> Captain</label>
      <input type="number" id="gwAddAmount" class="qw-amount" value="0" min="0" step="0.5" title="0 records the appearance without charging">
      <button class="btn btn-sm" id="gwAddBtn">Add</button>
    </div>
    <p class="hint">Amount 0 records the appearance without moving any balance.</p>

    ${!g.historical ? `<button class="btn btn-secondary mt" onclick="window.editGameweekClick('${g.id}')">Edit amounts / result</button>` : ''}`);

  const reopen = () => detail(id);

  $('gwAddBtn')?.addEventListener('click', async () => {
    const pid = $('gwAddPlayer').value;
    if (!pid) { toast('Pick a player', true); return; }
    try {
      await api.addCharge(id, {
        player_id: pid,
        team: $('gwAddTeam').value,
        is_captain: $('gwAddCapt').checked,
        amount: Number($('gwAddAmount').value) || 0,
      });
      toast('Player added ✓'); reopen(); render();
    } catch (e) { toast(e.message, true); }
  });

  document.querySelectorAll('[data-remove]').forEach(b =>
    b.addEventListener('click', async () => {
      try { await api.removeCharge(id, b.dataset.remove); toast('Removed'); reopen(); render(); }
      catch (e) { toast(e.message, true); }
    }));

  const patch = async (chargeId) => {
    const team = document.querySelector(`.ch-team[data-charge="${chargeId}"]`).value;
    const capt = document.querySelector(`.ch-capt[data-charge="${chargeId}"]`).checked;
    try { await api.updateCharge(id, chargeId, { team, is_captain: capt }); toast('Updated'); }
    catch (e) { toast(e.message, true); }
  };
  document.querySelectorAll('.ch-team').forEach(el =>
    el.addEventListener('change', () => patch(el.dataset.charge)));
  document.querySelectorAll('.ch-capt').forEach(el =>
    el.addEventListener('change', () => patch(el.dataset.charge)));
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
