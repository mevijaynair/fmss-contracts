// logins.js — admin panel to onboard players with name + PIN logins.
// One-click generates a login (random PIN) for every player, and lists the
// shareable credentials. Admin can reset a PIN or deactivate a login.
import { api } from '../api.js';
import { toast } from '../store.js';
import { $, esc } from '../util.js';

function render(rows) {
  // Defensive: ensure rows is an array
  const rowsList = Array.isArray(rows) ? rows : [];
  const withLogin = rowsList.filter(r => r.has_login).length;
  const tbody = $('loginsTable')?.querySelector('tbody');
  if (!tbody) return; // Container not ready yet
  tbody.innerHTML = rowsList.map(r => `
    <tr>
      <td><strong>${esc(r.name)}</strong></td>
      <td>${r.has_login
        ? `<span class="pin-chip">${esc(r.pin)}</span>`
        : '<span class="hint">no login</span>'}</td>
      <td>${r.has_login
        ? (r.is_active ? '<span class="tag tag-paid">Active</span>' : '<span class="tag tag-overdue">Disabled</span>')
        : '—'}</td>
      <td class="row-actions" style="white-space:nowrap;">
        ${r.has_login
          ? `<button class="btn btn-secondary btn-sm" data-reset="${r.player_id}">Reset PIN</button>`
          : `<button class="btn btn-sm" data-create="${r.player_id}">Create login</button>`}
      </td>
    </tr>`).join('') || '<tr><td colspan="4" class="hint">No players.</td></tr>';

  // subtitle count
  const gen = $('loginsGenerate');
  if (gen) {
    gen.textContent = withLogin === rowsList.length && rowsList.length > 0
      ? 'All players have logins ✓'
      : `Generate logins for all players (${rowsList.length - withLogin} left)`;
  }

  $('loginsTable').querySelectorAll('[data-reset]').forEach(b =>
    b.addEventListener('click', async () => {
      try {
        const res = await api.resetPin(b.dataset.reset);
        toast(`New PIN for ${res.name}: ${res.pin}`);
        load();
      } catch (e) { toast(e.message, true); }
    }));
  $('loginsTable').querySelectorAll('[data-create]').forEach(b =>
    b.addEventListener('click', async () => {
      try {
        const res = await api.createLogin(b.dataset.create);
        toast(`Login for ${res.name} — PIN ${res.pin}`);
        load();
      } catch (e) { toast(e.message, true); }
    }));
}

async function load() {
  render(await api.logins());
}

export function initLogins() {
  $('loginsGenerate').addEventListener('click', async () => {
    try {
      const rows = await api.generateLogins();
      const created = rows.filter(r => r.has_login).length;
      toast(`${created} player logins ready — share each PIN`);
      render(rows);
    } catch (e) { toast(e.message, true); }
  });
  // Load table when this view is shown
  window.addEventListener('fmss:view', (e) => {
    if (e.detail === 'logins') load();
  });
}

export function loadLogins() {
  return load();
}
