// players.js — per-contract ledger table + add player + timeline & stats detail.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money, balCell, contractSeg, openModal, closeModal, today } from '../util.js';
import { initOpeningBalances, loadOpeningBalances } from './opening_balances.js';

let contractId = 'sat';
let currentDetailPlayerId = null;

const STATUSES = ['In Contract', 'Refill needed', 'Out of contract'];

function isPlayer() { return store.user?.role === 'player'; }

async function render() {
  if (isPlayer()) return renderPlayerLedger();

  const ledgers = await api.ledgers(contractId);
  const roleOf = Object.fromEntries(store.players.map(p => [p.id, p.special_role]));
  $('playersTable').querySelector('tbody').innerHTML = ledgers.map(l => {
    const isCashier = roleOf[l.player_id] === 'cashier';
    return `
    <tr>
      <td><strong onclick="window.showPlayerDetail('${l.player_id}')" style="cursor: pointer; color: var(--sport);">${esc(l.player_name)}</strong>${isCashier ? ' <span class="tag tag-cashier" title="Cashier — excluded from contributions">💰 Cashier</span>' : ''}</td>
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
        ${isCashier ? '<span class="hint">no contributions</span>'
          : `<button class="btn btn-secondary btn-sm" data-pay="${l.player_id}">+ Pay</button>`}
        <button class="btn btn-tertiary btn-sm" data-reset="${l.player_id}" title="Reset balance to 0, clear contributions">Reset</button>
        <button class="btn btn-danger btn-sm" data-delete="${l.player_id}" title="Completely remove player">Delete</button>
      </td>
    </tr>`; }).join('') || '<tr><td colspan="8" class="hint">No players in this contract yet.</td></tr>';

  $('playersTable').querySelectorAll('[data-status]').forEach(sel =>
    sel.addEventListener('change', async () => {
      try { await api.setStatus(sel.dataset.status, contractId, sel.value); toast('Status updated'); }
      catch (e) { toast(e.message, true); }
    }));
  $('playersTable').querySelectorAll('[data-pay]').forEach(btn =>
    btn.addEventListener('click', () => payModal(btn.dataset.pay)));
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

async function renderPlayerDetail(player, stats) {
  const detailCard = $('playerDetailCard');
  $('playerDetailName').textContent = `${player.name} — ${store.contracts.find(c => c.id === contractId)?.name || ''}`;

  // Fetch contributions for this player
  let contributions = [];
  try {
    const data = await api.get(`/contributions?player_id=${player.id}&contract_id=${contractId}`);
    contributions = data || [];
  } catch (e) {
    console.error('Failed to load contributions:', e);
  }

  // Timeline
  const timelineHtml = stats.timeline.events.length > 0
    ? stats.timeline.events.map(e => {
        const type = e.type === 'contribution' ? 'contribution' : 'charge';
        return `
          <div class="timeline-event ${type}">
            <div class="timeline-marker"></div>
            <div class="timeline-content">
              <div class="timeline-date">${e.date}</div>
              <div class="timeline-type">${type === 'contribution' ? '📥 Contribution' : '⚽ Game charge'}</div>
              <div class="timeline-detail">${type === 'contribution' ? `+${e.amount} AED` : `${e.team || '—'} · ${e.rate_type || '—'} · -${e.amount} AED`}</div>
              <div class="timeline-balance">Balance: ${e.runningBalance} AED</div>
            </div>
          </div>
        `;
      }).join('')
    : '<div class="hint">No transactions yet.</div>';

  $('playerTimeline').innerHTML = `
    <div style="margin-bottom: 1rem;">
      <span class="muted">Opening</span> ${money(stats.timeline.opening)} AED
      &nbsp;·&nbsp;
      <span class="muted">Present</span> <strong>${money(stats.timeline.presentBalance)}</strong> AED
    </div>
    ${timelineHtml}
  `;

  // Stats grid
  const statsGrid = [
    { label: 'Games played', value: stats.games, detail: stats.games === 1 ? '1 game' : `${stats.games} games` },
    { label: 'Teams', value: stats.teams?.length || 0, detail: stats.teams?.map(t => t.team).join(', ') || 'None' },
    { label: 'Attendance', value: `${stats.streaks.current}`, detail: `${stats.streaks.longest} longest` },
    { label: 'Current balance', value: money(stats.timeline.presentBalance), detail: stats.timeline.presentBalance >= 0 ? 'Positive' : 'Refill needed' },
  ];

  const costBreakdownHtml = stats.costs?.length > 0
    ? stats.costs.map(c => `<div class="stat-detail">${c.rate_type}: ${c.gameCount}g @ ${money(c.totalAmount)}</div>`).join('')
    : '<div class="stat-detail">No cost breakdown</div>';

  $('playerStatsGrid').innerHTML = statsGrid.map(s => `
    <div class="stat-card">
      <div class="stat-label">${s.label}</div>
      <div class="stat-value">${s.value}</div>
      <div class="stat-detail">${s.detail}</div>
    </div>
  `).join('') + `
    <div class="stat-card" style="grid-column: span 2;">
      <div class="stat-label">Cost breakdown</div>
      ${costBreakdownHtml}
    </div>
  `;

  // Contributions table
  const contributionsHtml = contributions.length > 0
    ? `<table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
        <thead style="background: var(--bg-subtle);">
          <tr>
            <th style="padding: 0.5rem; text-align: left; border-bottom: 1px solid var(--border-color);">Date</th>
            <th style="padding: 0.5rem; text-align: right; border-bottom: 1px solid var(--border-color);">Amount</th>
            <th style="padding: 0.5rem; text-align: left; border-bottom: 1px solid var(--border-color);">Comments</th>
          </tr>
        </thead>
        <tbody>
          ${contributions.map(c => `
            <tr style="border-bottom: 1px solid var(--border-color);">
              <td style="padding: 0.5rem;">${c.date || '—'}</td>
              <td style="padding: 0.5rem; text-align: right; font-weight: 600; color: ${c.amount > 0 ? 'var(--success)' : 'var(--danger)'};">${c.amount > 0 ? '+' : ''}${money(c.amount)}</td>
              <td style="padding: 0.5rem; color: var(--text-muted);">${esc(c.comments || '—')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`
    : '<div class="hint">No contributions yet.</div>';

  const detailsContainer = document.createElement('div');
  detailsContainer.style.cssText = 'margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid var(--border-color);';
  detailsContainer.innerHTML = `
    <div style="font-weight: 600; margin-bottom: 1rem;">Contributions</div>
    ${contributionsHtml}
  `;

  const statsContainer = $('playerStatsGrid').parentElement;
  const existingDetails = statsContainer.querySelector('[data-contributions-table]');
  if (existingDetails) existingDetails.remove();
  detailsContainer.setAttribute('data-contributions-table', '');
  statsContainer.appendChild(detailsContainer);

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
  openModal(`Reset ${p?.name || 'player'}?`, `
    <p style="margin-bottom: 1rem;">This will clear contributions, but keep game charges for historical record. Opening balance → 0. Use for realignment.</p>
    <div style="display: flex; gap: 0.5rem;">
      <button class="btn" id="confirm_reset" style="flex: 1;">Yes, reset</button>
      <button class="btn btn-secondary" id="cancel_reset" style="flex: 1;">Cancel</button>
    </div>`);
  $('confirm_reset').addEventListener('click', async () => {
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
  openModal(`Delete ${p?.name || 'player'}?`, `
    <p style="margin-bottom: 1rem; color: var(--danger);">⚠️ This will completely remove the player and all their transaction history. This cannot be undone.</p>
    <div style="display: flex; gap: 0.5rem;">
      <button class="btn btn-danger" id="confirm_delete" style="flex: 1;">Yes, delete permanently</button>
      <button class="btn btn-secondary" id="cancel_delete" style="flex: 1;">Cancel</button>
    </div>`);
  $('confirm_delete').addEventListener('click', async () => {
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

export function initPlayers() {
  if (!isPlayer()) {
    $('plAdd').addEventListener('click', addPlayerModal);
    initSetupBanner();
    initOpeningBalances();
  }
  $('playerDetailClose').addEventListener('click', closePlayerDetail);
}

function initSetupBanner() {
  const toggle = $('setupToggle');
  const form = $('setupFormContainer');
  if (!toggle || !form) return;

  toggle.addEventListener('click', () => {
    const isHidden = form.style.display === 'none';
    form.style.display = isHidden ? 'block' : 'none';
    toggle.textContent = isHidden ? 'Hide form' : 'Show form';
    if (isHidden) renderSetupForm();
  });
}

function renderSetupForm() {
  const form = $('setupFormContainer');
  // Re-render the opening balances form in the setup banner
  const contractSelect = `
    <div style="max-width: 400px;">
      <div style="margin-bottom: 1rem;">
        <label style="display: block; font-weight: 600; margin-bottom: 0.5rem;">Select Contract</label>
        <select id="balanceContract" required style="width: 100%; padding: 0.6rem; border: 1px solid var(--border-color); border-radius: 8px;">
          <option value="">Choose contract…</option>
          ${store.contracts.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      <div style="margin-bottom: 1rem;">
        <label style="display: block; font-weight: 600; margin-bottom: 0.5rem;">Paste Opening Balances (Name, Balance)</label>
        <p class="hint" style="margin: 0 0 0.8rem; font-size: 0.85rem;">Format: one per line, can include headers. Example: "Toby -700"</p>
        <textarea id="balanceData" placeholder="Name&#9;Balance
Vijay&#9;0
Toby&#9;-700
..." style="width: 100%; min-height: 120px; padding: 0.6rem; font-family: monospace; font-size: 0.85rem; border: 1px solid var(--border-color); border-radius: 8px;"></textarea>
      </div>
      <div style="display: flex; gap: 0.6rem;">
        <button type="button" class="btn" id="submitBalances">Import Balances</button>
        <button type="button" class="btn btn-secondary" id="clearBalances">Clear</button>
      </div>
    </div>
  `;
  form.innerHTML = contractSelect;
  loadOpeningBalances();
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

  // Show setup banner only if no opening balances have been imported yet
  checkAndShowSetupBanner();
  contractSeg($('plContractSeg'), store.contracts, contractId, (id) => { contractId = id; render(); });
  return render();
}

async function checkAndShowSetupBanner() {
  const banner = $('setupBanner');
  if (!banner) return;

  try {
    // Check if any contract has opening balances
    const hasAny = await Promise.all(
      store.contracts.map(c => api.get(`/admin/contracts/${c.id}/kitty-opening`).catch(() => null))
    ).then(results => results.some(r => r !== null));

    // Hide banner if opening balances already exist
    banner.style.display = hasAny ? 'none' : 'block';
  } catch (e) {
    // Keep banner visible if there's an error checking
    banner.style.display = 'block';
  }
}
