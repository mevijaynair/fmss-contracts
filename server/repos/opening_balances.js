// opening_balances.js — manage opening balances per player per contract (1 Aug baseline)
import { randomBytes } from 'node:crypto';

function generateId() {
  return randomBytes(8).toString('hex');
}

export const openingBalancesRepo = {
  // Bulk import opening balances for a contract. Creates/updates ledger records.
  // payload: { contract_id, balances: [{name, balance}] }
  importBalances(db, playersRepo, contractId, balances) {
    if (!contractId || !balances?.length) {
      throw new Error('contract_id and balances array required');
    }

    const results = { imported: 0, skipped: 0, errors: [] };
    const now = new Date().toISOString();

    for (const row of balances) {
      const { name, balance } = row;
      if (!name || balance === undefined) continue;

      // Find player by name (case-insensitive)
      const player = playersRepo.all().find(p =>
        p.name.toLowerCase().trim() === name.toLowerCase().trim()
      );

      if (!player) {
        results.errors.push(`Player "${name}" not found`);
        results.skipped++;
        continue;
      }

      // Check if ledger record exists for this player-contract combo
      const existing = db.prepare(
        'SELECT id FROM ledgers WHERE player_id = ? AND contract_id = ?'
      ).get(player.id, contractId);

      if (existing) {
        // Update opening balance
        db.prepare(
          'UPDATE ledgers SET opening_balance = ? WHERE id = ?'
        ).run(balance, existing.id);
      } else {
        // Create new ledger record with opening balance
        db.prepare(
          `INSERT INTO ledgers (id, player_id, contract_id, opening_balance, contributed, charged, present_balance, games, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, 0, ?, 0, 'active', ?, ?)`
        ).run(generateId(), player.id, contractId, balance, balance, now, now);
      }

      results.imported++;
    }

    return results;
  },

  // Get all opening balances for a contract (for verification/export)
  getBalances(db, playersRepo, contractId) {
    const ledgers = db.prepare(
      `SELECT l.id, l.player_id, p.name, l.opening_balance, l.contributed, l.charged, l.present_balance
       FROM ledgers l
       JOIN players p ON p.id = l.player_id
       WHERE l.contract_id = ?
       ORDER BY p.name`
    ).all(contractId);

    return ledgers.map(l => ({
      player_id: l.player_id,
      name: l.name,
      opening_balance: l.opening_balance,
      contributed: l.contributed,
      charged: l.charged,
      present_balance: l.present_balance
    }));
  },

  // Get summary stats for a contract
  getSummary(db, contractId) {
    const stats = db.prepare(
      `SELECT
        COUNT(*) as player_count,
        SUM(opening_balance) as total_opening,
        SUM(contributed) as total_contributed,
        SUM(charged) as total_charged,
        SUM(present_balance) as total_balance
       FROM ledgers
       WHERE contract_id = ?`
    ).get(contractId);

    return stats;
  },
};
