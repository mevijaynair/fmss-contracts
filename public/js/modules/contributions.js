// contributions.js — role-aware contributions view.
//  • Admin: direct "Add Contribution" + a Pending Approvals queue + full log.
//  • Player: self-service "Submit Contribution" (→ pending) + their own history.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money, balCell, fmtDate, today } from '../util.js';

function contractName(id) {
  return store.contracts.find(c => c.id === id)?.name.split(' ')[0] || (id || '—');
}

function isPlayer() { return store.user?.role === 'player'; }

// ---------------------------------------------------------------- ADMIN view

function fillSelects() {
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
    <tr style="${c.historical ? 'opacity: 0.65; background-color: var(--bg-subtle);' : ''}">
      <td class="num">${esc(fmtDate(c.date))}</td>
      <td>${esc(c.player_name || c.name_raw || '—')}</td>
      <td>${esc(contractName(c.contract_id))}</td>
      <td class="num">${balCell(c.amount)}</td>
      <td>${esc(c.comments || '')}</td>
      <td class="row-actions">${c.historical ? '<span class="tag" style="background: var(--bg-muted); color: var(--text-muted);">📋 Seed</span>'
        : `<button class="link-btn" data-del="${c.id}">✕</button>`}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="hint">No contributions.</td></tr>';

  $('contribTable').querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', async () => {
      try { await api.deleteContribution(b.dataset.del); toast('Removed'); renderLog(); }
      catch (e) { toast(e.message, true); }
    }));
}

// Pending approvals queue (admin only). Injected above the log card.
async function renderPendingApprovals() {
  let card = $('pendingApprovalsCard');
  if (!card) {
    card = document.createElement('div');
    card.className = 'sams-card';
    card.id = 'pendingApprovalsCard';
    const view = document.querySelector('[data-view="contributions"]');
    view.insertBefore(card, view.children[1]);  // after the Add form, before the log
  }

  const pending = await api.pendingContributions();

  // If no pending, hide the card entirely
  if (pending.length === 0) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  card.innerHTML = `
    <div class="card-header"><h3 class="card-title">Pending Approvals</h3>
      <span class="card-sub">${pending.length} awaiting review</span></div>
    <div style="overflow-x:auto;">
      <table class="sams-table">
        <thead><tr><th>Date</th><th>Player</th><th>Contract</th><th class="num">Amount</th><th>Method</th><th></th></tr></thead>
        <tbody>${pending.map(p => `
          <tr>
            <td class="num">${esc(fmtDate(p.date))}</td>
            <td>${esc(p.player_name || '—')}</td>
            <td>${esc(contractName(p.contract_id))}</td>
            <td class="num">${money(p.amount)}</td>
            <td><span class="tag">${esc(p.payment_method)}</span></td>
            <td class="row-actions" style="white-space:nowrap;">
              <button class="btn btn-sm" data-approve="${p.id}">✓ Approve</button>
              <button class="btn btn-secondary btn-sm" data-reject="${p.id}">✕ Reject</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  card.querySelectorAll('[data-approve]').forEach(b =>
    b.addEventListener('click', async () => {
      try { await api.approveContribution(b.dataset.approve); toast('Approved ✓'); refreshAdmin(); }
      catch (e) { toast(e.message, true); }
    }));
  card.querySelectorAll('[data-reject]').forEach(b =>
    b.addEventListener('click', async () => {
      try { await api.rejectContribution(b.dataset.reject); toast('Rejected'); refreshAdmin(); }
      catch (e) { toast(e.message, true); }
    }));
}

function refreshAdmin() { renderPendingApprovals(); renderLog(); }

