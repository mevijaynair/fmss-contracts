// players.js — the unified roster (shared across both contracts) + aliases.
//
// Imports three sibling repos for splitInto, which has to prove it moved no
// money. None of them imports this one back — checked, because a cycle here
// would be a blank page rather than an error.
import { db } from '../db.js';
import { ledgersRepo } from './ledgers.js';
import { kittyRepo } from './kitty.js';
import { gameweeksRepo } from './gameweeks.js';

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
  create({ name, aliases = [], allowDuplicateName = false,
    player_type = 'regular', outside_cost = null }) {
    // Two people with the same name is a real situation — the club has two
    // Rohits — but it must be a decision, not an accident. The parser takes
    // the first record that matches a token, so an unnoticed duplicate means
    // one of them silently receives the other's games for ever.
    const clash = allowDuplicateName ? null : this.nameClashesWith(name);
    if (clash) {
      throw new Error(
        `${clash.name} is already on the roster, and a team sheet cannot tell the two apart. `
        + 'Add something that distinguishes them — a surname or an initial.');
    }
    // A guest could only be made by pasting an unknown name into Game Day and
    // answering a prompt, which meant the one thing you might want to do
    // deliberately — write down the walk-up who keeps turning up, as a guest —
    // could only happen by accident. outside_cost stays null unless a rate has
    // actually been agreed with them; null means the contract's own guest rate,
    // which is right for nearly everybody.
    const type = player_type === 'outside' ? 'outside' : 'regular';
    const cost = type === 'outside' && Number(outside_cost) > 0
      ? Number(outside_cost) : null;
    const id = slug(name);
    db.prepare(`INSERT INTO players (id,name,aliases,player_type,outside_cost,created_at)
                VALUES (?,?,?,?,?,?)`)
      .run(id, name.trim(), JSON.stringify(aliases), type, cost, new Date().toISOString());

    // Create ledger rows for all existing contracts so player appears everywhere
    const contracts = db.prepare('SELECT id FROM contracts ORDER BY sort, name').all();
    for (const c of contracts) {
      db.prepare(`INSERT OR IGNORE INTO ledgers (player_id, contract_id, opening_balance, status)
                  VALUES (?, ?, 0, '')`)
        .run(id, c.id);
    }

    return this.get(id);
  },
  /**
   * Only the fields the caller actually sent.
   *
   * special_role and hide_from_sheet are touched only when their key is present,
   * so the rename modal cannot quietly clear the cashier role or un-hide
   * somebody just by not mentioning them.
   */
  update(id, fields = {}) {
    const { name, aliases } = fields;
    // Renaming somebody onto a name already in use is the same hazard as
    // creating a duplicate, reached from the other end.
    for (const key of [name, ...(Array.isArray(aliases) ? aliases : [])]) {
      if (key === undefined || key === null || key === '') continue;
      const clash = this.nameClashesWith(key, id);
      if (clash) {
        throw new Error(
          `"${String(key).trim()}" is already how ${clash.name} is matched in a team sheet. `
          + 'Pick something that tells them apart.');
      }
    }
    const sets = [];
    const values = [];
    if (name !== undefined) { sets.push('name=?'); values.push(String(name).trim()); }
    if (aliases !== undefined) { sets.push('aliases=?'); values.push(JSON.stringify(aliases || [])); }
    if (fields.special_role !== undefined) {
      sets.push('special_role=?'); values.push(fields.special_role || null);
    }
    if (fields.hide_from_sheet !== undefined) {
      sets.push('hide_from_sheet=?'); values.push(fields.hide_from_sheet ? 1 : 0);
    }
    if (sets.length) {
      db.prepare(`UPDATE players SET ${sets.join(', ')} WHERE id=?`).run(...values, id);
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
  /**
   * Names that would resolve to the same person in a team sheet.
   *
   * The parser normalises a token and takes the FIRST record that matches, so
   * two people called Rohit are not an error anywhere — one of them silently
   * gets every Rohit that is ever pasted, and the other never appears. There
   * is no way to notice that from any screen, which is why this exists: it is
   * checked when a player is named, shown on Game Day, and counted by the
   * audit.
   *
   * Aliases count. "Roji" as an alias of Rojy colliding with a new player
   * actually called Roji is the same hazard by another route.
   */
  nameCollisions() {
    const norm = (s) => String(s).toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9 ]/g, '').trim();
    const seen = new Map();
    for (const p of this.all()) {
      for (const key of [p.name, ...(p.aliases || [])]) {
        const n = norm(key);
        if (!n) continue;
        if (!seen.has(n)) seen.set(n, []);
        const bucket = seen.get(n);
        if (!bucket.some(x => x.id === p.id)) bucket.push({ id: p.id, name: p.name, as: key });
      }
    }
    return [...seen.entries()].filter(([, who]) => who.length > 1)
      .map(([n, who]) => ({ name: n, players: who }));
  },

  /** Would this name be indistinguishable from somebody already on the roster? */
  nameClashesWith(name, exceptId = null) {
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    const n = norm(name);
    if (!n) return null;
    for (const p of this.all()) {
      if (p.id === exceptId) continue;
      for (const key of [p.name, ...(p.aliases || [])]) {
        if (norm(key) === n) return p;
      }
    }
    return null;
  },

  /**
   * Move somebody between the squad and the guest list.
   *
   * Looks like a label and is not. Whether a charge comes off a balance or is
   * cash owed on the day is read from the SETTLER'S kind — so making a member
   * a guest does not just change how they are listed, it retrospectively
   * turns every game they ever settled off their balance into cash they owe.
   * Their balance jumps up by the lot and they are suddenly a debtor for
   * football they have already paid for.
   *
   * So it is allowed when it moves nothing, which is the ordinary case — the
   * walk-ups sitting in the ledger at zero, which is exactly who this is for
   * — and refused with the arithmetic when it would. Same rule as the split:
   * this changes WHAT SOMEBODY IS, never how a game was settled, and the
   * second is a decision to make on the game.
   */
  setKind(playerId, kind, { outsideCost = null } = {}) {
    if (!['regular', 'outside'].includes(kind)) throw new Error('Unknown kind');
    const p = this.get(playerId);
    if (!p) throw new Error('No such player');
    if ((p.player_type || 'regular') === kind) return p;
    if (p.special_role === 'cashier' && kind === 'outside') {
      throw new Error('The cashier funds the contracts; they cannot be a guest');
    }

    const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const snapshot = () => {
      const rows = ledgersRepo.forPlayer(playerId);
      return {
        balance: r2(rows.reduce((s, l) => s + l.present_balance, 0)),
        owed: r2(rows.reduce((s, l) => s + (l.cash_owed || 0), 0)),
        kitty: r2(kittyRepo.balance().balance),
      };
    };
    const before = snapshot();
    const games = db.prepare(
      `SELECT DISTINCT gameweek_id FROM charges
       WHERE COALESCE(charged_to, player_id) = ?`).all(playerId).map(r => r.gameweek_id);

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE players SET player_type = ?, outside_cost = ? WHERE id = ?')
        .run(kind, kind === 'outside' && Number(outsideCost) > 0 ? Number(outsideCost) : null,
          playerId);
      for (const g of games) gameweeksRepo.recomputeGameKitty(g);

      const after = snapshot();
      if (after.balance !== before.balance || after.owed !== before.owed
          || after.kitty !== before.kitty) {
        const moved = r2(Math.abs(after.balance - before.balance));
        throw new Error(
          `${p.name} has ${moved} of football settled off a balance. Making them a `
          + `${kind === 'outside' ? 'guest' : 'member'} would turn that into `
          + `${kind === 'outside' ? 'cash they owe' : 'a balance charge'} and change what they `
          + 'hold, so nothing was done. Switch those games on the game itself first, in Game '
          + 'history, if that is really what happened.');
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return this.get(playerId);
  },

  /**
   * One record turns out to be two people. Pull the second one out of it.
   *
   * The club has two men called Rohit. Every "Rohit" in a pasted team sheet
   * resolved to whichever record the index happened to reach first, so one
   * person's games, and one person's debts, ended up on the other's row — and
   * nothing anywhere said so.
   *
   * This is a REASSIGNMENT, never a creation. The named charges and
   * contributions move across; nothing is edited, nothing is added, nothing is
   * deleted. So the invariant is exact and is checked before the commit: the
   * two people's balances afterwards must add up to the one person's balance
   * before, on every contract, and the kitty must not move at all. Anything
   * else means this has invented or destroyed money while tidying a roster,
   * and it rolls back.
   *
   * The new person is given a distinguishable name, because leaving two
   * records reading "Rohit" would rebuild the exact problem being fixed here.
   */
  splitInto(playerId, { name, chargeIds = [], contributionIds = [],
    playerType = null, outsideCost = null } = {}) {
    const original = this.get(playerId);
    if (!original) throw new Error('No such player');
    const newName = String(name || '').trim();
    if (!newName) throw new Error('The second person needs a name');
    if (!chargeIds.length && !contributionIds.length) {
      throw new Error('Nothing selected to move — pick the games or payments that are theirs');
    }
    const clash = this.nameClashesWith(newName);
    if (clash) {
      throw new Error(
        `"${newName}" is indistinguishable from ${clash.name} in a team sheet. `
        + 'Give the second person a name that tells them apart — a surname, or an initial.');
    }

    // Everything being moved must actually belong to this person, or the
    // selection is being used to reach into somebody else's record.
    const owned = new Set(db.prepare(
      'SELECT id FROM charges WHERE player_id = ? OR charged_to = ?').all(playerId, playerId)
      .map(r => r.id));
    for (const id of chargeIds) {
      if (!owned.has(id)) throw new Error(`Charge ${id} is not ${original.name}'s to move`);
    }
    const ownedContribs = new Set(db.prepare(
      'SELECT id FROM contributions WHERE player_id = ?').all(playerId).map(r => r.id));
    for (const id of contributionIds) {
      if (!ownedContribs.has(id)) throw new Error(`Payment ${id} is not ${original.name}'s to move`);
    }

    const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const balancesOf = (id) => Object.fromEntries(
      ledgersRepo.forPlayer(id).map(l => [l.contract_id, l.present_balance]));
    const before = { mine: balancesOf(playerId), kitty: r2(kittyRepo.balance().balance) };

    const affectedGames = chargeIds.length
      ? db.prepare(`SELECT DISTINCT gameweek_id FROM charges
                    WHERE id IN (${chargeIds.map(() => '?').join(',')})`).all(...chargeIds)
        .map(r => r.gameweek_id)
      : [];

    const newId = slug(newName);
    db.exec('BEGIN IMMEDIATE');
    try {
      // The second person is usually the same kind as the first, but not
      // always — and the case that prompted this is exactly the exception.
      // The club's second Rohit is a walk-up who pays cash, sharing a name
      // with a contracted member. Without being able to say so here, the
      // split produced another member and the guest had to be made by hand
      // afterwards, which is where the games get left behind.
      const type = playerType === 'outside' ? 'outside'
        : playerType === 'regular' ? 'regular'
          : (original.player_type || 'regular');
      const cost = type === 'outside'
        ? (Number(outsideCost) > 0 ? Number(outsideCost) : original.outside_cost ?? null)
        : null;
      db.prepare(`INSERT INTO players (id,name,aliases,player_type,outside_cost,created_at)
                  VALUES (?,?,'[]',?,?,?)`)
        .run(newId, newName, type, cost, new Date().toISOString());
      for (const c of db.prepare('SELECT id FROM contracts').all()) {
        ledgersRepo.ensure(newId, c.id);
      }

      if (chargeIds.length) {
        const q = chargeIds.map(() => '?').join(',');
        // Both columns, but charged_to only where it pointed at this person —
        // a guest billed to them stays billed to whoever is still paying.
        db.prepare(`UPDATE charges SET player_id = ? WHERE id IN (${q}) AND player_id = ?`)
          .run(newId, ...chargeIds, playerId);
        db.prepare(`UPDATE charges SET charged_to = ? WHERE id IN (${q}) AND charged_to = ?`)
          .run(newId, ...chargeIds, playerId);
      }
      if (contributionIds.length) {
        db.prepare(`UPDATE contributions SET player_id = ?
                    WHERE id IN (${contributionIds.map(() => '?').join(',')}) AND player_id = ?`)
          .run(newId, ...contributionIds, playerId);
      }
      // The pot is derived from the charges, and the charges have moved rows.
      // The amounts have not changed, so this should be a no-op — and the
      // check below is what proves it was.
      for (const g of affectedGames) gameweeksRepo.recomputeGameKitty(g);

      const after = { mine: balancesOf(playerId), theirs: balancesOf(newId),
        kitty: r2(kittyRepo.balance().balance) };
      const drift = [];
      for (const cid of new Set([...Object.keys(before.mine), ...Object.keys(after.mine),
        ...Object.keys(after.theirs)])) {
        const was = r2(before.mine[cid] ?? 0);
        const now = r2((after.mine[cid] ?? 0) + (after.theirs[cid] ?? 0));
        if (was !== now) drift.push(`${cid}: ${was} split into ${now}`);
      }
      if (after.kitty !== before.kitty) {
        drift.push(`kitty moved ${before.kitty} -> ${after.kitty}`);
      }
      if (drift.length) {
        // This tool reassigns WHO, never HOW something is settled, so the
        // money must come out the same. Three reasons it might not, and the
        // reader needs to know which:
        //
        //   Making the second person a guest, while one of the moved games
        //   was funded off a balance. A guest keeps no balance, so that game
        //   turns into cash they owe — a real change, and a legitimate one,
        //   but it is a change of SETTLEMENT and belongs on the game, where
        //   Game history already offers it.
        //
        //   A stale pot entry on one of these games, which recomputing has
        //   just corrected. Somebody else's fault, and not one to fix
        //   silently in the middle of splitting a person in two.
        //
        //   The reassignment itself being wrong, which is the case this
        //   whole check exists for.
        const guesty = playerType === 'outside' && drift.some(d => !d.startsWith('kitty'));
        throw new Error(`Splitting would have changed the money, so nothing was done: ${
          drift.join('; ')}.`
          + (guesty
            ? ' One of those games comes off a balance, and a guest keeps none — switch it to'
              + ' cash on the game first, in Game history, then split.'
            : '')
          + (drift.some(d => d.startsWith('kitty'))
            ? ' A game\'s pot entry looks out of date — run the kitty reconcile first.' : ''));
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { original: this.get(playerId), created: this.get(newId) };
  },

  reset(id) {
    // Keep player, clear contributions but KEEP charges for historical record; balance → accumulated charges
    db.prepare('DELETE FROM contributions WHERE player_id = ?').run(id);
    db.prepare('UPDATE ledgers SET opening_balance = 0 WHERE player_id = ?').run(id);
  },
};
