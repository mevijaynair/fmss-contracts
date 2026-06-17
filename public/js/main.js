// main.js — bootstrap: load shared data, build nav, wire per-view loads.
// Auth: check token on startup; if missing/invalid, show login. Otherwise load app.
import { api } from './api.js';
import { store, toast } from './store.js';
import { buildNav, showView } from './router.js';
import { initTheme } from './theme.js';
import { $, closeModal } from './util.js';

// Token management
const TOKEN_KEY = 'fmss_token';
export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function setToken(token) { localStorage.setItem(TOKEN_KEY, token); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }
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

  // Load app
  buildNav();
  [store.contracts, store.players] = await Promise.all([api.contracts(), api.players()]);
  store.activeContract = store.contracts[0]?.id || 'sat';

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
  // Hide the main shell; show login form
  document.querySelector('.shell').style.display = 'none';
  $('loginView').style.display = 'block';

  // Wire login form
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('loginPassword').value;
    try {
      const result = await api.post('/login', { password });
      setToken(result.token);
      $('loginView').style.display = 'none';
      document.querySelector('.shell').style.display = 'flex';
      start();  // restart the app with the new token
    } catch (err) {
      $('loginError').textContent = 'Invalid password';
      $('loginError').style.display = 'block';
    }
  });
}

// Let any module refresh the shared player list after a create.
export async function refreshPlayers() {
  store.players = await api.players();
}

window.addEventListener('DOMContentLoaded', start);
