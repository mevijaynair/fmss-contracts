// router.js — sidebar nav + single active view. Two-tier role-based nav.
const ADMIN_NAV = [
  { view: 'dashboard',     label: 'Dashboard',     title: 'Dashboard' },
  { view: 'gameday',       label: 'Game Day',      title: 'Game Day — paste WhatsApp teams' },
  { view: 'results',       label: 'Results',       title: 'Match Results' },
  { view: 'players',       label: 'Players',       title: 'Player Ledger' },
  { view: 'contributions', label: 'Contributions', title: 'Contributions' },
  { view: 'gameweeks',     label: 'Game History',  title: 'Game History' },
  { view: 'kitty',         label: 'Kitty',         title: 'Club Kitty' },
  { view: 'events',        label: 'External Events', title: 'External Events' },
  { view: 'opening-balances', label: 'Opening Balances', title: 'Opening Balances' },
  { view: 'sandbox',       label: 'Sandbox',       title: 'Test Environment' },
  { view: 'transfers',     label: 'Transfers',     title: 'Player Transfers' },
  { view: 'logins',        label: 'Player Logins', title: 'Player Logins' },
  { view: 'settings',      label: 'Settings',      title: 'Contract Settings' },
];

const PLAYER_NAV = [
  { view: 'dashboard',     label: 'Dashboard',     title: 'My Dashboard' },
  { view: 'results',       label: 'Results',       title: 'Match Results' },
  { view: 'players',       label: 'My Ledger',     title: 'My Account' },
  { view: 'contributions', label: 'Contributions', title: 'My Contributions' },
  { view: 'transfers',     label: 'Transfers',     title: 'Send Money' },
  { view: 'settings',      label: 'Account',       title: 'Account Settings' },
];

export const NAV = ADMIN_NAV;  // Export admin nav by default for compatibility

const I = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS = {
  dashboard:     I('<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>'),
  gameday:       I('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  results:       I('<path d="M3 3v18h18"/><path d="M7 16l4-6 4 3 5-7"/>'),
  players:       I('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  contributions: I('<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
  gameweeks:     I('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  kitty:         I('<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>'),
  events:        I('<path d="M3 12h18M3 6h18M5 12v6a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-6M12 3v3"/><circle cx="12" cy="9" r="1"/>'),
  'opening-balances': I('<path d="M12 2v20m-7-7h14"/><rect x="2" y="7" width="20" height="10" rx="1" ry="1"/>'),
  sandbox:       I('<circle cx="12" cy="12" r="1"/><circle cx="5" cy="5" r="1"/><circle cx="19" cy="5" r="1"/><circle cx="5" cy="19" r="1"/><circle cx="19" cy="19" r="1"/><path d="M5 5h14v14H5z" fill="none"/>'),
  transfers:     I('<path d="M12 5v14M5 12l7 7 7-7M19 9l-7-7-7 7"/>'),
  logins:        I('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  settings:      I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
};

let current = null;
let currentNav = ADMIN_NAV;

export function buildNav(role = 'admin') {
  currentNav = role === 'player' ? PLAYER_NAV : ADMIN_NAV;
  const nav = document.getElementById('nav');
  nav.innerHTML = currentNav.map(n =>
    `<button data-view="${n.view}">${ICONS[n.view] || ''}<span>${n.label}</span></button>`).join('');
  nav.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => showView(b.dataset.view)));
}

export function showView(view) {
  const meta = currentNav.find(n => n.view === view);
  if (!meta) return;
  current = view;
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.dataset.view !== view; });
  document.querySelectorAll('#nav button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('pageTitle').textContent = meta.title;
  window.dispatchEvent(new CustomEvent('fmss:view', { detail: view }));
}

export function currentView() { return current; }
