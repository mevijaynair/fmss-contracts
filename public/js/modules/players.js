// players.js — per-contract ledger table + add player + timeline & stats detail.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money, balCell, contractSeg, openModal, closeModal, today } from '../util.js';
import { initOpeningBalances, loadOpeningBalances } from './opening_balances.js';

let contractId = 'sat';
let currentDetailPlayerId = null;
let searchQuery = '';
let sortBy = 'name';
let filterStatus = 'all';
let filterBalance = 'all';

const STATUSES = ['In Contract', 'Refill needed', 'Out of contract'];

function isPlayer() { return store.user?.role === 'player'; }

// Auto-calculate status based on balance + color
function statusFromBalance(balance) {
  if (balance < 0) return {
    text: '🚨 Out of contract',
    cls: 'tag-danger',
    style: 'font-weight: 700; background: linear-gradient(135deg, #d32f2f 0%, #c62828 100%); color: white; padding: 0.5rem 0.75rem; border-radius: 4px;'
  };
  if (balance < 150) return {
    text: '⚠️ Refill needed',
    cls: 'tag-overdue',
    style: 'font-weight: 600; background: #ff9800; color: white; padding: 0.4rem 0.6rem; border-radius: 4px;'
  };
  return {
    text: '✓ In Contract',
    cls: 'tag-paid',
    style: 'font-weight: 600; background: #4caf50; color: white; padding: 0.4rem 0.6rem; border-radius: 4px;'
  };
}

