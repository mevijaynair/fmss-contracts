// finance.js — the cashier's side of the books.
//
// Everything else in this app is written on an ACCRUAL basis: a game deducts
// cost_per_gw from the pot the night it is played, so the kitty is profit and
// loss. That is the right way to answer "is this contract paying for itself".
// It is the wrong way to answer "am I, personally, up or down", because the
// cashier does not pay the pitch one game at a time. They sign a block booking
// with O365 or Koora, pay it up front out of their own pocket, and are repaid
// over the following weeks as players top up.
//
// Two bases, then, and this file is the second one:
//
//   the KITTY   accrual. What the club earned and spent, game by game.
//   the CASHIER cash. What actually left and entered their hands.
//
// The difference between them is exactly two things — money the books have
// charged but nobody has paid yet, and money paid ahead of the games it buys —
// and both are reported by name rather than netted into a number nobody can
// take apart.
//
// THE ONE RULE THAT MATTERS: a venue payment must NEVER write a kitty row. The
// pitch is already charged to the pot once, per game, by recomputeGameKitty.
// Booking the payment as an expense as well would charge the club twice for one
// booking — once as it is played, once as it is paid — and the P&L this file
// exists to produce would be wrong in the direction that flatters it. Nothing
// here writes to kitty, charges, contributions or ledgers at all; the venue
// tables are the only thing it owns, and everything else is read.
import { db } from '../db.js';
import { contractsRepo } from './contracts.js';
import { ledgersRepo } from './ledgers.js';
import { kittyRepo } from './kitty.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

// A kitty row derived from a game carries the gameweek id in `scope`, and one
// derived from a movement carries the movement id. Neither is a cash event in
// its own right: the game row is the accrual, and both legs of a movement are
// counted where the money actually is.
//
// A programme's surplus is the third derived kind and it does NOT carry a
// scope — it is keyed k_event_<id> — so it has to be excluded by id. It is not
// cash either: most of a programme's takings come off balances, and the cash
// part is counted from the guest list where it actually is. Counting the
// surplus as money received would count the balance-funded half twice.
//
// What is left is somebody typing in a real receipt, which is cash.
const MANUAL_KITTY = `COALESCE(scope,'') = '' AND historical = 0
  AND id NOT LIKE 'k_gw_%' AND id NOT LIKE 'k_event_%' AND id NOT LIKE 'k_charge_%'`;

/** Which settlement a charge is — the same three cases the ledger uses. */
const CASH_CHARGE = `ch.settled_from_kitty = 0 AND (ch.settles_cash = 1
  OR COALESCE(sp.player_type,'regular') = 'outside')`;

/** A whole number, or null for "not set". Rejects 2.5 rather than truncating it. */
function wholeOrNull(v, what) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${what} must be a whole number`);
  return n;
}

function contractName(id) {
  return db.prepare('SELECT name FROM contracts WHERE id = ?').get(id)?.name || id;
}

/** The one person whose pocket this is all about. */
function cashier() {
  return db.prepare("SELECT id, name FROM players WHERE special_role = 'cashier' ORDER BY id LIMIT 1")
    .get() || null;
}

/**
 * Games this venue contract actually covers.
 *
 * By DATE, not by counting forward from the start: a contract bought for twenty
 * sessions does not stop covering games at twenty, it runs out of money, and
 * those are different facts that the reader needs both of. An open-ended
 * contract (no end_date — the Saturday booking until it is renewed) covers
 * everything from its start onwards, which is what "let it run loose" means.
 */
function sessionsIn(contractId, from, to) {
  return db.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(cost_per_gw), 0) booked
     FROM gameweeks
     WHERE contract_id = ? AND historical = 0 AND date >= ? AND date <= ?`
  ).get(contractId, from, to || '9999-12-31');
}