function initAdmin() {
  $('cf_date').value = today();

  // Add split allocation UI
  const splitBtn = document.createElement('button');
  splitBtn.type = 'button';
  splitBtn.className = 'btn btn-secondary btn-sm';
  splitBtn.textContent = '🔀 Split across contracts';
  splitBtn.style.marginTop = '1rem';

  const contribForm = $('contribForm');
  contribForm.appendChild(splitBtn);

  let showingSplit = false;
  splitBtn.addEventListener('click', () => {
    showingSplit = !showingSplit;
    let splitDiv = document.getElementById('splitAllocationDiv');
    if (showingSplit && !splitDiv) {
      splitDiv = document.createElement('div');
      splitDiv.id = 'splitAllocationDiv';
      splitDiv.innerHTML = `
        <div style="margin-top: 1.5rem; padding: 1rem; background: var(--bg-subtle); border-radius: 8px; border-left: 4px solid var(--accent);">
          <div style="font-weight: 600; margin-bottom: 1rem; color: var(--accent);">Split this payment across contracts</div>
          <div id="splitRows" style="display: grid; gap: 0.8rem;"></div>
          <button type="button" class="btn btn-secondary btn-sm" id="addSplitBtn" style="margin-top: 0.8rem;">+ Add contract</button>
          <div style="margin-top: 1rem; padding: 0.8rem; background: var(--bg-alt); border-radius: 6px; font-size: 0.9rem;">
            <div>Total amount: <strong id="splitTotal">0</strong> AED</div>
            <div>Form amount: <strong id="splitFormAmount">0</strong> AED</div>
            <div id="splitMatch" style="color: var(--danger); display: none;">⚠️ Split totals must equal form amount</div>
          </div>
        </div>`;
      contribForm.appendChild(splitDiv);
      renderSplitRows();
    } else if (splitDiv) {
      splitDiv.style.display = showingSplit ? 'block' : 'none';
    }
    splitBtn.textContent = showingSplit ? '✕ Close split' : '🔀 Split across contracts';
  });

  $('contribForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const playerId = $('cf_player').value || null;
    const totalAmount = Number($('cf_amount').value) || 0;
    const date = $('cf_date').value;
    const comments = $('cf_comments').value;

    // Check if split is active
    const splitDiv = document.getElementById('splitAllocationDiv');
    const usingSplit = splitDiv && splitDiv.style.display !== 'none';

    if (usingSplit) {
      const splits = Array.from(document.querySelectorAll('[data-split-contract]')).map(row => ({
        contract_id: row.querySelector('[data-split-contract]').value,
        amount: Number(row.querySelector('[data-split-amount]').value) || 0,
      }));

      const splitTotal = splits.reduce((s, x) => s + x.amount, 0);
      if (Math.abs(splitTotal - totalAmount) > 0.01) {
        toast('Split amounts must equal total', true);
        return;
      }

      try {
        for (const split of splits) {
          await api.createContribution({
            player_id: playerId,
            contract_id: split.contract_id,
            amount: split.amount,
            date, comments: comments ? `${comments} (split from total)` : 'Split contribution',
          });
        }
        toast('Split contribution added ✓');
        $('cf_amount').value = ''; $('cf_comments').value = '';
        renderLog();
      } catch (err) { toast(err.message, true); }
    } else {
      try {
        await api.createContribution({
          player_id: playerId,
          contract_id: $('cf_contract').value,
          amount: totalAmount,
          date, comments,
        });
        toast('Contribution added ✓');
        $('cf_amount').value = ''; $('cf_comments').value = '';
        renderLog();
      } catch (err) { toast(err.message, true); }
    }
  });
  $('contribFilter').addEventListener('change', renderLog);
}

function renderSplitRows() {
  const rows = document.getElementById('splitRows');
  const addBtn = document.getElementById('addSplitBtn');
  if (!rows || !addBtn) return;

  const currentSplits = Array.from(document.querySelectorAll('[data-split-contract]')).length;
  if (currentSplits === 0) {
    store.contracts.forEach(c => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '0.5rem';
      row.style.alignItems = 'flex-end';
      row.innerHTML = `
        <select data-split-contract style="flex: 2; padding: 0.5rem; border: 1px solid var(--border-color); border-radius: 4px;">
          ${store.contracts.map(x => `<option value="${x.id}" ${x.id === c.id ? 'selected' : ''}>${x.name}</option>`).join('')}
        </select>
        <input type="number" data-split-amount step="1" placeholder="0" style="flex: 1; padding: 0.5rem; border: 1px solid var(--border-color); border-radius: 4px;">
        <button type="button" class="btn btn-secondary btn-sm" style="padding: 0.5rem 0.8rem;" onclick="this.parentElement.remove(); updateSplitTotal();">✕</button>`;
      rows.appendChild(row);

      row.querySelector('[data-split-amount]').addEventListener('input', updateSplitTotal);
      row.querySelector('[data-split-contract]').addEventListener('change', updateSplitTotal);
    });
  }

  addBtn.onclick = () => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '0.5rem';
    row.style.alignItems = 'flex-end';
    row.innerHTML = `
      <select data-split-contract style="flex: 2; padding: 0.5rem; border: 1px solid var(--border-color); border-radius: 4px;">
        ${store.contracts.map(x => `<option value="${x.id}">${x.name}</option>`).join('')}
      </select>
      <input type="number" data-split-amount step="1" placeholder="0" style="flex: 1; padding: 0.5rem; border: 1px solid var(--border-color); border-radius: 4px;">
      <button type="button" class="btn btn-secondary btn-sm" style="padding: 0.5rem 0.8rem;" onclick="this.parentElement.remove(); updateSplitTotal();">✕</button>`;
    rows.appendChild(row);

    row.querySelector('[data-split-amount]').addEventListener('input', updateSplitTotal);
    row.querySelector('[data-split-contract]').addEventListener('change', updateSplitTotal);
  };
}