async function render() {
  if (isPlayer()) return renderPlayerLedger();

  const ledgers = await api.ledgers(contractId);
  const roleOf = Object.fromEntries(store.players.map(p => [p.id, p.special_role]));

  // Filter
  let filtered = ledgers.filter(l => {
    // Exclude test players by ID or name pattern
    const testPatterns = ['test', 'fixtestplayer', 'newtestplayer', 'testplayer999'];
    const isTestPlayer = testPatterns.some(p =>
      l.player_id.toLowerCase().includes(p.toLowerCase()) ||
      l.player_name.toLowerCase().includes(p.toLowerCase())
    );
    if (isTestPlayer) return false;
    // Search by name
    if (searchQuery && !l.player_name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    // Filter by status
    if (filterStatus !== 'all' && l.status?.toLowerCase() !== filterStatus.toLowerCase()) return false;
    // Filter by balance
    if (filterBalance === 'positive' && l.present_balance <= 0) return false;
    if (filterBalance === 'negative' && l.present_balance >= 0) return false;
    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    if (sortBy === 'name') return a.player_name.localeCompare(b.player_name);
    if (sortBy === 'balance') return b.present_balance - a.present_balance;
    if (sortBy === 'status') return (a.status || '').localeCompare(b.status || '');
    if (sortBy === 'games') return b.games - a.games;
    return 0;
  });

  // View context header
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const contextHtml = `<div style="margin-bottom: 1rem; padding: 0.75rem; background: var(--bg-subtle); border-radius: 6px; font-size: 0.9rem; color: var(--text-muted);">📅 View as of <strong>${today}</strong> • Last incoming & Last played shown in detail view</div>`;

  // Render controls
  const controlsPanel = document.querySelector('[data-player-controls]') || document.createElement('div');
  controlsPanel.setAttribute('data-player-controls', '');
  controlsPanel.style.cssText = 'display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 1rem; margin-bottom: 1rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border-color);';
  controlsPanel.innerHTML = `
    <input type="text" id="pl_search" placeholder="🔍 Search by name..." style="padding: 0.5rem; border: 1px solid var(--border-color); border-radius: 6px;" value="${searchQuery}">
    <select id="pl_sort" style="padding: 0.5rem; border: 1px solid var(--border-color); border-radius: 6px;">
      <option value="name" ${sortBy === 'name' ? 'selected' : ''}>Sort: Name</option>
      <option value="balance" ${sortBy === 'balance' ? 'selected' : ''}>Sort: Balance</option>
      <option value="status" ${sortBy === 'status' ? 'selected' : ''}>Sort: Status</option>
      <option value="games" ${sortBy === 'games' ? 'selected' : ''}>Sort: Games</option>
    </select>
    <select id="pl_filter_status" style="padding: 0.5rem; border: 1px solid var(--border-color); border-radius: 6px;">
      <option value="all" ${filterStatus === 'all' ? 'selected' : ''}>Status: All</option>
      <option value="in contract" ${filterStatus === 'in contract' ? 'selected' : ''}>Status: In Contract</option>
      <option value="out of contract" ${filterStatus === 'out of contract' ? 'selected' : ''}>Status: Out</option>
    </select>
    <select id="pl_filter_balance" style="padding: 0.5rem; border: 1px solid var(--border-color); border-radius: 6px;">
      <option value="all" ${filterBalance === 'all' ? 'selected' : ''}>Balance: All</option>
      <option value="positive" ${filterBalance === 'positive' ? 'selected' : ''}>Balance: Positive</option>
      <option value="negative" ${filterBalance === 'negative' ? 'selected' : ''}>Balance: Negative</option>
    </select>
  `;

  const tableContainer = $('playersTable').parentElement;
  const contextPanel = document.querySelector('[data-player-context]') || document.createElement('div');
  contextPanel.setAttribute('data-player-context', '');
  contextPanel.innerHTML = contextHtml;

  if (!tableContainer.querySelector('[data-player-context]')) {
    tableContainer.insertBefore(contextPanel, $('playersTable'));
  } else {
    tableContainer.querySelector('[data-player-context]').innerHTML = contextHtml;
  }

  if (!tableContainer.querySelector('[data-player-controls]')) {
    tableContainer.insertBefore(controlsPanel, $('playersTable'));
  } else {
    Object.assign(tableContainer.querySelector('[data-player-controls]'), controlsPanel);
    tableContainer.querySelector('[data-player-controls]').innerHTML = controlsPanel.innerHTML;
  }

  // Add event listeners
  const updateRender = () => render();
  $('pl_search').addEventListener('input', (e) => { searchQuery = e.target.value; updateRender(); });
  $('pl_sort').addEventListener('change', (e) => { sortBy = e.target.value; updateRender(); });
  $('pl_filter_status').addEventListener('change', (e) => { filterStatus = e.target.value; updateRender(); });
  $('pl_filter_balance').addEventListener('change', (e) => { filterBalance = e.target.value; updateRender(); });

  // Fetch last transaction for each player
  const lastTransactionMap = {};
  await Promise.all(filtered.map(async l => {
    try {
      const txns = await api.playerTransactions(l.player_id, 1);
      if (txns && txns.length > 0) {
        lastTransactionMap[l.player_id] = txns[0];
      }
    } catch (e) {
      console.error(`Failed to load transactions for ${l.player_id}:`, e);
    }
  }));

  // Render as clean card grid instead of cluttered table
  const cardsHtml = filtered.map(l => {
    const isCashier = roleOf[l.player_id] === 'cashier';
    const status = statusFromBalance(l.present_balance);
    const lastTxn = lastTransactionMap[l.player_id];
    let lastTxnHtml = '<span class="hint">—</span>';
    if (lastTxn) {
      const isPositive = lastTxn.amount > 0;
      const emoji = isPositive ? '🟢' : '🔴';
      const sign = isPositive ? '+' : '';
      const dateStr = lastTxn.date?.split('T')[0] || '';
      const dateObj = new Date(dateStr);
      const formattedDate = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      lastTxnHtml = `<span style="white-space: nowrap;">${emoji} ${sign}${money(Math.abs(lastTxn.amount))} • ${formattedDate}</span>`;
    }

    const rowBg = l.present_balance < 0 ? 'background: rgba(255, 67, 54, 0.08);' : '';
    return `
    <tr style="border-left: 4px solid ${l.present_balance < 0 ? '#d32f2f' : 'transparent'}; ${rowBg}">
      <td><strong onclick="window.showPlayerDetail('${l.player_id}')" style="cursor: pointer; color: var(--sport);">${esc(l.player_name)}</strong>${isCashier ? ' <span class="tag tag-cashier" title="Cashier — excluded from contributions">💰 Cashier</span>' : ''}</td>
      <td><span class="tag ${status.cls}" ${status.style ? 'style="' + status.style + '"' : ''}>${status.text}</span></td>
      <td class="num">${money(l.opening_balance)}</td>
      <td class="num">${money(l.contributed)}</td>
      <td class="num"><span style="color: ${l.charged > 0 ? '#d32f2f' : 'var(--text-muted)'}; font-weight: 500; font-size: 0.9rem;">-${money(l.charged)}</span></td>
      <td class="num">${balCell(l.present_balance)}</td>
      <td class="row-actions">
        ${isCashier ? '<span class="hint">no contributions</span>'
          : `<button class="btn btn-secondary btn-sm" data-pay="${l.player_id}">+ Pay</button>`}
        <button class="btn btn-sm" data-menu="${l.player_id}" title="More options" style="font-size: 1rem; padding: 0.3rem 0.4rem; min-width: auto;">⋮</button>
      </td>
      <td style="display: none;" data-actions="${l.player_id}">
        <button class="btn btn-sm" data-reset="${l.player_id}" title="Clear contributions, keep charges" style="opacity: 0.6; font-size: 0.8rem; padding: 0.3rem 0.5rem; margin-right: 0.25rem;">↺ Reset</button>
        <button class="btn btn-sm" data-delete="${l.player_id}" title="Permanently remove player" style="opacity: 0.5; font-size: 0.8rem; padding: 0.3rem 0.5rem; color: var(--danger);">✕ Delete</button>
      </td>
    </tr>`; }).join('') || '<tr><td colspan="9" class="hint">No players in this contract yet.</td></tr>';

  $('playersTable').querySelectorAll('[data-pay]').forEach(btn =>
    btn.addEventListener('click', () => payModal(btn.dataset.pay)));

  // Menu button (⋮) toggles Reset/Delete visibility
  $('playersTable').querySelectorAll('[data-menu]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const playerId = btn.dataset.menu;
      const actionsCell = $('playersTable').querySelector(`[data-actions="${playerId}"]`);
      const isVisible = actionsCell.style.display !== 'none';
      actionsCell.style.display = isVisible ? 'none' : 'table-cell';
    });
  });

  // Close menu when clicking elsewhere
  document.addEventListener('click', () => {
    $('playersTable').querySelectorAll('[data-actions]').forEach(cell => {
      cell.style.display = 'none';
    });
  });

  $('playersTable').querySelectorAll('[data-reset]').forEach(btn =>
    btn.addEventListener('click', () => resetPlayerModal(btn.dataset.reset)));
  $('playersTable').querySelectorAll('[data-delete]').forEach(btn =>
    btn.addEventListener('click', () => deletePlayerModal(btn.dataset.delete)));
}

