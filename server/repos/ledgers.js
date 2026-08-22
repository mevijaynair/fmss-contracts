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

const CONTRIB = `COALESCE((SELECT SUM(q.amount) FROM contributions q
  WHERE q.player_id = l.player_id AND q.contract_id = l.contract_id AND q.historical = 0), 0)`;
const CHARGED = `COALESCE((SELECT SUM(ch.amount) FROM charges ch
  JOIN gameweeks g ON g.id = ch.gameweek_id
  WHERE ch.player_id = l.player_id AND g.contract_id = l.contract_id AND g.historical = 0), 0)`;
const LIFETIME_GAMES = `COALESCE((SELECT COUNT(DISTINCT ch.gameweek_id) FROM charges ch
  JOIN gameweeks g ON g.id = ch.gameweek_id
  WHERE ch.player_id = l.player_id AND g.contract_id = l.contract_id), 0)`;
const LAST_CHARGED_DATE = `(SELECT g.date FROM charges ch
  JOIN gameweeks g ON g.id = ch.gameweek_id
  WHERE ch.player_id = l.player_id AND g.contract_id = l.contract_id
  ORDER BY g.date DESC LIMIT 1)`;
const FIRST_GAME_DATE = `(SELECT g.date FROM charges ch
  JOIN gameweeks g ON g.id = ch.gameweek_id
  WHERE ch.player_id = l.player_id AND g.contract_id = l.contract_id
  ORDER BY g.date ASC LIMIT 1)`;
const LAST_GAME_DATE = `(SELECT g.date FROM charges ch
  JOIN gameweeks g ON g.id = ch.gameweek_id
  WHERE ch.player_id = l.player_id AND g.contract_id = l.contract_id
  ORDER BY g.date DESC LIMIT 1)`;

const SELECT = `
  SELECT l.player_id, l.contract_id, p.name AS player_name,
         l.opening_balance, l.status,
         ${CONTRIB} AS contributed,
         ${CHARGED} AS charged,
         ${LIFETIME_GAMES} AS games,
         ${LAST_CHARGED_DATE} AS last_charged_date,
         ${FIRST_GAME_DATE} AS first_game_date,
         ${LAST_GAME_DATE} AS last_game_date,
         ROUND(l.opening_balance + ${CONTRIB} - ${CHARGED}, 2) AS present_balance
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
      games: ledgers.reduce((s, l) => s + l.games, 0),
      present_balance: Math.round(ledgers.reduce((s, l) => s + l.present_balance, 0) * 100) / 100,
      first_game_date: null,
      last_game_date: null,
      last_charged_date: null,
      contracts: ledgers.map(l => ({
        contract_id: l.contract_id,
        opening_balance: l.opening_balance,
        contributed: l.contributed,
        charged: l.charged,
        present_balance: l.present_balance,
        games: l.games
      }))
    };

    // Get date ranges across all contracts
    const dates = db.prepare(`
      SELECT MIN(g.date) as first_date, MAX(g.date) as last_date
      FROM charges ch JOIN gameweeks g ON g.id = ch.gameweek_id
      WHERE ch.player_id = ?
    `).get(playerId);
    if (dates.first_date) combined.first_game_date = dates.first_date;
    if (dates.last_date) combined.last_game_date = dates.last_date;

    const lastCharged = db.prepare(`
      SELECT g.date FROM charges ch
      JOIN gameweeks g ON g.id = ch.gameweek_id
      WHERE ch.player_id = ?
      ORDER BY g.date DESC LIMIT 1
    `).get(playerId);
    if (lastCharged) combined.last_charged_date = lastCharged.date;

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
    let memberDetails = [];

    for (const member of groupMembers) {
      const ledger = this.get(member.id, contractId);
      if (ledger) {
        totalOpening += ledger.opening_balance;
        totalContributed += ledger.contributed;
        totalCharged += ledger.charged;
        memberDetails.push({
          player_id: member.id,
          player_name: ledger.player_name,
          opening_balance: ledger.opening_balance,
          contributed: ledger.contributed,
          charged: ledger.charged,
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
      combined_present_balance: Math.round((totalOpening + totalContributed - totalCharged) * 100) / 100,
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
