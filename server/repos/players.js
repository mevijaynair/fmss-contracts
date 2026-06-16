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
    return this.get(id);
  },
  update(id, { name, aliases }) {
    db.prepare('UPDATE players SET name=?, aliases=? WHERE id=?')
      .run(name.trim(), JSON.stringify(aliases || []), id);
    return this.get(id);
  },
};
