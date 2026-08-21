// store.js — tiny shared state + toast.
export const store = {
  contracts: [],
  players: [],
  activeContract: 'sat',      // current contract tab on contract-scoped views
};

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
