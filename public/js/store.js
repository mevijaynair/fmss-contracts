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
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
}
