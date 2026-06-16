// router.js — sidebar nav + single active view (no permissions).
export const NAV = [
  { view: 'dashboard',     label: 'Dashboard',     title: 'Dashboard' },
  { view: 'gameday',       label: 'Game Day',      title: 'Game Day — paste WhatsApp teams' },
  { view: 'players',       label: 'Players',       title: 'Player Ledger' },
  { view: 'contributions', label: 'Contributions', title: 'Contributions' },
  { view: 'gameweeks',     label: 'Game History',  title: 'Game History' },
  { view: 'kitty',         label: 'Kitty',         title: 'Club Kitty' },
  { view: 'settings',      label: 'Settings',      title: 'Contract Settings' },
];

const I = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS = {
  dashboard:     I('<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>'),
  gameday:       I('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  players:       I('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  contributions: I('<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
  gameweeks:     I('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  kitty:         I('<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>'),
  settings:      I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
};

let current = null;

export function buildNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = NAV.map(n =>
    `<button data-view="${n.view}">${ICONS[n.view] || ''}<span>${n.label}</span></button>`).join('');
  nav.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => showView(b.dataset.view)));
}

export function showView(view) {
  const meta = NAV.find(n => n.view === view);
  if (!meta) return;
  current = view;
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.dataset.view !== view; });
  document.querySelectorAll('#nav button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('pageTitle').textContent = meta.title;
  window.dispatchEvent(new CustomEvent('fmss:view', { detail: view }));
}

export function currentView() { return current; }
