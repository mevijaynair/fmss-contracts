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

    // Contract profits: sum of net standing from contracts with games recorded
    const contractProfits = db.prepare(`
      SELECT COALESCE(SUM(
        COALESCE(l.contributed, 0) - COALESCE(l.charged, 0)
      ), 0) as profit
      FROM ledgers l
      INNER JOIN (
        SELECT player_id, contract_id, COUNT(*) as games
        FROM gameweeks
        WHERE contract_id IN (SELECT id FROM contracts)
        GROUP BY player_id, contract_id
        HAVING games > 0
      ) gw ON l.player_id = gw.player_id AND l.contract_id = gw.contract_id
    `).get();

    const contractProfit = contractProfits?.profit || 0;

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
