// settings.js — edit each contract's venue, cost per game, and rate card.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, viewEl } from '../util.js';

// The third entry is the column heading in the history table, where the full
// label does not fit. Written out rather than derived from the long one by
// string surgery, which produced headings like "Captain (10-player".
const RATE_FIELDS = [
  ['contracted_10', 'Contract rate (10-player)', 'Player 10'],
  ['contracted_12', 'Contract rate (12-player)', 'Player 12'],
  ['captain_10', 'Captain rate (10-player)', 'Captain 10'],
  ['captain_12', 'Captain rate (12-player)', 'Captain 12'],
  // Stored under the key `noncontract`; shown as what it is — what somebody
  // outside the contract pays for a game.
  ['noncontract', 'Guest rate', 'Guest'],
];

const todayStr = () => new Date().toISOString().slice(0, 10);

/**
 * The history of what a place cost, newest first.
 *
 * A card runs until the next one starts, so the end date is shown but never
 * typed: between them the cards cover every night from the first one onwards
 * with no gap to fall through and no overlap to argue about.
 */
function cardHistory(c, cards) {
  if (!cards?.length) return '';
  const rows = [...cards].reverse().map(k => `
    <tr>
      <td>${k.effective_from || '—'}</td>
      <td>${k.effective_to || '<span class="rep-in">in force</span>'}</td>
      <td class="num">${k.pitch_per_game}</td>
      ${RATE_FIELDS.map(([f]) => `<td class="num">${k.rates?.[f] ?? '—'}</td>`).join('')}
      <td class="hint">${esc(k.notes || '')}</td>
      <td>${k.is_current ? '' :
    `<button class="btn btn-sm btn-danger" data-drop="${c.id}|${k.id}">Remove</button>`}</td>
    </tr>`).join('');
  return `
    <h4 class="mini-h mt">What a place has cost, and from when</h4>
    <div class="table-scroll">
      <table class="sams-table rep-table">
        <thead><tr><th>From</th><th>Until</th><th class="num">Pitch</th>
          ${RATE_FIELDS.map(([, , short]) => `<th class="num">${esc(short)}</th>`).join('')}
          <th>Note</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="hint">A game is priced by the card in force on the night it was played, so
      changing these never restates a game that has already been entered. To change prices
      from a date, put that date in <strong>From</strong> above and save: an earlier date
      edits the card that already starts there.</p>`;
}

function card(c, cards) {
  const live = cards?.find(k => k.is_current);
  return `
  <div class="sams-card" style="margin-bottom:1.25rem;">
    <div class="card-header"><h3 class="card-title">${esc(c.name)}</h3>
      <span class="card-sub">Rates in force since ${live?.effective_from || 'always'}</span></div>
    <div class="form-row">
      <div class="form-group"><label>Name</label><input id="s_${c.id}_name" value="${esc(c.name)}"></div>
      <div class="form-group"><label>Venue</label><input id="s_${c.id}_venue" value="${esc(c.venue || '')}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Cost per game (AED)</label>
        <input type="number" id="s_${c.id}_cost" value="${c.cost_per_gw}"></div>
      <div class="form-group"><label>In force from</label>
        <input type="date" id="s_${c.id}_from" value="${live?.effective_from || todayStr()}"></div>
      <div class="form-group"><label>Note (optional)</label>
        <input id="s_${c.id}_note" value="${esc(live?.notes || '')}"
          placeholder="why the price changed"></div>
    </div>
    <h4 class="mini-h mt">Rate card (AED per player)</h4>
    <div class="form-row">
      ${RATE_FIELDS.map(([k, lbl]) =>
        `<div class="form-group"><label>${lbl}</label>
          <input type="number" id="s_${c.id}_${k}" value="${c.rates[k] ?? 0}"></div>`).join('')}
    </div>
    <button class="btn mt" data-save="${c.id}">Save ${esc(c.name.split(' ')[0])}</button>
    ${cardHistory(c, cards)}
  </div>`;
}

function isPlayer() { return store.user?.role === 'player'; }

export function initSettings() {}

