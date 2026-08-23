// settings.js — edit each contract's venue, cost per game, and rate card.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc } from '../util.js';

const RATE_FIELDS = [
  ['contracted_10', 'Contract rate (10-player)'],
  ['contracted_12', 'Contract rate (12-player)'],
  ['captain_10', 'Captain rate (10-player)'],
  ['captain_12', 'Captain rate (12-player)'],
  ['noncontract', 'Non-contract rate'],
];

function card(c) {
  return `
  <div class="sams-card" style="margin-bottom:1.25rem;">
    <div class="card-header"><h3 class="card-title">${esc(c.name)}</h3></div>
    <div class="form-row">
      <div class="form-group"><label>Name</label><input id="s_${c.id}_name" value="${esc(c.name)}"></div>
      <div class="form-group"><label>Venue</label><input id="s_${c.id}_venue" value="${esc(c.venue || '')}"></div>
    </div>
    <div class="form-group mt" style="max-width:240px;"><label>Cost per game (AED)</label>
      <input type="number" id="s_${c.id}_cost" value="${c.cost_per_gw}"></div>
    <h4 class="mini-h mt">Rate card (AED per player)</h4>
    <div class="form-row">
      ${RATE_FIELDS.map(([k, lbl]) =>
        `<div class="form-group"><label>${lbl}</label>
          <input type="number" id="s_${c.id}_${k}" value="${c.rates[k] ?? 0}"></div>`).join('')}
    </div>
    <button class="btn mt" data-save="${c.id}">Save ${esc(c.name.split(' ')[0])}</button>
  </div>`;
}

function isPlayer() { return store.user?.role === 'player'; }

export function initSettings() {}

export async function loadSettings() {
  if (isPlayer()) return loadAccount();

  renderBackupPanel();
  store.contracts = await api.contracts();
  $('settingsCards').innerHTML = store.contracts.map(card).join('');
  $('settingsCards').querySelectorAll('[data-save]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const id = btn.dataset.save;
      const rates = {};
      RATE_FIELDS.forEach(([k]) => rates[k] = Number($(`s_${id}_${k}`).value) || 0);
      try {
        await api.updateContract(id, {
          name: $(`s_${id}_name`).value, venue: $(`s_${id}_venue`).value,
          cost_per_gw: Number($(`s_${id}_cost`).value) || 0, rates,
        });
        store.contracts = await api.contracts();
        toast('Contract saved ✓');
      } catch (e) { toast(e.message, true); }
    }));
}

// Player "Account" view: read-only profile (rate cards are not theirs to edit).
function loadAccount() {
  const view = document.querySelector('[data-view="settings"]');
  const title = view.querySelector('.card-title');
  const sub = view.querySelector('.card-sub');
  if (title) title.textContent = 'My Account';
  if (sub) sub.textContent = 'Your profile';

  $('settingsCards').innerHTML = `
    <div class="form-group"><label>Signed in as</label>
      <input value="${esc(store.user?.email || '')}" disabled></div>
    <div class="form-group mt"><label>Role</label>
      <input value="Player (view + submit contributions)" disabled></div>
    <p class="hint mt">To change your password or update your details, contact the club cashier.</p>`;
}

// ---- Backup & Restore ----------------------------------------------------
// Export is one click. Restore is deliberately not: it replaces everything, so
// it goes preview → tick → confirm, and the server refuses unless the row count
// echoes what the preview reported.

function renderBackupPanel() {
  const el = $('backupPanel');
  if (!el) return;
  el.innerHTML = `
    <div class="quick-row">
      <button class="btn" id="bkExport">⬇️ Download full backup</button>
      <button class="btn btn-secondary" id="bkExportSafe">⬇️ Without PINs</button>
      <label class="hint" style="display:flex;align-items:center;gap:.4rem">
        <input type="file" id="bkFile" accept="application/json,.json" style="max-width:230px">
      </label>
      <button class="btn btn-secondary" id="bkPreview">Preview restore</button>
    </div>
    <p class="hint mt">The download is a single JSON file holding every table — keep it somewhere
      safe. A full backup <strong>contains PINs and password hashes</strong>; use “Without PINs”
      for a copy you will share or store loosely.</p>
    <div id="bkResult" class="mt"></div>`;

  $('bkExport').addEventListener('click', () => downloadBackup(true));
  $('bkExportSafe').addEventListener('click', () => downloadBackup(false));
  $('bkPreview').addEventListener('click', previewRestore);
}

