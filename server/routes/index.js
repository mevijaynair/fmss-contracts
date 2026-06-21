// routes/index.js — all FMSS API endpoints (auth required; role-based filtering).
// Two-tier: admin sees everything, players see only their own data.
import { Router } from 'express';
import { db } from '../db.js';
import { contractsRepo } from '../repos/contracts.js';
import { playersRepo } from '../repos/players.js';
import { ledgersRepo } from '../repos/ledgers.js';
import { gameweeksRepo } from '../repos/gameweeks.js';
import { contributionsRepo } from '../repos/contributions.js';
import { pendingContributionsRepo } from '../repos/contributions_pending.js';
import { kittyRepo } from '../repos/kitty.js';
import { statsRepo } from '../repos/stats.js';
import { auditRepo } from '../repos/audit.js';
import { authUsersRepo } from '../repos/auth_users.js';
import { parseTeams } from '../parser.js';

const r = Router();
const wrap = (fn) => (req, res) => {
  try { const out = fn(req, res); if (out !== undefined) res.json(out); }
  catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
};

// Throw if the caller is not an admin. Used to gate all mutating endpoints so a
// player token can never create/edit/delete club-wide data.
function requireAdmin(req) {
  if (req.user.role !== 'admin') throw new Error('Admin only');
}

// ---- authentication ----
r.get('/me', wrap((req) => ({
  id: req.user.id,
  role: req.user.role,
  playerId: req.user.playerId,
  email: req.user.email,
})));

// ---- contracts ----
r.get('/contracts', wrap(() => contractsRepo.all()));
r.put('/contracts/:id', wrap((req) => { requireAdmin(req); return contractsRepo.update(req.params.id, req.body); }));

// ---- players + ledgers ----
r.get('/players', wrap((req) => {
  // Admin: see all players; Player: see only self
  if (req.user.role === 'player') {
    const player = playersRepo.get(req.user.playerId);
    return player ? [player] : [];
  }
  return playersRepo.all();
}));
r.post('/players', wrap((req) => {
  // Admin only
  if (req.user.role !== 'admin') throw new Error('Admin only');
  return playersRepo.create(req.body);
}));
r.put('/players/:id', wrap((req) => {
  // Admin only
  if (req.user.role !== 'admin') throw new Error('Admin only');
  return playersRepo.update(req.params.id, req.body);
}));
r.get('/players/:id/ledgers', wrap((req) => {
  // Admin: see any player's ledgers; Player: see only self
  if (req.user.role === 'player' && req.params.id !== req.user.playerId) {
    throw new Error('Forbidden');
  }
  return ledgersRepo.forPlayer(req.params.id);
}));
r.get('/my/ledgers', wrap((req) => {
  // Player view: their ledgers across all contracts
  if (req.user.role !== 'player') throw new Error('Player only');
  return ledgersRepo.forPlayer(req.user.playerId);
}));

r.get('/ledgers', wrap((req) => {
  // Admin: all/by-contract; Player: scoped to self
  if (req.user.role === 'player') {
    return ledgersRepo.forPlayer(req.user.playerId)
      .filter(l => !req.query.contract || l.contract_id === req.query.contract);
  }
  return req.query.contract ? ledgersRepo.forContract(req.query.contract) : ledgersRepo.all();
}));
r.put('/ledgers/:playerId/:contractId/status', wrap((req) => {
  requireAdmin(req);
  ledgersRepo.setStatus(req.params.playerId, req.params.contractId, req.body.status || '');
  return ledgersRepo.get(req.params.playerId, req.params.contractId);
}));

// ---- gameweeks ----
r.get('/gameweeks', wrap((req) => gameweeksRepo.all(req.query.contract)));
r.get('/gameweeks/:id', wrap((req) => {
  const g = gameweeksRepo.get(req.params.id);
  if (!g) throw new Error('Gameweek not found');
  return g;
}));
r.post('/gameweeks', wrap((req) => {
  requireAdmin(req);
  const { gameweek, charges } = req.body;
  if (!gameweek?.contract_id) throw new Error('contract_id required');
  return gameweeksRepo.create(gameweek, charges || []);
}));
r.delete('/gameweeks/:id', wrap((req) => { requireAdmin(req); gameweeksRepo.remove(req.params.id); return { ok: true }; }));

