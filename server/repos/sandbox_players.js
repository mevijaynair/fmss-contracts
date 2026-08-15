// sandbox_players.js — manage test players for safe balance testing
import { randomBytes } from 'node:crypto';

function generateId() {
  return randomBytes(8).toString('hex');
}

export const sandboxPlayersRepo = {
  // Create a sandbox player (test-only, can be safely deleted)
  createSandbox(db, name) {
    const id = generateId();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO players (id, name, is_sandbox, created_at)
       VALUES (?, ?, 1, ?)`
    ).run(id, name, now);
    return { id, name, is_sandbox: 1 };
  },

  // List all sandbox players
  listSandbox(db) {
    return db.prepare(
      'SELECT id, name FROM players WHERE is_sandbox = 1 ORDER BY created_at DESC'
    ).all();
  },

  // Delete a sandbox player and ALL their transactions (cascade clean)
  // Returns count of transactions deleted
  deleteSandbox(db, playerId) {
    // Verify it's actually a sandbox player
    const player = db.prepare('SELECT is_sandbox FROM players WHERE id = ?').get(playerId);
    if (!player || !player.is_sandbox) {
      throw new Error('Can only delete sandbox players');
    }

    // Delete cascade: transactions, charges, contributions, auth_users
    // Use transaction to ensure atomic cleanup
    const stmt = db.prepare('BEGIN TRANSACTION');
    stmt.run();

    try {
      // Count transactions being deleted (for audit)
      const txnCount = db.prepare(
        'SELECT COUNT(*) as cnt FROM transactions WHERE player_id = ? OR related_player_id = ?'
      ).get(playerId, playerId).cnt;

      // Delete transactions
      db.prepare('DELETE FROM transactions WHERE player_id = ? OR related_player_id = ?').run(playerId, playerId);

      // Delete charges
      db.prepare(
        `DELETE FROM charges WHERE player_id = ? AND gameweek_id IN (
          SELECT id FROM gameweeks WHERE id IN (
            SELECT game_id FROM transactions WHERE player_id = ?
          )
        )`
      ).run(playerId, playerId);

      // Delete contributions
      db.prepare('DELETE FROM contributions WHERE player_id = ?').run(playerId);

      // Delete auth_users entry
      db.prepare('DELETE FROM auth_users WHERE player_id = ?').run(playerId);

      // Delete ledger entries
      db.prepare('DELETE FROM ledgers WHERE player_id = ?').run(playerId);

      // Delete opening balance snapshots
      db.prepare('DELETE FROM opening_balances_snapshot WHERE player_id = ?').run(playerId);

      // Finally delete the player
      db.prepare('DELETE FROM players WHERE id = ?').run(playerId);

      db.prepare('COMMIT').run();

      return { deleted: true, transactionsRemoved: txnCount };
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }
  },

  // Get all sandboxes created in last N hours (for cleanup purposes)
  recentSandboxes(db, hoursAgo = 24) {
    const cutoff = new Date(Date.now() - hoursAgo * 3600000).toISOString();
    return db.prepare(
      'SELECT id, name, created_at FROM players WHERE is_sandbox = 1 AND created_at > ? ORDER BY created_at DESC'
    ).all(cutoff);
  },

  // Check if a player is sandbox
  isSandbox(db, playerId) {
    const p = db.prepare('SELECT is_sandbox FROM players WHERE id = ?').get(playerId);
    return p?.is_sandbox === 1;
  },
};
