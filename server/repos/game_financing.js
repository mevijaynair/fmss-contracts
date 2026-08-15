// game_financing.js — track water costs, kitty, and provisional payments per game
import { randomUUID } from 'node:crypto';

export const gameFinancingRepo = {
  create(db, gameweekId, contractId, category, payerId, amount, notes = '') {
    const id = randomUUID();
    db.prepare(`
      INSERT INTO game_financing (id, gameweek_id, contract_id, category, payer_id, amount, status, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'provisional', ?, ?)
    `).run(id, gameweekId, contractId, category, payerId, amount, notes, new Date().toISOString());

    return { id, gameweekId, contractId, category, payerId, amount, status: 'provisional' };
  },

  getByGameweekId(db, gameweekId) {
    return db.prepare('SELECT * FROM game_financing WHERE gameweek_id = ? ORDER BY created_at').all(gameweekId);
  },

  getByGameweekAndCategory(db, gameweekId, category) {
    return db.prepare('SELECT * FROM game_financing WHERE gameweek_id = ? AND category = ?').all(gameweekId, category);
  },

  // Get water cost for a game (typically 15 AED)
  getWaterCost(db, gameweekId) {
    const result = db.prepare(`
      SELECT * FROM game_financing
      WHERE gameweek_id = ? AND category = 'water_cost'
    `).get(gameweekId);
    return result || null;
  },

  // Get kitty collected for a game
  getKittyCollected(db, gameweekId) {
    return db.prepare(`
      SELECT * FROM game_financing
      WHERE gameweek_id = ? AND category = 'kitty_collection'
    `).all(gameweekId);
  },

  // Settle a provisional payment (mark as received)
  settle(db, financingId) {
    db.prepare(`
      UPDATE game_financing
      SET status = 'settled', settled_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), financingId);
  },

  // Get provisional (unsettled) amounts for a player
  getPlayerProvisional(db, playerId, contractId) {
    return db.prepare(`
      SELECT SUM(amount) as total FROM game_financing
      WHERE payer_id = ? AND contract_id = ? AND status = 'provisional'
    `).get(playerId, contractId).total || 0;
  },

  delete(db, financingId) {
    db.prepare('DELETE FROM game_financing WHERE id = ?').run(financingId);
  }
};