// ---- gameweek edit with impact preview & audit ----
r.get('/gameweeks/:id/impact', wrap((req) => {
  const { chargeEdits } = req.query;
  if (!chargeEdits) return { playerImpacts: [] };
  return gameweeksRepo.previewChargeEdits(req.params.id, JSON.parse(chargeEdits));
}));
r.put('/gameweeks/:id', wrap((req) => {
  requireAdmin(req);
  const { metadata, chargeEdits, reason, autoRecalculate } = req.body;
  const g = gameweeksRepo.get(req.params.id);
  if (!g) throw new Error('Gameweek not found');
  // Update metadata (game_type, tournament_name, score, etc.)
  if (metadata) gameweeksRepo.updateMetadata(req.params.id, metadata);
  // Apply charge edits with audit trail
  if (chargeEdits?.length) {
    gameweeksRepo.applyChargeEdits(req.params.id, chargeEdits, {
      reason,
      changedBy: 'web-ui',
      autoRecalculate: autoRecalculate !== false,
    });
  }
  return gameweeksRepo.get(req.params.id);
}));

// ---- WhatsApp parse → charge preview ----
r.post('/parse', wrap((req) => {
  requireAdmin(req);
  const { contract_id, text } = req.body;
  const contract = contractsRepo.get(contract_id);
  if (!contract) throw new Error('Unknown contract');
  const players = playersRepo.all();
  const statusOf = {};
  for (const l of ledgersRepo.forContract(contract_id)) statusOf[l.player_id] = l.status;
  return parseTeams(text || '', players, statusOf, contract.rates);
}));

// ---- contributions ----
r.get('/contributions', wrap((req) => {
  // Player: scoped to self (ignores any player query param); Admin: full filter
  if (req.user.role === 'player') {
    return contributionsRepo.all({ playerId: req.user.playerId, contractId: req.query.contract });
  }
  return contributionsRepo.all({ playerId: req.query.player, contractId: req.query.contract });
}));
r.post('/contributions', wrap((req) => { requireAdmin(req); return contributionsRepo.create(req.body); }));
r.delete('/contributions/:id', wrap((req) => { requireAdmin(req); contributionsRepo.remove(req.params.id); return { ok: true }; }));

// ---- player self-service: submit contribution for approval ----
r.get('/my/contributions', wrap((req) => {
  if (req.user.role !== 'player') throw new Error('Player only');
  // Approved (live) contributions + the player's pending/rejected submissions.
  const approved = contributionsRepo.all({ playerId: req.user.playerId });
  const pending = pendingContributionsRepo.forPlayer(req.user.playerId);
  return { approved, pending };
}));
r.post('/my/contributions', wrap((req) => {
  if (req.user.role !== 'player') throw new Error('Player only');
  const { contract_id, amount, date, payment_method } = req.body;
  return pendingContributionsRepo.create({
    player_id: req.user.playerId, contract_id, amount, date, payment_method,
  });
}));
r.get('/my/stats', wrap((req) => {
  if (req.user.role !== 'player') throw new Error('Player only');
  const { contract_id } = req.query;
  if (!contract_id) throw new Error('contract_id required');
  const timeline = statsRepo.playerTimeline(req.user.playerId, contract_id);
  const stats = statsRepo.playerStats(req.user.playerId, contract_id);
  return { timeline, ...stats };
}));

// ---- admin: contribution approval queue ----
r.get('/admin/contributions/pending', wrap((req) => {
  requireAdmin(req);
  return pendingContributionsRepo.allPending();
}));
r.post('/admin/contributions/:id/approve', wrap((req) => {
  requireAdmin(req);
  return pendingContributionsRepo.approve(req.params.id, req.user.email || 'admin');
}));
r.post('/admin/contributions/:id/reject', wrap((req) => {
  requireAdmin(req);
  return pendingContributionsRepo.reject(req.params.id, req.user.email || 'admin');
}));

// ---- kitty ----
r.get('/kitty', wrap((req) => { requireAdmin(req); return { entries: kittyRepo.all(), ...kittyRepo.balance() }; }));
r.post('/kitty', wrap((req) => { requireAdmin(req); return kittyRepo.create(req.body); }));
r.delete('/kitty/:id', wrap((req) => { requireAdmin(req); kittyRepo.remove(req.params.id); return { ok: true }; }));

// ---- results: match history with full context ----
r.get('/results', wrap((req) => {
  const contractId = req.query.contract;
  const games = contractId
    ? gameweeksRepo.all(contractId)
    : gameweeksRepo.all();
  return games.map(g => {
    const charges = gameweeksRepo.get(g.id).charges || [];
    return {
      ...g,
      charges,
      total_charged: gameweeksRepo.chargeTotal(g.id),
      players_count: charges.length,
    };
  });
}));

