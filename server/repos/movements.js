// movements.js — money moved without a game being played.
//
// Three things the club does that no game records: paying somebody out of the
// pot (the cashier reimbursing themselves for something they bought), putting
// money into the pot from a player's balance, and moving credit from one player
// to another. Before this they had to be faked — a contribution here, a manual
// kitty entry there — with nothing tying the two halves together, so a half-done
// move left money invented or destroyed and no record of what was intended.
//
// A movement is one row of intent with two legs written together. Both legs
// carry the movement's id, so reversing one always reverses the other, and
// neither can exist alone.
//
// The legs use the transaction types the schema already allows: 'adjustment' for
// a leg facing the kitty, and transfer_out/transfer_in between two players. That
// keeps every existing balance query correct without widening the CHECK
// constraint that governs them.
import { db } from './../db.js';
import { ledgersRepo } from './ledgers.js';

const round2 = (n) => Math.round(n * 100) / 100;
const KITTY = 'kitty';

function nameOf(playerId) {
  return db.prepare('SELECT name FROM players WHERE id = ?').get(playerId)?.name || playerId;
}

/**
 * Both sides of a movement, described the way a person would say it.
 * `from` and `to` are either a player id or the literal 'kitty'.
 */
function describe({ from, to, amount, contract_id: contractId, note }) {
  const side = (x) => (x === KITTY ? 'the kitty' : nameOf(x));
  const base = `${side(from)} → ${side(to)}`;
  return note ? `${base} — ${note}` : base;
}

export const movementsRepo = {
  /** Every movement, newest first, with both legs resolved for display. */
  all({ contractId = null, limit = 100 } = {}) {
    const rows = contractId
      ? db.prepare(`SELECT * FROM movements WHERE contract_id = ?
                    ORDER BY date DESC, created_at DESC LIMIT ?`).all(contractId, limit)
      : db.prepare(`SELECT * FROM movements
                    ORDER BY date DESC, created_at DESC LIMIT ?`).all(limit);
    return rows.map(m => ({
      ...m,
      from_name: m.from_party === KITTY ? 'Kitty' : nameOf(m.from_party),
      to_name: m.to_party === KITTY ? 'Kitty' : nameOf(m.to_party),
    }));
  },

  /**
   * Move money, in one transaction, or not at all.
   *
   * Refuses a movement whose two ends are the same, and one with no positive
   * amount — both are ways of writing a pair of legs that cancel out, leaving
   * rows that say something happened when nothing did.
   */
  create({ from, to, amount, contract_id: contractId, date, note = '', created_by = 'admin' }) {
    const amt = round2(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) throw new Error('Amount must be more than zero');
    if (!from || !to) throw new Error('Both a source and a destination are required');
    if (from === to) throw new Error('Money cannot move to where it already is');
    if (from !== KITTY && to !== KITTY && !contractId) {
      throw new Error('A transfer between players needs a contract — balances are per contract');
    }
    for (const party of [from, to]) {
      if (party === KITTY) continue;
      if (!db.prepare('SELECT id FROM players WHERE id = ?').get(party)) {
        throw new Error(`No such player: ${party}`);
      }
    }

    const id = `mv_${Date.now()}`;
    const when = date || new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    const label = describe({ from, to, amount: amt, contract_id: contractId, note });

    const playerLeg = db.prepare(`INSERT INTO transactions
      (id, player_id, contract_id, type, amount, description, status, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,'approved',?,?,?)`);

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO movements
        (id, from_party, to_party, amount, contract_id, date, note, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, from, to, amt, contractId || null, when, note || '', created_by, now);

      // A leg facing the kitty is a kitty row plus one player adjustment. A leg
      // between two players is two adjustments and no kitty row — the pot is not
      // involved, so it must not move.
      if (from === KITTY || to === KITTY) {
        const player = from === KITTY ? to : from;
        const intoKitty = to === KITTY;
        if (contractId) ledgersRepo.ensure(player, contractId);
        db.prepare(`INSERT INTO kitty (id,kind,label,amount,date,scope,contract_id,historical,created_at)
                    VALUES (?,?,?,?,?,?,?,0,?)`)
          .run(`k_${id}`, intoKitty ? 'income' : 'expense', label, amt, when, id,
            contractId || null, now);
        // The player's side only reaches a balance when a contract is named — a
        // transaction with no contract belongs to no ledger. Paying the cashier
        // out of the pot for a BBQ is exactly that case: real money leaves the
        // kitty and no contract balance should move.
        if (contractId) {
          playerLeg.run(`t_${id}`, player, contractId, 'adjustment',
            intoKitty ? -amt : amt, label, created_by, now, now);
        }
      } else {
        ledgersRepo.ensure(from, contractId);
        ledgersRepo.ensure(to, contractId);
        playerLeg.run(`t_${id}_out`, from, contractId, 'transfer_out', -amt, label, created_by, now, now);
        playerLeg.run(`t_${id}_in`, to, contractId, 'transfer_in', amt, label, created_by, now, now);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return this.all({ limit: 1 })[0];
  },

  /** Undo a movement: both legs and the record of it, together or not at all. */
  remove(id) {
    const m = db.prepare('SELECT id FROM movements WHERE id = ?').get(id);
    if (!m) throw new Error('Movement not found');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM kitty WHERE scope = ?').run(id);
      db.prepare('DELETE FROM transactions WHERE id IN (?,?,?)')
        .run(`t_${id}`, `t_${id}_out`, `t_${id}_in`);
      db.prepare('DELETE FROM movements WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { ok: true };
  },
};
