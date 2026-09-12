// players.js — the unified roster (shared across both contracts) + aliases.
import { db } from '../db.js';

const row = (p) => p && ({ ...p, aliases: JSON.parse(p.aliases || '[]') });

function slug(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  let id = base || 'player';
  let i = 2;
  while (db.prepare('SELECT 1 FROM players WHERE id = ?').get(id)) id = `${base}_${i++}`;
  return id;
}

export const playersRepo = {
  all() {
    return db.prepare('SELECT * FROM players ORDER BY name').all().map(row);
  },
  get(id) {
    return row(db.prepare('SELECT * FROM players WHERE id = ?').get(id));
  },
  create({ name, aliases = [] }) {
    const id = slug(name);
    db.prepare('INSERT INTO players (id,name,aliases,created_at) VALUES (?,?,?,?)')
      .run(id, name.trim(), JSON.stringify(aliases), new Date().toISOString());

    // Create ledger rows for all existing contracts so player appears everywhere
    const contracts = db.prepare('SELECT id FROM contracts ORDER BY sort, name').all();
    for (const c of contracts) {
      db.prepare(`INSERT OR IGNORE INTO ledgers (player_id, contract_id, opening_balance, status)
                  VALUES (?, ?, 0, '')`)
        .run(id, c.id);
    }

    return this.get(id);
  },
  update(id, { name, aliases, special_role }) {
    // special_role is only touched when the key is present, so callers that
    // omit it (e.g. the rename modal) don't accidentally clear the cashier role.
    if (special_role !== undefined) {
      db.prepare('UPDATE players SET name=?, aliases=?, special_role=? WHERE id=?')
        .run(name.trim(), JSON.stringify(aliases || []), special_role || null, id);
    } else {
      db.prepare('UPDATE players SET name=?, aliases=? WHERE id=?')
        .run(name.trim(), JSON.stringify(aliases || []), id);
    }
    return this.get(id);
  },
  getByName(name) {
    // Find player by exact name match (case-insensitive)
    return row(db.prepare('SELECT * FROM players WHERE LOWER(name) = LOWER(?)').get(name));
  },
  /**
   * Remove a player who should never have existed — a typo, or a name added
   * from the wrong import.
   *
   * Refuses anyone carrying financial history. Deleting a player who has been
   * charged for games or has paid money in would tear rows out of the club's
   * accounts to tidy up a roster, which is never the right trade; rename them
   * or leave them dormant instead.
   *
   * Fourteen tables reference players(id). This used to clear three, so with
   * foreign keys on, deleting anyone who had reached any of the other eleven —
   * a locked opening-balance snapshot, for instance — failed outright.
   */
  delete(id) {
    const counts = {
      charges: db.prepare('SELECT COUNT(*) n FROM charges WHERE player_id = ? OR charged_to = ?').get(id, id).n,
      contributions: db.prepare('SELECT COUNT(*) n FROM contributions WHERE player_id = ?').get(id).n,
      transactions: db.prepare('SELECT COUNT(*) n FROM transactions WHERE player_id = ? OR related_player_id = ?').get(id, id).n,
      events: db.prepare('SELECT COUNT(*) n FROM event_attendees WHERE player_id = ? OR host_player_id = ?').get(id, id).n,
      financing: db.prepare('SELECT COUNT(*) n FROM game_financing WHERE payer_id = ?').get(id).n,
      paid_for_event: db.prepare('SELECT COUNT(*) n FROM external_events WHERE paid_by_player_id = ?').get(id).n,
    };
    const held = Object.entries(counts).filter(([, n]) => n > 0);
    if (held.length) {
      throw new Error(
        `${id} has financial history (${held.map(([k, n]) => `${n} ${k}`).join(', ')}) and cannot be deleted. ` +
        'Rename them or leave them dormant instead — removing them would take those records with them.'
      );
    }

    // Safe to remove: nothing here is an accounting record.
    db.prepare('UPDATE players SET introduced_by = NULL WHERE introduced_by = ?').run(id);
    db.prepare('UPDATE audit_log SET player_id = NULL WHERE player_id = ?').run(id);
    db.prepare('DELETE FROM opening_balances_snapshot WHERE player_id = ?').run(id);
    db.prepare('DELETE FROM contributions_pending WHERE player_id = ?').run(id);
    db.prepare('DELETE FROM auth_users WHERE player_id = ?').run(id);
    db.prepare('DELETE FROM ledgers WHERE player_id = ?').run(id);
    db.prepare('DELETE FROM players WHERE id = ?').run(id);
  },
  reset(id) {
    // Keep player, clear contributions but KEEP charges for historical record; balance → accumulated charges
    db.prepare('DELETE FROM contributions WHERE player_id = ?').run(id);
    db.prepare('UPDATE ledgers SET opening_balance = 0 WHERE player_id = ?').run(id);
  },
};
