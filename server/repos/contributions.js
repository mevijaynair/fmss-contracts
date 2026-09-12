// contributions.js — incoming funds log (the "Contri" sheet).
import { db } from '../db.js';

export const contributionsRepo = {
  all({ playerId, contractId } = {}) {
    const where = [];
    const args = [];
    if (playerId) { where.push('q.player_id = ?'); args.push(playerId); }
    if (contractId) { where.push('q.contract_id = ?'); args.push(contractId); }
    // Rows that came from one payment carry its whole size and how many ways it
    // went, so a 1000 can be read back as "1000 of a 1500 split two ways"
    // without the reader having to find its siblings.
    const sql = `SELECT q.*, p.name AS player_name,
        CASE WHEN q.split_group IS NULL THEN NULL ELSE (
          SELECT ROUND(SUM(s.amount), 2) FROM contributions s WHERE s.split_group = q.split_group
        ) END AS split_total,
        CASE WHEN q.split_group IS NULL THEN NULL ELSE (
          SELECT COUNT(*) FROM contributions s WHERE s.split_group = q.split_group
        ) END AS split_parts
      FROM contributions q
      LEFT JOIN players p ON p.id = q.player_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY q.date DESC, q.created_at DESC`;
    return db.prepare(sql).all(...args);
  },

  /** The other legs of the same payment — what a bank line reconciles against. */
  splitSiblings(groupId) {
    if (!groupId) return [];
    return db.prepare(
      `SELECT q.id, q.contract_id, q.amount, q.date, c.name AS contract_name
       FROM contributions q LEFT JOIN contracts c ON c.id = q.contract_id
       WHERE q.split_group = ? ORDER BY q.amount DESC`
    ).all(groupId);
  },

  create({ player_id, contract_id, amount, date, comments, split_group = null }) {
    // Cashier exception: block Vijay from contributing
    if (player_id) {
      const player = db.prepare('SELECT special_role FROM players WHERE id = ?').get(player_id);
      if (player?.special_role === 'cashier') {
        throw new Error('Cashier cannot contribute; contributions excluded for audit integrity');
      }
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt)) {
      throw new Error(`Invalid contribution amount: ${amount} (must be a number)`);
    }
    // A split writes several rows back to back; a timestamp alone collides when
    // two land in the same millisecond, and the second insert would fail on the
    // primary key.
    const id = `q_live_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const name = player_id
      ? (db.prepare('SELECT name FROM players WHERE id=?').get(player_id)?.name || '')
      : '';
    db.prepare(`INSERT INTO contributions
      (id,player_id,contract_id,name_raw,amount,date,comments,historical,created_at,split_group)
      VALUES (?,?,?,?,?,?,?,0,?,?)`).run(
      id, player_id || null, contract_id || null, name, Number(amount) || 0,
      date || new Date().toISOString().slice(0, 10), comments || '',
      new Date().toISOString(), split_group || null);
    return db.prepare('SELECT * FROM contributions WHERE id = ?').get(id);
  },
  remove(id) {
    db.prepare('DELETE FROM contributions WHERE id = ?').run(id);
  },
};