// Player "My Ledger": their own balances across all contracts (read-only), and
// clicking a contract row opens their timeline for that contract.
async function renderPlayerLedger() {
  const ledgers = await api.myLedgers();
  $('playersTable').querySelector('tbody').innerHTML = ledgers.map(l => `
    <tr>
      <td><strong onclick="window.showPlayerDetailFor('${l.player_id}','${l.contract_id}')" style="cursor:pointer; color:var(--sport);">${esc(contractLabel(l.contract_id))}</strong></td>
      <td>${esc(l.status || '—')}</td>
      <td class="num">${money(l.opening_balance)}</td>
      <td class="num">${money(l.contributed)}</td>
      <td class="num">${money(l.charged)}</td>
      <td class="num">${balCell(l.present_balance)}</td>
      <td>${l.games}</td>
      <td class="row-actions"></td>
    </tr>`).join('') || '<tr><td colspan="8" class="hint">No contracts yet.</td></tr>';
}

function contractLabel(id) {
  return store.contracts.find(c => c.id === id)?.name || id;
}

// Player-scoped detail: load own stats for a specific contract.
window.showPlayerDetailFor = async (playerId, cId) => {
  try {
    const stats = await api.get(`/players/${playerId}/stats?contract_id=${cId}`);
    const player = { id: playerId, name: store.user?.email || 'My account' };
    const prevContract = contractId;
    contractId = cId;  // so renderPlayerDetail's contract lookup resolves
    await renderPlayerDetail(player, stats);
    contractId = prevContract;
  } catch (e) {
    toast(`Failed to load stats: ${e.message}`, true);
  }
};