function updateSplitTotal() {
  const splits = Array.from(document.querySelectorAll('[data-split-amount]')).map(x => Number(x.value) || 0);
  const splitTotal = splits.reduce((s, x) => s + x, 0);
  const formAmount = Number($('cf_amount').value) || 0;

  const totalEl = document.getElementById('splitTotal');
  const formEl = document.getElementById('splitFormAmount');
  const matchEl = document.getElementById('splitMatch');

  if (totalEl) totalEl.textContent = splitTotal.toFixed(2);
  if (formEl) formEl.textContent = formAmount.toFixed(2);
  if (matchEl) matchEl.style.display = Math.abs(splitTotal - formAmount) > 0.01 ? 'block' : 'none';
}

// --------------------------------------------------------------- PLAYER view

let playerInited = false;

function rebuildPlayerUI() {
  const view = document.querySelector('[data-view="contributions"]');
  view.innerHTML = `
    <div class="sams-card">
      <div class="card-header"><h3 class="card-title">Submit a Contribution</h3>
        <span class="card-sub">Your submission is reviewed by the cashier before it lands on your balance</span></div>
      <form id="myContribForm">
        <div class="form-row">
          <div class="form-group"><label>Contract</label><select id="mcf_contract"></select></div>
          <div class="form-group"><label>Amount (AED)</label><input type="number" id="mcf_amount" step="1" placeholder="300"></div>
        </div>
        <div class="form-row mt">
          <div class="form-group"><label>Payment method</label>
            <select id="mcf_method">
              <option value="cash">Cash</option>
              <option value="bank">Bank deposit</option>
              <option value="transfer">Bank transfer</option>
            </select></div>
          <div class="form-group"><label>Date paid</label><input type="date" id="mcf_date"></div>
        </div>
        <button type="submit" class="btn mt">Submit for approval</button>
      </form>
    </div>
    <div class="sams-card">
      <div class="card-header"><h3 class="card-title">My Contributions</h3>
        <span class="card-sub">Pending submissions + approved payments</span></div>
      <div style="overflow-x:auto;">
        <table class="sams-table" id="myContribTable">
          <thead><tr><th>Date</th><th>Contract</th><th class="num">Amount</th><th>Method</th><th>Status</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>`;

  $('mcf_contract').innerHTML = store.contracts.map(c =>
    `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('mcf_date').value = today();

  $('myContribForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = Number($('mcf_amount').value) || 0;
    if (amount <= 0) { toast('Enter a positive amount', true); return; }
    try {
      await api.submitContribution({
        contract_id: $('mcf_contract').value,
        amount,
        payment_method: $('mcf_method').value,
        date: $('mcf_date').value,
      });
      toast('Submitted for approval ✓');
      $('mcf_amount').value = '';
      renderMyContributions();
    } catch (err) { toast(err.message, true); }
  });
}

const STATUS_TAG = {
  pending: '<span class="tag tag-due">⏳ Pending</span>',
  rejected: '<span class="tag tag-overdue">✕ Rejected</span>',
  approved: '<span class="tag tag-paid">✓ Approved</span>',
};

async function renderMyContributions() {
  const { approved, pending } = await api.myContributions();

  // Merge: pending/rejected submissions + approved live rows. Approved live rows
  // come from the contributions table; the matching pending row is also marked
  // approved, so to avoid double-listing we show pending(non-approved) + approved.
  const pendingRows = pending
    .filter(p => p.status !== 'approved')
    .map(p => ({
      date: p.date, contract_id: p.contract_id, amount: p.amount,
      method: p.payment_method, status: p.status,
    }));
  const approvedRows = approved.map(c => ({
    date: c.date, contract_id: c.contract_id, amount: c.amount,
    method: '—', status: 'approved',
  }));

  const all = [...pendingRows, ...approvedRows]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  $('myContribTable').querySelector('tbody').innerHTML = all.map(rw => `
    <tr>
      <td class="num">${esc(fmtDate(rw.date))}</td>
      <td>${esc(contractName(rw.contract_id))}</td>
      <td class="num">${money(rw.amount)}</td>
      <td>${rw.method === '—' ? '—' : `<span class="tag">${esc(rw.method)}</span>`}</td>
      <td>${STATUS_TAG[rw.status] || esc(rw.status)}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="hint">No contributions yet.</td></tr>';
}

// ------------------------------------------------------------------- exports

export function initContributions() {
  if (isPlayer()) return;   // player UI is built lazily on first load
  initAdmin();
}

export function loadContributions() {
  if (isPlayer()) {
    if (!playerInited) { rebuildPlayerUI(); playerInited = true; }
    return renderMyContributions();
  }
  fillSelects();
  return Promise.all([renderPendingApprovals(), renderLog()]);
}
