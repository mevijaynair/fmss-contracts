// main.js — bootstrap: load shared data, build nav, wire per-view loads.
// Two-tier auth: admin (password) or player (email+password). Role-based nav.
import { api } from './api.js';
import { store, toast } from './store.js';
import { buildNav, showView } from './router.js';
import { initTheme } from './theme.js';
import { $, closeModal } from './util.js';

// Token & user management
const TOKEN_KEY = 'fmss_token';
const USER_KEY = 'fmss_user';
export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function setToken(token) { localStorage.setItem(TOKEN_KEY, token); }
export function getUser() {
  const u = localStorage.getItem(USER_KEY);
  return u ? JSON.parse(u) : null;
}
export function setUser(user) { localStorage.setItem(USER_KEY, JSON.stringify(user)); }
export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}
export function isAuthenticated() { return !!getToken(); }

import { loadDashboard } from './modules/dashboard.js';
import { initResults, loadResults } from './modules/results.js';
import { initGameday, loadGameday } from './modules/gameday.js';
import { initPlayers, loadPlayers } from './modules/players.js';
import { initContributions, loadContributions } from './modules/contributions.js';
import { initGameweeks, loadGameweeks } from './modules/gameweeks.js';
import { initKitty, loadKitty } from './modules/kitty.js';
import { initSettings, loadSettings } from './modules/settings.js';
import { initLogins, loadLogins } from './modules/logins.js';
import { initExternalEvents, loadExternalEvents } from './modules/external_events.js';
import { initReport, loadReport } from './modules/report.js';
import { initTransfers, loadTransfers } from './modules/transfers.js';
import { initOpeningBalances, loadOpeningBalances } from './modules/opening_balances.js';

const LOADERS = {
  dashboard: loadDashboard,
  results: loadResults,
  gameday: loadGameday,
  players: loadPlayers,
  contributions: loadContributions,
  gameweeks: loadGameweeks,
  kitty: loadKitty,
  events: loadExternalEvents,
  report: loadReport,
  transfers: loadTransfers,
  logins: loadLogins,
  'opening-balances': loadOpeningBalances,
  settings: loadSettings,
};

async function start() {
  initTheme();

  // Check authentication
  if (!isAuthenticated()) {
    showLoginView();
    return;
  }

  // Authenticated: make sure the login overlay is hidden and the shell is shown
  // (covers a reload with a valid token, where no interactive login ran).
  $('loginView').style.display = 'none';
  document.querySelector('.shell').style.display = '';

  // Load app with role-based nav
  const user = getUser();
  document.body.classList.toggle('role-player', user?.role === 'player');
  document.body.classList.toggle('role-admin', user?.role === 'admin');
  buildNav(user?.role);
  [store.contracts, store.players] = await Promise.all([api.contracts(), api.players()]);
  store.activeContract = store.contracts[0]?.id || 'sat';
  store.user = user;

  initReport(); initResults(); initGameday(); initPlayers(); initContributions(); initGameweeks(); initKitty(); initSettings();
  if (user?.role === 'admin') { initLogins(); initExternalEvents(); initOpeningBalances(); }
  initTransfers();

  window.addEventListener('fmss:view', (e) => {
    const fn = LOADERS[e.detail];
    if (fn) Promise.resolve(fn()).catch(err => toast(err.message, true));
  });

  // Any button can send you to a view. The screens that are no longer in the
  // sidebar — Standing, Player Logins, Transfer approvals — are reached this
  // way, from the screen each belongs to. Delegated, so buttons rendered later
  // work without being wired individually.
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (go) showView(go.dataset.goto);
  });

  $('modalClose').addEventListener('click', closeModal);
  document.querySelector('#modal .modal-overlay').addEventListener('click', closeModal);

  showView('dashboard');
}

let loginWired = false;