/** One venue contract with everything derived from it. */
function decorate(vc) {
  const payments = db.prepare(
    'SELECT * FROM venue_payments WHERE venue_contract_id = ? ORDER BY date, created_at'
  ).all(vc.id);
  const paid = round2(payments.reduce((s, p) => s + Number(p.amount || 0), 0));

  const upto = vc.end_date && vc.end_date < today() ? vc.end_date : today();
  const played = sessionsIn(vc.contract_id, vc.start_date, upto);

  // Nights bought, including the ones thrown in. O365 sells "20 + 3hrs free",
  // so the bundle buys twenty-three nights; Koora sells twenty with nothing
  // free. Both are priced by the same rule.
  const free = Number(vc.free_sessions) || 0;
  const covered = vc.sessions_total > 0 ? vc.sessions_total + free : null;

  // What one session costs under this contract, which is the whole reason for
  // entering it. Divided by every night the bundle covers, not by the ones that
  // were paid for: a free night still gets played, and pricing against twenty
  // when twenty-three are played overstates the pitch by 15% — enough to turn a
  // contract that is making money into one that reads as losing it.
  //
  // Null when the deal is open-ended — a rate cannot be derived from a total
  // with no session count, and guessing one would quietly put a made-up number
  // into the P&L.
  const perSession = covered ? round2(Number(vc.amount_total) / covered) : null;
  const perPaidSession = vc.sessions_total > 0
    ? round2(Number(vc.amount_total) / vc.sessions_total) : null;

  // The cost the GAMES were booked at, which is contracts.cost_per_gw and may
  // well not be what the contract turned out to cost. Reported as a variance
  // rather than silently corrected: changing it moves the kitty on games that
  // have already been played and shared with the club.
  const bookedPerSession = played.n ? round2(played.booked / played.n) : null;

  const consumed = perSession === null ? null : round2(perSession * played.n);

  return {
    ...vc,
    contract_name: contractName(vc.contract_id),
    payments,
    paid,
    outstanding: round2(Number(vc.amount_total) - paid),
    sessions_played: played.n,
    free_sessions: free,
    sessions_covered: covered,
    sessions_left: covered === null ? null : covered - played.n,
    cost_per_session: perSession,
    // What a night would cost if the free ones were not counted. Shown beside
    // the real rate so the saving the bundle actually buys is visible, never
    // used in the arithmetic.
    cost_per_paid_session: perPaidSession,
    booked_per_session: bookedPerSession,
    // Positive: the games were booked at more than the contract charges, so the
    // pot is quietly making more than the P&L claims. Negative: the other way,
    // and the club is losing money it has not noticed.
    variance_per_session: perSession !== null && bookedPerSession !== null
      ? round2(bookedPerSession - perSession) : null,
    variance_total: perSession !== null && bookedPerSession !== null
      ? round2((bookedPerSession - perSession) * played.n) : null,
    consumed,
    // Money handed over that has not been played off yet. Negative means the
    // opposite and is the ordinary state early on: games played on a booking
    // that has not been paid for.
    prepaid: consumed === null ? null : round2(paid - consumed),
    is_open_ended: !vc.end_date,
    covers_today: vc.start_date <= today() && (!vc.end_date || vc.end_date >= today()),
  };
}

