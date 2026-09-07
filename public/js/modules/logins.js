// logins.js — admin panel to onboard players with name + PIN logins.
//
// A PIN is only ever visible at the moment it is created: the database stores a
// salted SHA-256 hash, so it cannot be read back. The listing therefore shows
// whether a login EXISTS, not what the PIN is, and any newly issued PINs are
// shown once in a copyable block that has to be saved before leaving the page.
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
        ? '<span class="hint">set — reset to issue a new one</span>'
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
        // Also pin it to the sheet: a toast disappears, and this is the only
        // moment the PIN can be read.
        showIssued([{ name: res.name, pin: res.pin }]);
        toast(`New PIN for ${res.name}: ${res.pin}`);
        load();
      } catch (e) { toast(e.message, true); }
    }));
  $('loginsTable').querySelectorAll('[data-create]').forEach(b =>
    b.addEventListener('click', async () => {
      try {
        const res = await api.createLogin(b.dataset.create);
        showIssued([{ name: res.name, pin: res.pin }]);
        toast(`Login for ${res.name} — PIN ${res.pin}`);
        load();
      } catch (e) { toast(e.message, true); }
    }));
}

// Newly issued PINs, shown once. Rendered as text in a block that can be
// selected and copied straight into WhatsApp.
function showIssued(created) {
  const box = $('loginsIssued');
  if (!box || !created?.length) return;
  const lines = created.map(c => `${c.name}: ${c.pin}`).join('\n');
  box.hidden = false;
  box.innerHTML = `
    <p class="mini-h">New PINs — copy them now, they cannot be shown again</p>
    <div class="teams-raw" id="loginsIssuedText"></div>
    <div class="row-actions mt">
      <button class="btn btn-sm" id="loginsCopy">Copy all</button>
    </div>`;
  // textContent, not innerHTML: player names are free text.
  $('loginsIssuedText').textContent = lines;
  $('loginsCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(lines); toast('Copied'); }
    catch { toast('Select the text and copy manually', true); }
  });
}

async function load() {
  render(await api.logins());
}

export function initLogins() {
  $('loginsGenerate').addEventListener('click', async () => {
    try {
      const res = await api.generateLogins();
      // The endpoint now returns { created, logins }. Tolerate the old array
      // shape so a stale cached bundle does not blank the table.
      const logins = Array.isArray(res) ? res : res.logins;
      const created = Array.isArray(res) ? [] : (res.created ?? []);
      render(logins);
      showIssued(created);
      toast(created.length
        ? `${created.length} login(s) created — copy the PINs below`
        : 'Every player already has a login');
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
