// main.js — bootstrap: load shared data, build nav, wire per-view loads.
// Two-tier auth: admin (password) or player (email+password). Role-based nav.
import { api } from './api.js';
import { store, toast, defaultContract } from './store.js';
import { buildNav, showView } from './router.js';
import { initTheme } from './theme.js';
import { $, closeModal } from './util.js';

// Token & user management.
//
// Two places to keep a token, and which one is a security decision the person
// makes at sign-in. localStorage survives closing the browser, which is what
// you want on your own phone and exactly what you do not want on a borrowed
// one; sessionStorage dies with the tab. Everything reads sessionStorage first,
// so the shared-device choice always wins.
const TOKEN_KEY = 'fmss_token';
const USER_KEY = 'fmss_user';
export function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
}
export function setToken(token, { thisSessionOnly = false } = {}) {
  clearAuth();
  (thisSessionOnly ? sessionStorage : localStorage).setItem(TOKEN_KEY, token);
}
export function getUser() {
  const u = sessionStorage.getItem(USER_KEY) || localStorage.getItem(USER_KEY);
  return u ? JSON.parse(u) : null;
}
export function setUser(user) {
  // Beside the token, wherever that went, so the two can never be split.
  const store = sessionStorage.getItem(TOKEN_KEY) ? sessionStorage : localStorage;
  store.setItem(USER_KEY, JSON.stringify(user));
}
export function clearAuth() {
  for (const store of [localStorage, sessionStorage]) {
    store.removeItem(TOKEN_KEY);
    store.removeItem(USER_KEY);
  }
}
export function isAuthenticated() { return !!getToken(); }

/**
 * Sign out, and mean it.
 *
 * There was no way out of the app at all: a token lasts a week, so anyone who
 * signed in on a shared phone stayed signed in on it. Clearing both stores and
 * reloading puts the login screen back. The view-as choice goes too — it is a
 * property of the session, not of the person.
 */
export function signOut() {
  clearAuth();
  try { sessionStorage.removeItem(VIEW_AS_KEY); } catch { /* private mode */ }
  window.location.replace('/');
}

// Seeing the app as a player sees it. Kept in sessionStorage because it is a
// thing you do for a minute to check something, not a setting — and because it
// must never outlive the tab and leave an admin wondering where the app went.
// It changes ONLY what is drawn: the token is untouched, so this is a preview,
// not a privilege drop, and the screens a player cannot reach are still
// refused by the server either way.
const VIEW_AS_KEY = 'fmss_view_as';
export function viewingAsPlayer() {
  try { return sessionStorage.getItem(VIEW_AS_KEY) === 'player'; } catch { return false; }
}
function setViewingAsPlayer(on) {
  try {
    if (on) sessionStorage.setItem(VIEW_AS_KEY, 'player');
    else sessionStorage.removeItem(VIEW_AS_KEY);
  } catch { /* private mode: the toggle just will not stick */ }
  window.location.reload();
}

