// util.js — small DOM + formatting helpers.
export const $ = (id) => document.getElementById(id);
export const el = (sel, root = document) => root.querySelector(sel);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Money: 1 decimal max, thousands separator, no trailing ".0".
export function money(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

// Balance cell HTML with pos/neg/zero colouring.
export function balCell(n) {
  const v = Number(n) || 0;
  const cls = v > 0.001 ? 'pos' : v < -0.001 ? 'neg' : 'zero';
  return `<span class="bal ${cls}">${money(v)}</span>`;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function fmtDate(d) {
  if (!d) return '';
  const s = String(d).slice(0, 10);
  return s;
}

// Build a segmented contract switcher into `host`; calls onPick(contractId).
export function contractSeg(host, contracts, active, onPick) {
  // The contract's own name is already the label. This used to truncate at the
  // first space and bolt "/Thu" back on when the id was exactly 'monthu', which
  // rendered "Mon/Thu/Thu" on any database spelling the id that way — and did
  // nothing at all where it is spelled 'mon_thu'.
  host.innerHTML = contracts.map(c =>
    `<button data-id="${c.id}" class="${c.id === active ? 'active' : ''}">${esc(c.name)}</button>`).join('');
  host.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => {
      host.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      onPick(b.dataset.id);
    }));
}

// Generic modal with keyboard support
let modalEscapeListener = null;
/**
 * Options for a player picker, squad first and guests kept out of the way.
 *
 * Sixty-one names in one flat list is most of a season's walk-ups sitting on top
 * of the twenty people you actually pick from. Guests go in their own group at
 * the bottom, still reachable — hiding a guest outright would make it impossible
 * to say who covered them — but never between two squad members.
 *
 * `players` is the roster (store.players). Sandbox rows never appear.
 */
export function rosterOptions(players, selectedId = '', { includeGuests = true } = {}) {
  const usable = (players || []).filter(p => !p.is_sandbox);
  const opt = (p) =>
    `<option value="${esc(p.id)}"${p.id === selectedId ? ' selected' : ''}>${esc(p.name)}</option>`;
  const byName = (a, b) => a.name.localeCompare(b.name);

  const squad = usable.filter(p => (p.player_type || 'regular') !== 'outside').sort(byName);
  const guests = usable.filter(p => (p.player_type || 'regular') === 'outside').sort(byName);
  // A guest who is already the selected value must stay in the list even when
  // guests are being withheld, or opening the control would silently change it.
  const keptGuests = includeGuests ? guests : guests.filter(p => p.id === selectedId);

  return squad.map(opt).join('')
    + (keptGuests.length
      ? `<optgroup label="Guests">${keptGuests.map(opt).join('')}</optgroup>` : '');
}

export function openModal(title, bodyHtml) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHtml;
  $('modal').hidden = false;

  // Add escape key support
  if (modalEscapeListener) {
    document.removeEventListener('keydown', modalEscapeListener);
  }
  modalEscapeListener = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', modalEscapeListener);
}

export function closeModal() {
  $('modal').hidden = true;
  if (modalEscapeListener) {
    document.removeEventListener('keydown', modalEscapeListener);
    modalEscapeListener = null;
  }
}
