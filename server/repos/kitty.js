// kitty.js — club income/expense pot (BBQ, iftar, annual day, football top-ups).
import { db } from '../db.js';

function opening() {
  const m = db.prepare("SELECT value FROM meta WHERE key='kitty_opening_balance'").get();
  return m ? Number(m.value) || 0 : 0;
}

export const kittyRepo = {
  all() {
    return db.prepare('SELECT * FROM kitty ORDER BY date DESC, created_at DESC').all();
  },
  // Balance = opening + kitty income/expense + contract profits (only from contracts with games).
  balance() {
    const live = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN kind='income'  THEN amount ELSE 0 END),0) AS income,
        COALESCE(SUM(CASE WHEN kind='expense' THEN amount ELSE 0 END),0) AS expense
      FROM kitty WHERE historical = 0`).get();

    // Contract profits: sum of (contributed - charged) from contracts with games recorded
    const contractProfits = db.prepare(`
      SELECT COALESCE(SUM(profit), 0) as total_profit
      FROM (
        SELECT
          l.contract_id,
          COALESCE(SUM(CASE WHEN con.kind='income' THEN con.amount ELSE 0 END), 0) as contributed,
          COALESCE(SUM(CASE WHEN ch.id IS NOT NULL THEN ch.amount ELSE 0 END), 0) as charged,
          COUNT(DISTINCT gw.id) as games,
          (COALESCE(SUM(CASE WHEN con.kind='income' THEN con.amount ELSE 0 END), 0) -
           COALESCE(SUM(CASE WHEN ch.id IS NOT NULL THEN ch.amount ELSE 0 END), 0)) as profit
        FROM ledgers l
        LEFT JOIN contributions con ON l.player_id = con.player_id AND l.contract_id = con.contract_id AND con.historical = 0
        LEFT JOIN charges ch ON l.player_id = ch.player_id
        LEFT JOIN gameweeks gw ON ch.gameweek_id = gw.id AND gw.contract_id = l.contract_id
        WHERE gw.id IS NOT NULL
        GROUP BY l.contract_id
      ) profit_by_contract
    `).get();

    const contractProfit = contractProfits?.total_profit || 0;

    return {
      opening: opening(),
      income: live.income,
      expense: live.expense,
      contractProfit: Math.round(contractProfit * 100) / 100,
      balance: Math.round((opening() + live.income - live.expense + contractProfit) * 100) / 100,
    };
  },
  create({ kind, label, amount, date, scope }) {
    const id = `k_live_${Date.now()}`;
    db.prepare(`INSERT INTO kitty (id,kind,label,amount,date,scope,historical,created_at)
                VALUES (?,?,?,?,?,?,0,?)`).run(
      id, kind === 'income' ? 'income' : 'expense', label || '',
      Number(amount) || 0, date || new Date().toISOString().slice(0, 10),
      scope || '', new Date().toISOString());
    return db.prepare('SELECT * FROM kitty WHERE id = ?').get(id);
  },
  remove(id) {
    db.prepare('DELETE FROM kitty WHERE id = ?').run(id);
  },
};
