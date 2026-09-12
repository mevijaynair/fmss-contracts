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
 * Read one end of a movement.
 *
 * A party is a player id, or the kitty. The kitty is written 'kitty' for the
 * club-wide pot and 'kitty:<contract>' for one contract's share — which is what
 * makes "take it out of the Mon/Thu kitty" expressible, and what lets both ends
 * of a movement be the kitty without being the same place.
 */
function readParty(raw) {
  const s = String(raw || '');
  if (s === KITTY) return { kind: KITTY, contractId: null };
  if (s.startsWith(`${KITTY}:`)) {
    const contractId = s.slice(KITTY.length + 1);
    if (!db.prepare('SELECT id FROM contracts WHERE id = ?').get(contractId)) {
      throw new Error(`No such contract: ${contractId}`);
    }
    return { kind: KITTY, contractId };
  }
  if (!db.prepare('SELECT id FROM players WHERE id = ?').get(s)) {
    throw new Error(`No such player: ${s}`);
  }
  return { kind: 'player', playerId: s };
}

function partyName(raw) {
  const p = readParty(raw);
  if (p.kind !== KITTY) return nameOf(p.playerId);
  if (!p.contractId) return 'the kitty';
  const c = db.prepare('SELECT name FROM contracts WHERE id = ?').get(p.contractId);
  return `the ${c?.name || p.contractId} kitty`;
}

/** Both sides of a movement, described the way a person would say it. */
function describe({ from, to, note }) {
  const base = `${partyName(from)} → ${partyName(to)}`;
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
      from_name: partyName(m.from_party),
      to_name: partyName(m.to_party),
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
    const src = readParty(from);
    const dst = readParty(to);
    if (src.kind === 'player' && dst.kind === 'player' && !contractId) {
      throw new Error('A transfer between players needs a contract — balances are per contract');
    }

    const id = `mv_${Date.now()}`;
    const when = date || new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    const label = describe({ from, to, note });

    const playerLeg = db.prepare(`INSERT INTO transactions
      (id, player_id, contract_id, type, amount, description, status, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,'approved',?,?,?)`);
    const kittyLeg = db.prepare(`INSERT INTO kitty
      (id,kind,label,amount,date,scope,contract_id,historical,created_at)
      VALUES (?,?,?,?,?,?,?,0,?)`);

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO movements
        (id, from_party, to_party, amount, contract_id, date, note, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, from, to, amt, contractId || null, when, note || '', created_by, now);

      // Each end is written on its own terms, so any pairing works: pot to
      // player, player to pot, one contract's pot to another's, player to
      // player. Both ends being the kitty is how a Saturday place gets carried
      // by the Mon/Thu pot — the money leaves one share and lands in the other,
      // and the club's total is unchanged.
      if (src.kind === KITTY) {
        kittyLeg.run(`k_${id}_out`, 'expense', label, amt, when, id, src.contractId, now);
      } else if (contractId) {
        // A player's side only reaches a balance when a contract is named — a
        // transaction with no contract belongs to no ledger. Paying the cashier
        // out of the pot for a BBQ is exactly that case: real money leaves the
        // kitty and no contract balance should move.
        ledgersRepo.ensure(src.playerId, contractId);
        playerLeg.run(`t_${id}_out`, src.playerId, contractId,
          dst.kind === KITTY ? 'adjustment' : 'transfer_out', -amt, label, created_by, now, now);
      }

      if (dst.kind === KITTY) {
        kittyLeg.run(`k_${id}_in`, 'income', label, amt, when, id, dst.contractId, now);
      } else if (contractId) {
        ledgersRepo.ensure(dst.playerId, contractId);
        playerLeg.run(`t_${id}_in`, dst.playerId, contractId,
          src.kind === KITTY ? 'adjustment' : 'transfer_in', amt, label, created_by, now, now);
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
      db.prepare('DELETE FROM transactions WHERE id IN (?,?)')
        .run(`t_${id}_out`, `t_${id}_in`);
      db.prepare('DELETE FROM movements WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { ok: true };
  },
};
