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
import { gameResultsRepo } from '../repos/game_results.js';
import { gameFinancingRepo } from '../repos/game_financing.js';
import { playerRelationshipsRepo } from '../repos/player_relationships.js';
import { outsidePlayersRepo } from '../repos/outside_players.js';
import { kittyOpeningBalanceRepo } from '../repos/kitty_opening_balance.js';
import { parseTeams } from '../parser.js';
import { parseResultsSheet, normaliseScore, winningTeam } from '../results_import.js';
import { exportAll, inspect as inspectBackup, restore as restoreBackup, BACKUP_FORMAT } from '../backup.js';

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
r.delete('/admin/players/:id', wrap((req) => {
  // Admin: completely delete a player + all ledger/contribution entries
  if (req.user.role !== 'admin') throw new Error('Admin only');
  playersRepo.delete(req.params.id);
  return { success: true, message: `Player ${req.params.id} deleted` };
}));
r.post('/admin/players/:id/reset', wrap((req) => {
  // Admin: reset a player's balance to 0, clear contributions, keep player
  if (req.user.role !== 'admin') throw new Error('Admin only');
  playersRepo.reset(req.params.id);
  return { success: true, message: `Player ${req.params.id} reset` };
}));
r.post('/admin/bulk-import/kitty-entries', wrap((req) => {
  // Admin: bulk import Kitty entries
  if (req.user.role !== 'admin') throw new Error('Admin only');
  const { data } = req.body;
  if (!data) throw new Error('data required');

  const lines = data.trim().split('\n').filter(l => l.trim());
  let imported = 0;

  for (const line of lines) {
    const parts = line.split(/\t|,/).map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;

    const label = parts[0];
    const amount = parseFloat(parts[1]);
    if (!label || isNaN(amount)) continue;

    // Determine kind based on amount (positive = income, negative = expense)
    const kind = amount > 0 ? 'income' : 'expense';
    const absAmount = Math.abs(amount);

    db.prepare(`INSERT INTO kitty (id,kind,label,amount,date,historical,created_at)
                VALUES (?,?,?,?,?,1,?)`)
      .run(
        `k_imp_${Date.now()}_${imported}`,
        kind,
        label,
        absAmount,
        new Date().toISOString().slice(0, 10),
        new Date().toISOString()
      );
    imported++;
  }

  return { success: true, imported, message: `Imported ${imported} Kitty entries` };
}));
r.post('/admin/bulk-import/players-and-balances', wrap((req) => {
  // Admin: bulk create players and set opening balances for a contract
  if (req.user.role !== 'admin') throw new Error('Admin only');
  const { contract_id, data } = req.body;
  if (!contract_id || !data) throw new Error('contract_id and data required');

  const lines = data.trim().split('\n').filter(l => l.trim());
  let created = 0, updated = 0;

  for (const line of lines) {
    const parts = line.split(/\t|,/).map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;

    const name = parts[0];
    const balance = parseFloat(parts[1]);
    if (!name || isNaN(balance)) continue;

    // Create player if not exists
    let player = db.prepare('SELECT id FROM players WHERE LOWER(name) = LOWER(?)').get(name);
    if (!player) {
      const playerId = playersRepo.create({ name, aliases: [] }).id;
      created++;
    } else {
      created++; // count as created for new entries
    }

    // Get player id
    player = db.prepare('SELECT id FROM players WHERE LOWER(name) = LOWER(?)').get(name);

    // Update or create ledger
    const existing = db.prepare('SELECT 1 FROM ledgers WHERE player_id = ? AND contract_id = ?').get(player.id, contract_id);
    if (existing) {
      db.prepare('UPDATE ledgers SET opening_balance = ? WHERE player_id = ? AND contract_id = ?')
        .run(balance, player.id, contract_id);
    } else {
      db.prepare('INSERT INTO ledgers (player_id, contract_id, opening_balance, status) VALUES (?, ?, ?, ?)')
        .run(player.id, contract_id, balance, '');
    }
    updated++;
  }

  return { success: true, created, updated, message: `Imported ${created} players, updated ${updated} balances` };
}));
r.get('/players/:id/ledgers', wrap((req) => {
  // Admin: see any player's ledgers; Player: see only self
  if (req.user.role === 'player' && req.params.id !== req.user.playerId) {
    throw new Error('Forbidden');
  }
  return ledgersRepo.forPlayer(req.params.id);
}));

