// kitty.js — club pot: income/expense ledger + running balance.
import { api } from '../api.js';
import { toast } from '../store.js';
import { $, esc, money, balCell, fmtDate, today, openModal, closeModal } from '../util.js';

async function render() {
  const k = await api.kitty();
  $('kittyKpi').innerHTML = [
    { v: money(k.balance), l: 'Current balance (AED)', cls: k.balance >= 0 ? 'good' : 'bad' },
    { v: money(k.opening), l: 'Opening balance' },
    { v: money(k.income), l: 'Income (manual)' },
    { v: money(k.expense), l: 'Expense (manual)', cls: 'warn' },
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

  // Summary breakdown by category
  if (k.entries && k.entries.length > 0) {
    const breakdown = {};
    k.entries.forEach(e => {
      const cat = e.label.toLowerCase().includes('old') ? 'Old Sheet' :
                  e.label.toLowerCase().includes('2025') ? '2025' :
                  e.label.toLowerCase().includes('2026') ? '2026' :
                  e.kind === 'expense' ? 'Expenses' : 'Other';
      if (!breakdown[cat]) breakdown[cat] = 0;
      breakdown[cat] += e.kind === 'income' ? e.amount : -e.amount;
    });

    const summaryHtml = `
      <div style="margin-top: 2rem; padding: 1rem; background: var(--bg-subtle); border-radius: 8px;">
        <div style="font-weight: 600; margin-bottom: 1rem;">Breakdown by Category</div>
        <table style="width: 100%; font-size: 0.9rem;">
          <tbody>
            ${Object.entries(breakdown).sort().map(([cat, amt]) => `
              <tr style="border-bottom: 1px solid var(--border-color);">
                <td style="padding: 0.5rem;">${esc(cat)}</td>
                <td style="padding: 0.5rem; text-align: right; font-weight: 600; color: ${amt > 0 ? 'var(--success)' : 'var(--danger)'};">
                  ${amt > 0 ? '+' : ''}${money(amt)}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    const summaryContainer = document.querySelector('[data-kitty-summary]') || document.createElement('div');
    summaryContainer.setAttribute('data-kitty-summary', '');
    summaryContainer.innerHTML = summaryHtml;

    const tableParent = $('kittyTable').parentElement;
    if (!tableParent.querySelector('[data-kitty-summary]')) {
      tableParent.appendChild(summaryContainer);
    } else {
      tableParent.querySelector('[data-kitty-summary]').innerHTML = summaryHtml;
    }
  }
}

export function initKitty() {
  $('kf_date').value = today();

  // Add bulk import button next to form
  const bulkBtn = document.createElement('button');
  bulkBtn.type = 'button';
  bulkBtn.className = 'btn btn-secondary';
  bulkBtn.textContent = '📥 Bulk Import';
  bulkBtn.addEventListener('click', bulkImportModal);
  $('kittyForm').parentElement.appendChild(bulkBtn);

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

function bulkImportModal() {
  openModal('Bulk Import Kitty Entries', `
    <div style="margin-bottom: 1.5rem;">
      <label style="display: block; font-weight: 600; margin-bottom: 0.5rem;">Paste Data (Label + Amount)</label>
      <p class="hint" style="margin: 0 0 0.8rem; font-size: 0.85rem;">
        Positive = Income, Negative = Expense. One per line.
      </p>
      <textarea id="ki_data" placeholder="Abhi Handover&#9;640
Mon/Thu Kitty 2025&#9;1381
Expenses&#9;-5512
..." style="width: 100%; min-height: 200px; padding: 0.8rem; font-family: monospace; font-size: 0.9rem; border: 1px solid var(--border-color); border-radius: 8px;"></textarea>
    </div>
    <button class="btn full-w" id="ki_import">Import</button>`);

  $('ki_import').addEventListener('click', async () => {
    const data = $('ki_data').value;
    if (!data.trim()) { toast('Paste data', true); return; }

    try {
      const result = await api.bulkImportKittyEntries(data);
      closeModal();
      toast(`✓ Imported ${result.imported} Kitty entries`);
      render();
    } catch (e) { toast(e.message, true); }
  });
}

export function loadKitty() { return render(); }
