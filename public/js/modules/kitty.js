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
    <tr style="${e.historical ? 'opacity: 0.65; background-color: var(--bg-subtle);' : ''}">
      <td class="num">${esc(fmtDate(e.date))}</td>
      <td><span class="tag ${e.kind === 'income' ? 'tag-paid' : 'tag-overdue'}">${e.kind}</span></td>
      <td>${esc(e.label)}</td>
      <td class="num">${e.kind === 'income' ? balCell(e.amount) : `<span class="bal neg">-${money(e.amount)}</span>`}</td>
      <td class="row-actions">${e.historical ? '<span class="tag" style="background: var(--bg-subtle); color: var(--text-muted);">📋 Seed</span>'
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

// === MODULAR KITTY ACTIONS ===

// Get pending collections (players with negative balances)
async function getPendingCollections() {
  try {
    const ledgers = await api.ledgers();
    const negative = ledgers.filter(l => l.present_balance < 0);
    return negative.sort((a, b) => a.present_balance - b.present_balance); // most owed first
  } catch (e) {
    console.error('Failed to get pending collections:', e);
    return [];
  }
}

// Quick commit: Move collected amount from player to kitty
async function quickCommitToKitty(playerId, amount, label) {
  try {
    const finalLabel = label || `Collected from ${playerId}`;
    await api.createKitty({
      kind: 'income',
      amount: amount,
      label: finalLabel,
      date: today(),
    });
    toast(`✓ Committed ${money(amount)} to kitty`, false);
    render();
    return true;
  } catch (e) {
    toast(`Failed to commit: ${e.message}`, true);
    return false;
  }
}

// Quick withdraw: Take from kitty for immediate expense
async function quickWithdrawFromKitty(amount, label, reason) {
  try {
    const finalLabel = label || `Expense: ${reason || 'Withdrawal'}`;
    await api.createKitty({
      kind: 'expense',
      amount: amount,
      label: finalLabel,
      date: today(),
    });
    toast(`✓ Withdrawn ${money(amount)} from kitty`, false);
    render();
    return true;
  } catch (e) {
    toast(`Failed to withdraw: ${e.message}`, true);
    return false;
  }
}

// Render pending collections panel
async function renderPendingCollections() {
  const pending = await getPendingCollections();
  if (!pending.length) return;

  const totalOwed = pending.reduce((s, l) => s + Math.abs(l.present_balance), 0);

  const html = `
    <div class="panel panel-warn">
      <div class="panel-title">💰 Pending Collections</div>
      <div class="panel-body">
        <strong>${pending.length}</strong> players owe <strong>${money(totalOwed)}</strong> total
      </div>
      <div class="panel-scroll">
        ${pending.map(p => `
          <div class="panel-row">
            <strong>${esc(p.player_name)}</strong>
            <span class="bal neg">${money(Math.abs(p.present_balance))}</span>
            <button class="btn btn-sm" data-quick-commit="${p.player_id}" data-amount="${Math.abs(p.present_balance)}" title="Quick commit this amount to kitty">✓ Commit</button>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  const container = document.querySelector('[data-pending-collections]') || document.createElement('div');
  container.setAttribute('data-pending-collections', '');
  container.innerHTML = html;

  const tableParent = $('kittyTable').parentElement;
  if (!tableParent.querySelector('[data-pending-collections]')) {
    tableParent.insertBefore(container, $('kittyTable'));
  } else {
    tableParent.querySelector('[data-pending-collections]').innerHTML = html;
  }

  // Attach event listeners for quick commit buttons
  document.querySelectorAll('[data-quick-commit]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const playerId = btn.dataset.quickCommit;
      const amount = Number(btn.dataset.amount);
      await quickCommitToKitty(playerId, amount);
    });
  });
}

// Render quick withdraw panel
function renderQuickWithdraw() {
  const html = `
    <div class="panel panel-danger">
      <div class="panel-title">⚡ Quick Withdraw</div>
      <div class="quick-row">
        ${[50, 100, 200, 500].map(amt => `
          <button class="btn btn-sm" data-quick-withdraw="${amt}">- ${money(amt)}</button>
        `).join('')}
        <input type="number" id="qw_custom" class="qw-amount" placeholder="Custom…">
        <input type="text" id="qw_reason" class="qw-reason" placeholder="Reason…">
        <button class="btn btn-secondary btn-sm" id="qw_submit">Go</button>
      </div>
    </div>
  `;

  const container = document.querySelector('[data-quick-withdraw]') || document.createElement('div');
  container.setAttribute('data-quick-withdraw', '');
  container.innerHTML = html;

  const tableParent = $('kittyTable').parentElement;
  if (!tableParent.querySelector('[data-quick-withdraw]')) {
    tableParent.insertBefore(container, $('kittyTable'));
  } else {
    tableParent.querySelector('[data-quick-withdraw]').innerHTML = html;
  }

  // Quick withdraw button handlers
  document.querySelectorAll('[data-quick-withdraw]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const amount = Number(btn.dataset.quickWithdraw);
      const reason = $('qw_reason')?.value || 'Quick expense';
      await quickWithdrawFromKitty(amount, reason, reason);
    });
  });

  // Custom amount + reason
  $('qw_submit').addEventListener('click', async () => {
    const amount = Number($('qw_custom').value || 0);
    const reason = $('qw_reason')?.value || 'Withdrawal';
    if (amount <= 0) { toast('Enter amount', true); return; }
    await quickWithdrawFromKitty(amount, reason, reason);
    $('qw_custom').value = '';
    $('qw_reason').value = '';
  });
}

export function loadKitty() {
  render();
  renderPendingCollections();
  renderQuickWithdraw();
}
