// opening_balances.js — admin panel to import opening balances per contract (1 Aug baseline)
import { api } from '../api.js';
import { toast } from '../store.js';
import { $, esc } from '../util.js';
import { store } from '../store.js';

function renderImportForm() {
  return `
    <div style="display: grid; gap: 1.5rem;">
      <div>
        <label style="display: block; font-weight: 600; margin-bottom: 0.5rem;">Select Contract</label>
        <select id="balanceContract" required style="width: 100%; padding: 0.6rem; border: 1px solid var(--border-color); border-radius: 8px;">
          <option value="">Choose contract…</option>
          ${store.contracts.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
        </select>
      </div>

      <div>
        <label style="display: block; font-weight: 600; margin-bottom: 0.5rem;">Paste Opening Balances (Name, Balance)</label>
        <p class="hint" style="margin: 0 0 0.8rem;">Format: one per line, name TAB or comma balance (e.g., "Toby -700")</p>
        <textarea id="balanceData" placeholder="Toby&#9;-700
Rakesh&#9;-129
Jeetu&#9;-241
..." style="width: 100%; min-height: 200px; padding: 0.8rem; font-family: monospace; font-size: 0.9rem; border: 1px solid var(--border-color); border-radius: 8px;"></textarea>
      </div>

      <div style="display: flex; gap: 0.8rem;">
        <button type="button" class="btn" id="submitBalances">Import Balances</button>
        <button type="button" class="btn btn-secondary" id="clearBalances">Clear</button>
      </div>
    </div>
  `;
}

function renderBalancesSummary(data) {
  const { balances, summary } = data;
  return `
    <div style="display: grid; gap: 1.5rem;">
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem;">
        <div style="padding: 1rem; background: var(--bg-subtle); border-radius: 8px;">
          <div style="color: var(--text-muted); font-size: 0.9rem;">Players</div>
          <div style="font-size: 1.4rem; font-weight: 700; color: var(--sport);">${summary.player_count || 0}</div>
        </div>
        <div style="padding: 1rem; background: var(--bg-subtle); border-radius: 8px;">
          <div style="color: var(--text-muted); font-size: 0.9rem;">Total Opening</div>
          <div style="font-size: 1.4rem; font-weight: 700; color: ${(summary.total_opening || 0) > 0 ? 'var(--success)' : 'var(--danger)'};"> AED ${(summary.total_opening || 0).toFixed(2)}</div>
        </div>
        <div style="padding: 1rem; background: var(--bg-subtle); border-radius: 8px;">
          <div style="color: var(--text-muted); font-size: 0.9rem;">Total Balance</div>
          <div style="font-size: 1.4rem; font-weight: 700; color: ${(summary.total_balance || 0) > 0 ? 'var(--success)' : 'var(--danger)'};"> AED ${(summary.total_balance || 0).toFixed(2)}</div>
        </div>
      </div>

      <div style="overflow-x: auto;">
        <table class="sams-table">
          <thead>
            <tr><th>Player</th><th>Opening</th><th>Contributed</th><th>Charged</th><th>Balance</th></tr>
          </thead>
          <tbody>
            ${(balances || []).map(b => `
              <tr>
                <td>${esc(b.name)}</td>
                <td style="text-align: right; font-weight: 600;">${b.opening_balance.toFixed(2)}</td>
                <td style="text-align: right;">${b.contributed.toFixed(2)}</td>
                <td style="text-align: right;">${b.charged.toFixed(2)}</td>
                <td style="text-align: right; font-weight: 600; color: ${b.present_balance > 0 ? 'var(--success)' : 'var(--danger)'};"> ${b.present_balance.toFixed(2)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function loadBalances(contractId) {
  if (!contractId) return;
  try {
    const data = await api.getOpeningBalances(contractId);
    const container = $('balancesSummaryContainer');
    if (container) {
      container.innerHTML = renderBalancesSummary(data);
    }
  } catch (e) {
    toast(e.message, true);
  }
}

export function initOpeningBalances() {
  attachImportHandlers();
}

function attachImportHandlers() {
  const formContainer = $('balancesFormContainer');
  if (!formContainer) return;

  const contractSelect = $('balanceContract');
  if (contractSelect) {
    contractSelect.addEventListener('change', (e) => {
      if (e.target.value) {
        loadBalances(e.target.value);
      } else {
        // Show form when contract is deselected
        showImportForm();
      }
    });
  }

  const submitBtn = $('submitBalances');
  if (submitBtn) {
    submitBtn.addEventListener('click', doImport);
  }

  const clearBtn = $('clearBalances');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      $('balanceData').value = '';
    });
  }
}

async function doImport() {
  const contractId = $('balanceContract').value;
  const rawData = $('balanceData').value;

  if (!contractId) {
    toast('Select a contract', true);
    return;
  }

  if (!rawData.trim()) {
    toast('Paste opening balances data', true);
    return;
  }

  const balances = rawData
    .split('\n')
    .filter(line => line.trim())
    .map((line) => {
      const isHeader = line.toLowerCase().includes('name')
        || line.toLowerCase().includes('player')
        || line.toLowerCase().includes('balance');
      if (isHeader) return null;

      const parts = line.includes('\t')
        ? line.split('\t')
        : line.split(/\s+/);

      if (parts.length < 2) return null;

      const lastPart = parts[parts.length - 1];
      const balance = parseFloat(lastPart);
      if (isNaN(balance)) return null;

      const name = parts.slice(0, -1).join(' ').trim();
      if (!name) return null;

      return { name, balance };
    })
    .filter(b => b && b.name && !isNaN(b.balance));

  if (!balances.length) {
    toast('No valid data found. Format: Name Amount per line', true);
    return;
  }

  try {
    const result = await api.importOpeningBalances(contractId, balances);
    toast(`✓ Imported ${result.imported} balances${result.errors.length ? `, ${result.errors.length} errors` : ''}`);
    $('balanceData').value = '';
    loadBalances(contractId);
  } catch (e) {
    toast(e.message, true);
  }
}

function showImportForm() {
  const formContainer = $('balancesFormContainer');
  if (formContainer) {
    formContainer.innerHTML = renderImportForm();
    attachImportHandlers();
  }
}

export function loadOpeningBalances() {
  const contractId = $('balanceContract')?.value;
  if (contractId) loadBalances(contractId);
}