import { loadDashboard } from './modules/dashboard.js';
import { initResults, loadResults } from './modules/results.js';
import { initGameday, loadGameday } from './modules/gameday.js';
import { initPlayers, loadPlayers } from './modules/players.js';
import { initContributions, loadContributions } from './modules/contributions.js';
import { initGameweeks, loadGameweeks } from './modules/gameweeks.js';
import { initKitty, loadKitty } from './modules/kitty.js';
import { initFinance, loadFinance } from './modules/finance.js';
import { initSettings, loadSettings } from './modules/settings.js';
import { initLogins, loadLogins } from './modules/logins.js';
import { initExternalEvents, loadExternalEvents } from './modules/external_events.js';
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
  finance: loadFinance,
  events: loadExternalEvents,
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

  // Ask the server who this is, every time, rather than trusting what was
  // cached at sign-in.
  //
  // The cached copy is written once, by the login form. When the rules about
  // who gets what changed — the cashier signing in under their own name now
  // gets the admin side — everyone already holding a seven-day token went on
  // seeing the role they were given the week before. Vijay stayed in the
  // read-only player view, which looks exactly like an app with no data in it,
  // and no amount of reloading fixed it because reloading is precisely the
  // path that used the stale copy. A token is proof of who you are; what that
  // is worth today is the server's to say.
  let user = getUser();
  try {
    const fresh = await api.get('/me');
    if (fresh) { user = fresh; setUser(fresh); }
  } catch {
    // A network blip should not lock somebody out of a session they hold. Fall
    // back to the cached role; an invalid token is already handled by api.js,
    // which clears it and reloads to the login screen.
  }
  // An admin who has asked to look at the player side is drawn as a player.
  // The token still says admin — this is a preview of the other view, not a
  // change of who you are.
  const realRole = user?.role;
  const shownRole = realRole === 'admin' && viewingAsPlayer() ? 'player' : realRole;
  document.body.classList.toggle('role-player', shownRole === 'player');
  document.body.classList.toggle('role-admin', shownRole === 'admin');
  document.body.classList.toggle('is-view-as', shownRole !== realRole);
  buildNav(shownRole);
  [store.contracts, store.players] = await Promise.all([api.contracts(), api.players()]);
  // After the roster loads: the strip names the person, and a player id is all
  // the token carries.
  wireIdentity(user, realRole, shownRole);

  // A sign-in from somewhere this account has not been seen before. Shown once
  // and then forgotten, and worded as a question rather than an alarm — the
  // usual cause is a new phone or a different network, and an app that shouts
  // at you for changing wifi is an app whose warnings you stop reading.
  try {
    if (sessionStorage.getItem('fmss_new_device') === '1') {
      sessionStorage.removeItem('fmss_new_device');
      toast('First sign-in from this network. If that was not you, change your PIN.');
    }
  } catch { /* private mode */ }
  store.activeContract = defaultContract();
  store.user = user;

  initResults(); initGameday(); initPlayers(); initContributions(); initGameweeks(); initKitty(); initSettings();
  if (user?.role === 'admin') {
    initLogins(); initExternalEvents(); initOpeningBalances(); initFinance();
  }
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

/**
 * The topbar's identity strip: who you are, the way out, and — for an admin —
 * the way to see what a player sees.
 */
function wireIdentity(user, realRole, shownRole) {
  const who = $('whoami');
  if (who) {
    const name = user?.playerId
      ? (store.players?.find(p => p.id === user.playerId)?.name || user.playerId)
      : 'Administrator';
    who.textContent = shownRole !== realRole ? `${name} — seeing the player view` : name;
    who.title = shownRole !== realRole
      ? 'You are still signed in as an administrator'
      : 'Signed in';
  }
  const viewAs = $('viewAs');
  if (viewAs) {
    // Drawn only for a real admin. In player view the role-admin-only rule
    // hides it, so it is shown explicitly and labelled to get back.
    viewAs.hidden = realRole !== 'admin';
    viewAs.textContent = shownRole === 'player' ? '← Back to admin' : 'View as player';
    viewAs.onclick = () => setViewingAsPlayer(shownRole !== 'player');
  }
  const out = $('signOut');
  if (out) out.onclick = () => signOut();
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

  // Ticking "shared device" also tells the browser not to autofill or offer to
  // remember. Browsers do not always honour it on a password field, which is
  // why the notice below says what to do if it asks anyway — promising more
  // than the platform delivers would be worse than saying nothing.
  const shared = $('loginShared');
  const notice = $('loginNotice');
  shared?.addEventListener('change', () => {
    passwordInput.setAttribute('autocomplete', shared.checked ? 'off' : 'current-password');
    passwordInput.value = '';
    if (notice) {
      notice.hidden = !shared.checked;
      notice.textContent = shared.checked
        ? 'You will be signed out when this tab closes. If the browser offers to save '
          + 'your PIN, say no.'
        : '';
    }
  });

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
      const shared = $('loginShared')?.checked === true;
      const result = await api.post('/login', body);
      // On a shared device the session dies with the tab. Everywhere else it
      // lasts, because asking somebody to sign in on their own phone every
      // morning is how you teach them to pick a PIN they will not forget
      // rather than one nobody can guess.
      setToken(result.token, { thisSessionOnly: shared });
      const user = await api.get('/me');
      setUser(user);
      if (result.newDevice) {
        // Said once, after the fact, because this is not a gate — it is the
        // one moment somebody could notice that a PIN they shared over
        // WhatsApp is being used by somebody else.
        sessionStorage.setItem('fmss_new_device', '1');
      }
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
