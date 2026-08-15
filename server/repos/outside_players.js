// outside_players.js — handle outside player charges and introducer credits
import { randomUUID } from 'node:crypto';

export const outsidePlayersRepo = {
  // Record when an outside player is charged and introduce gets credited
  recordOutsidePlayerCharge(db, gameweekId, contractId, outsidePlayerId, introducerId, cost) {
    const now = new Date().toISOString();

    // Get introducer name for transaction description
    const introducer = db.prepare('SELECT name FROM players WHERE id = ?').get(introducerId);
    const outsidePlayer = db.prepare('SELECT name FROM players WHERE id = ?').get(outsidePlayerId);

    // Create debit transaction for outside player
    const debitId = randomUUID();
    db.prepare(`
      INSERT INTO transactions
      (id, player_id, contract_id, type, amount, description, game_id, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'charge', ?, ?, ?, 'approved', 'system', ?, ?)
    `).run(
      debitId,
      outsidePlayerId,
      contractId,
      -cost,
      `Outside player charge (introduced by ${introducer?.name || introducerId})`,
      gameweekId,
      now,
      now
    );

    // Create credit transaction for introducer
    const creditId = randomUUID();
    db.prepare(`
      INSERT INTO transactions
      (id, player_id, contract_id, type, amount, description, game_id, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'contribution', ?, ?, ?, 'approved', 'system', ?, ?)
    `).run(
      creditId,
      introducerId,
      contractId,
      cost,
      `Outside player credit (${outsidePlayer?.name || outsidePlayerId} charge)`,
      gameweekId,
      now,
      now
    );

    return { debitId, creditId };
  },

  // Get outside player charges for a game
  getOutsidePlayerCharges(db, gameweekId, contractId) {
    return db.prepare(`
      SELECT t.*, p.name AS player_name,
             (SELECT name FROM players WHERE id = (SELECT introduced_by FROM players WHERE id = t.player_id)) AS introducer_name
      FROM transactions t
      JOIN players p ON p.id = t.player_id
      WHERE t.game_id = ? AND t.contract_id = ? AND p.player_type = 'outside'
      ORDER BY t.created_at
    `).all(gameweekId, contractId);
  },

  // Get total outside player credits for a player (money introduced)
  getIntroducerCredits(db, introducerId, contractId) {
    return db.prepare(`
      SELECT SUM(t.amount) as total_credited FROM transactions t
      WHERE t.player_id = ? AND t.contract_id = ?
      AND t.type = 'contribution'
      AND t.description LIKE '%Outside player credit%'
    `).get(introducerId, contractId).total_credited || 0;
  },

  // Get outside player charges against an introducer
  getIntroducerCharges(db, introducerId, contractId) {
    return db.prepare(`
      SELECT COUNT(*) as charge_count, SUM(ABS(t.amount)) as total_charged
      FROM transactions t
      JOIN players p ON p.id = t.player_id
      WHERE p.introduced_by = ? AND t.contract_id = ?
      AND t.type = 'charge'
      AND t.description LIKE '%Outside player charge%'
    `).get(introducerId, contractId);
  },

  // Get summary for introducer (how much they earned, how many outside players they brought)
  getIntroducerSummary(db, introducerId, contractId) {
    const result = db.prepare(`
      SELECT
        COUNT(DISTINCT p.id) as outside_players_count,
        COUNT(DISTINCT t.game_id) as games_with_outside_players,
        COALESCE(SUM(CASE WHEN t.type = 'contribution' THEN t.amount ELSE 0 END), 0) as total_credited
      FROM players p
      LEFT JOIN transactions t ON t.player_id = ? AND t.contract_id = ? AND p.introduced_by = ?
      WHERE p.introduced_by = ? AND p.player_type = 'outside'
    `).get(introducerId, contractId, introducerId, introducerId);

    return {
      introducer_id: introducerId,
      outside_players_brought: result.outside_players_count || 0,
      games_participated: result.games_with_outside_players || 0,
      total_credits_earned: result.total_credited || 0,
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
