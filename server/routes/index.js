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
import { externalEventsRepo } from '../repos/external_events.js';
import { openingBalancesRepo } from '../repos/opening_balances.js';
import { sandboxPlayersRepo } from '../repos/sandbox_players.js';
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

// ---- admin: player login management (name + PIN) ----

// List every player + login status + PIN (for the shareable credentials panel).
r.get('/admin/logins', wrap((req) => {
  requireAdmin(req);
  return authUsersRepo.listPlayerLogins(db, playersRepo);
}));

// One-click: generate logins (random PINs) for every player without one.
r.post('/admin/logins/generate', wrap((req) => {
  requireAdmin(req);
  return authUsersRepo.generateAllPlayerLogins(db, playersRepo);
}));

// Create a login for a single player.
r.post('/admin/logins/:playerId', wrap((req) => {
  requireAdmin(req);
  return authUsersRepo.createPlayerLogin(db, playersRepo, req.params.playerId);
}));

// Reset a player's PIN → returns the new PIN.
r.post('/admin/logins/:playerId/reset', wrap((req) => {
  requireAdmin(req);
  return authUsersRepo.resetPin(db, playersRepo, req.params.playerId);
}));

// Activate / deactivate a player's login.
r.put('/admin/logins/:playerId/active', wrap((req) => {
  requireAdmin(req);
  authUsersRepo.setActive(db, req.params.playerId, !!req.body.active);
  return { ok: true };
}));

// ---- PIN security ----

// Player: change their own PIN (requires old PIN for verification).
r.post('/my/pin/change', wrap((req) => {
  if (req.user.role !== 'player') throw new Error('Players only');
  const { old_pin, new_pin } = req.body;
  if (!old_pin || !new_pin) throw new Error('old_pin and new_pin required');
  authUsersRepo.changePinForUser(db, req.user.id, req.user.playerId, old_pin, new_pin);
  return { ok: true };
}));

// Player: set PIN on first login (no old PIN verification, just set the new one).
r.post('/my/pin/set-initial', wrap((req) => {
  if (req.user.role !== 'player') throw new Error('Players only');
  const { new_pin } = req.body;
  if (!new_pin) throw new Error('new_pin required');
  authUsersRepo.changePinForUser(db, req.user.id, req.user.playerId, null, new_pin);
  return { ok: true };
}));

// ---- audit trail ----

// Player: view their own audit log (logins, PIN changes, balance adjustments).
r.get('/my/audit', wrap((req) => {
  if (req.user.role !== 'player') throw new Error('Players only');
  const logs = authUsersRepo.auditTrailForPlayer(db, req.user.playerId, 100);
  return logs.map(l => ({ ...l, details: l.details ? JSON.parse(l.details) : null }));
}));

// Admin: view all audit logs with optional filters.
r.get('/admin/audit', wrap((req) => {
  requireAdmin(req);
  const logs = authUsersRepo.auditTrailForAdmin(db, {
    action: req.query.action,
    player_id: req.query.player_id,
    user_id: req.query.user_id,
    since: req.query.since,
  }, Number(req.query.limit) || 100);
  return logs.map(l => ({ ...l, details: l.details ? JSON.parse(l.details) : null }));
}));

// ---- external events (restaurant bills, venue costs, etc.) ----

// Admin: create an external event where one person paid and costs are divided among others.
// payer_id: who paid (gets credit/incoming), participants: who shares cost (get debits/deductions)
r.post('/admin/events', wrap((req) => {
  requireAdmin(req);
  const { title, description, event_type, event_date, payer_id, participants } = req.body;
  if (!title || !event_type || !event_date || !payer_id || !participants?.length) {
    throw new Error('title, event_type, event_date, payer_id, and participants (array) required');
  }
  return externalEventsRepo.createEvent(db, authUsersRepo, req.user.id, {
    title, description, event_type, event_date, payer_id, participants
  });
}));

// Admin: list all external events.
r.get('/admin/events', wrap((req) => {
  requireAdmin(req);
  return externalEventsRepo.listEvents(db, {
    event_type: req.query.event_type,
    since: req.query.since,
    limit: Number(req.query.limit) || 100
  });
}));

// Admin: get transactions for a specific event (who paid what).
r.get('/admin/events/:eventId', wrap((req) => {
  requireAdmin(req);
  return externalEventsRepo.getEventTransactions(db, req.params.eventId);
}));

// Admin: delete an external event (refunds all participants).
r.delete('/admin/events/:eventId', wrap((req) => {
  requireAdmin(req);
  externalEventsRepo.deleteEvent(db, req.params.eventId);
  return { ok: true };
}));

// ---- player-to-player transfers (kitty transfers) ----

// Player: initiate a transfer to another player's kitty.
r.post('/my/transfers', wrap((req) => {
  if (req.user.role !== 'player') throw new Error('Players only');
  const { to_player_id, contract_id, amount, notes } = req.body;
  if (!to_player_id || !amount || amount <= 0) {
    throw new Error('to_player_id, contract_id, and amount (positive) required');
  }
  if (to_player_id === req.user.playerId) {
    throw new Error('Cannot transfer to yourself');
  }
  // Create pending transfer transaction
  const now = new Date().toISOString();
  const txnId = require('crypto').randomBytes(8).toString('hex');
  db.prepare(
    `INSERT INTO transactions (id, player_id, contract_id, type, amount, description, related_player_id, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'transfer_out', ?, ?, ?, 'pending', ?, ?, ?)`
  ).run(txnId, req.user.playerId, contract_id, -amount, notes || 'Transfer to player', to_player_id, req.user.playerId, now, now);
  return { id: txnId, status: 'pending', amount, to_player_id, message: 'Transfer pending admin approval' };
}));

