// routes/index.js — all FMSS API endpoints (auth required; role-based filtering).
// Two-tier: admin sees everything, players see only their own data.
import { Router } from 'express';
import { contractsRepo } from '../repos/contracts.js';
import { playersRepo } from '../repos/players.js';
import { ledgersRepo } from '../repos/ledgers.js';
import { gameweeksRepo } from '../repos/gameweeks.js';
import { contributionsRepo } from '../repos/contributions.js';
import { kittyRepo } from '../repos/kitty.js';
import { statsRepo } from '../repos/stats.js';
import { auditRepo } from '../repos/audit.js';
import { parseTeams } from '../parser.js';

const r = Router();
const wrap = (fn) => (req, res) => {
  try { const out = fn(req, res); if (out !== undefined) res.json(out); }
  catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
};

// ---- authentication ----
r.get('/me', wrap((req) => ({
  id: req.user.id,
  role: req.user.role,
  playerId: req.user.playerId,
  email: req.user.email,
})));

// ---- contracts ----
r.get('/contracts', wrap(() => contractsRepo.all()));
r.put('/contracts/:id', wrap((req) => contractsRepo.update(req.params.id, req.body)));

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

r.get('/ledgers', wrap((req) =>
  req.query.contract ? ledgersRepo.forContract(req.query.contract) : ledgersRepo.all()));
r.put('/ledgers/:playerId/:contractId/status', wrap((req) => {
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
  const { gameweek, charges } = req.body;
  if (!gameweek?.contract_id) throw new Error('contract_id required');
  return gameweeksRepo.create(gameweek, charges || []);
}));
r.delete('/gameweeks/:id', wrap((req) => { gameweeksRepo.remove(req.params.id); return { ok: true }; }));

// ---- gameweek edit with impact preview & audit ----
r.get('/gameweeks/:id/impact', wrap((req) => {
  const { chargeEdits } = req.query;
  if (!chargeEdits) return { playerImpacts: [] };
  return gameweeksRepo.previewChargeEdits(req.params.id, JSON.parse(chargeEdits));
}));
r.put('/gameweeks/:id', wrap((req) => {
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
  const { contract_id, text } = req.body;
  const contract = contractsRepo.get(contract_id);
  if (!contract) throw new Error('Unknown contract');
  const players = playersRepo.all();
  const statusOf = {};
  for (const l of ledgersRepo.forContract(contract_id)) statusOf[l.player_id] = l.status;
  return parseTeams(text || '', players, statusOf, contract.rates);
}));

// ---- contributions ----
r.get('/contributions', wrap((req) =>
  contributionsRepo.all({ playerId: req.query.player, contractId: req.query.contract })));
r.post('/contributions', wrap((req) => contributionsRepo.create(req.body)));
r.delete('/contributions/:id', wrap((req) => { contributionsRepo.remove(req.params.id); return { ok: true }; }));

// ---- kitty ----
r.get('/kitty', wrap(() => ({ entries: kittyRepo.all(), ...kittyRepo.balance() })));
r.post('/kitty', wrap((req) => kittyRepo.create(req.body)));
r.delete('/kitty/:id', wrap((req) => { kittyRepo.remove(req.params.id); return { ok: true }; }));

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
r.get('/dashboard', wrap(() => {
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
    players: playersRepo.all().length,
    kitty: kittyRepo.balance(),
    contracts: perContract,
  };
}));

export default r;