function showLoginView() {
  // Hide the main shell; show the full-screen login overlay (flex-centered).
  document.querySelector('.shell').style.display = 'none';
  $('loginView').style.display = 'flex';

  if (loginWired) return;   // wire the form once
  loginWired = true;

  const playerGroup = $('playerGroup');
  const passwordLabel = $('passwordLabel');
  const passwordInput = $('loginPassword');
  const modeToggle = $('loginModeToggle');
  const playerSelect = $('loginPlayer');
  const help = $('loginHelp');

  // Player is the default and the common case; admin is the exception you have
  // to ask for.
  let adminMode = false;

  let playersLoaded = false;
  async function loadPlayerNames() {
    if (playersLoaded) return;
    try {
      const players = await api.get('/login/players');
      playerSelect.innerHTML = '<option value="">Select your name…</option>'
        + players.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
      playersLoaded = true;
    } catch { /* leave placeholder */ }
  }
  loadPlayerNames();

  function applyMode() {
    playerGroup.style.display = adminMode ? 'none' : 'block';
    playerSelect.required = !adminMode;
    passwordLabel.textContent = adminMode ? 'Admin password' : 'PIN';
    passwordInput.placeholder = adminMode ? 'Enter password' : 'Enter your PIN';
    passwordInput.inputMode = adminMode ? 'text' : 'numeric';
    passwordInput.value = '';
    modeToggle.textContent = adminMode
      ? '← Back to player sign-in' : 'Sign in as administrator';
    help.textContent = adminMode
      ? 'Runs the club — full access to every balance and setting.'
      : 'Your PIN comes from the club — ask for one if you have not been given it.';
    $('loginError').style.display = 'none';
    (adminMode ? passwordInput : playerSelect).focus();
  }
  modeToggle.addEventListener('click', () => { adminMode = !adminMode; applyMode(); });
  applyMode();

  // Wire login form
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const isPlayerLogin = !adminMode;
    const secret = passwordInput.value;

    let body;
    if (isPlayerLogin) {
      const playerId = playerSelect.value;
      if (!playerId) { showLoginError('Please select your name'); return; }
      if (!secret) { showLoginError('Please enter your PIN'); return; }
      body = { player_id: playerId, pin: secret };
    } else {
      body = { password: secret };
    }

    try {
      const result = await api.post('/login', body);
      setToken(result.token);
      const user = await api.get('/me');
      setUser(user);
      // A club-issued PIN arrives over WhatsApp, so it is known to whoever
      // passed it on. The server has always flagged that it must be replaced;
      // nothing ever acted on the flag, so every player kept the shared one.
      if (result.requiresPinChange) {
        const changed = await forceNewPin();
        if (!changed) { clearAuth(); showLoginError('Sign in again to set your PIN'); return; }
      }
      // start() (authenticated path) hides the overlay and restores the shell.
      start();
    } catch (err) {
      showLoginError(err.message || 'Login failed');
    }
  });
}

/**
 * Make a player replace the PIN they were handed, before anything else.
 *
 * Deliberately blocking: it is the one moment they are certainly paying
 * attention, and a PIN that was texted to them is not a secret. Returns false if
 * they back out, in which case the session is dropped rather than left signed in
 * on the shared PIN.
 */
async function forceNewPin() {
  const card = document.querySelector('.login-card');
  const original = card.innerHTML;
  card.innerHTML = `
    <div class="login-header"><h1>Choose a PIN</h1>
      <p>The one you were given is known to whoever sent it. Pick your own.</p></div>
    <div class="form-group"><label for="np1">New PIN</label>
      <input type="password" id="np1" inputmode="numeric" autocomplete="new-password"
             placeholder="At least 4 digits"></div>
    <div class="form-group"><label for="np2">Again</label>
      <input type="password" id="np2" inputmode="numeric" autocomplete="new-password"
             placeholder="Type it a second time"></div>
    <button type="button" class="btn" id="npSave">Save and continue</button>
    <div id="npError" class="login-error" style="display:none;"></div>
    <p class="login-alt"><button type="button" class="link-btn" id="npCancel">Cancel</button></p>`;

  const fail = (m) => {
    const e = $('npError'); e.textContent = m; e.style.display = 'block';
  };
  const done = await new Promise((resolve) => {
    $('npSave').addEventListener('click', async () => {
      const a = $('np1').value.trim(); const b = $('np2').value.trim();
      if (a.length < 4) return fail('Use at least 4 digits.');
      if (a !== b) return fail('The two do not match.');
      try { await api.setInitialPin(a); resolve(true); }
      catch (e) { fail(e.message); }
    });
    $('npCancel').addEventListener('click', () => resolve(false));
    $('np1').focus();
  });
  card.innerHTML = original;
  loginWired = false;          // the form's listeners went with the markup
  return done;
}

function showLoginError(message) {
  const err = $('loginError');
  err.textContent = message;
  err.style.display = 'block';
  // Auto-clear error on next input
  [$('loginPlayer'), $('loginPassword')].forEach(el => {
    el?.addEventListener('input', () => { err.style.display = 'none'; }, { once: true });
  });
}

// Let any module refresh the shared player list after a create.
export async function refreshPlayers() {
  store.players = await api.players();
}

window.addEventListener('DOMContentLoaded', start);