async function downloadBackup(withCredentials) {
  try {
    const res = await fetch(`/api/admin/backup?credentials=${withCredentials}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('fmss_token')}` },
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const blob = await res.blob();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fmss-backup-${stamp}${withCredentials ? '' : '-nopins'}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Backup downloaded ✓');
  } catch (e) { toast(`Export failed: ${e.message}`, true); }
}

function readFileAsJson(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('Could not read that file'));
    fr.onload = () => {
      try { resolve(JSON.parse(fr.result)); }
      catch { reject(new Error('That file is not valid JSON')); }
    };
    fr.readAsText(file);
  });
}

async function previewRestore() {
  const file = $('bkFile')?.files?.[0];
  const out = $('bkResult');
  if (!file) { toast('Choose a backup file first', true); return; }
  out.innerHTML = '<p class="hint">Reading…</p>';

  let doc;
  try { doc = await readFileAsJson(file); }
  catch (e) { out.innerHTML = ''; toast(e.message, true); return; }

  let check;
  try { check = await api.post('/admin/backup/inspect', { backup: doc }); }
  catch (e) { out.innerHTML = ''; toast(`Preview failed: ${e.message}`, true); return; }

  const rows = check.tables.filter(t => t.rows || t.current).map(t => `
    <div class="panel-row">
      <strong style="flex:1">${esc(t.table)}</strong>
      <span class="hint">now ${t.current ?? 0}</span>
      <span class="hint">→</span>
      <strong>${t.rows}</strong>
      <span class="hint">${esc(t.action)}</span>
    </div>`).join('');

  out.innerHTML = `
    <div class="panel panel-danger">
      <div class="panel-title">⚠️ Restoring replaces everything</div>
      <div class="panel-body">
        Every table is emptied and reloaded from this file — anything recorded since
        it was taken is lost. The current database is copied to
        <code>data/backups/</code> first, so this can be undone.
      </div>
    </div>
    <p class="hint mt">Backup taken <strong>${esc(check.created_at || 'unknown')}</strong> ·
      format ${check.format} · ${check.includes_credentials ? 'includes PINs' : 'PINs redacted'} ·
      <strong>${check.total_rows}</strong> row(s)</p>
    ${check.includes_credentials ? '' :
      `<p class="hint">This copy has no PINs, so player logins will need regenerating after restore.</p>`}
    <div class="panel-scroll">${rows}</div>
    ${check.problems.length ? `
      <div class="panel panel-warn mt">
        <div class="panel-title">${check.problems.length} thing(s) to note</div>
        <div class="panel-body">${check.problems.map(esc).join('<br>')}</div>
      </div>` : ''}
    <label class="confirm-check">
      <input type="checkbox" id="bkOk">
      <span>Yes, replace all current data with this backup</span>
    </label>
    <div class="btn-row mt">
      <button class="btn btn-danger" id="bkGo" disabled>Restore ${check.total_rows} row(s)</button>
      <button class="btn btn-secondary" id="bkCancel">Cancel</button>
    </div>`;

  $('bkOk').addEventListener('change', (e) => { $('bkGo').disabled = !e.target.checked; });
  $('bkCancel').addEventListener('click', () => { out.innerHTML = ''; });
  $('bkGo').addEventListener('click', async () => {
    $('bkGo').disabled = true;
    $('bkGo').textContent = 'Restoring…';
    try {
      const res = await api.post('/admin/backup/restore',
        { backup: doc, confirm_rows: check.total_rows });
      out.innerHTML = `
        <div class="panel">
          <div class="panel-title">✓ Restored ${res.total_rows} row(s)</div>
          <div class="panel-body">
            ${res.safety_copy ? `The previous database was saved to <code>${esc(res.safety_copy)}</code>.<br>` : ''}
            Reload the page to see the restored data.
          </div>
        </div>
        <button class="btn mt" onclick="location.reload()">Reload now</button>`;
      toast(`✓ Restored ${res.total_rows} rows`);
    } catch (e) {
      $('bkGo').disabled = false;
      $('bkGo').textContent = 'Restore';
      toast(`Restore failed: ${e.message}`, true);
    }
  });
}