export const financeRepo = {
  // ---- venue contracts -----------------------------------------------------

  venueContracts(contractId = null) {
    const rows = contractId
      ? db.prepare('SELECT * FROM venue_contracts WHERE contract_id = ? ORDER BY start_date DESC')
        .all(contractId)
      : db.prepare('SELECT * FROM venue_contracts ORDER BY contract_id, start_date DESC').all();
    return rows.map(decorate);
  },

  venueContract(id) {
    const vc = db.prepare('SELECT * FROM venue_contracts WHERE id = ?').get(id);
    return vc ? decorate(vc) : null;
  },

  createVenueContract({ contract_id, vendor, start_date, end_date, sessions_total,
    free_sessions, amount_total, notes }) {
    if (!db.prepare('SELECT id FROM contracts WHERE id = ?').get(contract_id)) {
      throw new Error(`No such contract: ${contract_id}`);
    }
    if (!start_date) throw new Error('A start date is required');
    if (end_date && end_date < start_date) throw new Error('The end date is before the start date');
    const sessions = wholeOrNull(sessions_total, 'Sessions');
    const free = wholeOrNull(free_sessions, 'Free sessions') ?? 0;
    const amount = round2(amount_total);
    if (!(amount >= 0)) throw new Error('The amount must be zero or more');

    const id = `vc_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    db.prepare(`INSERT INTO venue_contracts
      (id, contract_id, vendor, start_date, end_date, sessions_total, free_sessions,
       amount_total, notes, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      id, contract_id,
      String(vendor || contractsRepo.get(contract_id)?.venue || 'Venue').trim(),
      start_date, end_date || null, sessions, free, amount, String(notes || '').trim(),
      new Date().toISOString());
    return this.venueContract(id);
  },

  updateVenueContract(id, patch = {}) {
    const current = db.prepare('SELECT * FROM venue_contracts WHERE id = ?').get(id);
    if (!current) throw new Error('No such venue contract');
    const sets = [];
    const vals = [];
    const put = (col, v) => { sets.push(`${col}=?`); vals.push(v); };
    if (patch.vendor !== undefined) put('vendor', String(patch.vendor).trim());
    if (patch.start_date !== undefined) put('start_date', patch.start_date);
    if (patch.end_date !== undefined) put('end_date', patch.end_date || null);
    if (patch.sessions_total !== undefined) {
      put('sessions_total', wholeOrNull(patch.sessions_total, 'Sessions'));
    }
    if (patch.free_sessions !== undefined) {
      put('free_sessions', wholeOrNull(patch.free_sessions, 'Free sessions') ?? 0);
    }
    if (patch.amount_total !== undefined) put('amount_total', round2(patch.amount_total));
    if (patch.notes !== undefined) put('notes', String(patch.notes).trim());
    if (!sets.length) return this.venueContract(id);
    vals.push(id);
    db.prepare(`UPDATE venue_contracts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    const after = db.prepare('SELECT * FROM venue_contracts WHERE id = ?').get(id);
    if (after.end_date && after.end_date < after.start_date) {
      // Put it back rather than leave a contract that ends before it starts —
      // sessionsIn would then match nothing and the P&L would read as though no
      // games had been played at all.
      db.prepare('UPDATE venue_contracts SET start_date = ?, end_date = ? WHERE id = ?')
        .run(current.start_date, current.end_date, id);
      throw new Error('The end date is before the start date');
    }
    return this.venueContract(id);
  },

  removeVenueContract(id) {
    // Payments cascade with it. They mean nothing on their own — a payment is
    // always a payment against a booking — and leaving them behind would put
    // money into the cash statement that no contract accounts for.
    const info = db.prepare('DELETE FROM venue_contracts WHERE id = ?').run(id);
    if (!info.changes) throw new Error('No such venue contract');
    return { ok: true };
  },

  addPayment(venueContractId, { amount, date, paid_by, method, note }) {
    if (!db.prepare('SELECT id FROM venue_contracts WHERE id = ?').get(venueContractId)) {
      throw new Error('No such venue contract');
    }
    const amt = round2(amount);
    if (!(amt > 0)) throw new Error('A payment must be more than zero');
    const payer = paid_by || cashier()?.id || null;
    if (payer && !db.prepare('SELECT id FROM players WHERE id = ?').get(payer)) {
      throw new Error(`No such player: ${payer}`);
    }
    const id = `vp_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    db.prepare(`INSERT INTO venue_payments
      (id, venue_contract_id, amount, date, paid_by, method, note, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      id, venueContractId, amt, date || today(), payer,
      String(method || 'bank').trim(), String(note || '').trim(),
      new Date().toISOString());
    return this.venueContract(venueContractId);
  },

  removePayment(paymentId) {
    const p = db.prepare('SELECT venue_contract_id FROM venue_payments WHERE id = ?').get(paymentId);
    if (!p) throw new Error('No such payment');
    db.prepare('DELETE FROM venue_payments WHERE id = ?').run(paymentId);
    return this.venueContract(p.venue_contract_id);
  },

  /** Everything paid out to venues, across every booking. */
  venuePaidTotal(contractId = null) {
    const sql = contractId
      ? `SELECT COALESCE(SUM(p.amount),0) s FROM venue_payments p
         JOIN venue_contracts v ON v.id = p.venue_contract_id WHERE v.contract_id = ?`
      : 'SELECT COALESCE(SUM(amount),0) s FROM venue_payments';
    return round2((contractId ? db.prepare(sql).get(contractId) : db.prepare(sql).get()).s);
  },

  // ---- profit and loss -----------------------------------------------------

  /**
   * What one contract earned and what it cost, over a window.
   *
   * On the accrual basis, so it answers "is Monday paying for itself" rather
   * than "has the money arrived". The cash side is the cashier statement below.
   *
   * The profit is cross-checked against the kitty rows those same games wrote,
   * and the difference is reported. They are derived from the same charges by
   * two different routes, so a drift means one of them has a bug — and a check
   * that is computed but never shown is a check nobody ever reads.
   */
  pnl(contractId, { from = null, to = null } = {}) {
    const c = contractsRepo.get(contractId);
    if (!c) throw new Error(`No such contract: ${contractId}`);
    const start = from || c.season_start || '0000-01-01';
    const end = to || '9999-12-31';

    const games = db.prepare(
      `SELECT id, date, cost_per_gw, game_cost, game_cost_paid_by
       FROM gameweeks WHERE contract_id = ? AND historical = 0
         AND date >= ? AND date <= ? ORDER BY date`
    ).all(contractId, start, end);
    const ids = games.map(g => g.id);

    const zero = { on_balances: 0, cash_in: 0, cash_owed: 0, carried: 0 };
    const rev = ids.length ? db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN ch.settled_from_kitty = 0 AND NOT (${CASH_CHARGE})
                          THEN ch.amount ELSE 0 END), 0) AS on_balances,
        COALESCE(SUM(CASE WHEN ${CASH_CHARGE} AND ch.paid = 1
                          THEN ch.amount ELSE 0 END), 0) AS cash_in,
        COALESCE(SUM(CASE WHEN ${CASH_CHARGE} AND ch.paid = 0
                          THEN ch.amount ELSE 0 END), 0) AS cash_owed,
        COALESCE(SUM(CASE WHEN ch.settled_from_kitty = 1
                          THEN ch.amount ELSE 0 END), 0) AS carried
      FROM charges ch
      LEFT JOIN players sp ON sp.id = COALESCE(ch.charged_to, ch.player_id)
      WHERE ch.gameweek_id IN (${ids.map(() => '?').join(',')})`).get(...ids) : zero;

    const pitchBooked = round2(games.reduce((s, g) => s + (Number(g.cost_per_gw) || 0), 0));
    // Water comes off the pot only when the pot bought it; when a player buys it
    // they are credited instead. Same rule recomputeGameKitty uses, and it has
    // to be the same or the cross-check below would always disagree.
    const water = round2(games.reduce((s, g) =>
      s + ((g.game_cost_paid_by || 'self') === 'self' ? Number(g.game_cost) || 0 : 0), 0));

    // What the venue actually charges for those same nights, where a booking has
    // been entered. Falls back to the booked cost for any date no contract
    // covers — the Saturday deal until it is renewed — so the figure is never a
    // guess dressed up as a contract price.
    const bookings = this.venueContracts(contractId);
    const rateOn = (date) => {
      const vc = bookings.find(v => v.start_date <= date
        && (!v.end_date || v.end_date >= date) && v.cost_per_session !== null);
      return vc ? vc.cost_per_session : null;
    };
    let pitchContracted = 0;
    let covered = 0;
    for (const g of games) {
      const r = rateOn(g.date);
      if (r === null) pitchContracted += Number(g.cost_per_gw) || 0;
      else { pitchContracted += r; covered += 1; }
    }
    pitchContracted = round2(pitchContracted);

    // Club income and spend that is not a game: a BBQ, shirts, a referee. Scoped
    // to this contract, which is why kitty rows carry one.
    const other = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN kind='income'  THEN amount ELSE 0 END),0) income,
             COALESCE(SUM(CASE WHEN kind='expense' THEN amount ELSE 0 END),0) expense
      FROM kitty WHERE ${MANUAL_KITTY} AND contract_id = ?
        AND date >= ? AND date <= ?`).get(contractId, start, end);

    const revenue = round2(rev.on_balances + rev.cash_in + other.income);
    const costBooked = round2(pitchBooked + water + other.expense);
    const profitBooked = round2(revenue - costBooked);
    const profitContracted = round2(revenue - round2(pitchContracted + water + other.expense));

    // The same money by another route: what those games actually put in the pot.
    const kittyRows = ids.length ? db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN kind='income' THEN amount ELSE -amount END),0) net
      FROM kitty WHERE scope IN (${ids.map(() => '?').join(',')})`).get(...ids).net : 0;
    const kittyFromGames = round2(kittyRows + other.income - other.expense);

    return {
      contract_id: contractId,
      contract_name: c.name,
      venue: c.venue || '',
      from: start,
      to: to || today(),
      games: games.length,
      players_billed: ids.length ? db.prepare(
        `SELECT COUNT(*) n FROM charges WHERE gameweek_id IN (${ids.map(() => '?').join(',')})`)
        .get(...ids).n : 0,
      revenue: {
        from_balances: round2(rev.on_balances),
        guest_cash_collected: round2(rev.cash_in),
        other_income: round2(other.income),
        total: revenue,
      },
      cost: {
        pitch_booked: pitchBooked,
        pitch_contracted: pitchContracted,
        sessions_priced_from_a_contract: covered,
        water,
        other_expense: round2(other.expense),
        total_booked: costBooked,
        total_contracted: round2(pitchContracted + water + other.expense),
      },
      profit: profitBooked,
      profit_contracted: profitContracted,
      profit_per_game: games.length ? round2(profitBooked / games.length) : null,
      profit_per_game_contracted: games.length
        ? round2(profitContracted / games.length) : null,
      // Not revenue. A place the pot carried brings in nothing, and a guest who
      // has not settled up has not paid — both are stated so the reader can see
      // what the profit is NOT counting.
      not_counted: {
        guest_cash_still_owed: round2(rev.cash_owed),
        places_carried_by_the_kitty: round2(rev.carried),
      },
      // Two routes to the same figure. Anything other than zero is a bug in one
      // of them, not a rounding curiosity.
      kitty_says: kittyFromGames,
      drift: round2(profitBooked - kittyFromGames),
    };
  },

  /**
   * The cashier's cash statement, and whether it reconciles.
   *
   * Written as a person would read a bank statement: what you were holding when
   * tracking began, what came in, what went out, what you should therefore be
   * holding now — and then every claim on that money, which must add back to
   * exactly the same figure.
   *
   * The reconciliation is the point. Each side is built from different tables by
   * a different route, so a non-zero drift means money has gone somewhere the
   * books cannot name, and that is worth finding on the day it happens rather
   * than at the end of a season.
   */
  cashier() {
    const who = cashier();
    const ledgers = ledgersRepo.all();
    const contracts = contractsRepo.all();

    // ---- what the baseline says was already in hand when tracking began
    const openingCredit = round2(db.prepare(
      'SELECT COALESCE(SUM(opening_balance),0) s FROM ledgers').get().s);
    const openingKitty = round2(kittyRepo.balance().opening);

    // ---- money in
    const topUps = round2(db.prepare(
      'SELECT COALESCE(SUM(amount),0) s FROM contributions WHERE historical = 0').get().s);
    const guestCash = round2(db.prepare(`
      SELECT COALESCE(SUM(ch.amount),0) s FROM charges ch
      JOIN gameweeks g ON g.id = ch.gameweek_id
      LEFT JOIN players sp ON sp.id = COALESCE(ch.charged_to, ch.player_id)
      WHERE g.historical = 0 AND ch.paid = 1 AND ${CASH_CHARGE}`).get().s);
    // Heads who paid cash for a programme, rather than off a balance. The
    // balance-funded half never becomes cash and is already in the ledgers.
    const eventCash = round2(db.prepare(
      `SELECT COALESCE(SUM(amount_due),0) s FROM event_attendees
       WHERE pay_method = 'cash' AND paid = 1`).get().s);
    const otherIn = round2(db.prepare(
      `SELECT COALESCE(SUM(amount),0) s FROM kitty WHERE ${MANUAL_KITTY} AND kind='income'`)
      .get().s);

    // ---- money out
    const venuePaid = this.venuePaidTotal();
    // Water bought by a player is not the cashier's cash: the player is credited
    // a contribution for it instead, so the club owes them rather than having
    // spent anything. Only 'self' — the pot — is money actually leaving.
    const water = round2(db.prepare(`
      SELECT COALESCE(SUM(game_cost),0) s FROM gameweeks
      WHERE historical = 0 AND COALESCE(game_cost_paid_by,'self') = 'self'`).get().s);
    // A programme the cashier paid for out of pocket. Anyone else fronting it is
    // credited on their ledger and no cash has moved, by the same argument as
    // the water above.
    const eventsFronted = who ? round2(db.prepare(
      `SELECT COALESCE(SUM(actual_amount),0) s FROM external_events
       WHERE paid_by_player_id = ?`).get(who.id).s) : 0;
    const otherOut = round2(db.prepare(
      `SELECT COALESCE(SUM(amount),0) s FROM kitty WHERE ${MANUAL_KITTY} AND kind='expense'`)
      .get().s);

    const inTotal = round2(topUps + guestCash + eventCash + otherIn);
    const outTotal = round2(venuePaid + water + eventsFronted + otherOut);
    const inHand = round2(openingCredit + openingKitty + inTotal - outTotal);

    // ---- who has a claim on it
    const others = ledgers.filter(l => l.special_role !== 'cashier');
    const heldForPlayers = round2(others.filter(l => l.present_balance > 0)
      .reduce((s, l) => s + l.present_balance, 0));
    const owedByPlayers = round2(Math.abs(others.filter(l => l.present_balance < 0)
      .reduce((s, l) => s + l.present_balance, 0)));
    // The cashier's own balance. They are blocked from contributing, so this only
    // ever falls: it is the football they have played and not paid in for, which
    // is money of the club's they have effectively already spent on themselves.
    // Negative here means they owe it — the sign is kept as the ledger has it so
    // it can be added straight into the reconciliation.
    const ownAccount = round2(ledgers.filter(l => l.special_role === 'cashier')
      .reduce((s, l) => s + l.present_balance, 0));
    const kitty = round2(kittyRepo.balance().balance);

    // What the venue is owed for games already played, less what has been handed
    // over. Positive: the club is behind with the venue and that money in hand is
    // spoken for. Negative: paid ahead, and the cash has already gone.
    const pitchAccrued = round2(db.prepare(
      'SELECT COALESCE(SUM(cost_per_gw),0) s FROM gameweeks WHERE historical = 0').get().s);
    const owedToVenues = round2(pitchAccrued - venuePaid);

    const claims = round2(heldForPlayers - owedByPlayers + ownAccount + kitty + owedToVenues);

    const perContract = contracts.map(c => ({
      contract_id: c.id,
      contract_name: c.name,
      venue: c.venue || '',
      pitch_accrued: round2(db.prepare(
        'SELECT COALESCE(SUM(cost_per_gw),0) s FROM gameweeks WHERE contract_id = ? AND historical = 0')
        .get(c.id).s),
      paid_to_venue: this.venuePaidTotal(c.id),
      has_booking: this.venueContracts(c.id).length > 0,
    })).map(r => ({ ...r, owed_to_venue: round2(r.pitch_accrued - r.paid_to_venue) }));

    return {
      as_at: today(),
      cashier: who,
      opening: {
        player_credit: openingCredit,
        kitty: openingKitty,
        total: round2(openingCredit + openingKitty),
      },
      money_in: {
        top_ups: topUps,
        guest_cash_collected: guestCash,
        programme_cash: eventCash,
        other: otherIn,
        total: inTotal,
      },
      money_out: {
        paid_to_venues: venuePaid,
        water: water,
        programmes_you_paid_for: eventsFronted,
        other: otherOut,
        total: outTotal,
      },
      in_hand: inHand,
      claims: {
        held_for_players: heldForPlayers,
        owed_by_players: owedByPlayers,
        own_account: ownAccount,
        kitty,
        owed_to_venues: owedToVenues,
        total: claims,
      },
      // Zero, or something is wrong. Reported rather than asserted, because a
      // statement that refuses to render is no use to the person who has to find
      // out why it does not balance.
      drift: round2(inHand - claims),
      per_contract: perContract,
    };
  },
};
