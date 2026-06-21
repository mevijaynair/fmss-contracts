// contributions_pending.js — player-submitted contributions awaiting admin approval.
// When approved, a real (live) row is written into the contributions table.
import { db } from '../db.js';

export const pendingContributionsRepo = {
  // Player self-service: submit a contribution for approval.
  create({ player_id, contract_id, amount, date, payment_method }) {
    if (!player_id) throw new Error('player_id required');
    if (!contract_id) throw new Error('contract_id required');

    // Cashier exception: block the cashier (Vijay) from contributing.
    const player = db.prepare('SELECT special_role FROM players WHERE id = ?').get(player_id);
    if (player?.special_role === 'cashier') {
      throw new Error('Cashier cannot contribute; contributions excluded for audit integrity');
    }

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      throw new Error(`Invalid contribution amount: ${amount} (must be a positive number)`);
    }

    const method = ['cash', 'bank', 'transfer'].includes(payment_method) ? payment_method : 'cash';
    const id = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();

    db.prepare(`INSERT INTO contributions_pending
      (id, player_id, contract_id, amount, date, payment_method, status, created_at)
      VALUES (?,?,?,?,?,?,'pending',?)`).run(
      id, player_id, contract_id, amt,
      date || now.slice(0, 10), method, now);

    return this.get(id);
  },

  get(id) {
    return db.prepare(`SELECT cp.*, p.name AS player_name
      FROM contributions_pending cp
      LEFT JOIN players p ON p.id = cp.player_id
      WHERE cp.id = ?`).get(id);
  },

  // A player's own submissions (any status).
  forPlayer(playerId) {
    return db.prepare(`SELECT cp.*, p.name AS player_name
      FROM contributions_pending cp
      LEFT JOIN players p ON p.id = cp.player_id
      WHERE cp.player_id = ?
      ORDER BY cp.created_at DESC`).all(playerId);
  },

  // Admin: all pending submissions awaiting review.
  allPending() {
    return db.prepare(`SELECT cp.*, p.name AS player_name
      FROM contributions_pending cp
      LEFT JOIN players p ON p.id = cp.player_id
      WHERE cp.status = 'pending'
      ORDER BY cp.created_at ASC`).all();
  },

  // Admin: approve a pending contribution → writes a live row in contributions.
  approve(id, reviewedBy) {
    const pending = this.get(id);
    if (!pending) throw new Error('Pending contribution not found');
    if (pending.status !== 'pending') throw new Error(`Already ${pending.status}`);

    const now = new Date().toISOString();
    const method = pending.payment_method || 'cash';
    const comments = `Player submission (${method})`;

    // Create the live contribution.
    const contribId = `q_appr_${Date.now()}`;
    db.prepare(`INSERT INTO contributions
      (id, player_id, contract_id, name_raw, amount, date, comments, historical, created_at)
      VALUES (?,?,?,?,?,?,?,0,?)`).run(
      contribId, pending.player_id, pending.contract_id, pending.player_name || '',
      pending.amount, pending.date, comments, now);

    // Mark the pending row approved.
    db.prepare(`UPDATE contributions_pending
      SET status = 'approved', reviewed_by = ?, reviewed_at = ?
      WHERE id = ?`).run(reviewedBy || 'admin', now, id);

    return { ...this.get(id), contribution_id: contribId };
  },

  // Admin: reject a pending contribution (no live row written).
  reject(id, reviewedBy) {
    const pending = this.get(id);
    if (!pending) throw new Error('Pending contribution not found');
    if (pending.status !== 'pending') throw new Error(`Already ${pending.status}`);

    const now = new Date().toISOString();
    db.prepare(`UPDATE contributions_pending
      SET status = 'rejected', reviewed_by = ?, reviewed_at = ?
      WHERE id = ?`).run(reviewedBy || 'admin', now, id);

    return this.get(id);
  },

  // Count of pending submissions (for admin badge).
  pendingCount() {
    return db.prepare(`SELECT COUNT(*) AS n FROM contributions_pending WHERE status = 'pending'`).get().n;
  },
};
