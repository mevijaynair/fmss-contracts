// transfers.js — player-to-player kitty transfers with admin approval
import { api } from '../api.js';
import { toast } from '../store.js';
import { $, esc } from '../util.js';
import { store } from '../store.js';

function renderPlayerTransferForm() {
  const user = JSON.parse(localStorage.getItem('fmss_user') || '{}');
  const isPlayer = user.role === 'player';

  if (!isPlayer) return '';

  return `
    <div class="form-group">
      <label>Send money to</label>
      <select id="transferToPlayer" required>
        <option value="">Select player…</option>
        ${store.players
          .filter(p => p.id !== user.playerId && p.special_role !== 'cashier')
          .map(p => `<option value="${p.id}">${esc(p.name)}</option>`)
          .join('')}
      </select>
    </div>
    <div class="form-group">
      <label>Contract</label>
      <select id="transferContract">
        <option value="">Both / General</option>
        ${store.contracts.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label>Amount (AED)</label>
      <input type="number" id="transferAmount" placeholder="0" step="0.1" min="0" required>
    </div>
    <div class="form-group">
      <label>Notes (optional)</label>
      <input type="text" id="transferNotes" placeholder="e.g., money from X, etc.">
    </div>
    <button type="button" class="btn" id="submitTransfer">Send Transfer</button>
  `;
}

function renderAdminTransfersPanel() {
  const user = JSON.parse(localStorage.getItem('fmss_user') || '{}');
  return user.role === 'admin' ? '' : 'hidden';
}

function renderPlayerTransfersHistory() {
  const user = JSON.parse(localStorage.getItem('fmss_user') || '{}');
  if (user.role !== 'player') return;

  const container = document.getElementById('playerTransfersContainer');
  if (!container) return;

  container.innerHTML = `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem;">
      <div>
        <h4 style="margin-bottom: 1rem; color: var(--text-muted);">Money I Sent</h4>
        <div id="sentTransfers" style="max-height: 300px; overflow-y: auto;"></div>
      </div>
      <div>
        <h4 style="margin-bottom: 1rem; color: var(--text-muted);">Money I Received</h4>
        <div id="receivedTransfers" style="max-height: 300px; overflow-y: auto;"></div>
      </div>
    </div>
  `;
}

export async function loadTransfers() {
  const user = JSON.parse(localStorage.getItem('fmss_user') || '{}');

  if (user.role === 'player') {
    // Load player's transfers
    const transfers = await api.myTransfers();
    const sent = $('sentTransfers');
    const received = $('receivedTransfers');

    if (sent) {
      sent.innerHTML = transfers.sent.length ? transfers.sent.map(t => `
        <div style="padding: 0.8rem; background: var(--bg-subtle); border-radius: 8px; margin-bottom: 0.6rem;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 0.4rem;">
            <strong>→ ${esc(t.to_player_name)}</strong>
            <span class="tag ${t.status === 'approved' ? 'tag-paid' : 'tag-due'}">${t.status}</span>
          </div>
          <div style="color: var(--text-muted); font-size: 0.9rem;">AED ${t.amount.toFixed(2)}</div>
          <div style="color: var(--text-faint); font-size: 0.8rem;">${new Date(t.created_at).toLocaleDateString()}</div>
        </div>
      `).join('') : '<p class="hint">No transfers sent yet.</p>';
    }

    if (received) {
      received.innerHTML = transfers.received.length ? transfers.received.map(t => `
        <div style="padding: 0.8rem; background: var(--bg-subtle); border-radius: 8px; margin-bottom: 0.6rem;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 0.4rem;">
            <strong>← ${esc(t.from_player_name)}</strong>
            <span class="tag ${t.status === 'approved' ? 'tag-paid' : 'tag-due'}">${t.status}</span>
          </div>
          <div style="color: var(--text-muted); font-size: 0.9rem;">AED ${t.amount.toFixed(2)}</div>
          <div style="color: var(--text-faint); font-size: 0.8rem;">${new Date(t.created_at).toLocaleDateString()}</div>
        </div>
      `).join('') : '<p class="hint">No transfers received yet.</p>';
    }
  } else if (user.role === 'admin') {
    // Load pending transfers for admin
    const transfers = await api.listPendingTransfers();
    const table = $('transfersTable')?.querySelector('tbody');
    if (table) {
      table.innerHTML = transfers.length ? transfers.map(t => `
        <tr>
          <td>${esc(t.from_player)}</td>
          <td>${esc(t.to_player)}</td>
          <td>AED ${t.amount.toFixed(2)}</td>
          <td><span class="tag tag-due">${t.status}</span></td>
          <td class="row-actions">
            <button class="btn btn-secondary btn-sm" data-approve-transfer="${t.id}">Approve</button>
            <button class="btn btn-danger btn-sm" data-reject-transfer="${t.id}">Reject</button>
          </td>
        </tr>
      `).join('') : '<tr><td colspan="5" class="hint">No pending transfers.</td></tr>';

      // Wire approval buttons
      table.querySelectorAll('[data-approve-transfer]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            await api.approveTransfer(btn.dataset.approveTransfer);
            toast('Transfer approved');
            loadTransfers();
          } catch (e) { toast(e.message, true); }
        });
      });

      table.querySelectorAll('[data-reject-transfer]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            await api.rejectTransfer(btn.dataset.rejectTransfer);
            toast('Transfer rejected');
            loadTransfers();
          } catch (e) { toast(e.message, true); }
        });
      });
    }
  }
}

export function initTransfers() {
  const user = JSON.parse(localStorage.getItem('fmss_user') || '{}');

  if (user.role === 'player') {
    const formContainer = $('transferFormContainer');
    if (formContainer) {
      formContainer.innerHTML = renderPlayerTransferForm();
    }

    renderPlayerTransfersHistory();

    const submitBtn = $('submitTransfer');
    if (submitBtn) {
      submitBtn.addEventListener('click', async () => {
        const to_player_id = $('transferToPlayer').value;
        const contract_id = $('transferContract').value;
        const amount = parseFloat($('transferAmount').value);
        const notes = $('transferNotes').value;

        if (!to_player_id || !amount || amount <= 0) {
          toast('Select player and enter amount', true);
          return;
        }

        try {
          await api.submitTransfer(to_player_id, contract_id, amount, notes);
          toast('Transfer sent for approval');
          $('transferToPlayer').value = '';
          $('transferAmount').value = '';
          $('transferNotes').value = '';
          loadTransfers();
        } catch (e) { toast(e.message, true); }
      });
    }
  }

  // Listen for view changes to load transfers when the view is shown
  window.addEventListener('fmss:view', (e) => {
    if (e.detail === 'transfers') loadTransfers();
  });
}
