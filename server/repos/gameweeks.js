// gameweeks.js — match records + their per-player charges.
import { db } from '../db.js';
import { ledgersRepo } from './ledgers.js';

export const gameweeksRepo = {
  all(contractId) {
    const sql = contractId
      ? 'SELECT * FROM gameweeks WHERE contract_id = ? ORDER BY date DESC, gw_number DESC'
      : 'SELECT * FROM gameweeks ORDER BY date DESC';
    const rows = contractId ? db.prepare(sql).all(contractId) : db.prepare(sql).all();
    return rows.map(g => ({ ...g, charged: this.chargeTotal(g.id) }));
  },
  get(id) {
    const g = db.prepare('SELECT * FROM gameweeks WHERE id = ?').get(id);
    if (!g) return null;
    g.charges = db.prepare(`SELECT ch.*, p.name AS player_name FROM charges ch
      JOIN players p ON p.id = ch.player_id WHERE ch.gameweek_id = ?
      ORDER BY ch.team, p.name`).all(id);
    return g;
  },
  chargeTotal(id) {
    return db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM charges WHERE gameweek_id = ?')
      .get(id).t;
  },
  nextGwNumber(contractId) {
    return (db.prepare('SELECT MAX(gw_number) AS m FROM gameweeks WHERE contract_id = ?')
      .get(contractId).m || 0) + 1;
  },
  // Create a live gameweek and its charges; ensures every charged player has a ledger.
  create(gw, charges) {
    const id = `${gw.contract_id}_live_${Date.now()}`;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO gameweeks
      (id,contract_id,gw_number,contract_number,date,cost_per_gw,num_players,
       teams_raw,captains_raw,score,comments,historical,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?)`).run(
      id, gw.contract_id, gw.gw_number ?? this.nextGwNumber(gw.contract_id),
      gw.contract_number ?? 0, gw.date || now.slice(0, 10), gw.cost_per_gw || 0,
      charges.length, gw.teams_raw || '', gw.captains_raw || '', gw.score || '',
      gw.comments || '', now);

    const insCharge = db.prepare(`INSERT INTO charges
      (id,gameweek_id,player_id,team,is_captain,rate_type,amount) VALUES (?,?,?,?,?,?,?)`);
    charges.forEach((ch, i) => {
      ledgersRepo.ensure(ch.player_id, gw.contract_id);
      insCharge.run(`c_live_${Date.now()}_${i}`, id, ch.player_id, ch.team || '',
        ch.is_captain ? 1 : 0, ch.rate_type || '', Number(ch.amount) || 0);
    });
    return this.get(id);
  },
  remove(id) {
    db.prepare('DELETE FROM gameweeks WHERE id = ?').run(id);   // charges cascade
  },
};
