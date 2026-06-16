// api.js — fetch wrapper for the FMSS API (no auth).
async function req(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, opts);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
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
};
