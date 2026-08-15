// kitty_opening_balance.js — immutable one-time kitty balance snapshot
// Like player opening_balances, this is a single locked entry per contract
// Live kitty position = opening_amount + Σ kitty transactions

import { db } from '../db.js';

export const kittyOpeningBalanceRepo = {
  // Import/set the one-time opening kitty balance
  import(contractId, openingAmount, snapshotDate, breakdownJson, importedById, notes = '') {
    // Check if already exists — kitty opening should be set once
    const existing = db.prepare('SELECT id FROM kitty_opening_balance WHERE contract_id = ?').get(contractId);
    if (existing) {
      throw new Error('Kitty opening balance already set for this contract. Edit or delete first.');
    }

    const id = `kitty_opening_${contractId}_${Date.now()}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO kitty_opening_balance
      (id, contract_id, snapshot_date, opening_amount, breakdown_json, imported_by, locked_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      contractId,
      snapshotDate || now,
      openingAmount,
      breakdownJson ? JSON.stringify(breakdownJson) : null,
      importedById,
      now,
      notes
    );

    return this.get(contractId);
  },

  // Get kitty opening for a contract
  get(contractId) {
    const row = db.prepare(`
      SELECT id, contract_id, snapshot_date, opening_amount, breakdown_json, locked_at, notes
      FROM kitty_opening_balance
      WHERE contract_id = ?
    `).get(contractId);

    if (!row) return null;

    return {
      ...row,
      breakdown: row.breakdown_json ? JSON.parse(row.breakdown_json) : null,
    };
  },

  // Get all kitty openings
  all() {
    return db.prepare(`
      SELECT id, contract_id, snapshot_date, opening_amount, breakdown_json, locked_at, notes
      FROM kitty_opening_balance
      ORDER BY locked_at DESC
    `).all().map(row => ({
      ...row,
      breakdown: row.breakdown_json ? JSON.parse(row.breakdown_json) : null,
    }));
  },

  // Delete/reset kitty opening (admin only, careful!)
  delete(contractId) {
    db.prepare('DELETE FROM kitty_opening_balance WHERE contract_id = ?').run(contractId);
    return { ok: true };
  },

  // Get current kitty balance (opening + live transactions)
  // Kitty transactions come from: game_financing (kitty_collection), external_events, manual adjustments
  getCurrentBalance(contractId) {
    const opening = this.get(contractId);
    const openingAmount = opening?.opening_amount || 0;

    // Sum kitty-related transactions
    // For now, kitty transactions are tracked in the old kitty table and game_financing
    const kittyRows = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM kitty
      WHERE scope = ? AND historical = 0
    `).get(contractId);

    const kittyEarned = db.prepare(`
      SELECT COALESCE(SUM(kitty_earned), 0) as total
      FROM gameweeks
      WHERE contract_id = ? AND historical = 0
    `).get(contractId);

    const totalLiveTransactions = (kittyRows?.total || 0) + (kittyEarned?.total || 0);

    return {
      opening_amount: openingAmount,
      live_transactions: totalLiveTransactions,
      present_balance: openingAmount + totalLiveTransactions,
      snapshot_date: opening?.snapshot_date,
      locked_at: opening?.locked_at,
    };
  },

  // Get detailed kitty breakdown (opening + all transactions)
  getDetailedBreakdown(contractId) {
    const balance = this.getCurrentBalance(contractId);
    const opening = this.get(contractId);

    // Get all kitty transactions in order
    const kittyTransactions = db.prepare(`
      SELECT id, kind, label, amount, date, 'kitty' as source
      FROM kitty
      WHERE scope = ? AND historical = 0
      ORDER BY date
    `).all(contractId);

    const gameKitty = db.prepare(`
      SELECT id, 'kitty_earned' as kind, 'Game kitty earned' as label, kitty_earned as amount, date
      FROM gameweeks
      WHERE contract_id = ? AND historical = 0 AND kitty_earned != 0
      ORDER BY date
    `).all(contractId);

    const allTransactions = [
      ...kittyTransactions,
      ...gameKitty.map(g => ({ ...g, source: 'game' })),
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    return {
      contract_id: contractId,
      opening: {
        amount: balance.opening_amount,
        snapshot_date: opening?.snapshot_date,
        breakdown: opening?.breakdown,
        notes: opening?.notes,
      },
      transactions: allTransactions,
      present_balance: balance.present_balance,
    };
  },
};
