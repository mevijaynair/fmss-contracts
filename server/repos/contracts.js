// contracts.js — contract config (rate cards, venue, cost per gameweek).
import { db } from '../db.js';

const row = (c) => c && ({
  ...c,
  rates: JSON.parse(c.rates || '{}'),
  tournament_rates: JSON.parse(c.tournament_rates || '{}')
});

export const contractsRepo = {
  all() {
    return db.prepare('SELECT * FROM contracts ORDER BY sort, name').all().map(row);
  },
  get(id) {
    return row(db.prepare('SELECT * FROM contracts WHERE id = ?').get(id));
  },
  update(id, { name, venue, cost_per_gw, rates, tournament_rates }) {
    db.prepare(`UPDATE contracts SET name=?, venue=?, cost_per_gw=?, rates=?, tournament_rates=? WHERE id=?`)
      .run(name, venue, cost_per_gw, JSON.stringify(rates || {}),
           JSON.stringify(tournament_rates || {}), id);
    return this.get(id);
  },

  // Get applicable rates for a game (regular or tournament)
  getRates(id, gameType = 'regular') {
    const contract = this.get(id);
    if (!contract) return {};
    return gameType === 'tournament' && Object.keys(contract.tournament_rates).length > 0
      ? contract.tournament_rates
      : contract.rates;
  },
};
