// routes/index.js — all FMSS API endpoints (no auth; single local user).
import { Router } from 'express';
import { contractsRepo } from '../repos/contracts.js';
import { playersRepo } from '../repos/players.js';
import { ledgersRepo } from '../repos/ledgers.js';
import { gameweeksRepo } from '../repos/gameweeks.js';
import { contributionsRepo } from '../repos/contributions.js';
import { kittyRepo } from '../repos/kitty.js';
import { parseTeams } from '../parser.js';

const r = Router();
const wrap = (fn) => (req, res) => {
  try { const out = fn(req, res); if (out !== undefined) res.json(out); }
  catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
};

// ---- contracts ----
r.get('/contracts', wrap(() => contractsRepo.all()));
r.put('/contracts/:id', wrap((req) => contractsRepo.update(req.params.id, req.body)));

// ---- players + ledgers ----
r.get('/players', wrap(() => playersRepo.all()));
r.post('/players', wrap((req) => playersRepo.create(req.body)));
r.put('/players/:id', wrap((req) => playersRepo.update(req.params.id, req.body)));
r.get('/players/:id/ledgers', wrap((req) => ledgersRepo.forPlayer(req.params.id)));

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
