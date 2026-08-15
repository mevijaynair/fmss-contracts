// sandbox.js — admin panel to manage test players for safe balance testing
import { api } from '../api.js';
import { toast } from '../store.js';
import { $, esc } from '../util.js';

function renderSandboxForm() {
  return `
    <div style="padding: 1.5rem; background: var(--bg-subtle); border-radius: 8px; border-left: 4px solid var(--accent); margin-bottom: 2rem;">
      <div style="color: var(--accent); font-weight: 600; margin-bottom: 0.5rem;">🧪 Sandbox Testing Environment</div>
      <p style="color: var(--text-muted); margin: 0; font-size: 0.9rem;">Create temporary test players to safely experiment with balance imports and transactions. Delete them anytime to revert all changes.</p>
    </div>

    <div class="form-group">
      <label>Test Player Name</label>
      <input type="text" id="sandboxName" placeholder="e.g., Test Player 1" required>
    </div>
    <button class="btn" id="createSandbox" style="background: var(--accent); color: #000; font-weight: 600;">Create Test Player</button>

    <div id="sandboxList" style="margin-top: 2rem;"></div>
  `;
}

async function loadSandboxPlayers() {
  try {
    const players = await api.getSandboxPlayers();
    const container = $('sandboxList');
    if (!container) return;

    if (!players.length) {
      container.innerHTML = '<p class="hint">No test players yet. Create one to start testing.</p>';
      return;
    }

    container.innerHTML = `
      <div style="margin-top: 1.5rem;">
        <h4 style="margin-bottom: 0.8rem; color: var(--text-muted);">Active Test Players</h4>
        <div style="overflow-x: auto;">
          <table class="sams-table">
            <thead>
              <tr>
                <th>Player Name</th>
                <th>ID</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${players.map(p => `
                <tr style="opacity: 0.7;">
                  <td><strong style="color: var(--accent);">🧪 ${esc(p.name)}</strong></td>
                  <td style="font-family: monospace; font-size: 0.85rem; color: var(--text-muted);">${p.id.slice(0, 8)}…</td>
                  <td style="color: var(--text-muted); font-size: 0.9rem;">${new Date(p.created_at).toLocaleDateString()}</td>
                  <td class="row-actions">
                    <button class="btn btn-danger btn-sm" data-delete-sandbox="${p.id}" style="width: auto;">Delete & Reset</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    // Wire delete buttons
    container.querySelectorAll('[data-delete-sandbox]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const playerId = btn.dataset.deleteSandbox;
        const playerName = btn.closest('tr').querySelector('td:first-child').textContent.replace('🧪 ', '');

        if (!confirm(`Delete test player "${playerName}"? All their balance data will be permanently removed.`)) return;

        try {
          await api.deleteSandboxPlayer(playerId);
          toast(`Test player "${playerName}" deleted and balances reset`);
          loadSandboxPlayers();
        } catch (e) {
          toast(e.message, true);
        }
      });
    });
  } catch (e) {
    toast(e.message, true);
  }
}

export function initSandbox() {
  const container = $('sandboxContainer');
  if (container) {
    container.innerHTML = renderSandboxForm();
  }

  const createBtn = $('createSandbox');
  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      const name = $('sandboxName').value.trim();
      if (!name) {
        toast('Enter a test player name', true);
        return;
      }

      try {
        await api.createSandboxPlayer(name);
        toast(`Test player "${name}" created`);
        $('sandboxName').value = '';
        loadSandboxPlayers();
      } catch (e) {
        toast(e.message, true);
      }
    });
  }

  loadSandboxPlayers();
}

export function loadSandbox() {
  return loadSandboxPlayers();
}