r.get('/players/:id/ledgers/combined', wrap((req) => {
  // Combined view: all contracts aggregated into one row
  if (req.user.role === 'player' && req.params.id !== req.user.playerId) {
    throw new Error('Forbidden');
  }
  return ledgersRepo.forPlayerCombined(req.params.id);
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
  const rows = req.query.contract
    ? ledgersRepo.forContract(req.query.contract)
    : ledgersRepo.all();

  // Attach the same runway the dashboard uses, plus the roster flags, so the
  // players table can say "2 games left" and mark guests rather than leaving the
  // reader to work it out from a raw balance.
  const rateFor = {};
  for (const c of contractsRepo.all()) {
    const rates = typeof c.rates === 'string'
      ? (() => { try { return JSON.parse(c.rates || '{}'); } catch { return {}; } })()
      : (c.rates || {});
    rateFor[c.id] = Number(rates.contracted_10) || Number(rates.noncontract) || 0;
  }
  const meta = Object.fromEntries(playersRepo.all().map(p => [p.id, p]));
  return rows.map(l => {
    const rate = rateFor[l.contract_id] || 0;
    const p = meta[l.player_id] || {};
    return {
      ...l,
      rate,
      games_left: rate > 0 ? Math.floor(l.present_balance / rate) : null,
      player_type: p.player_type || 'regular',
      is_sandbox: p.is_sandbox ? 1 : 0,
      balance_group_id: p.balance_group_id || null,
      special_role: p.special_role || null,
    };
  });
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

// ---- per-player edits on an existing game ----
// After an import, names the sheet used may not have matched anyone. The raw
// team text is kept on the gameweek so the gaps can be filled in here.
r.post('/gameweeks/:id/charges', wrap((req) => {
  requireAdmin(req);
  return gameweeksRepo.addCharge(req.params.id, req.body || {});
}));
r.put('/gameweeks/:id/charges/:chargeId', wrap((req) => {
  requireAdmin(req);
  return gameweeksRepo.updateCharge(req.params.id, req.params.chargeId, req.body || {});
}));
r.delete('/gameweeks/:id/charges/:chargeId', wrap((req) => {
  requireAdmin(req);
  return gameweeksRepo.removeCharge(req.params.id, req.params.chargeId);
}));

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

// ---- game accounting: scoreline, teams, result, costs ----
r.post('/gameweeks/:id/accounting', wrap((req) => {
  requireAdmin(req);
  const { scoreline, teams_json, whatsapp_message, game_cost, game_cost_paid_by, kitty_earned, team_a_name, team_b_name, goals_team_a, goals_team_b } = req.body;

  // Update gameweek accounting fields
  gameweeksRepo.updateGameAccounting(req.params.id, {
    scoreline, teams_json, whatsapp_message, game_cost, game_cost_paid_by, kitty_earned
  });

  // If result data provided, create or update game result
  if (team_a_name && team_b_name && typeof goals_team_a === 'number' && typeof goals_team_b === 'number') {
    const existing = db.prepare('SELECT id FROM game_results WHERE gameweek_id = ?').get(req.params.id);
    if (existing) {
      gameResultsRepo.update(db, req.params.id, team_a_name, team_b_name, goals_team_a, goals_team_b);
    } else {
      gameResultsRepo.create(db, req.params.id, team_a_name, team_b_name, goals_team_a, goals_team_b);
    }
  }

  return gameweeksRepo.getFullGame(req.params.id);
}));

// Record water cost payment / who paid
r.post('/gameweeks/:id/water-cost', wrap((req) => {
  requireAdmin(req);
  const { payer_id, amount, notes } = req.body;
  const g = gameweeksRepo.get(req.params.id);
  if (!g) throw new Error('Gameweek not found');

  // Delete existing water cost record if any
  db.prepare('DELETE FROM game_financing WHERE gameweek_id = ? AND category = ?').run(req.params.id, 'water_cost');

  // Create new water cost record
  return gameFinancingRepo.create(db, req.params.id, g.contract_id, 'water_cost', payer_id, amount, notes);
}));

// Record kitty collection / provisional payment
r.post('/gameweeks/:id/kitty', wrap((req) => {
  requireAdmin(req);
  const { payer_id, amount, notes } = req.body;
  const g = gameweeksRepo.get(req.params.id);
  if (!g) throw new Error('Gameweek not found');

  return gameFinancingRepo.create(db, req.params.id, g.contract_id, 'kitty_collection', payer_id, amount, notes);
}));

// Settle a provisional payment
r.post('/gameweeks/:id/financing/:financing_id/settle', wrap((req) => {
  requireAdmin(req);
  gameFinancingRepo.settle(db, req.params.financing_id);
  return gameweeksRepo.getFullGame(req.params.id);
}));

// Get full game data with results and financing
r.get('/gameweeks/:id/full', wrap((req) => {
  const g = gameweeksRepo.getFullGame(req.params.id);
  if (!g) throw new Error('Gameweek not found');
  return g;
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

// ---- results sheet import ----
// Two-phase on purpose: without `commit` this only reports what WOULD happen, so
// unmatched names surface before anything is written.
//
// Imported games are financial-nil. Participation only exists in `charges`, so
// rows are written there, but every amount is 0 — this records who played, on
// which team, and who captained. It never moves a balance.
r.post('/admin/import/results', wrap((req) => {
  requireAdmin(req);
  const { contract_id: contractId, text, commit = false, create_missing: createMissing = false } =
    req.body || {};
  const contract = contractsRepo.get(contractId);
  if (!contract) throw new Error('Unknown contract');

  let parsed = parseResultsSheet(text || '', playersRepo.all());

  // Names in the sheet are often real people who simply are not on a contract —
  // guests and irregulars. On commit, optionally add them as outside players so
  // their appearances count, then re-parse so those games pick them up. Tokens
  // that collide with a shared-balance account are never auto-created: splitting
  // one is a roster decision, not something to infer here.
  let createdPlayers = [];
  if (commit && createMissing) {
    for (const u of parsed.unmatched) {
      if (/shared account/i.test(u.reason || '')) continue;
      const name = u.token.trim();
      if (!name) continue;
      try {
        const p = playersRepo.create({ name });
        db.prepare("UPDATE players SET player_type = 'outside' WHERE id = ?").run(p.id);
        createdPlayers.push({ id: p.id, name: p.name, games: u.count });
      } catch { /* already exists under a different spelling — leave it unmatched */ }
    }
    if (createdPlayers.length) parsed = parseResultsSheet(text || '', playersRepo.all());
  }

  // Flag games whose date already has a gameweek on this contract, so a re-paste
  // does not silently duplicate a season.
  const existing = new Map();
  for (const g of gameweeksRepo.all(contractId)) existing.set(String(g.date).slice(0, 10), g.id);
  const games = parsed.games.map(g => ({ ...g, duplicate_of: existing.get(g.date) || null }));

  const importable = games.filter(g => !g.duplicate_of);
  const summary = {
    contract_id: contractId,
    games_found: games.length,
    games_importable: importable.length,
    games_duplicate: games.length - importable.length,
    players_linked: importable.reduce((a, g) => a + g.matched_count, 0),
    unmatched_names: parsed.unmatched.length,
  };

  if (!commit) {
    return { dry_run: true, summary, games, skipped: parsed.skipped, unmatched: parsed.unmatched };
  }

  const created = [];
  for (const g of importable) {
    const gw = gameweeksRepo.create({
      contract_id: contractId,
      date: g.date,
      score: g.score_text,
      teams_raw: g.teams_raw,
      captains_raw: g.captains_raw || '',
      comments: 'Imported from results sheet',
      cost_per_gw: 0,
      game_cost: 0,
      kitty_earned: 0,
    }, g.players.map(p => ({
      player_id: p.player_id,
      team: p.team,
      is_captain: p.is_captain,
      rate_type: 'imported_result',
      amount: 0,                 // financial-nil: participation only
    })));
    created.push({ id: gw.id, date: g.date, players: g.players.length });
  }

  return {
    dry_run: false,
    summary: { ...summary, games_created: created.length, players_created: createdPlayers.length },
    created,
    players_created: createdPlayers,
    skipped: parsed.skipped,
    unmatched: parsed.unmatched,
  };
}));

// ---- whole-database backup ----
// Export is a plain JSON document of every table, meant to be kept offline.
// Restore replaces everything, in one transaction, after snapshotting the
// current database — see server/backup.js for why it is built that way.
r.get('/admin/backup', wrap((req, res) => {
  requireAdmin(req);
  const includeCredentials = req.query.credentials !== 'false';
  const doc = exportAll({ includeCredentials });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="fmss-backup-${stamp}.json"`);
  res.send(JSON.stringify(doc, null, 2));
}));

// Describe what a backup would do, without writing anything.
r.post('/admin/backup/inspect', wrap((req) => {
  requireAdmin(req);
  return inspectBackup(req.body?.backup ?? req.body);
}));

// Apply it. `confirm` must echo the row count from inspect, so a mis-click
// cannot wipe the database — the caller has to have looked at the preview.
r.post('/admin/backup/restore', wrap((req) => {
  requireAdmin(req);
  const doc = req.body?.backup ?? req.body;
  const check = inspectBackup(doc);
  if (!check.ok) throw new Error(check.problems[0] || 'Invalid backup');
  if (Number(req.body?.confirm_rows) !== check.total_rows) {
    throw new Error(
      `Confirmation mismatch: expected ${check.total_rows} rows. Re-run the preview and try again.`);
  }
  return restoreBackup(doc);
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

// ---- kitty opening balance (one-time per contract) ----
r.post('/admin/contracts/:contractId/kitty-opening', wrap((req) => {
  requireAdmin(req);
  const { opening_amount, snapshot_date, notes } = req.body;
  if (opening_amount === undefined) throw new Error('opening_amount required');
  return kittyOpeningBalanceRepo.import(req.params.contractId, opening_amount, snapshot_date, req.user.id, notes);
}));

r.get('/admin/contracts/:contractId/kitty-opening', wrap((req) => {
  requireAdmin(req);
  return kittyOpeningBalanceRepo.get(req.params.contractId);
}));

r.delete('/admin/contracts/:contractId/kitty-opening', wrap((req) => {
  requireAdmin(req);
  return kittyOpeningBalanceRepo.delete(req.params.contractId);
}));

// ---- kitty balance per contract ----
r.get('/admin/contracts/:contractId/kitty-balance', wrap((req) => {
  requireAdmin(req);
  return kittyOpeningBalanceRepo.getBalance(req.params.contractId);
}));

// ---- kitty activity log (opening + all transactions) ----
r.get('/admin/contracts/:contractId/kitty-activity', wrap((req) => {
  requireAdmin(req);
  return kittyOpeningBalanceRepo.getActivityLog(req.params.contractId);
}));

// ---- all kitty balances (summary across contracts) ----
r.get('/admin/kitty-summary', wrap((req) => {
  requireAdmin(req);
  return kittyOpeningBalanceRepo.getAllBalances();
}));

// ---- results: match history with full context ----
r.get('/results', wrap((req) => {
  const contractId = req.query.contract;
  const games = contractId
    ? gameweeksRepo.all(contractId)
    : gameweeksRepo.all();
  return games.map(g => {
    const charges = gameweeksRepo.get(g.id).charges || [];
    const teams = [...new Set(charges.map(c => c.team).filter(Boolean))];
    // Resolve the result to concrete goals and an actual winning TEAM. Without
    // this the client had only free text, so it credited a win to everyone who
    // played rather than to the side that won.
    const score = normaliseScore(g.scoreline || g.score);
    return {
      ...g,
      charges,
      teams,
      result: {
        ...score,
        winner_team: winningTeam(score.winner, teams),
        is_draw: score.winner === 'draw',
      },
      total_charged: gameweeksRepo.chargeTotal(g.id),
      players_count: charges.length,
    };
  });
}));

// ---- player stats: timeline, cost breakdown, streaks ----
r.get('/players/:id/record', wrap((req) => {
  // A player may read their own record; an admin may read anyone's.
  if (req.user.role === 'player' && req.params.id !== req.user.playerId) {
    throw new Error('Forbidden');
  }
  return statsRepo.matchRecord(req.params.id, req.query.contract || null);
}));

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

// ---- player transactions: audit trail (all transactions - contributions + external events + charges)
r.get('/players/:id/transactions', wrap((req) => {
  // Player may only read their own transactions; admin may read anyone's.
  if (req.user.role === 'player' && req.params.id !== req.user.playerId) {
    throw new Error('Forbidden');
  }
  const limit = Number(req.query.limit) || 200;
  const transactions = db.prepare(`
    SELECT
      t.id,
      t.type,
      t.amount,
      t.description,
      t.created_at as date,
      c.name as contract_name,
      e.title as event_title,
      e.event_type,
      p.name as related_player_name
    FROM transactions t
    LEFT JOIN contracts c ON t.contract_id = c.id
    LEFT JOIN external_events e ON t.event_id = e.id
    LEFT JOIN players p ON t.related_player_id = p.id
    WHERE t.player_id = ?
    ORDER BY t.created_at DESC
    LIMIT ?
  `).all(req.params.id, limit);
  return transactions;
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
  //
  // Two deliberate choices here, both about being useful rather than merely true:
  //
  // 1. Credit and debt are reported separately, never netted. They are opposite
  //    in kind — credit is money held ON BEHALF of players (a liability the club
  //    must be able to honour), debt is money owed TO the club (an asset). A
  //    single "net" figure hides whether the club is solvent against prepayments.
  //
  // 2. "Needs a refill" is expressed in GAMES OF RUNWAY, not a fixed number of
  //    dirhams. A balance of 60 is comfortable at 30/game and nearly spent at
  //    35/game, and a flat threshold cannot say which. Runway also answers the
  //    question actually being asked: who will not make it through the next game.
  const round2 = (n) => Math.round(n * 100) / 100;
  const LOW_RUNWAY_GAMES = 2;      // fewer than this and a top-up is due

  const contracts = contractsRepo.all();
  const perContract = contracts.map((c) => {
    const ledgers = ledgersRepo.forContract(c.id);
    // contractsRepo already parses this into an object; only a raw DB row is text.
    const rates = typeof c.rates === 'string'
      ? (() => { try { return JSON.parse(c.rates || '{}'); } catch { return {}; } })()
      : (c.rates || {});
    // The standard contracted rate is what a regular actually pays per game.
    const rate = Number(rates.contracted_10) || Number(rates.noncontract) || 0;

    const credit = ledgers.filter(l => l.present_balance > 0)
      .reduce((s, l) => s + l.present_balance, 0);
    const debt = ledgers.filter(l => l.present_balance < 0)
      .reduce((s, l) => s + l.present_balance, 0);

    // Only chase people it makes sense to chase. A sandbox account, or someone
    // who has never played and sits at exactly zero, is dormant rather than at
    // risk — including them buries the handful who genuinely need a top-up.
    const sandbox = new Set(playersRepo.all().filter(p => p.is_sandbox).map(p => p.id));
    const active = ledgers.filter(l =>
      !sandbox.has(l.player_id) && ((l.games || 0) > 0 || l.present_balance !== 0));

    const withRunway = active.map(l => ({
      player_id: l.player_id,
      name: l.player_name,
      balance: round2(l.present_balance),
      games_left: rate > 0 ? Math.floor(l.present_balance / rate) : null,
    }));

    const inDebt = withRunway.filter(p => p.balance < 0);
    const lowRunway = withRunway.filter(p =>
      p.balance >= 0 && p.games_left !== null && p.games_left < LOW_RUNWAY_GAMES);

    const games = gameweeksRepo.all(c.id);
    const lastGame = games[0]?.date || null;      // all() sorts date DESC
    const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

    return {
      id: c.id, name: c.name, venue: c.venue,
      rate,
      players: ledgers.length,
      net: round2(ledgers.reduce((s, l) => s + l.present_balance, 0)),
      credit: round2(credit),
      debt: round2(debt),
      games: games.length,
      last_game: lastGame,
      games_30d: games.filter(g => String(g.date) >= cutoff).length,
      // Split so the UI can distinguish "already owes" from "about to run out".
      in_debt_count: inDebt.length,
      low_runway_count: lowRunway.length,
      refill_count: inDebt.length + lowRunway.length,
      // Chase list: deepest debt first, then those closest to running out.
      watchlist: [...inDebt.sort((a, b) => a.balance - b.balance),
        ...lowRunway.sort((a, b) => a.balance - b.balance)].slice(0, 12),
    };
  });

  const creditHeld = round2(perContract.reduce((s, c) => s + c.credit, 0));
  const owed = round2(Math.abs(perContract.reduce((s, c) => s + c.debt, 0)));
  const kitty = kittyRepo.balance();

  return {
    role: 'admin',
    players: playersRepo.all().length,
    kitty,
    pending_contributions: pendingContributionsRepo.pendingCount(),
    contracts: perContract,
    // Can the club honour what players have already paid in? Positive means the
    // pot covers the prepayments; negative means some of that money is spent.
    cash: {
      credit_held: creditHeld,
      owed,
      kitty_balance: round2(kitty.balance),
      cover: round2(kitty.balance - creditHeld),
      covered_pct: creditHeld > 0 ? Math.round((kitty.balance / creditHeld) * 100) : null,
    },
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

// ---- player relationships (outside players, shared balances) ----

// Mark a player as outside (introduced by someone, costs 35-40 AED)
r.post('/admin/players/:playerId/mark-outside', wrap((req) => {
  requireAdmin(req);
  const { introduced_by, cost } = req.body;
  if (!introduced_by) throw new Error('introduced_by required');
  playerRelationshipsRepo.markOutside(db, req.params.playerId, introduced_by, cost || 35);
  return { ok: true, message: 'Player marked as outside' };
}));

// Mark a player as regular (remove outside status)
r.post('/admin/players/:playerId/mark-regular', wrap((req) => {
  requireAdmin(req);
  playerRelationshipsRepo.markRegular(db, req.params.playerId);
  return { ok: true, message: 'Player marked as regular' };
}));

// Get outside players for a contract
r.get('/admin/contracts/:contractId/outside-players', wrap((req) => {
  requireAdmin(req);
  return playerRelationshipsRepo.getOutsidePlayersForContract(db, req.params.contractId);
}));

// Create a balance group (for shared balances like Aws & Ali)
r.post('/admin/contracts/:contractId/balance-groups', wrap((req) => {
  requireAdmin(req);
  const { group_name, player_ids, description } = req.body;
  if (!group_name || !player_ids?.length) throw new Error('group_name and player_ids required');
  return playerRelationshipsRepo.createBalanceGroup(db, req.params.contractId, group_name, player_ids, description);
}));

// Get balance group details
r.get('/admin/balance-groups/:groupId', wrap((req) => {
  requireAdmin(req);
  const group = playerRelationshipsRepo.getBalanceGroup(db, req.params.groupId);
  if (!group) throw new Error('Balance group not found');
  return group;
}));

// Get combined balance for a group
r.get('/admin/contracts/:contractId/balance-groups/:groupId/balance', wrap((req) => {
  requireAdmin(req);
  const balance = ledgersRepo.getGroupBalance(req.params.contractId, req.params.groupId);
  if (!balance) throw new Error('Group or balance not found');
  return balance;
}));

// Record outside player charge and introducer credit
r.post('/gameweeks/:gameweekId/outside-player-charge', wrap((req) => {
  requireAdmin(req);
  const { outside_player_id, introducer_id, cost } = req.body;
  const gw = gameweeksRepo.get(req.params.gameweekId);
  if (!gw) throw new Error('Gameweek not found');
  return outsidePlayersRepo.recordOutsidePlayerCharge(db, req.params.gameweekId, gw.contract_id, outside_player_id, introducer_id, cost || 35);
}));

// Get outside player charges for a game
r.get('/gameweeks/:gameweekId/outside-player-charges', wrap((req) => {
  requireAdmin(req);
  const gw = gameweeksRepo.get(req.params.gameweekId);
  if (!gw) throw new Error('Gameweek not found');
  return outsidePlayersRepo.getOutsidePlayerCharges(db, req.params.gameweekId, gw.contract_id);
}));

// Get introducer summary (how much they earned, how many outside players brought)
r.get('/admin/players/:playerId/introducer-summary', wrap((req) => {
  requireAdmin(req);
  const { contract_id } = req.query;
  if (!contract_id) throw new Error('contract_id required');
  return outsidePlayersRepo.getIntroducerSummary(db, req.params.playerId, contract_id);
}));

// Record bank transfer (transfer credits from one player to another)
r.post('/admin/contracts/:contractId/bank-transfer', wrap((req) => {
  requireAdmin(req);
  const { from_player_id, to_player_id, amount, description } = req.body;
  if (!from_player_id || !to_player_id || !amount) throw new Error('from_player_id, to_player_id, and amount required');
  return outsidePlayersRepo.recordBankTransfer(db, from_player_id, to_player_id, req.params.contractId, amount, description);
}));

// Get club accounting summary (all financial flows)
r.get('/admin/contracts/:contractId/accounting-summary', wrap((req) => {
  requireAdmin(req);
  const contractId = req.params.contractId;

  // Get all outside player introducers and their earnings
  const introducers = playersRepo.all()
    .filter(p => {
      const introduced = db.prepare('SELECT COUNT(*) as count FROM players WHERE introduced_by = ?').get(p.id).count;
      return introduced > 0;
    })
    .map(p => ({
      introducer_id: p.id,
      introducer_name: p.name,
      ...outsidePlayersRepo.getIntroducerSummary(db, p.id, contractId),
    }));

  // Get all balance groups
  const groupBalances = ledgersRepo.getAllGroupBalances(contractId);

  // Get overall contract finances
  const totalGameCost = db.prepare(`
    SELECT COALESCE(SUM(game_cost), 0) as total FROM gameweeks WHERE contract_id = ?
  `).get(contractId).total;

  const totalKitty = db.prepare(`
    SELECT COALESCE(SUM(kitty_earned), 0) as total FROM gameweeks WHERE contract_id = ?
  `).get(contractId).total;

  return {
    contract_id: contractId,
    introducers,
    shared_balances: groupBalances,
    total_water_costs: totalGameCost,
    total_kitty_earned: totalKitty,
    net_club_position: totalKitty - totalGameCost,
  };
}));

export default r;
