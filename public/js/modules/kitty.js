// kitty.js — club pot: income/expense ledger + running balance.
import { api } from '../api.js';
import { toast } from '../store.js';
import { $, esc, money, balCell, fmtDate, today } from '../util.js';

async function render() {
  const k = await api.kitty();
  $('kittyKpi').innerHTML = [
    { v: money(k.balance), l: 'Current balance (AED)', cls: k.balance >= 0 ? 'good' : 'bad' },
    { v: money(k.opening), l: 'Imported opening' },
    { v: money(k.income), l: 'New income' },
    { v: money(k.expense), l: 'New expense', cls: 'warn' },
  ].map(x => `<div class="kpi ${x.cls || ''}"><div class="v">${x.v}</div><div class="l">${esc(x.l)}</div></div>`).join('');

  $('kittyTable').querySelector('tbody').innerHTML = k.entries.map(e => `
    <tr>
      <td class="num">${esc(fmtDate(e.date))}</td>
      <td><span class="tag ${e.kind === 'income' ? 'tag-paid' : 'tag-overdue'}">${e.kind}</span></td>
      <td>${esc(e.label)}</td>
      <td class="num">${e.kind === 'income' ? balCell(e.amount) : `<span class="bal neg">-${money(e.amount)}</span>`}</td>
      <td class="row-actions">${e.historical ? '<span class="hint">imported</span>'
        : `<button class="link-btn" data-del="${e.id}">✕</button>`}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="hint">No entries.</td></tr>';

  $('kittyTable').querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', async () => {
      try { await api.deleteKitty(b.dataset.del); toast('Removed'); render(); }
      catch (e) { toast(e.message, true); }
    }));
}

export function initKitty() {
  $('kf_date').value = today();
  $('kittyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.createKitty({
        kind: $('kf_kind').value, amount: Number($('kf_amount').value) || 0,
        label: $('kf_label').value, date: $('kf_date').value,
      });
      toast('Kitty entry added ✓');
      $('kf_amount').value = ''; $('kf_label').value = '';
      render();
    } catch (err) { toast(err.message, true); }
  });
}

export function loadKitty() { return render(); }
