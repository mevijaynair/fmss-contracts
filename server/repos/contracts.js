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
  /**
   * Partial update — only the fields actually supplied are written.
   *
   * This used to overwrite every column unconditionally, so any caller sending a
   * subset silently blanked the rest. The settings form never sends
   * tournament_rates, which meant saving a rate card wiped the tournament rates
   * to {} every time. A form that quietly discards data it does not display is
   * the worst kind of bug, because nothing looks wrong until you go looking.
   */
  update(id, patch = {}) {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown contract: ${id}`);

    const sets = [];
    const vals = [];
    const put = (col, v) => { sets.push(`${col}=?`); vals.push(v); };

    if (patch.name !== undefined) put('name', String(patch.name).trim());
    if (patch.venue !== undefined) put('venue', String(patch.venue).trim());
    if (patch.cost_per_gw !== undefined) put('cost_per_gw', Number(patch.cost_per_gw) || 0);
    if (patch.rates !== undefined) put('rates', JSON.stringify(patch.rates || {}));
    if (patch.tournament_rates !== undefined) {
      put('tournament_rates', JSON.stringify(patch.tournament_rates || {}));
    }
    if (!sets.length) return current;

    vals.push(id);
    db.prepare(`UPDATE contracts SET ${sets.join(', ')} WHERE id=?`).run(...vals);
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
