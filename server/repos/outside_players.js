// outside_players.js — handle outside player charges and introducer credits
import { randomUUID } from 'node:crypto';

export const outsidePlayersRepo = {
  // recordOutsidePlayerCharge / getOutsidePlayerCharges / getIntroducerCredits /
  // getIntroducerCharges were removed. They wrote and read transactions typed
  // 'charge' and 'contribution' — the two types every balance query excludes,
  // since the charges and contributions tables own them. So they were a parallel
  // set of books that moved no money, and the summary below now derives from the
  // charges themselves, which is where a guest's cost actually lives.

  /**
   * What one member's guests have amounted to, read from the charges themselves.
   *
   * This used to read the parallel transaction rows, which no balance counted
   * and nothing now writes — so it would have reported zero for everyone. The
   * charges table is the real record: `charged_to` names whoever settles a
   * guest's cost, so a guest billed to the member who brought them is that
   * member's, and a guest paying their own cash is not.
   */
  getIntroducerSummary(db, introducerId, contractId) {
    const result = db.prepare(`
      SELECT COUNT(DISTINCT p.id)           AS outside_players_count,
             COUNT(DISTINCT ch.gameweek_id) AS games_with_outside_players,
             COALESCE(SUM(CASE WHEN ch.charged_to = ? THEN ch.amount ELSE 0 END), 0) AS borne,
             COALESCE(SUM(CASE WHEN ch.charged_to = p.id AND ch.paid = 0
                               THEN ch.amount ELSE 0 END), 0) AS uncollected
      FROM players p
      LEFT JOIN charges ch ON ch.player_id = p.id
      LEFT JOIN gameweeks g ON g.id = ch.gameweek_id AND g.contract_id = ?
      WHERE p.introduced_by = ? AND p.player_type = 'outside' AND g.id IS NOT NULL
    `).get(introducerId, contractId, introducerId);

    return {
      introducer_id: introducerId,
      outside_players_brought: result.outside_players_count || 0,
      games_participated: result.games_with_outside_players || 0,
      // What the member actually carried for their guests, and what those guests
      // still owe the club directly — two different people's money.
      total_borne_for_guests: result.borne || 0,
      guest_cash_uncollected: result.uncollected || 0,
    };
  },

  // Get outside players brought by someone
  getPlayersIntroduced(db, introducerId, contractId) {
    return db.prepare(`
      SELECT p.id, p.name, p.outside_cost,
             (SELECT COUNT(DISTINCT ch.gameweek_id) FROM charges ch
              WHERE ch.player_id = p.id AND ch.gameweek_id IN
              (SELECT id FROM gameweeks WHERE contract_id = ?)) as games_played
      FROM players p
      WHERE p.introduced_by = ? AND p.player_type = 'outside'
      ORDER BY p.name
    `).all(contractId, introducerId);
  },

  // Bank transfer: transfer credits from one player to introducer's bank balance
  recordBankTransfer(db, fromPlayerId, toPlayerId, contractId, amount, description) {
    const now = new Date().toISOString();

    // Debit from player
    const debitId = randomUUID();
    db.prepare(`
      INSERT INTO transactions
      (id, player_id, contract_id, type, amount, description, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'transfer_out', ?, ?, 'approved', 'system', ?, ?)
    `).run(debitId, fromPlayerId, contractId, -amount, description || 'Bank transfer', now, now);

    // Credit to introducer
    const creditId = randomUUID();
    db.prepare(`
      INSERT INTO transactions
      (id, player_id, contract_id, type, amount, description, related_player_id, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'transfer_in', ?, ?, ?, 'approved', 'system', ?, ?)
    `).run(creditId, toPlayerId, contractId, amount, description || 'Bank transfer', fromPlayerId, now, now);

    return { debitId, creditId };
  },
};
