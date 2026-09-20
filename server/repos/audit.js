// audit.js — charge audit trail (change history with impact tracking).
import { db } from '../db.js';

export const auditRepo = {
  create(chargeId, originalAmount, newAmount, reason, changedBy, autoRecalculate = true) {
    // A millisecond is not unique enough to be a primary key, and this is
    // called in a LOOP — applyChargeEdits walks every edited charge in a game,
    // and correcting two of them takes well under a millisecond. The second
    // insert died on "UNIQUE constraint failed: charge_audit.id", which rolled
    // the whole edit back: correcting one charge in a game worked, correcting
    // two never did. Same fault movements.js and contributions.js each hit and
    // fixed separately; this one was still here.
    const id = `audit_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    db.prepare(`INSERT INTO charge_audit
      (id, charge_id, original_amount, new_amount, reason, changed_by, auto_recalculate, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      id, chargeId, originalAmount, newAmount, reason || '', changedBy || 'system',
      autoRecalculate ? 1 : 0, new Date().toISOString());
    return this.get(id);
  },

  get(id) {
    return db.prepare('SELECT * FROM charge_audit WHERE id = ?').get(id);
  },

  forCharge(chargeId) {
    return db.prepare(`SELECT * FROM charge_audit WHERE charge_id = ? ORDER BY created_at DESC`)
      .all(chargeId);
  },

  forPlayer(playerId, limit = 50) {
    return db.prepare(`
      SELECT ca.* FROM charge_audit ca
      JOIN charges ch ON ch.id = ca.charge_id
      WHERE ch.player_id = ?
      ORDER BY ca.created_at DESC
      LIMIT ?`).all(playerId, limit);
  },

  // Get audit trail for a gameweek (all charge edits in that game)
  forGameweek(gameweekId) {
    return db.prepare(`
      SELECT ca.* FROM charge_audit ca
      JOIN charges ch ON ch.id = ca.charge_id
      WHERE ch.gameweek_id = ?
      ORDER BY ca.created_at DESC`).all(gameweekId);
  },
};
