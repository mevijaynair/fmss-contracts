// opening_balances.js — manage opening balances per player per contract (1 Aug baseline)
import { ledgersRepo } from './ledgers.js';

export const openingBalancesRepo = {
  // Bulk import opening balances for a contract. Creates/updates ledger records.
  // payload: { contract_id, balances: [{name, balance}] }
  importBalances(db, playersRepo, contractId, balances) {
    if (!contractId || !balances?.length) {
      throw new Error('contract_id and balances array required');
    }

    const results = { imported: 0, skipped: 0, errors: [] };

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

      // ledgers has no surrogate id — its key is (player_id, contract_id). This
      // used to SELECT/INSERT a nonexistent `id` column and an INSERT list with
      // columns (contributed, charged, present_balance) that don't exist on the
      // table either — every call threw before writing anything, so this import
      // path has never actually worked.
      db.prepare(
        `INSERT INTO ledgers (player_id, contract_id, opening_balance, status)
         VALUES (?, ?, ?, '')
         ON CONFLICT (player_id, contract_id) DO UPDATE SET opening_balance = excluded.opening_balance`
      ).run(player.id, contractId, balance);

      results.imported++;
    }

    return results;
  },

  // Get all opening balances for a contract (for verification/export).
  // contributed/charged/present_balance aren't stored columns — ledgersRepo
  // already computes them live from contributions/charges, so reuse that
  // instead of re-deriving (and re-breaking) the same query here.
  getBalances(db, playersRepo, contractId) {
    return ledgersRepo.forContract(contractId).map(l => ({
      player_id: l.player_id,
      name: l.player_name,
      opening_balance: l.opening_balance,
      contributed: l.contributed,
      charged: l.charged,
      present_balance: l.present_balance,
    }));
  },

  // Get summary stats for a contract
  getSummary(db, contractId) {
    const rows = ledgersRepo.forContract(contractId);
    return {
      player_count: rows.length,
      total_opening: rows.reduce((s, l) => s + l.opening_balance, 0),
      total_contributed: rows.reduce((s, l) => s + l.contributed, 0),
      total_charged: rows.reduce((s, l) => s + l.charged, 0),
      total_balance: Math.round(rows.reduce((s, l) => s + l.present_balance, 0) * 100) / 100,
    };
  },
};