export async function loadSettings() {
  if (isPlayer()) return loadAccount();

  renderBackupPanel();
  wireClubContact();
  store.contracts = await api.contracts();
  // The card history, per contract. Quietly skipped if it cannot be read, so
  // a failure here leaves the rest of the screen working.
  const history = {};
  await Promise.all(store.contracts.map(async (c) => {
    try { history[c.id] = await api.rateCards(c.id); } catch { history[c.id] = null; }
  }));
  $('settingsCards').innerHTML = store.contracts.map(c => card(c, history[c.id])).join('');
  $('settingsCards').querySelectorAll('[data-save]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const id = btn.dataset.save;
      const rates = {};
      RATE_FIELDS.forEach(([k]) => rates[k] = Number($(`s_${id}_${k}`).value) || 0);
      try {
        await api.updateContract(id, {
          name: $(`s_${id}_name`).value, venue: $(`s_${id}_venue`).value,
        });
        // Prices go through the dated card, which is what decides what a game
        // costs. A date already in the history edits that card; a new one
        // starts a new price from that night and leaves the past as it was.
        const from = $(`s_${id}_from`).value || todayStr();
        await api.saveRateCard(id, {
          effective_from: from,
          rates,
          pitch_per_game: Number($(`s_${id}_cost`).value) || 0,
          notes: $(`s_${id}_note`).value || '',
        });
        await loadSettings();
        toast(`Saved ✓ — in force from ${from}`);
      } catch (e) { toast(e.message, true); }
    }));
  $('settingsCards').querySelectorAll('[data-drop]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const [id, cardId] = btn.dataset.drop.split('|');
      // Removing a card does not change a game that was priced from it: the
      // amounts are already on the charges. It changes what the night BEFORE
      // the next card would be priced at if it were entered again.
      if (!confirm('Remove this rate card? Games already entered keep what they were charged.')) return;
      try {
        await api.removeRateCard(id, cardId);
        await loadSettings();
        toast('Rate card removed');
      } catch (e) { toast(e.message, true); }
    }));
}

/**
 * The number a player is pointed at when a result is wrong.
 *
 * Optional and blank by default: the app must not publish somebody's phone
 * number because it guessed one. Without it, the report screen offers to copy
 * the message instead, which works everywhere.
 */
async function wireClubContact() {
  const input = $('s_whatsapp');
  const save = $('s_whatsapp_save');
  if (!input || !save) return;
  try { input.value = (await api.get('/admin/club-contact')).whatsapp || ''; }
  catch { /* leave it blank rather than block the rest of the screen */ }
  save.onclick = async () => {
    try {
      await api.put('/admin/club-contact', { whatsapp: input.value });
      toast(input.value.trim() ? 'Saved ✓' : 'Cleared');
    } catch (e) { toast(e.message, true); }
  };
}

// Player "Account" view: read-only profile (rate cards are not theirs to edit).
function loadAccount() {
  const view = viewEl('settings');
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
      <button class="btn" id="bkExcel">📊 Download Excel workbook</button>
      <button class="btn btn-secondary" id="bkExport">⬇️ Full backup (JSON)</button>
      <button class="btn btn-secondary" id="bkExportSafe">⬇️ Without PINs</button>
      <label class="hint" style="display:flex;align-items:center;gap:.4rem">
        <input type="file" id="bkFile" accept="application/json,.json" style="max-width:230px">
      </label>
      <button class="btn btn-secondary" id="bkPreview">Preview restore</button>
    </div>
    <p class="hint mt">The <strong>Excel workbook</strong> is for working offline: a sheet each for
      balances, games, charges, money in, the pot, the cashier statement, profit and loss, and the
      venue contracts. It holds no PINs, so it is safe to send on. It is <em>not</em> a backup —
      nothing reads it back in.</p>
    <p class="hint">The <strong>JSON backup</strong> is what you restore from: a single file holding
      every table. A full one <strong>contains PINs and password hashes</strong>; use “Without PINs”
      for a copy you will share or store loosely.</p>
    <div id="bkResult" class="mt"></div>`;

  $('bkExcel').addEventListener('click', downloadWorkbook);
  $('bkExport').addEventListener('click', () => downloadBackup(true));
  $('bkExportSafe').addEventListener('click', () => downloadBackup(false));
  $('bkPreview').addEventListener('click', previewRestore);
}

/**
 * The spreadsheet. Fetched rather than linked, because the download needs the
 * bearer token and an <a href> cannot carry one.
 */
async function downloadWorkbook() {
  const btn = $('bkExcel');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Building the workbook…';
  try {
    const res = await fetch('/api/admin/export/workbook', {
      headers: { Authorization: `Bearer ${localStorage.getItem('fmss_token')}` },
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fmss-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Workbook downloaded ✓');
  } catch (e) { toast(`Export failed: ${e.message}`, true); }
  finally { btn.disabled = false; btn.textContent = label; }
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
