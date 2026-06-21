// players.js — per-contract ledger table + add player + timeline & stats detail.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money, balCell, contractSeg, openModal, closeModal, today } from '../util.js';

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
      </td>
    </tr>`; }).join('') || '<tr><td colspan="8" class="hint">No players in this contract yet.</td></tr>';

  $('playersTable').querySelectorAll('[data-status]').forEach(sel =>
    sel.addEventListener('change', async () => {
      try { await api.setStatus(sel.dataset.status, contractId, sel.value); toast('Status updated'); }
      catch (e) { toast(e.message, true); }
    }));
  $('playersTable').querySelectorAll('[data-pay]').forEach(btn =>
    btn.addEventListener('click', () => payModal(btn.dataset.pay)));
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
    renderPlayerDetail(player, stats);
    contractId = prevContract;
  } catch (e) {
    toast(`Failed to load stats: ${e.message}`, true);
  }
};

window.showPlayerDetail = async (playerId) => {
  try {
    const stats = await api.get(`/players/${playerId}/stats?contract_id=${contractId}`);
    const player = store.players.find(p => p.id === playerId);
    renderPlayerDetail(player, stats);
  } catch (e) {
    toast(`Failed to load player stats: ${e.message}`, true);
  }
};

function renderPlayerDetail(player, stats) {
  const detailCard = $('playerDetailCard');
  $('playerDetailName').textContent = `${player.name} — ${store.contracts.find(c => c.id === contractId)?.name || ''}`;

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
  if (!isPlayer()) $('plAdd').addEventListener('click', addPlayerModal);
  $('playerDetailClose').addEventListener('click', closePlayerDetail);
}

export function loadPlayers() {
  if (isPlayer()) {
    // Hide admin-only chrome; "My Ledger" lists all contracts as rows.
    $('plAdd').style.display = 'none';
    $('plContractSeg').innerHTML = '';
    return render();
  }
  contractSeg($('plContractSeg'), store.contracts, contractId, (id) => { contractId = id; render(); });
  return render();
}
