// api.js — fetch wrapper for the FMSS API.
// Attaches JWT token from localStorage to every request (except /login).
async function req(method, path, body) {
  const opts = { method, headers: {} };

  // Attach token for protected endpoints
  if (!path.includes('/login')) {
    const token = localStorage.getItem('fmss_token');
    if (token) {
      opts.headers['Authorization'] = `Bearer ${token}`;
    }
  }

  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, opts);

  // If 401, token expired — clear and reload to show login
  if (res.status === 401) {
    localStorage.removeItem('fmss_token');
    window.location.reload();
    return;
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  // Helper methods
  get: (path) => req('GET', path),
  put: (path, body) => req('PUT', path, body),
  post: (path, body) => req('POST', path, body),
  delete: (path) => req('DELETE', path),

  dashboard: () => req('GET', '/dashboard'),

  contracts: () => req('GET', '/contracts'),
  updateContract: (id, c) => req('PUT', `/contracts/${id}`, c),

  players: () => req('GET', '/players'),
  createPlayer: (p) => req('POST', '/players', p),
  updatePlayer: (id, p) => req('PUT', `/players/${id}`, p),

  ledgers: (contract) => req('GET', `/ledgers${contract ? `?contract=${contract}` : ''}`),
  setStatus: (pid, cid, status) => req('PUT', `/ledgers/${pid}/${cid}/status`, { status }),

  gameweeks: (contract) => req('GET', `/gameweeks${contract ? `?contract=${contract}` : ''}`),
  gameweek: (id) => req('GET', `/gameweeks/${id}`),
  createGameweek: (gameweek, charges) => req('POST', '/gameweeks', { gameweek, charges }),
  deleteGameweek: (id) => req('DELETE', `/gameweeks/${id}`),

  parse: (contract_id, text) => req('POST', '/parse', { contract_id, text }),

  contributions: (q = {}) => {
    const p = new URLSearchParams(q).toString();
    return req('GET', `/contributions${p ? `?${p}` : ''}`);
  },
  createContribution: (c) => req('POST', '/contributions', c),
  deleteContribution: (id) => req('DELETE', `/contributions/${id}`),

  kitty: () => req('GET', '/kitty'),
  createKitty: (k) => req('POST', '/kitty', k),
  deleteKitty: (id) => req('DELETE', `/kitty/${id}`),

  // New endpoints (Phase 1 backend)
  results: (contract) => req('GET', `/results${contract ? `?contract=${contract}` : ''}`),
  playerStats: (playerId, contractId) => req('GET', `/players/${playerId}/stats?contract_id=${contractId}`),
  auditTrail: (q = {}) => {
    const p = new URLSearchParams(q).toString();
    return req('GET', `/audit/charges${p ? `?${p}` : ''}`);
  },

  // ---- two-tier (Phase 2) ----
  me: () => req('GET', '/me'),
  myLedgers: () => req('GET', '/my/ledgers'),
  myContributions: () => req('GET', '/my/contributions'),
  submitContribution: (c) => req('POST', '/my/contributions', c),
  myStats: (contractId) => req('GET', `/my/stats?contract_id=${contractId}`),

  // ---- admin: contribution approval ----
  pendingContributions: () => req('GET', '/admin/contributions/pending'),
  approveContribution: (id) => req('POST', `/admin/contributions/${id}/approve`, {}),
  rejectContribution: (id) => req('POST', `/admin/contributions/${id}/reject`, {}),

  // ---- admin: user management ----
  users: () => req('GET', '/admin/users'),
  createUser: (u) => req('POST', '/admin/users', u),
  updateUser: (id, u) => req('PUT', `/admin/users/${id}`, u),
  deleteUser: (id) => req('DELETE', `/admin/users/${id}`),
};