window.showPlayerDetail = async (playerId) => {
  try {
    const stats = await api.get(`/players/${playerId}/stats?contract_id=${contractId}`);
    const player = store.players.find(p => p.id === playerId);
    await renderPlayerDetail(player, stats);
  } catch (e) {
    toast(`Failed to load player stats: ${e.message}`, true);
  }
};

// Render audit trail (grouped by date with color coding)
function renderAuditTrail(transactions) {
  if (!transactions || transactions.length === 0) {
    return '<div class="hint">No transactions yet.</div>';
  }

  // Group transactions by date
  const grouped = {};
  transactions.forEach(t => {
    const dateStr = t.date?.split('T')[0] || 'Unknown';
    if (!grouped[dateStr]) {
      grouped[dateStr] = [];
    }
    grouped[dateStr].push(t);
  });

  // Sort dates descending
  const sortedDates = Object.keys(grouped).sort().reverse();

  let html = '<div style="font-size: 0.9rem;">';

  sortedDates.forEach(dateStr => {
    const items = grouped[dateStr];
    const totalAmount = items.reduce((sum, t) => sum + (t.amount || 0), 0);
    const hasPositive = items.some(t => t.amount > 0);
    const hasNegative = items.some(t => t.amount < 0);

    const dateObj = new Date(dateStr);
    const formattedDate = dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

    if (items.length === 1) {
      const t = items[0];
      const typeLabel = t.type === 'contribution' ? 'Contribution'
        : t.type === 'event_deduction' ? (t.event_title || 'Event Deduction')
        : t.type === 'charge' ? 'Game Charge'
        : t.type === 'transfer_out' ? 'Transfer Out'
        : t.type === 'transfer_in' ? 'Transfer In'
        : 'Transaction';
      const isPositive = t.amount > 0;
      const emoji = isPositive ? '🟢' : '🔴';
      const sign = isPositive ? '+' : '';
      const color = isPositive ? 'var(--success)' : 'var(--danger)';

      html += `
        <div style="padding: 0.75rem; margin-bottom: 0.5rem; background: var(--bg-subtle); border-radius: 6px; border-left: 3px solid ${color};">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-weight: 500;">${emoji} ${formattedDate}</div>
              <div style="color: var(--text-muted); font-size: 0.85rem; margin-top: 0.2rem;">${esc(typeLabel)}</div>
            </div>
            <div style="text-align: right; font-weight: 600; color: ${color};">${sign}${money(Math.abs(t.amount))}</div>
          </div>
        </div>
      `;
    } else {
      // Multiple items on same date
      const emoji = hasPositive && !hasNegative ? '🟢' : hasNegative && !hasPositive ? '🔴' : '⚪';
      const sign = totalAmount > 0 ? '+' : '';

      let detailsHtml = '';
      items.forEach(t => {
        const typeLabel = t.type === 'contribution' ? 'Contribution'
          : t.type === 'event_deduction' ? (t.event_title || 'Event Deduction')
          : t.type === 'charge' ? 'Game Charge'
          : t.type === 'transfer_out' ? 'Transfer Out'
          : t.type === 'transfer_in' ? 'Transfer In'
          : 'Transaction';
        const isPos = t.amount > 0;
        const eIcon = isPos ? '🟢' : '🔴';
        const s = isPos ? '+' : '';
        const color = isPos ? 'var(--success)' : 'var(--danger)';

        detailsHtml += `<div style="display: flex; justify-content: space-between; font-size: 0.85rem; color: var(--text-muted);">
          <span>${eIcon} ${esc(typeLabel)}</span>
          <span style="color: ${color}; font-weight: 500;">${s}${money(Math.abs(t.amount))}</span>
        </div>`;
      });

      html += `
        <div style="padding: 0.75rem; margin-bottom: 0.5rem; background: var(--bg-subtle); border-radius: 6px; border-left: 3px solid var(--border-color);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
            <div style="font-weight: 500;">${emoji} ${items.length} items on ${formattedDate}</div>
            <div style="text-align: right; font-weight: 600; color: var(--text-muted);">${sign}${money(Math.abs(totalAmount))}</div>
          </div>
          <div style="display: grid; gap: 0.3rem; margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border-color);">
            ${detailsHtml}
          </div>
        </div>
      `;
    }
  });

  html += '</div>';
  return html;
}

