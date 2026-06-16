// contracts.js — contract config (rate cards, venue, cost per gameweek).
import { db } from '../db.js';

const row = (c) => c && ({ ...c, rates: JSON.parse(c.rates || '{}') });

export const contractsRepo = {
  all() {
    return db.prepare('SELECT * FROM contracts ORDER BY sort, name').all().map(row);
  },
  get(id) {
    return row(db.prepare('SELECT * FROM contracts WHERE id = ?').get(id));
  },
  update(id, { name, venue, cost_per_gw, rates }) {
    db.prepare(`UPDATE contracts SET name=?, venue=?, cost_per_gw=?, rates=? WHERE id=?`)
      .run(name, venue, cost_per_gw, JSON.stringify(rates || {}), id);
    return this.get(id);
  },
};
