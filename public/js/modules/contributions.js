// contributions.js — add a payment + browse the incoming-funds log.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money, balCell, fmtDate, today } from '../util.js';

function contractName(id) {
  return store.contracts.find(c => c.id === id)?.name.split(' ')[0] || (id || '—');
}

function fillSelects() {
  // Cashier (Vijay) is excluded from contributing — never offer them in the
  // "add contribution" dropdown. They remain available in the filter so their
  // history (charges) can still be browsed.
  const payable = store.players
    .filter(p => p.special_role !== 'cashier')
    .map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const everyone = store.players.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('cf_player').innerHTML = '<option value="">— unassigned —</option>' + payable;
  $('cf_contract').innerHTML = store.contracts.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('contribFilter').innerHTML = '<option value="">All players</option>' + everyone;
}

async function renderLog() {
  const rows = await api.contributions(
    $('contribFilter').value ? { player: $('contribFilter').value } : {});
  $('contribTable').querySelector('tbody').innerHTML = rows.slice(0, 400).map(c => `
    <tr>
      <td class="num">${esc(fmtDate(c.date))}</td>
      <td>${esc(c.player_name || c.name_raw || '—')}</td>
      <td>${esc(contractName(c.contract_id))}</td>
      <td class="num">${balCell(c.amount)}</td>
      <td>${esc(c.comments || '')}</td>
      <td class="row-actions">${c.historical ? '<span class="hint">imported</span>'
        : `<button class="link-btn" data-del="${c.id}">✕</button>`}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="hint">No contributions.</td></tr>';

  $('contribTable').querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', async () => {
      try { await api.deleteContribution(b.dataset.del); toast('Removed'); renderLog(); }
      catch (e) { toast(e.message, true); }
    }));
}

export function initContributions() {
  $('cf_date').value = today();
  $('contribForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.createContribution({
        player_id: $('cf_player').value || null,
        contract_id: $('cf_contract').value,
        amount: Number($('cf_amount').value) || 0,
        date: $('cf_date').value, comments: $('cf_comments').value,
      });
      toast('Contribution added ✓');
      $('cf_amount').value = ''; $('cf_comments').value = '';
      renderLog();
    } catch (err) { toast(err.message, true); }
  });
  $('contribFilter').addEventListener('change', renderLog);
}

export function loadContributions() {
  fillSelects();
  return renderLog();
}
