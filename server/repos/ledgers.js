// ledgers.js — per-(player, contract) balance.
//
// Live present balance = opening_balance
//   + Σ contributions (non-historical, this contract)
//   − Σ charges        (non-historical gameweeks, this contract)
//
// Historical (imported) rows are EXCLUDED from the live balance because the
// imported opening_balance already nets them out. They remain visible in the
// Contributions / Gameweeks history views for the record.

import { db } from '../db.js';

// Movements with no home in contributions/charges: transfers between players,
// external-event deductions, introducer credits, manual adjustments. Amounts are
// already signed (positive = credit), so this adds rather than subtracts.
//
// 'contribution' and 'charge' are deliberately excluded — those two types are
// owned by the dedicated tables below, and counting them here would double them.
// Only 'approved' rows count, so a pending transfer does not move a balance
// before an admin signs it off.
//
// NOTE: a transaction with a NULL contract_id belongs to no ledger and is
// invisible here. Anything written to this table that should affect a balance
// must name its contract.
const ADJUSTED = `COALESCE((SELECT SUM(t.amount) FROM transactions t
  WHERE t.player_id = l.player_id AND t.contract_id = l.contract_id
    AND t.status = 'approved'
    AND t.type NOT IN ('contribution', 'charge')), 0)`;

const CONTRIB = `COALESCE((SELECT SUM(q.amount) FROM contributions q
  WHERE q.player_id = l.player_id AND q.contract_id = l.contract_id AND q.historical = 0), 0)`;
const CHARGED = `COALESCE((SELECT SUM(ch.amount) FROM charges ch
  JOIN gameweeks g ON g.id = ch.gameweek_id
  WHERE ch.player_id = l.player_id AND g.contract_id = l.contract_id AND g.historical = 0), 0)`;
const LIFETIME_GAMES = `COALESCE((SELECT COUNT(DISTINCT ch.gameweek_id) FROM charges ch
  JOIN gameweeks g ON g.id = ch.gameweek_id
  WHERE ch.player_id = l.player_id AND g.contract_id = l.contract_id), 0)`;
// Of those, the ones that actually cost them something. The bulk-imported
// seasons carry a charge row per player worth 0 — an attendance record, not a
// bill — so a single "games played" figure mixes games that moved a balance
// with games that only say who turned up.
const GAMES_BILLED = `COALESCE((SELECT COUNT(DISTINCT ch.gameweek_id) FROM charges ch
  JOIN gameweeks g ON g.id = ch.gameweek_id
  WHERE ch.player_id = l.player_id AND g.contract_id = l.contract_id AND ch.amount > 0), 0)`;
// Last incoming transaction (contribution or positive adjustment)
const LAST_INCOMING = `(SELECT MAX(CASE WHEN c.amount > 0 THEN c.date END) FROM contributions c
  WHERE c.player_id = l.player_id AND c.contract_id = l.contract_id AND c.historical = 0)`;
// Last game played (most recent gameweek with charges)
const LAST_GAME_DATE = `(SELECT g.date FROM charges ch
  JOIN gameweeks g ON g.id = ch.gameweek_id
  WHERE ch.player_id = l.player_id
  ORDER BY g.date DESC LIMIT 1)`;

const SELECT = `
  SELECT l.player_id, l.contract_id, p.name AS player_name,
         l.opening_balance, l.status,
         ${CONTRIB} AS contributed,
         ${CHARGED} AS charged,
         ${ADJUSTED} AS adjusted,
         ${LIFETIME_GAMES} AS games,
         ${GAMES_BILLED} AS games_billed,
         ${LAST_INCOMING} AS last_incoming_date,
         ${LAST_GAME_DATE} AS last_game_date,
         ROUND(l.opening_balance + ${CONTRIB} - ${CHARGED} + ${ADJUSTED}, 2) AS present_balance
  FROM ledgers l JOIN players p ON p.id = l.player_id`;

