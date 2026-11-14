// contracts.js — contract config (rate cards, venue, cost per gameweek).
import { db } from '../db.js';

/** The day before a date, as a string — the end of the card before this one. */
const dayBefore = (date) => {
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

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

    // Keep the card history and the contract's own columns saying the same
    // thing. A caller that sets rates or the pitch cost here means "the price
    // now", so it is written onto the card in force now — in place, under its
    // own date. Anything that means "the price CHANGED on this date" goes
    // through saveCard with that date, which is what the settings screen does.
    if (patch.rates !== undefined || patch.cost_per_gw !== undefined) {
      const live = this.cardOn(id, new Date().toISOString().slice(0, 10));
      if (live?.effective_from) {
        const now = this.get(id);
        db.prepare(`UPDATE contract_rate_cards SET rates = ?, pitch_per_game = ?
                    WHERE id = ?`)
          .run(JSON.stringify(now.rates || {}), Number(now.cost_per_gw) || 0, live.id);
      }
    }
    return this.get(id);
  },

  // ---- dated rate cards ----------------------------------------------------
  //
  // A card says what a place cost from a given night onwards. It runs until
  // the next card starts, so the end date is derived rather than stored: see
  // the migration in db.js for why a stored end date is a bug waiting to be
  // entered. Together they cover every date from the first card onwards with
  // no gap and no overlap, which is a property of the shape rather than
  // something a check has to police.

  /** Every card for a contract, oldest first, each with the day it stopped. */
  cards(contractId) {
    const rows = db.prepare(
      `SELECT * FROM contract_rate_cards WHERE contract_id = ?
       ORDER BY effective_from`).all(contractId);
    return rows.map((r, i) => ({
      ...r,
      rates: JSON.parse(r.rates || '{}'),
      // The day before the next card came in. Null on the last one: it is
      // still in force, and an end date invented for it would be a date the
      // club never agreed to.
      effective_to: rows[i + 1] ? dayBefore(rows[i + 1].effective_from) : null,
      is_current: i === rows.length - 1,
    }));
  },

  /**
   * The card in force on a date — which is how a game is priced.
   *
   * Falls back to the earliest card for anything before the history starts.
   * A night played before the first card is not a night with no price: it is
   * a night from before anybody wrote the prices down, and pricing it at the
   * oldest known card is the only answer that is not a guess at zero.
   */
  cardOn(contractId, date) {
    const on = String(date || '').slice(0, 10) || '9999-12-31';
    const hit = db.prepare(
      `SELECT * FROM contract_rate_cards WHERE contract_id = ? AND effective_from <= ?
       ORDER BY effective_from DESC LIMIT 1`).get(contractId, on)
      || db.prepare(
        `SELECT * FROM contract_rate_cards WHERE contract_id = ?
         ORDER BY effective_from LIMIT 1`).get(contractId);
    // No card at all: fall back to the contract's own columns, which are the
    // mirror of the current card everywhere else. A contract created by an
    // import, a seed or a script has rates and a pitch cost but no history,
    // and the alternative to this line is pricing its games at nothing.
    if (!hit) {
      const c = this.get(contractId);
      if (!c) return null;
      return {
        id: null, contract_id: contractId, effective_from: null,
        rates: c.rates || {}, pitch_per_game: Number(c.cost_per_gw) || 0,
        water_per_game: 0, notes: 'The contract as it stands — no dated card yet',
      };
    }
    return { ...hit, rates: JSON.parse(hit.rates || '{}') };
  },

  /**
   * Write a card, and keep the contract's own columns pointing at today's.
   *
   * contracts.rates and contracts.cost_per_gw are a MIRROR of the card in
   * force today, not a second opinion: every screen that asks "what does a
   * game cost right now" reads them, and they would drift the moment a card
   * was saved without them. Updating them here is what keeps one answer.
   */
  saveCard(contractId, { effective_from, rates, pitch_per_game, water_per_game, notes }) {
    if (!this.get(contractId)) throw new Error(`Unknown contract: ${contractId}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effective_from || ''))) {
      throw new Error('A rate card needs the date it comes into force (YYYY-MM-DD)');
    }
    const existing = db.prepare(
      'SELECT id, rates, pitch_per_game, water_per_game FROM contract_rate_cards WHERE contract_id = ? AND effective_from = ?')
      .get(contractId, effective_from);
    const card = {
      rates: JSON.stringify(rates ?? (existing ? JSON.parse(existing.rates || '{}') : {})),
      pitch: Number(pitch_per_game ?? existing?.pitch_per_game ?? 0) || 0,
      water: Number(water_per_game ?? existing?.water_per_game ?? 0) || 0,
      notes: String(notes ?? '').trim(),
    };
    if (existing) {
      db.prepare(`UPDATE contract_rate_cards
        SET rates = ?, pitch_per_game = ?, water_per_game = ?, notes = ? WHERE id = ?`)
        .run(card.rates, card.pitch, card.water, card.notes, existing.id);
    } else {
      db.prepare(`INSERT INTO contract_rate_cards
        (id, contract_id, effective_from, rates, pitch_per_game, water_per_game, notes, created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        `crc_${contractId}_${effective_from.replace(/-/g, '')}`, contractId, effective_from,
        card.rates, card.pitch, card.water, card.notes, new Date().toISOString());
    }
    this.syncCurrent(contractId);
    return this.cards(contractId);
  },

  removeCard(cardId) {
    const row = db.prepare('SELECT contract_id FROM contract_rate_cards WHERE id = ?').get(cardId);
    if (!row) throw new Error('No such rate card');
    const left = db.prepare(
      'SELECT COUNT(*) n FROM contract_rate_cards WHERE contract_id = ?').get(row.contract_id).n;
    // The last card is the only price the contract has. Deleting it would
    // leave every game priced from nothing.
    if (left <= 1) throw new Error('A contract must keep at least one rate card');
    db.prepare('DELETE FROM contract_rate_cards WHERE id = ?').run(cardId);
    this.syncCurrent(row.contract_id);
    return this.cards(row.contract_id);
  },

  /** Point contracts.rates / cost_per_gw at the card in force today. */
  syncCurrent(contractId) {
    const today = new Date().toISOString().slice(0, 10);
    const card = this.cardOn(contractId, today);
    if (!card) return this.get(contractId);
    db.prepare('UPDATE contracts SET rates = ?, cost_per_gw = ? WHERE id = ?')
      .run(JSON.stringify(card.rates || {}), Number(card.pitch_per_game) || 0, contractId);
    return this.get(contractId);
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
