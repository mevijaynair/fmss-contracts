// contributions.js — incoming funds log (the "Contri" sheet).
import { db } from '../db.js';

export const contributionsRepo = {
  all({ playerId, contractId } = {}) {
    const where = [];
    const args = [];
    if (playerId) { where.push('q.player_id = ?'); args.push(playerId); }
    if (contractId) { where.push('q.contract_id = ?'); args.push(contractId); }
    const sql = `SELECT q.*, p.name AS player_name FROM contributions q
      LEFT JOIN players p ON p.id = q.player_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY q.date DESC, q.created_at DESC`;
    return db.prepare(sql).all(...args);
  },
  create({ player_id, contract_id, amount, date, comments }) {
    // Cashier exception: block Vijay from contributing
    if (player_id) {
      const player = db.prepare('SELECT special_role FROM players WHERE id = ?').get(player_id);
      if (player?.special_role === 'cashier') {
        throw new Error('Cashier cannot contribute; contributions excluded for audit integrity');
      }
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) {
      throw new Error(`Invalid contribution amount: ${amount} (must be a number ≥ 0)`);
    }
    const id = `q_live_${Date.now()}`;
    const name = player_id
      ? (db.prepare('SELECT name FROM players WHERE id=?').get(player_id)?.name || '')
      : '';
    db.prepare(`INSERT INTO contributions
      (id,player_id,contract_id,name_raw,amount,date,comments,historical,created_at)
      VALUES (?,?,?,?,?,?,?,0,?)`).run(
      id, player_id || null, contract_id || null, name, Number(amount) || 0,
      date || new Date().toISOString().slice(0, 10), comments || '',
      new Date().toISOString());
    return db.prepare('SELECT * FROM contributions WHERE id = ?').get(id);
  },
  remove(id) {
    db.prepare('DELETE FROM contributions WHERE id = ?').run(id);
  },
};