export const ledgersRepo = {
  all() {
    return db.prepare(`${SELECT} ORDER BY l.contract_id, present_balance ASC`).all();
  },
  forContract(contractId) {
    return db.prepare(`${SELECT} WHERE l.contract_id = ? ORDER BY present_balance ASC`)
      .all(contractId);
  },
  forPlayer(playerId) {
    return db.prepare(`${SELECT} WHERE l.player_id = ?`).all(playerId);
  },

  // Combined view: aggregate all contracts for a player into single row
  forPlayerCombined(playerId) {
    const player = db.prepare('SELECT id, name FROM players WHERE id = ?').get(playerId);
    if (!player) return null;

    const ledgers = db.prepare(`${SELECT} WHERE l.player_id = ?`).all(playerId);
    if (ledgers.length === 0) return null;

    // Aggregate across all contracts
    const combined = {
      player_id: playerId,
      player_name: player.name,
      opening_balance: ledgers.reduce((s, l) => s + l.opening_balance, 0),
      contributed: ledgers.reduce((s, l) => s + l.contributed, 0),
      charged: ledgers.reduce((s, l) => s + l.charged, 0),
      adjusted: ledgers.reduce((s, l) => s + l.adjusted, 0),
      games: ledgers.reduce((s, l) => s + l.games, 0),
      games_billed: ledgers.reduce((s, l) => s + l.games_billed, 0),
      present_balance: Math.round(ledgers.reduce((s, l) => s + l.present_balance, 0) * 100) / 100,
      first_game_date: null,
      last_game_date: null,
      last_charged_date: null,
      contracts: ledgers.map(l => ({
        contract_id: l.contract_id,
        opening_balance: l.opening_balance,
        contributed: l.contributed,
        charged: l.charged,
        adjusted: l.adjusted,
        present_balance: l.present_balance,
        games: l.games,
        games_billed: l.games_billed
      }))
    };

    // Get last incoming and last game date across all contracts
    const lastIncoming = db.prepare(`
      SELECT MAX(CASE WHEN amount > 0 THEN date END) as date FROM contributions
      WHERE player_id = ? AND historical = 0
    `).get(playerId);
    if (lastIncoming?.date) combined.last_incoming_date = lastIncoming.date;

    const lastGame = db.prepare(`
      SELECT g.date FROM charges ch
      JOIN gameweeks g ON g.id = ch.gameweek_id
      WHERE ch.player_id = ?
      ORDER BY g.date DESC LIMIT 1
    `).get(playerId);
    if (lastGame?.date) combined.last_game_date = lastGame.date;

    return combined;
  },
  get(playerId, contractId) {
    return db.prepare(`${SELECT} WHERE l.player_id = ? AND l.contract_id = ?`)
      .get(playerId, contractId);
  },
  // Ensure a ledger row exists (opening 0) so a player can be charged in a contract.
  ensure(playerId, contractId) {
    db.prepare(`INSERT OR IGNORE INTO ledgers (player_id,contract_id,opening_balance,status)
                VALUES (?,?,0,'')`).run(playerId, contractId);
  },
  /**
   * Close the baseline for a contract: mark every opening balance as agreed and
   * final. After this, importing opening balances over the top is refused rather
   * than quietly accepted — which is the point. The opening figures come from
   * signed-off reference sheets, and the damage from a later import silently
   * replacing them is invisible until somebody notices their balance is wrong.
   *
   * Reversible by design (reopenBaseline), because being unable to correct a
   * genuine mistake is its own kind of damage. What it prevents is doing so by
   * accident.
   */
  closeBaseline(contractId) {
    const at = new Date().toISOString();
    const info = db.prepare(
      `UPDATE ledgers SET is_opening_balanced = 1, opening_balanced_at = ?
       WHERE contract_id = ? AND is_opening_balanced = 0`
    ).run(at, contractId);
    return { contract_id: contractId, closed: info.changes, closed_at: at };
  },

  reopenBaseline(contractId) {
    const info = db.prepare(
      `UPDATE ledgers SET is_opening_balanced = 0, opening_balanced_at = NULL
       WHERE contract_id = ?`
    ).run(contractId);
    return { contract_id: contractId, reopened: info.changes };
  },

  baselineState(contractId) {
    const r = db.prepare(
      `SELECT COUNT(*) total, SUM(is_opening_balanced) closed, MAX(opening_balanced_at) at
       FROM ledgers WHERE contract_id = ?`
    ).get(contractId);
    return { total: r.total, closed: r.closed || 0, closed_at: r.at, is_closed: r.total > 0 && r.closed === r.total };
  },

  setStatus(playerId, contractId, status) {
    this.ensure(playerId, contractId);
    db.prepare('UPDATE ledgers SET status=? WHERE player_id=? AND contract_id=?')
      .run(status, playerId, contractId);
  },

  // Get combined balance for a shared balance group (e.g., Aws & Ali)
  getGroupBalance(contractId, balanceGroupId) {
    const groupMembers = db.prepare(`
      SELECT id FROM players WHERE balance_group_id = ?
    `).all(balanceGroupId);

    if (!groupMembers.length) return null;

    let totalOpening = 0;
    let totalContributed = 0;
    let totalCharged = 0;
    let totalAdjusted = 0;
    let totalPresent = 0;
    let memberDetails = [];

    for (const member of groupMembers) {
      const ledger = this.get(member.id, contractId);
      if (ledger) {
        totalOpening += ledger.opening_balance;
        totalContributed += ledger.contributed;
        totalCharged += ledger.charged;
        totalAdjusted += ledger.adjusted;
        // Sum the balance the SELECT already computed rather than re-deriving it
        // from the parts — re-deriving silently drops any term added later.
        totalPresent += ledger.present_balance;
        memberDetails.push({
          player_id: member.id,
          player_name: ledger.player_name,
          opening_balance: ledger.opening_balance,
          contributed: ledger.contributed,
          charged: ledger.charged,
          adjusted: ledger.adjusted,
          individual_balance: ledger.present_balance,
        });
      }
    }

    return {
      balance_group_id: balanceGroupId,
      contract_id: contractId,
      members: memberDetails,
      combined_opening_balance: totalOpening,
      combined_contributed: totalContributed,
      combined_charged: totalCharged,
      combined_adjusted: totalAdjusted,
      combined_present_balance: Math.round(totalPresent * 100) / 100,
    };
  },

  // Get all balance groups for a contract
  getAllGroupBalances(contractId) {
    const groups = db.prepare(`
      SELECT DISTINCT balance_group_id FROM players
      WHERE balance_group_id IS NOT NULL
    `).all();

    return groups
      .map(g => this.getGroupBalance(contractId, g.balance_group_id))
      .filter(g => g !== null);
  },
};
