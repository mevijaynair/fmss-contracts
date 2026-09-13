// store.js — tiny shared state + toast.
export const store = {
  contracts: [],
  players: [],
  // Only a fallback for the moment before /api/contracts answers — the real
  // choice is the club's first contract, see defaultContract() below.
  activeContract: 'mon_thu',
};

/**
 * Which contract a contract-scoped view opens on.
 *
 * Five views each kept their own `let contractId = 'sat'`, so the app opened on
 * Saturdays everywhere while `contracts` sorts Mon/Thu first and Mon/Thu is by
 * far the bigger book — 12 games and 27 players on the sheet against 38 games
 * but 19 players, and more than twice the money moving through it. Every screen
 * therefore started on the wrong one and had to be switched by hand.
 *
 * Reading it off the sorted list rather than naming an id means reordering the
 * contracts in the database is enough to change this, and there is one string
 * to fall back on rather than five.
 *
 * Call it ONCE per view, on first load — calling it on every load would undo
 * the user's own choice each time they navigated away and back.
 */
export const defaultContract = () => store.contracts[0]?.id || store.activeContract;

let toastTimer = null;
export function toast(msg, isErr = false) {
  const t = document.getElementById('toast');
  if (!t) return;

  // Clear any existing close handler
  const closeBtn = t.querySelector('.toast-close');
  if (closeBtn) closeBtn.remove();

  // Build toast with close button
  t.innerHTML = `<span>${msg}</span><button class="toast-close" aria-label="Close">✕</button>`;
  const newCloseBtn = t.querySelector('.toast-close');
  newCloseBtn.addEventListener('click', () => { t.className = 'toast'; });

  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 4000);
}