// Player: view their transfers (sent and received).
r.get('/my/transfers', wrap((req) => {
  if (req.user.role !== 'player') throw new Error('Players only');
  const sent = db.prepare(
    `SELECT t.id, t.amount, t.related_player_id, p.name as to_player_name, t.status, t.created_at
     FROM transactions t
     JOIN players p ON p.id = t.related_player_id
     WHERE t.player_id = ? AND t.type = 'transfer_out'
     ORDER BY t.created_at DESC`
  ).all(req.user.playerId);
  const received = db.prepare(
    `SELECT t.id, t.amount, t.player_id, p.name as from_player_name, t.status, t.created_at
     FROM transactions t
     JOIN players p ON p.id = t.player_id
     WHERE t.related_player_id = ? AND t.type IN ('transfer_in', 'transfer_out')
     ORDER BY t.created_at DESC`
  ).all(req.user.playerId);
  return { sent, received };
}));

// Admin: approve a pending transfer (creates matching credit to recipient).
r.post('/admin/transfers/:txnId/approve', wrap((req) => {
  requireAdmin(req);
  const txn = db.prepare('SELECT * FROM transactions WHERE id = ? AND type = \'transfer_out\'').get(req.params.txnId);
  if (!txn) throw new Error('Transfer not found');
  if (txn.status !== 'pending') throw new Error('Only pending transfers can be approved');

  const now = new Date().toISOString();
  // Mark transfer_out as approved
  db.prepare('UPDATE transactions SET status = ?, approved_by = ?, updated_at = ? WHERE id = ?')
    .run('approved', req.user.id, now, req.params.txnId);

  // Create matching transfer_in for recipient
  db.prepare(
    `INSERT INTO transactions (id, player_id, contract_id, type, amount, description, related_player_id, status, approved_by, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'transfer_in', ?, ?, ?, 'approved', ?, ?, ?, ?)`
  ).run(
    require('crypto').randomBytes(8).toString('hex'),
    txn.related_player_id, txn.contract_id, txn.amount, // positive = credit
    txn.description, txn.player_id, req.user.id, req.user.id, now, now
  );

  return { ok: true, status: 'approved' };
}));

// Admin: reject a pending transfer.
r.post('/admin/transfers/:txnId/reject', wrap((req) => {
  requireAdmin(req);
  const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.txnId);
  if (!txn) throw new Error('Transfer not found');
  if (txn.status !== 'pending') throw new Error('Only pending transfers can be rejected');

  db.prepare('UPDATE transactions SET status = ?, approved_by = ? WHERE id = ?')
    .run('rejected', req.user.id, req.params.txnId);
  return { ok: true, status: 'rejected' };
}));

// Admin: view all pending transfers.
r.get('/admin/transfers', wrap((req) => {
  requireAdmin(req);
  const status = req.query.status || 'pending';
  return db.prepare(
    `SELECT t.id, t.player_id, p1.name as from_player, t.related_player_id, p2.name as to_player,
            t.amount, t.contract_id, t.status, t.created_at
     FROM transactions t
     JOIN players p1 ON p1.id = t.player_id
     JOIN players p2 ON p2.id = t.related_player_id
     WHERE t.type = 'transfer_out' AND t.status = ?
     ORDER BY t.created_at DESC
     LIMIT ?`
  ).all(status, Number(req.query.limit) || 100);
}));

// ---- opening balances (1 Aug baseline per contract) ----

// Admin: import opening balances for a contract (bulk from CSV or manual entry).
r.post('/admin/opening-balances/import', wrap((req) => {
  requireAdmin(req);
  const { contract_id, balances } = req.body;
  if (!contract_id || !balances?.length) {
    throw new Error('contract_id and balances array required');
  }
  return openingBalancesRepo.importBalances(db, playersRepo, contract_id, balances);
}));

// Admin: get current opening balances for a contract (for verification).
r.get('/admin/opening-balances/:contractId', wrap((req) => {
  requireAdmin(req);
  const balances = openingBalancesRepo.getBalances(db, playersRepo, req.params.contractId);
  const summary = openingBalancesRepo.getSummary(db, req.params.contractId);
  return { balances, summary };
}));

// ---- Sandbox Players (test environment) ----
// Admin: create a test player (sandboxed, can be safely deleted with all data)
r.post('/admin/sandbox/players', wrap((req) => {
  requireAdmin(req);
  if (!req.body.name) throw new Error('name required');
  return sandboxPlayersRepo.createSandbox(db, req.body.name);
}));

// Admin: list all test players
r.get('/admin/sandbox/players', wrap((req) => {
  requireAdmin(req);
  return sandboxPlayersRepo.listSandbox(db);
}));

// Admin: delete a test player and cascade-clean all their data
r.delete('/admin/sandbox/players/:playerId', wrap((req) => {
  requireAdmin(req);
  return sandboxPlayersRepo.deleteSandbox(db, req.params.playerId);
}));

export default r;