async function renderPlayerDetail(player, stats) {
  const detailCard = $('playerDetailCard');
  $('playerDetailName').textContent = `${player.name}`;

  // Fetch ALL contributions for this player (across all contracts)
  let allContributions = [];
  try {
    const data = await api.get(`/contributions?player_id=${player.id}`);
    allContributions = data || [];
  } catch (e) {
    console.error('Failed to load contributions:', e);
  }

  // Fetch ledgers for all contracts
  let allLedgers = [];
  try {
    const data = await api.get(`/players/${player.id}/ledgers`);
    allLedgers = data || [];
  } catch (e) {
    console.error('Failed to load ledgers:', e);
  }

  // Fetch all transactions (audit trail)
  let allTransactions = [];
  try {
    const data = await api.playerTransactions(player.id, 500);
    allTransactions = data || [];
  } catch (e) {
    console.error('Failed to load transactions:', e);
  }

  // Calculate cross-contract stats
  const totalGames = allLedgers.reduce((sum, l) => sum + (l.games || 0), 0);
  const totalContributions = allContributions.reduce((sum, c) => sum + (c.amount || 0), 0);
  const totalBalance = allLedgers.reduce((sum, l) => sum + (l.present_balance || 0), 0);

  // Build modular tabs
  let tabsHtml = `
    <div style="display: flex; gap: 0.5rem; margin-bottom: 1.5rem; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem; overflow-x: auto;">
      <button class="tab-btn active" data-tab="overview" style="padding: 0.5rem 1rem; background: none; border: none; cursor: pointer; font-weight: 500; border-bottom: 2px solid var(--sport); color: var(--sport); white-space: nowrap;">Overview</button>
      <button class="tab-btn" data-tab="audit-trail" style="padding: 0.5rem 1rem; background: none; border: none; cursor: pointer; font-weight: 500; color: var(--text-muted); white-space: nowrap;">Audit Trail</button>
      <button class="tab-btn" data-tab="contributions" style="padding: 0.5rem 1rem; background: none; border: none; cursor: pointer; font-weight: 500; color: var(--text-muted); white-space: nowrap;">Contributions</button>
      <button class="tab-btn" data-tab="charges" style="padding: 0.5rem 1rem; background: none; border: none; cursor: pointer; font-weight: 500; color: var(--text-muted); white-space: nowrap;">Charges</button>
      <button class="tab-btn" data-tab="contracts" style="padding: 0.5rem 1rem; background: none; border: none; cursor: pointer; font-weight: 500; color: var(--text-muted); white-space: nowrap;">By Contract</button>
    </div>

    <!-- OVERVIEW TAB -->
    <div class="tab-content" data-tab="overview" style="display: block;">
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem;">
        <div style="padding: 1rem; background: var(--bg-subtle); border-radius: 8px;">
          <div style="color: var(--text-muted); font-size: 0.9rem;">Games Played</div>
          <div style="font-size: 1.8rem; font-weight: 700; color: var(--sport);">${totalGames}</div>
        </div>
        <div style="padding: 1rem; background: var(--bg-subtle); border-radius: 8px;">
          <div style="color: var(--text-muted); font-size: 0.9rem;">Total Balance</div>
          <div style="font-size: 1.8rem; font-weight: 700; color: ${totalBalance > 0 ? 'var(--success)' : 'var(--danger)'};">${money(totalBalance)}</div>
        </div>
        <div style="padding: 1rem; background: var(--bg-subtle); border-radius: 8px;">
          <div style="color: var(--text-muted); font-size: 0.9rem;">Total Contributions</div>
          <div style="font-size: 1.8rem; font-weight: 700; color: var(--success);">+${money(totalContributions)}</div>
        </div>
        <div style="padding: 1rem; background: var(--bg-subtle); border-radius: 8px;">
          <div style="color: var(--text-muted); font-size: 0.9rem;">Contracts</div>
          <div style="font-size: 1.8rem; font-weight: 700;">${allLedgers.length}</div>
        </div>
      </div>
    </div>

    <!-- AUDIT TRAIL TAB (all transactions: contributions + external events + charges) -->
    <div class="tab-content" data-tab="audit-trail" style="display: none;">
      ${renderAuditTrail(allTransactions)}
    </div>

    <!-- CONTRIBUTIONS TAB -->
    <div class="tab-content" data-tab="contributions" style="display: none;">
      ${allContributions.length > 0
        ? `<table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
            <thead style="background: var(--bg-subtle);">
              <tr>
                <th style="padding: 0.5rem; text-align: left; border-bottom: 1px solid var(--border-color);">Date</th>
                <th style="padding: 0.5rem; text-align: left; border-bottom: 1px solid var(--border-color);">Contract</th>
                <th style="padding: 0.5rem; text-align: right; border-bottom: 1px solid var(--border-color);">Amount</th>
                <th style="padding: 0.5rem; text-align: left; border-bottom: 1px solid var(--border-color);">Comments</th>
              </tr>
            </thead>
            <tbody>
              ${allContributions.map(c => `
                <tr style="border-bottom: 1px solid var(--border-color);">
                  <td style="padding: 0.5rem;">${c.date || '—'}</td>
                  <td style="padding: 0.5rem; color: var(--text-muted);">${esc(store.contracts.find(x => x.id === c.contract_id)?.name || c.contract_id)}</td>
                  <td style="padding: 0.5rem; text-align: right; font-weight: 600; color: ${c.amount > 0 ? 'var(--success)' : 'var(--danger)'};">${c.amount > 0 ? '+' : ''}${money(c.amount)}</td>
                  <td style="padding: 0.5rem; color: var(--text-muted); font-size: 0.85rem;">${esc(c.comments || '—')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>`
        : '<div class="hint">No contributions yet.</div>'
      }
    </div>

    <!-- CHARGES TAB -->
    <div class="tab-content" data-tab="charges" style="display: none;">
      <div class="hint">Game charges from current contract (${store.contracts.find(c => c.id === contractId)?.name || ''}):</div>
      ${stats.timeline?.events?.filter(e => e.type !== 'contribution').length > 0
        ? stats.timeline.events
            .filter(e => e.type !== 'contribution')
            .map(e => `
              <div style="padding: 0.75rem; margin-bottom: 0.5rem; background: var(--bg-subtle); border-radius: 6px; font-size: 0.9rem;">
                <div style="font-weight: 500;">${e.date} · ${e.team || '—'}</div>
                <div style="color: var(--text-muted); font-size: 0.85rem;">${e.rate_type || '—'}</div>
                <div style="margin-top: 0.25rem; color: var(--danger); font-weight: 600;">-${money(e.amount)}</div>
              </div>
            `).join('')
        : '<div class="hint">No charges in this contract yet.</div>'
      }
    </div>

    <!-- BY CONTRACT TAB -->
    <div class="tab-content" data-tab="contracts" style="display: none;">
      <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
        <thead style="background: var(--bg-subtle);">
          <tr>
            <th style="padding: 0.5rem; text-align: left; border-bottom: 1px solid var(--border-color);">Contract</th>
            <th style="padding: 0.5rem; text-align: right; border-bottom: 1px solid var(--border-color);">Balance</th>
            <th style="padding: 0.5rem; text-align: right; border-bottom: 1px solid var(--border-color);">Games</th>
            <th style="padding: 0.5rem; text-align: right; border-bottom: 1px solid var(--border-color);">Status</th>
          </tr>
        </thead>
        <tbody>
          ${allLedgers.map(l => `
            <tr style="border-bottom: 1px solid var(--border-color);">
              <td style="padding: 0.5rem;">${esc(store.contracts.find(c => c.id === l.contract_id)?.name || l.contract_id)}</td>
              <td style="padding: 0.5rem; text-align: right; font-weight: 600; color: ${l.present_balance > 0 ? 'var(--success)' : 'var(--danger)'};">${money(l.present_balance)}</td>
              <td style="padding: 0.5rem; text-align: right;">${l.games || 0}</td>
              <td style="padding: 0.5rem; text-align: right; font-size: 0.85rem; color: var(--text-muted);">${l.status || 'In Contract'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  $('playerStatsGrid').innerHTML = tabsHtml;

  // Tab switching
  $('playerStatsGrid').querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      $('playerStatsGrid').querySelectorAll('.tab-btn').forEach(b => {
        b.style.color = b.dataset.tab === tab ? 'var(--sport)' : 'var(--text-muted)';
        b.style.borderBottomColor = b.dataset.tab === tab ? 'var(--sport)' : 'transparent';
      });
      $('playerStatsGrid').querySelectorAll('.tab-content').forEach(tc => {
        tc.style.display = tc.dataset.tab === tab ? 'block' : 'none';
      });
    });
  });

  detailCard.hidden = false;
  currentDetailPlayerId = player.id;
}

function closePlayerDetail() {
  $('playerDetailCard').hidden = true;
  currentDetailPlayerId = null;
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

function resetPlayerModal(playerId) {
  const p = store.players.find(x => x.id === playerId);
  const checkboxId = `reset_confirm_${Date.now()}`;
  openModal(`Reset ${p?.name || 'player'}?`, `
    <div style="background: #f5f5f5; padding: 1rem; border-radius: 8px; margin-bottom: 1.5rem; border: 1px solid #ddd;">
      <div style="font-weight: 600; margin-bottom: 0.5rem; color: #333;">What will happen:</div>
      <div style="color: #555; line-height: 1.6;">
        ✓ Clear all money (contributions)<br>
        ✓ Reset balance to 0<br>
        ✓ Keep game records (history stays)
      </div>
    </div>
    <label style="display: flex; align-items: center; gap: 0.8rem; margin-bottom: 1.5rem; cursor: pointer; padding: 0.75rem; background: #fafafa; border-radius: 6px; border: 1px solid #e0e0e0;">
      <input type="checkbox" id="${checkboxId}" style="cursor: pointer; width: 20px; height: 20px;">
      <span style="font-weight: 500; color: #333;">Yes, reset ${p?.name || 'this player'}</span>
    </label>
    <div style="display: flex; gap: 0.5rem;">
      <button class="btn" id="confirm_reset" style="flex: 1;" disabled>Reset</button>
      <button class="btn btn-secondary" id="cancel_reset" style="flex: 1;">Cancel</button>
    </div>`);

  const checkbox = $(`${checkboxId}`);
  const confirmBtn = $('confirm_reset');

  checkbox.addEventListener('change', () => {
    confirmBtn.disabled = !checkbox.checked;
  });

  confirmBtn.addEventListener('click', async () => {
    try {
      await api.post(`/admin/players/${playerId}/reset`, {});
      store.players = await api.players();
      closeModal(); toast('Player reset ✓'); render();
    } catch (e) { toast(e.message, true); }
  });
  $('cancel_reset').addEventListener('click', closeModal);
}

function deletePlayerModal(playerId) {
  const p = store.players.find(x => x.id === playerId);
  const playerName = p?.name || 'this player';
  const checkboxId = `delete_confirm_${Date.now()}`;
  openModal(`⚠️ Delete ${playerName}?`, `
    <div style="background: #fff3f3; padding: 1rem; border-radius: 8px; margin-bottom: 1.5rem; border: 2px solid #dc3545;">
      <div style="font-weight: 600; margin-bottom: 0.5rem; color: #dc3545;">⚠️ WARNING - Cannot undo!</div>
      <div style="color: #333; line-height: 1.6;">
        ✗ Player will be deleted<br>
        ✗ All payments/money records gone<br>
        ✗ All game history gone<br>
        ✗ No way to get it back
      </div>
    </div>
    <label style="display: flex; align-items: center; gap: 0.8rem; margin-bottom: 1.5rem; cursor: pointer; padding: 0.75rem; background: #fafafa; border-radius: 6px; border: 1px solid #e0e0e0;">
      <input type="checkbox" id="${checkboxId}" style="cursor: pointer; width: 20px; height: 20px;">
      <span style="font-weight: 500; color: #333;">Yes, delete ${playerName} forever</span>
    </label>
    <div style="display: flex; gap: 0.5rem;">
      <button class="btn btn-danger" id="confirm_delete" style="flex: 1;" disabled>DELETE</button>
      <button class="btn btn-secondary" id="cancel_delete" style="flex: 1;">Cancel</button>
    </div>`);

  const checkbox = $(`${checkboxId}`);
  const confirmBtn = $('confirm_delete');

  checkbox.addEventListener('change', () => {
    confirmBtn.disabled = !checkbox.checked;
  });

  confirmBtn.addEventListener('click', async () => {
    try {
      await api.delete(`/admin/players/${playerId}`);
      store.players = await api.players();
      closeModal(); toast('Player deleted ✓'); render();
    } catch (e) { toast(e.message, true); }
  });
  $('cancel_delete').addEventListener('click', closeModal);
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

function bulkImportModal() {
  openModal('Bulk Import Players & Balances', `
    <div style="margin-bottom: 1.5rem;">
      <label style="display: block; font-weight: 600; margin-bottom: 0.5rem;">Select Contract</label>
      <select id="bi_contract" required style="width: 100%; padding: 0.6rem; border: 1px solid var(--border-color); border-radius: 8px;">
        <option value="">Choose contract…</option>
        ${store.contracts.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
      </select>
    </div>

    <div style="margin-bottom: 1rem;">
      <label style="display: block; font-weight: 600; margin-bottom: 0.5rem;">Paste Data (Name + Balance)</label>
      <p class="hint" style="margin: 0 0 0.8rem; font-size: 0.85rem;">
        Copy from Excel: Name in column 1, Opening Balance in column 2. One per line.
      </p>
      <textarea id="bi_data" placeholder="Toby&#9;-700
Vijay&#9;0
Joe&#9;223
..." style="width: 100%; min-height: 200px; padding: 0.8rem; font-family: monospace; font-size: 0.9rem; border: 1px solid var(--border-color); border-radius: 8px;"></textarea>
    </div>

    <button class="btn full-w" id="bi_import">Import</button>`);

  $('bi_import').addEventListener('click', async () => {
    const contractId = $('bi_contract').value;
    const data = $('bi_data').value;

    if (!contractId) { toast('Select a contract', true); return; }
    if (!data.trim()) { toast('Paste data', true); return; }

    try {
      const result = await api.bulkImportPlayersAndBalances(contractId, data);
      store.players = await api.players();
      closeModal();
      toast(`✓ Imported: ${result.created} players, ${result.updated} balances`);
      render();
    } catch (e) { toast(e.message, true); }
  });
}

export function initPlayers() {
  if (!isPlayer()) {
    $('plAdd').addEventListener('click', addPlayerModal);

    // Add bulk import button
    const bulkImportBtn = document.createElement('button');
    bulkImportBtn.className = 'btn btn-secondary';
    bulkImportBtn.textContent = '📥 Bulk Import';
    bulkImportBtn.addEventListener('click', bulkImportModal);
    $('plAdd').parentElement.appendChild(bulkImportBtn);
  }
  $('playerDetailClose').addEventListener('click', closePlayerDetail);
}


export function loadPlayers() {
  if (isPlayer()) {
    // Hide admin-only chrome; "My Ledger" lists all contracts as rows.
    $('plAdd').style.display = 'none';
    $('plContractSeg').innerHTML = '';
    const banner = $('setupBanner');
    if (banner) banner.style.display = 'none';
    return render();
  }

  contractSeg($('plContractSeg'), store.contracts, contractId, (id) => { contractId = id; render(); });
  return render();
}
