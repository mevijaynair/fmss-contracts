// players.js — per-contract ledger table + add player.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money, balCell, contractSeg, openModal, closeModal, today } from '../util.js';

let contractId = 'sat';

const STATUSES = ['In Contract', 'Refill needed', 'Out of contract'];

async function render() {
  const ledgers = await api.ledgers(contractId);
  $('playersTable').querySelector('tbody').innerHTML = ledgers.map(l => `
    <tr>
      <td><strong>${esc(l.player_name)}</strong></td>
      <td>
        <select data-status="${l.player_id}" class="btn-sm" style="padding:0.25rem 0.4rem;">
          ${STATUSES.map(s => `<option ${s.toLowerCase() === (l.status || '').toLowerCase() ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </td>
      <td class="num">${money(l.opening_balance)}</td>
      <td class="num">${money(l.contributed)}</td>
      <td class="num">${money(l.charged)}</td>
      <td class="num">${balCell(l.present_balance)}</td>
      <td>${l.games}</td>
      <td class="row-actions">
        <button class="btn btn-secondary btn-sm" data-pay="${l.player_id}">+ Pay</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="8" class="hint">No players in this contract yet.</td></tr>';

  $('playersTable').querySelectorAll('[data-status]').forEach(sel =>
    sel.addEventListener('change', async () => {
      try { await api.setStatus(sel.dataset.status, contractId, sel.value); toast('Status updated'); }
      catch (e) { toast(e.message, true); }
    }));
  $('playersTable').querySelectorAll('[data-pay]').forEach(btn =>
    btn.addEventListener('click', () => payModal(btn.dataset.pay)));
}

function payModal(playerId) {
  const p = store.players.find(x => x.id === playerId);
  openModal(`Add contribution — ${p?.name || ''}`, `
    <div class="form-group"><label>Amount (AED)</label><input type="number" id="pm_amount" step="1" placeholder="300"></div>
    <div class="form-group mt"><label>Date</label><input type="date" id="pm_date" value="${today()}"></div>
    <div class="form-group mt"><label>Comments</label><input type="text" id="pm_comments" placeholder="cash / transfer"></div>
    <button class="btn full-w mt" id="pm_save">Add to ${esc((store.contracts.find(c=>c.id===contractId)||{}).name||'')}</button>`);
  $('pm_save').addEventListener('click', async () => {
    try {
      await api.createContribution({
        player_id: playerId, contract_id: contractId,
        amount: Number($('pm_amount').value) || 0,
        date: $('pm_date').value, comments: $('pm_comments').value,
      });
      closeModal(); toast('Contribution added ✓'); render();
    } catch (e) { toast(e.message, true); }
  });
}

function addPlayerModal() {
  openModal('Add player', `
    <div class="form-group"><label>Name</label><input type="text" id="np_name" placeholder="Player name"></div>
    <div class="form-group mt"><label>WhatsApp aliases (comma-separated)</label>
      <input type="text" id="np_aliases" placeholder="e.g. Tush, Tushi"></div>
    <button class="btn full-w mt" id="np_save">Create player</button>`);
  $('np_save').addEventListener('click', async () => {
    const name = $('np_name').value.trim();
    if (!name) { toast('Name required', true); return; }
    try {
      await api.createPlayer({ name, aliases: $('np_aliases').value.split(',').map(s => s.trim()).filter(Boolean) });
      store.players = await api.players();
      closeModal(); toast('Player created ✓'); render();
    } catch (e) { toast(e.message, true); }
  });
}

export function initPlayers() {
  $('plAdd').addEventListener('click', addPlayerModal);
}

export function loadPlayers() {
  contractSeg($('plContractSeg'), store.contracts, contractId, (id) => { contractId = id; render(); });
  return render();
}
