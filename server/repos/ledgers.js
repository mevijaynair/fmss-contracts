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

const SELECT = `
  SELECT l.player_id, l.contract_id, p.name AS player_name,
         l.opening_balance, l.status,
         ${CONTRIB} AS contributed,
         ${CHARGED} AS charged,
         ${LIFETIME_GAMES} AS games,
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
