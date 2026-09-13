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
      <td class="row-actions">${e.historical ? '<span class="tag" style="background: var(--bg-subtle); color: var(--text-muted);" title="Came in with the opening balances — already counted there, so it cannot be edited or removed">📋 Imported</span>'
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
        <div style="font-weight: 600; margin-bottom: 1rem;">Breakdown by category</div>
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

    // Below the ledger but outside its scroll box, like the two panels above it.
    if (!summaryContainer.isConnected) {
      $('kittyTable').closest('.sams-card').appendChild(summaryContainer);
    }
  }
}

export function initKitty() {
  $('kf_date').value = today();

  // Add bulk import button next to form
  const bulkBtn = document.createElement('button');
  bulkBtn.type = 'button';
  bulkBtn.className = 'btn btn-secondary';
  bulkBtn.textContent = '📥 Bulk import';
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
  openModal('Bulk import kitty entries', `
    <div style="margin-bottom: 1.5rem;">
      <label style="display: block; font-weight: 600; margin-bottom: 0.5rem;">Paste data (label + amount)</label>
      <p class="hint" style="margin: 0 0 0.8rem; font-size: 0.85rem;">
        Positive is income, negative is expense. One per line.
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
      toast(`✓ Imported ${result.imported} kitty entries`);
      render();
    } catch (e) { toast(e.message, true); }
  });
}

// === MODULAR KITTY ACTIONS ===

// Money the club is waiting on, which arrives in two different shapes.
//
// A member in the red owes a top-up: their balance is short and they pay it in
// as a contribution. A guest owes cash for a game they played — they keep no
// balance to be short, so they used to appear here only because settling up
// pushed them negative, and after that correction they would not appear at all.
// cash_owed is what they actually owe.
async function getPendingCollections() {
  try {
    // Two sources, because the two kinds of debt live in different places. A
    // member in the red is a ledger fact. Guest cash is a charge fact — and has
    // to be, now that a guest who keeps no balance is given no ledger row at
    // all. Reading only ledgers would have quietly lost them.
    const [ledgers, cash] = await Promise.all([api.ledgers(), api.cashOutstanding()]);
    const topups = (ledgers || [])
      // The cashier is not a debtor. Their balance falls as they play because
      // they put the money in up front and take the fees back in — the club
      // owes them, not the reverse — so listing them here asked the cashier to
      // chase themselves, and for the largest figure on the page.
      .filter(l => l.present_balance < 0 && l.player_type !== 'outside'
        && l.special_role !== 'cashier')
      .map(l => ({ player_id: l.player_id, player_name: l.player_name,
        contract_id: l.contract_id, contract_name: l.contract_name,
        owes: -l.present_balance, kind: 'topup' }));
    const guests = (cash || []).map(c => ({ player_id: c.player_id,
      player_name: c.player_name || 'Guest', owes: c.owed, kind: 'cash' }));
    return [...topups, ...guests].sort((a, b) => b.owes - a.owes);
  } catch (e) {
    console.error('Failed to get pending collections:', e);
    return [];
  }
}

/**
 * A member has handed over their top-up. Record it where it actually goes.
 *
 * This used to write a free-standing KITTY INCOME row and nothing else, which
 * was wrong twice over:
 *
 *   - Wrong destination. A top-up is not profit. The member is refilling the
 *     balance the cashier funded up front, so the money goes back to the
 *     cashier's float. The kitty is only where profit and loss flow — the
 *     surplus or shortfall on a game, and what the club spends. Money that
 *     merely passes through on its way to restoring a balance never touches it.
 *   - The debt survived. Nothing credited the member, so after "committing" 409
 *     from Jeetu the kitty was 409 richer, Jeetu still owed 409, and the two
 *     numbers had no relationship to each other or to anything that happened.
 *
 * So it records a contribution on the contract the balance is short on, which
 * credits the member and leaves the kitty alone. Nobody had pressed the old
 * button — production carries no such kitty row — so there is nothing to undo.
 */
async function recordTopUp(playerId, contractId, amount, playerName) {
  try {
    await api.createContribution({
      player_id: playerId,
      contract_id: contractId,
      amount,
      date: today(),
      comments: 'Top-up collected',
    });
    toast(`✓ ${money(amount)} added to ${playerName || 'their'} balance`, false);
    render();
    return true;
  } catch (e) {
    toast(`Could not record it: ${e.message}`, true);
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

  const totalOwed = pending.reduce((s, l) => s + l.owes, 0);

  const html = `
    <div class="panel panel-warn">
      <div class="panel-title">💰 Still to collect</div>
      <div class="panel-body">
        <strong>${pending.length}</strong> to chase, <strong>${money(totalOwed)}</strong> in all.
        A top-up goes back to the cashier's float, not into the kitty.
      </div>
      <div class="panel-scroll">
        ${pending.map(p => `
          <div class="panel-row">
            <strong>${esc(p.player_name)}</strong>
            <span class="hint">${esc(p.contract_name || '')}</span>
            <span class="bal neg">${money(p.owes)}</span>
            ${p.kind === 'cash'
    // Marking the charge collected in Game History is what banks a guest's
    // cash, and it credits the kitty on its own. Offering a commit button
    // here as well would put the same 35 in the pot twice.
    ? '<span class="hint">mark collected in Game history</span>'
    : `<button class="btn btn-sm" data-topup="${p.player_id}" data-contract="${esc(p.contract_id)}"
        data-amount="${p.owes}" data-name="${esc(p.player_name)}"
        title="Record the top-up on their balance — this does not touch the kitty">Mark paid</button>`}
          </div>
        `).join('')}
      </div>
    </div>
  `;

  const container = document.querySelector('[data-pending-collections]') || document.createElement('div');
  container.setAttribute('data-pending-collections', '');
  container.innerHTML = html;

  // The mount point lives in index.html, above the ledger and outside its
  // scroll box. Inserting it beside the table put this control inside the
  // horizontal scroller, where it slid away with the columns.
  if (!container.isConnected) {
    $('kittyTable').closest('.sams-card').insertBefore(
      container, $('kittyTable').closest('.table-scroll'));
  }

  // Recording a top-up credits a balance, so it is worth a confirmation — the
  // amount is whatever they were short, and that is not always what they handed
  // over. Anything else belongs on the Contributions screen, where a partial
  // payment can be typed in.
  document.querySelectorAll('[data-topup]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { topup, contract, amount, name } = btn.dataset;
      const amt = Number(amount);
      if (!confirm(`Record ${money(amt)} from ${name}?\n\n`
        + `It is added to their balance and clears what they owe. `
        + `The kitty is not affected.\n\n`
        + `If they paid a different amount, use Contributions instead.`)) return;
      await recordTopUp(topup, contract, amt, name);
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

  // The mount point lives in index.html, above the ledger and outside its
  // scroll box. Inserting it beside the table put this control inside the
  // horizontal scroller, where it slid away with the columns.
  if (!container.isConnected) {
    $('kittyTable').closest('.sams-card').insertBefore(
      container, $('kittyTable').closest('.table-scroll'));
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
