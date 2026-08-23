#!/usr/bin/env node
/**
 * split-shared-account.js — turn a combined "A + B" player into two players that
 * share one balance.
 *
 * Why: an account like "AWS + Ali" is correct for money (one pot) but wrong for
 * results — merging two people credits one with the other's appearances, and
 * when both play the same match the second is dropped as a duplicate.
 *
 * Approach, chosen to move no money:
 *   - RENAME the existing record to the first name. It keeps its id, ledgers,
 *     opening balance, contributions and charges, so nothing is recalculated.
 *   - CREATE the second person as a new player starting at zero.
 *   - LINK both into a player_balance_groups row, so the pair's balance is the
 *     sum of the two and behaves as one pot again.
 *   - Strip the now-misleading aliases from the renamed record, so "Ali" in a
 *     team sheet resolves to Ali rather than back to the combined account.
 *
 * Usage:
 *   node scripts/split-shared-account.js                 # dry run, prints the plan
 *   node scripts/split-shared-account.js --commit        # apply
 *   node scripts/split-shared-account.js --id aws_ali --commit
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.FMSS_DB_PATH || join(__dirname, '..', 'data', 'fmss.db');

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const idArg = args[args.indexOf('--id') + 1];
const TARGET = args.includes('--id') ? idArg : null;

const db = new DatabaseSync(DB_PATH);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const combined = db.prepare(`
  SELECT id, name, aliases, balance_group_id FROM players
  WHERE ${TARGET ? 'id = ?' : "name LIKE '% + %' OR name LIKE '% & %'"}
`).all(...(TARGET ? [TARGET] : []));

if (!combined.length) {
  console.log('No combined accounts found. Nothing to do.');
  process.exit(0);
}

console.log(`DB: ${DB_PATH}`);
console.log(COMMIT ? 'MODE: COMMIT\n' : 'MODE: DRY RUN — nothing will be written\n');

for (const p of combined) {
  const parts = p.name.split(/\s*[+&]\s*/).map(s => s.trim()).filter(Boolean);
  if (parts.length !== 2) {
    console.log(`skip ${p.id}: expected two names, got ${parts.length}`);
    continue;
  }
  const [keepName, newName] = parts;
  const newId = slug(newName);

  const ledgers = db.prepare('SELECT contract_id, opening_balance FROM ledgers WHERE player_id = ?').all(p.id);
  const charges = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount),0) t FROM charges WHERE player_id = ?').get(p.id);
  const contribs = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount),0) t FROM contributions WHERE player_id = ?').get(p.id);
  const clash = db.prepare('SELECT id FROM players WHERE id = ? OR LOWER(name) = LOWER(?)').get(newId, newName);

  console.log(`"${p.name}"  (id: ${p.id})`);
  console.log(`  keep  → "${keepName}" on the SAME id, so its ledger and history are untouched`);
  console.log(`         opening: ${ledgers.map(l => `${l.contract_id}=${l.opening_balance}`).join(', ') || 'none'}`);
  console.log(`         ${contribs.n} contribution(s) = ${contribs.t}, ${charges.n} charge(s) = ${charges.t}`);
  console.log(`  new   → "${newName}" (id: ${newId}) starting at 0 on every contract`);
  console.log(`  group → both linked, so the pair's balance stays the sum`);
  if (clash) { console.log(`  ✗ ABORT: "${newName}" already exists (id ${clash.id}) — resolve by hand`); continue; }
  if (p.balance_group_id) { console.log(`  ✗ ABORT: already in group ${p.balance_group_id}`); continue; }

  if (!COMMIT) { console.log('  (dry run)\n'); continue; }

  const now = new Date().toISOString();
  const contracts = db.prepare('SELECT id FROM contracts').all();

  db.prepare('UPDATE players SET name = ?, aliases = ? WHERE id = ?').run(keepName, '[]', p.id);
  db.prepare('INSERT INTO players (id,name,aliases,created_at,player_type) VALUES (?,?,?,?,?)')
    .run(newId, newName, '[]', now, 'regular');
  for (const c of contracts) {
    db.prepare(`INSERT OR IGNORE INTO ledgers (player_id, contract_id, opening_balance, status)
                VALUES (?, ?, 0, '')`).run(newId, c.id);
  }

  // One group row per contract — the table is scoped that way.
  const groupId = randomUUID();
  for (const c of contracts) {
    db.prepare(`INSERT INTO player_balance_groups (id, group_name, contract_id, description, created_at)
                VALUES (?,?,?,?,?)`)
      .run(`${groupId}_${c.id}`, `${keepName} + ${newName}`, c.id,
        'Split from a combined account; one shared balance, separate results', now);
  }
  db.prepare('UPDATE players SET balance_group_id = ? WHERE id IN (?, ?)').run(groupId, p.id, newId);

  console.log(`  ✓ done — group ${groupId}\n`);
}

if (!COMMIT) console.log('Re-run with --commit to apply.');
