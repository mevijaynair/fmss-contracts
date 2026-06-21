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

const LOADERS = {
  dashboard: loadDashboard,
  results: loadResults,
  gameday: loadGameday,
  players: loadPlayers,
  contributions: loadContributions,
  gameweeks: loadGameweeks,
  kitty: loadKitty,
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

  initResults(); initGameday(); initPlayers(); initContributions(); initGameweeks(); initKitty(); initSettings();

  window.addEventListener('fmss:view', (e) => {
    const fn = LOADERS[e.detail];
    if (fn) Promise.resolve(fn()).catch(err => toast(err.message, true));
  });

  $('modalClose').addEventListener('click', closeModal);
  document.querySelector('#modal .modal-overlay').addEventListener('click', closeModal);

  showView('dashboard');
}

function showLoginView() {
  // Hide the main shell; show the full-screen login overlay (flex-centered).
  document.querySelector('.shell').style.display = 'none';
  $('loginView').style.display = 'flex';

  const emailGroup = $('emailGroup');
  const passwordLabel = $('passwordLabel');
  const toggle = $('playerLoginToggle');

  // Toggle between player and admin login modes
  toggle.addEventListener('change', () => {
    if (toggle.checked) {
      emailGroup.style.display = 'block';
      passwordLabel.textContent = 'Password';
    } else {
      emailGroup.style.display = 'none';
      passwordLabel.textContent = 'Admin Password';
    }
  });

  // Wire login form
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const isPlayerLogin = toggle.checked;
    const email = isPlayerLogin ? $('loginEmail').value : null;
    const password = $('loginPassword').value;

    if (isPlayerLogin && !email) {
      showLoginError('Please enter your email');
      return;
    }

    try {
      const result = await api.post('/login', { email, password });
      setToken(result.token);

      // Fetch user info to store role + playerId
      const user = await api.get('/me');
      setUser(user);

      // start() (authenticated path) hides the overlay and restores the shell.
      start();
    } catch (err) {
      showLoginError(err.message || 'Login failed');
    }
  });
}

function showLoginError(message) {
  const err = $('loginError');
  err.textContent = message;
  err.style.display = 'block';
}

// Let any module refresh the shared player list after a create.
export async function refreshPlayers() {
  store.players = await api.players();
}

window.addEventListener('DOMContentLoaded', start);
