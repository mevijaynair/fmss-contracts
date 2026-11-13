// period_report.js — the per-contract standing that gets shared with players,
// in the shape of the credit-tracking sheet it replaces.
//
// Everything here is scoped to the CURRENT contract period (contracts.season_start).
// That scoping is the whole point: when a new contract starts, played counts go
// back to zero, and a captaincy share measured against a lifetime total would
// read as more than 100% of a handful of games. Counting both halves of the
// ratio over the same period is what keeps it honest.
import { db } from '../db.js';
import { ledgersRepo } from './ledgers.js';

// How many games of runway before a balance stops being comfortable. Below one
// game they cannot cover the next fixture at all.
const REFILL_BELOW_GAMES = 4;

// "Lately" on this sheet, in weeks.
//
// The period figures answer "how has the season gone"; nobody reads them to
// find out who is actually turning up now. A player who played eight games in
// September and nothing since reads identically to a regular, and the only
// number that separates them is a short window. Five weeks is long enough to
// hold four or five Saturdays and a run of Mon/Thu, and short enough that a
// month off shows up.
const RECENT_WEEKS = 5;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const weeksAgo = (weeks) => new Date(Date.now() - weeks * 7 * 86400000)
  .toISOString().slice(0, 10);

// A contribution dated by hand can be blank; fall back to the day it was
// written down rather than dropping it out of the window silently.
const CONTRIB_DAY = "COALESCE(NULLIF(q.date, ''), substr(q.created_at, 1, 10))";
const TXN_DAY = "substr(t.created_at, 1, 10)";

function contractRate(contractId) {
  const c = db.prepare('SELECT rates FROM contracts WHERE id = ?').get(contractId);
  let rates = {};
  try { rates = JSON.parse(c?.rates || '{}'); } catch { rates = {}; }
  return Number(rates.contracted_10) || Number(rates.noncontract) || 0;
}

/**
 * What a game in this period actually costs, taken from what was actually
 * charged rather than from the rate card.
 *
 * A contract carries several rates (10-a-side, 12-a-side, captain, guest) and
 * which one applies depends on how many turned up. Reading the card would put
 * the runway on a price nobody is paying — the difference between the 10- and
 * 12-player rate is enough to move players across the "needs a refill" line.
 * Falls back to the card when the period has no games yet.
 */
function effectiveRate(contractId, since) {
  const row = db.prepare(
    `SELECT ch.amount AS amount, COUNT(*) AS n
     FROM charges ch JOIN gameweeks g ON g.id = ch.gameweek_id
     WHERE g.contract_id = ? AND g.date >= ? AND g.historical = 0 AND ch.amount > 0
     GROUP BY ch.amount ORDER BY n DESC, amount DESC LIMIT 1`
  ).get(contractId, since || '0000-01-01');
  return Number(row?.amount) || contractRate(contractId);
}

function statusFor(balance, gamesLeft) {
  if (balance < 0 || gamesLeft < 1) return 'Out of contract';
  if (gamesLeft < REFILL_BELOW_GAMES) return 'Refill needed - No priority';
  return 'In contract';
}

