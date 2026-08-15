// kitty_opening_balance.js — immutable one-time kitty balance snapshot per contract
// Clean model: opening_amount is locked at a snapshot date, all live activity (income/expense) builds on top
// Expenses are fully trackable: each entry labeled with contract_id for automatic categorization

import { db } from '../db.js';

export const kittyOpeningBalanceRepo = {
  // Set one-time opening kitty balance for a contract (idempotent)
  import(contractId, openingAmount, snapshotDate, importedById, notes = '') {
    const existing = db.prepare('SELECT id FROM kitty_opening_balance WHERE contract_id = ?').get(contractId);
    if (existing) {
      throw new Error(`Kitty opening already set for ${contractId}. Delete first if you need to change.`);
    }

    const id = `kitty_open_${contractId}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO kitty_opening_balance
      (id, contract_id, snapshot_date, opening_amount, imported_by, locked_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, contractId, snapshotDate || now, openingAmount, importedById || 'system', now, notes || '');

    return this.get(contractId);
  },

  // Get opening balance for a contract
  get(contractId) {
    return db.prepare(`
      SELECT id, contract_id, snapshot_date, opening_amount, locked_at, notes
      FROM kitty_opening_balance
      WHERE contract_id = ?
    `).get(contractId);
  },

  // Delete opening (for corrections only)
  delete(contractId) {
    db.prepare('DELETE FROM kitty_opening_balance WHERE contract_id = ?').run(contractId);
    return { ok: true };
  },

  // Get kitty position for one contract: opening + all income/expenses
  getBalance(contractId) {
    const opening = this.get(contractId);
    const openingAmount = opening?.opening_amount || 0;

    // Income: game kitty earned + manual income entries for this contract
    const income = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN kind='income' THEN amount ELSE 0 END), 0) as total
      FROM kitty
      WHERE scope = ? AND historical = 0
    `).get(contractId);

    const gameIncome = db.prepare(`
      SELECT COALESCE(SUM(kitty_earned), 0) as total
      FROM gameweeks
      WHERE contract_id = ? AND historical = 0 AND kitty_earned > 0
    `).get(contractId);

    // Expenses: manual expense entries for this contract
    const expenses = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN kind='expense' THEN amount ELSE 0 END), 0) as total
      FROM kitty
      WHERE scope = ? AND historical = 0
    `).get(contractId);

    const totalIncome = (income?.total || 0) + (gameIncome?.total || 0);
    const totalExpense = expenses?.total || 0;

    return {
      contract_id: contractId,
      opening_amount: openingAmount,
      snapshot_date: opening?.snapshot_date,
      total_income: totalIncome,
      total_expense: totalExpense,
      present_balance: openingAmount + totalIncome - totalExpense,
    };
  },

  // Get all kitty activity for a contract: opening + all transactions in one list
  getActivityLog(contractId) {
    const opening = this.get(contractId);

    // All kitty entries for this contract
    const kittyEntries = db.prepare(`
      SELECT
        id, kind, label, amount, date, created_at,
        'kitty_entry' as type
      FROM kitty
      WHERE scope = ? AND historical = 0
      ORDER BY date, created_at
    `).all(contractId);

    // Game kitty earned
    const gameKitty = db.prepare(`
      SELECT
        id, 'income' as kind, 'Game kitty earned' as label, kitty_earned as amount, date, created_at,
        'game_kitty' as type
      FROM gameweeks
      WHERE contract_id = ? AND historical = 0 AND kitty_earned != 0
      ORDER BY date
    `).all(contractId);

    const allActivity = [...kittyEntries, ...gameKitty].sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );

    return {
      contract_id: contractId,
      opening: {
        amount: opening?.opening_amount || 0,
        snapshot_date: opening?.snapshot_date,
        notes: opening?.notes,
      },
      activity: allActivity,
    };
  },

  // Get summary across all contracts
  getAllBalances() {
    const contracts = db.prepare('SELECT id FROM contracts ORDER BY id').all();
    const balances = contracts.map(c => this.getBalance(c.id));

    const totalOpening = balances.reduce((s, b) => s + b.opening_amount, 0);
    const totalIncome = balances.reduce((s, b) => s + b.total_income, 0);
    const totalExpense = balances.reduce((s, b) => s + b.total_expense, 0);

    return {
      by_contract: balances,
      summary: {
        total_opening: totalOpening,
        total_income: totalIncome,
        total_expense: totalExpense,
        total_present: totalOpening + totalIncome - totalExpense,
      },
    };
  },
};