// ---- player stats: timeline, cost breakdown, streaks ----
r.get('/players/:id/stats', wrap((req) => {
  // Player may only read their own stats; admin may read anyone's.
  if (req.user.role === 'player' && req.params.id !== req.user.playerId) {
    throw new Error('Forbidden');
  }
  const { contract_id } = req.query;
  if (!contract_id) throw new Error('contract_id required');
  const timeline = statsRepo.playerTimeline(req.params.id, contract_id);
  const stats = statsRepo.playerStats(req.params.id, contract_id);
  return { timeline, ...stats };
}));

// ---- audit trail: view charge history ----
r.get('/audit/charges', wrap((req) => {
  const { player_id, gameweek_id, charge_id } = req.query;
  if (charge_id) return auditRepo.forCharge(charge_id);
  if (gameweek_id) return auditRepo.forGameweek(gameweek_id);
  if (player_id) return auditRepo.forPlayer(player_id, Number(req.query.limit) || 50);
  throw new Error('player_id, gameweek_id, or charge_id required');
}));

// ---- dashboard summary ----
r.get('/dashboard', wrap((req) => {
  // Player dashboard: only their own balances across contracts.
  if (req.user.role === 'player') {
    const myLedgers = ledgersRepo.forPlayer(req.user.playerId);
    return {
      role: 'player',
      player_id: req.user.playerId,
      contracts: myLedgers.map(l => ({
        id: l.contract_id,
        name: store_contractName(l.contract_id),
        opening_balance: l.opening_balance,
        contributed: l.contributed,
        charged: l.charged,
        present_balance: l.present_balance,
        games: l.games,
        status: l.status,
      })),
    };
  }

  // Admin dashboard: club-wide aggregates.
  const contracts = contractsRepo.all();
  const perContract = contracts.map((c) => {
    const ledgers = ledgersRepo.forContract(c.id);
    const credit = ledgers.filter(l => l.present_balance > 0).reduce((s, l) => s + l.present_balance, 0);
    const debt = ledgers.filter(l => l.present_balance < 0).reduce((s, l) => s + l.present_balance, 0);
    const refills = ledgers.filter(l => l.present_balance < 0);
    return {
      id: c.id, name: c.name, venue: c.venue,
      players: ledgers.length,
      net: Math.round(ledgers.reduce((s, l) => s + l.present_balance, 0) * 100) / 100,
      credit: Math.round(credit * 100) / 100,
      debt: Math.round(debt * 100) / 100,
      refill_count: refills.length,
      watchlist: refills.slice(0, 12).map(l => ({ name: l.player_name, balance: l.present_balance })),
      games: gameweeksRepo.all(c.id).length,
    };
  });
  return {
    role: 'admin',
    players: playersRepo.all().length,
    kitty: kittyRepo.balance(),
    pending_contributions: pendingContributionsRepo.pendingCount(),
    contracts: perContract,
  };
}));

// Helper: resolve a contract's display name (used by the player dashboard).
function store_contractName(id) {
  return contractsRepo.get(id)?.name || id;
}

// ---- admin: user management ----
r.post('/admin/users', wrap((req) => {
  // Admin only: create a new player account
  if (req.user.role !== 'admin') throw new Error('Admin only');
  const { email, password, player_id } = req.body;
  if (!email || !password || !player_id) {
    throw new Error('email, password, and player_id are required');
  }
  return authUsersRepo.createPlayer(db, { email, password, playerId: player_id });
}));

r.get('/admin/users', wrap((req) => {
  // Admin only: list all player accounts
  if (req.user.role !== 'admin') throw new Error('Admin only');
  return authUsersRepo.listUsers(db, { role: 'player' });
}));

r.put('/admin/users/:id', wrap((req) => {
  // Admin only: update player account (email, password, reset password)
  if (req.user.role !== 'admin') throw new Error('Admin only');
  const { email, password } = req.body;
  if (password === 'RESET') {
    const tempPassword = authUsersRepo.resetPassword(db, req.params.id);
    return { id: req.params.id, tempPassword, note: 'Password has been reset to temp value' };
  }
  return authUsersRepo.updateUser(db, req.params.id, { email, password });
}));

r.delete('/admin/users/:id', wrap((req) => {
  // Admin only: deactivate player account
  if (req.user.role !== 'admin') throw new Error('Admin only');
  authUsersRepo.deactivateUser(db, req.params.id);
  return { ok: true };
}));

export default r;