export const periodReportRepo = {
  /**
   * One row per player on the contract, ordered as the sheet is: everyone with
   * a stake, most recently active first is NOT what the sheet does — it keeps a
   * stable roster order, so sort by name and let the reader scan.
   */
  report(contractId, {
    since = null, includeDormant = false, recentWeeks = RECENT_WEEKS,
  } = {}) {
    const c = db.prepare('SELECT id, name, season_start FROM contracts WHERE id = ?').get(contractId);
    if (!c) throw new Error('Contract not found');
    const from = since || c.season_start || '0000-01-01';
    const rate = effectiveRate(contractId, from);

    // The recent window never reaches back past the period it sits inside. On
    // a contract three weeks old, "the last five weeks" would otherwise count
    // games from the previous contract and make the recent number larger than
    // the period one — a sheet that contradicts itself in two adjacent
    // columns.
    const weeks = Math.min(52, Math.max(1, Number(recentWeeks) || RECENT_WEEKS));
    const askedFrom = weeksAgo(weeks);
    const recentFrom = askedFrom > from ? askedFrom : from;

    // Games, spend and captaincies for this period only.
    const activity = new Map(
      db.prepare(
        `SELECT ch.player_id,
                COUNT(DISTINCT ch.gameweek_id) AS played,
                COALESCE(SUM(ch.amount), 0)    AS deducted,
                COALESCE(SUM(ch.is_captain), 0) AS captaincies
         FROM charges ch JOIN gameweeks g ON g.id = ch.gameweek_id
         WHERE g.contract_id = ? AND g.date >= ? AND g.historical = 0
         GROUP BY ch.player_id`
      ).all(contractId, from).map(r => [r.player_id, r])
    );

    // The most recent money in, which is what "when did they last top up?"
    // actually means to whoever is chasing it.
    const lastIn = new Map(
      db.prepare(
        `SELECT player_id, date, amount FROM contributions
         WHERE contract_id = ? AND historical = 0 AND amount > 0
           AND (player_id, date) IN (
             SELECT player_id, MAX(date) FROM contributions
             WHERE contract_id = ? AND historical = 0 AND amount > 0 GROUP BY player_id)`
      ).all(contractId, contractId).map(r => [r.player_id, r])
    );

    // ---- what has happened lately, over the same window for everybody.
    //
    // Games first. Counted the way the balance counts them — on whoever
    // SETTLES the charge — would answer a money question, and this column is
    // not a money question: it is "has this person been turning up". So it
    // keys on player_id, who was actually on the pitch, and a member who
    // brought a guest is not credited with their game.
    const recentPlayed = new Map(db.prepare(
      `SELECT ch.player_id, COUNT(DISTINCT ch.gameweek_id) AS played,
              MAX(g.date) AS last_game
       FROM charges ch JOIN gameweeks g ON g.id = ch.gameweek_id
       WHERE g.contract_id = ? AND g.date >= ? AND g.historical = 0
       GROUP BY ch.player_id`
    ).all(contractId, recentFrom).map(r => [r.player_id, r]));

    // Then money in. Both places a top-up can land: the contributions table,
    // and the transaction ledger for everything that has no home there — a
    // transfer in from another player, an introducer credit, an adjustment.
    // Leaving the second out would show "nothing paid in" against somebody
    // whose balance plainly went up, which is exactly the surprise this
    // column exists to prevent.
    const recentIn = new Map();
    const bump = (id, amount) => {
      const e = recentIn.get(id)
        || { paid_in: 0, payments: 0, taken_out: 0, deductions: 0 };
      if (amount >= 0) { e.paid_in += amount; e.payments += 1; }
      else { e.taken_out += -amount; e.deductions += 1; }
      recentIn.set(id, e);
    };
    for (const r of db.prepare(
      `SELECT q.player_id AS id, SUM(q.amount) AS inn,
              SUM(CASE WHEN q.amount >= 0 THEN 1 ELSE 0 END) AS n_in,
              SUM(CASE WHEN q.amount < 0 THEN 1 ELSE 0 END) AS n_out,
              SUM(CASE WHEN q.amount >= 0 THEN q.amount ELSE 0 END) AS amt_in,
              SUM(CASE WHEN q.amount < 0 THEN -q.amount ELSE 0 END) AS amt_out
       FROM contributions q
       WHERE q.contract_id = ? AND q.historical = 0 AND ${CONTRIB_DAY} >= ?
       GROUP BY q.player_id`).all(contractId, recentFrom)) {
      const e = recentIn.get(r.id)
        || { paid_in: 0, payments: 0, taken_out: 0, deductions: 0 };
      e.paid_in += Number(r.amt_in) || 0;
      e.payments += Number(r.n_in) || 0;
      e.taken_out += Number(r.amt_out) || 0;
      e.deductions += Number(r.n_out) || 0;
      recentIn.set(r.id, e);
    }
    // Charges are excluded here: games already have their own column, and
    // counting them as "taken out" would list every regular as having had
    // money removed from them lately.
    for (const r of db.prepare(
      `SELECT t.player_id AS id, t.amount AS amount
       FROM transactions t
       WHERE t.contract_id = ? AND t.status = 'approved'
         AND t.type NOT IN ('contribution', 'charge')
         AND ${TXN_DAY} >= ?`).all(contractId, recentFrom)) {
      bump(r.id, Number(r.amount) || 0);
    }

    const hiddenIds = new Set(db.prepare(
      'SELECT id FROM players WHERE hide_from_sheet = 1').all().map(p => p.id));

    const rows = ledgersRepo.forContract(contractId).map(l => {
      const a = activity.get(l.player_id);
      const played = a?.played || 0;
      const captaincies = a?.captaincies || 0;
      const gamesLeft = rate > 0 ? Math.floor(l.present_balance / rate) : null;
      const last = lastIn.get(l.player_id) || null;
      return {
        player_id: l.player_id,
        name: l.player_name,
        player_type: l.player_type || 'regular',
        // Carried on the row because the collect list has to know: the cashier
        // is in the red by design and must never be listed as owing anything.
        special_role: l.special_role || null,
        hidden: !!hiddenIds.has(l.player_id),
        cash_owed: round2(l.cash_owed || 0),
        present_balance: round2(l.present_balance),
        status: statusFor(l.present_balance, gamesLeft ?? 0),
        games_left: gamesLeft,
        // Share of this period's games they wore the armband for. Null, shown
        // as NA, when they have not played — a share of nothing is not 0%.
        capt_subsidy_pct: played ? Math.round((captaincies / played) * 100) : null,
        captaincies,
        deducted: round2(a?.deducted || 0),
        played,
        last_contribution_date: last?.date || null,
        last_contribution_amount: last ? round2(last.amount) : null,
        // Lately, as its own small object so no reader of a row can mistake a
        // window figure for a period one.
        recent: (() => {
          const g = recentPlayed.get(l.player_id);
          const m = recentIn.get(l.player_id);
          return {
            played: g?.played || 0,
            last_game: g?.last_game || null,
            paid_in: round2(m?.paid_in || 0),
            payments: m?.payments || 0,
            taken_out: round2(m?.taken_out || 0),
            deductions: m?.deductions || 0,
          };
        })(),
      };
    });

    // This sheet answers one question: who is topped up, and who needs a refill.
    // A row earns its place by having a credit position — money held, money
    // owed, or a history of paying in. Having once turned out does not create
    // one, and the old rule kept anyone with a single appearance, which is how
    // Yash, Raj, Obaid and Aryansh ended up on it at exactly 0 having never paid
    // anything in. Thirty-five names on Mon/Thu, most of them nothing to act on.
    //
    // hide_from_sheet is the manual override for what a rule cannot know — that
    // someone holding a balance has left the club.
    //
    // Guests are held out for the same reason. This sheet is about contract
    // credit — who is topped up, who needs a refill, how many games they have
    // left. A guest keeps no balance and buys no games; they pay cash on the day
    // and that is the whole of their involvement. Listing every one-off who
    // turned up once buries the squad, and gives them a 0 balance and an "Out of
    // contract" status that mean nothing. What they owe is counted separately
    // and reported as guest_cash_owed.
    const guests = rows.filter(r => r.player_type === 'outside');
    // Cash owed is deliberately NOT a reason to appear. It is a different kind
    // of debt from a contract credit position, and it is already reported by
    // name in three other places — the To collect column, Pending Collections,
    // and guest_cash_owed below. Keeping it here put Raj, Kartik, Manish and
    // Rohit on the sheet at a 0 balance, which is the crowding this is meant to
    // remove and tells the reader nothing the sheet is for.
    const members = rows.filter(r => r.player_type !== 'outside');
    const squad = (includeDormant
      ? members
      : members.filter(r => r.present_balance !== 0 || r.last_contribution_date))
      .filter(r => !r.hidden);
    squad.sort((x, y) => x.name.localeCompare(y.name));

    // Two different reasons to be off the sheet, counted apart because they
    // mean opposite things. Dormant is a rule — no money, nothing this period —
    // and safe to state as such. Hidden is a person's decision that someone has
    // left, and they may well still be holding a balance. Reporting them as one
    // number meant the sheet could say "holding no money" about someone with
    // money, so the one case where the flag was used would be described wrongly.
    const dormant = includeDormant ? 0
      : members.filter(r => !r.hidden && r.present_balance === 0
                            && !r.last_contribution_date).length;
    const hiddenMembers = members.filter(r => r.hidden);

    // Who to go and ask, and for how much — the one thing this sheet is
    // actually used to do. Two kinds of debt that must not be added together:
    // a member whose prepaid balance has run out owes a top-up, and a guest
    // owes cash for games they played. Both are read from the gameweeks in
    // this period, so the list is about what has actually been tracked rather
    // than about a standing figure.
    //
    // The cashier is never on it. They fund the pitch up front and their
    // balance sits in the red by design; asking them to chase themselves, for
    // the largest figure on the page, is how that used to read.
    const collect = [
      ...members
        .filter(r => r.present_balance < 0 && !r.hidden
          && r.special_role !== 'cashier')
        .map(r => ({
          player_id: r.player_id, name: r.name, kind: 'topup',
          amount: round2(-r.present_balance), games: r.played,
          last_game: null,
        })),
      ...ledgersRepo.cashOutstanding(contractId).map(r => ({
        player_id: r.player_id, name: r.player_name || 'Guest', kind: 'cash',
        amount: round2(r.owed), games: r.games, last_game: r.last_game_date,
      })),
    ].sort((a, b) => b.amount - a.amount);

    return {
      contract_id: contractId,
      contract_name: c.name,
      period_start: from,
      to_collect: collect,
      to_collect_total: round2(collect.reduce((s, r) => s + r.amount, 0)),
      dormant_hidden: dormant,
      flag_hidden: hiddenMembers.length,
      // What those people are still holding, so hiding somebody can never make
      // their balance disappear from the sheet without a word.
      flag_hidden_balance: round2(
        hiddenMembers.reduce((s, r) => s + r.present_balance, 0)),
      guests_hidden: guests.filter(r => r.played > 0 || r.cash_owed > 0).length,
      guest_cash_owed: round2(ledgersRepo.cashOutstanding(contractId)
        .reduce((s2, r) => s2 + r.owed, 0)),
      generated_at: new Date().toISOString().slice(0, 10),
      rate,
      refill_below_games: REFILL_BELOW_GAMES,
      // The window is reported, not assumed: on a young contract it is
      // shorter than the weeks asked for, and the sheet says so rather than
      // labelling five weeks of nothing as five weeks.
      recent_weeks: weeks,
      recent_from: recentFrom,
      recent_clipped: recentFrom !== askedFrom,
      recent_gameweeks: db.prepare(
        `SELECT COUNT(*) n FROM gameweeks
         WHERE contract_id = ? AND date >= ? AND historical = 0`
      ).get(contractId, recentFrom)?.n || 0,
      rows: squad,
      totals: {
        players: squad.length,
        played: squad.reduce((s, r) => s + r.played, 0),
        deducted: round2(squad.reduce((s, r) => s + r.deducted, 0)),
        balance: round2(squad.reduce((s, r) => s + r.present_balance, 0)),
        in_contract: squad.filter(r => r.status === 'In contract').length,
        refill: squad.filter(r => r.status === 'Refill needed - No priority').length,
        out: squad.filter(r => r.status === 'Out of contract').length,
        recent_played: squad.reduce((s, r) => s + r.recent.played, 0),
        recent_paid_in: round2(squad.reduce((s, r) => s + r.recent.paid_in, 0)),
        recent_payers: squad.filter(r => r.recent.paid_in > 0).length,
        recent_taken_out: round2(squad.reduce((s, r) => s + r.recent.taken_out, 0)),
        // Who has not been seen at all in the window — the one thing a
        // period total cannot tell you.
        recent_absent: squad.filter(r => r.recent.played === 0).length,
      },
    };
  },
};
