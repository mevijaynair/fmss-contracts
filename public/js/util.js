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
  host.innerHTML = contracts.map(c =>
    `<button data-id="${c.id}" class="${c.id === active ? 'active' : ''}">${esc(c.name.split(' ')[0])}${c.id === 'monthu' ? '/Thu' : ''}</button>`).join('');
  host.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => {
      host.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      onPick(b.dataset.id);
    }));
}

// Generic modal.
export function openModal(title, bodyHtml) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHtml;
  $('modal').hidden = false;
}
export function closeModal() { $('modal').hidden = true; }
