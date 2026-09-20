// share.js — the numbers behind the snapshot images that get sent to WhatsApp.
//
// This assembles nothing of its own. Every figure comes from the repo that
// already owns it — the squad and its statuses from the Standing sheet, cash
// still to collect from the ledger, the kitty from the kitty — because a
// picture sent to the whole club that disagrees with the app is worse than no
// picture at all. If the sheet says someone is out of contract, so does this.
//
// Two shapes, because there are two audiences:
//
//   club(...)   one image for the group: both contracts side by side, what
//               has happened these last few weeks, and who owes what.
//   player(...) one image for one person: their standing across BOTH
//               contracts at once, which no screen in the app shows — the
//               ledger is per contract, so a player with money on Mon/Thu and
//               a debt on Saturdays had to be looked up twice and added up by
//               hand.
//
// "Pending" is the word the club uses, and it means two different things that
// must not be added together:
//
//   to_collect  cash the club is waiting on — a guest's own charge, unpaid.
//               Real money outside the app.
//   in_the_red  a member whose prepaid balance has run out. Nothing is owed in
//               cash; they need to top up before they play again.
//
// Note especially that `charges.paid = 0` is NOT pending. The ordinary charge
// comes off a prepaid balance and is never marked paid, so counting unpaid
// charges would report the entire season as outstanding.
import { db } from '../db.js';
import { contractsRepo } from './contracts.js';
import { ledgersRepo } from './ledgers.js';
import { periodReportRepo } from './period_report.js';
import { statsRepo } from './stats.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * The cashier, who must never appear in a list of people who owe the club.
 *
 * They pay the pitch up front and are reimbursed as the season runs, so their
 * balance sits deep in the red by design — that figure is the club's float,
 * not a debt. Every screen has to know this, and a picture sent to the whole
 * group naming them as the biggest debtor would be both wrong and unpleasant.
 */
function cashierIds() {
  return new Set(db.prepare(
    "SELECT id FROM players WHERE special_role = 'cashier'").all().map(p => p.id));
}

/** ISO date `weeks` before today. */
function since(weeks) {
  const d = new Date();
  d.setDate(d.getDate() - weeks * 7);
  return d.toISOString().slice(0, 10);
}

/** What the club pays per game on this contract, the same way the sheet reads it. */
function rateOf(contract) {
  const rates = typeof contract.rates === 'string'
    ? (() => { try { return JSON.parse(contract.rates || '{}'); } catch { return {}; } })()
    : (contract.rates || {});
  return Number(rates.contracted_10) || Number(rates.noncontract) || 0;
}

/**
 * Games played on a contract since a date, and who turned out.
 *
 * What each night COLLECTED used to be here and is not any more. It is a true
 * figure that nobody reading the picture can act on — the club's takings are
 * the cashier's business, and publishing them to forty people invites a
 * conversation about the pot rather than about the one thing this picture is
 * for, which is who still needs to pay.
 */
function recentGames(contractId, from) {
  return db.prepare(`
    SELECT g.id, g.date,
           COUNT(DISTINCT ch.player_id) AS players
    FROM gameweeks g
    LEFT JOIN charges ch ON ch.gameweek_id = g.id
    WHERE g.contract_id = ? AND g.historical = 0 AND g.date >= ?
    GROUP BY g.id
    ORDER BY g.date DESC`).all(contractId, from);
}

/**
 * Who still has to pay, ONCE, across both contracts.
 *
 * The picture listed each contract's debtors separately, so Jeetu appeared as
 * -159 on one line and -441 on another and was never shown the -600 he
 * actually owes. Worse, somebody in credit on one night and short on the
 * other was named as a debtor for a shortfall their own money already
 * covers — Toby was on the Mon/Thu list at 487 in hand.
 *
 * Two kinds, kept apart because they are settled differently and adding them
 * would produce a figure nobody can act on:
 *
 *   top_up   a member whose prepaid balance, across everything they hold, has
 *            run out. They pay it in.
 *   cash     a guest who played and has not handed the money over. Real notes.
 *
 * The cashier never appears: they fund the pitch up front, so their balance
 * is the club's float and naming them in a picture sent to forty people would
 * be both wrong and unpleasant.
 */
function stillToPay() {
  const cashiers = cashierIds();
  const names = Object.fromEntries(contractsRepo.all().map(c => [c.id, c.name]));

  const byPlayer = new Map();
  for (const l of ledgersRepo.all()) {
    if (cashiers.has(l.player_id) || (l.player_type || 'regular') === 'outside') continue;
    if (!byPlayer.has(l.player_id)) {
      byPlayer.set(l.player_id, { name: l.player_name, total: 0, parts: [] });
    }
    const row = byPlayer.get(l.player_id);
    row.total += l.present_balance;
    if (l.present_balance !== 0) {
      row.parts.push({ contract: names[l.contract_id] || l.contract_id,
        balance: round2(l.present_balance) });
    }
  }

  const topUp = [...byPlayer.values()]
    .map(r => ({ ...r, total: round2(r.total) }))
    .filter(r => r.total < 0)
    .sort((a, b) => a.total - b.total);

  // Guest cash, also once per person however many contracts it spans.
  const cashBy = new Map();
  for (const r of ledgersRepo.cashOutstanding()) {
    const key = r.player_id || r.player_name;
    if (!cashBy.has(key)) cashBy.set(key, { name: r.player_name || 'Guest', amount: 0, games: 0 });
    const c = cashBy.get(key);
    c.amount += r.owed;
    c.games += r.games;
  }
  const cash = [...cashBy.values()]
    .map(c => ({ ...c, amount: round2(c.amount) }))
    .sort((a, b) => b.amount - a.amount);

  return {
    top_up: topUp,
    top_up_total: round2(topUp.reduce((s, r) => s + r.total, 0)),
    cash,
    cash_total: round2(cash.reduce((s, r) => s + r.amount, 0)),
  };
}

export const shareRepo = {
  /**
   * One snapshot covering every contract — what the group gets sent.
   *
   * `weeks` scopes only the "what has happened lately" parts. Balances are
   * always as they stand right now; a balance as at three weeks ago would be
   * a different and much more confusing thing to publish.
   */
  club({ weeks = 3 } = {}) {
    const from = since(weeks);
    const cashiers = cashierIds();
    const contracts = contractsRepo.all().map((c) => {
      // The Standing sheet's own rows, so the image and the sheet cannot drift.
      const sheet = periodReportRepo.report(c.id, { since: null, includeDormant: false });
      const collect = ledgersRepo.cashOutstanding(c.id);
      return {
        id: c.id,
        name: c.name,
        venue: c.venue || '',
        rate: rateOf(c),
        squad: sheet.rows.map(r => ({
          name: r.name,
          balance: r.present_balance,
          games_left: r.games_left,
          status: r.status,
          played: r.played,
        })),
        totals: sheet.totals,
        left_out: {
          dormant: sheet.dormant_hidden,
          retired: sheet.flag_hidden,
          retired_balance: sheet.flag_hidden_balance,
        },
        recent_games: recentGames(c.id, from),
        // Who owes what is no longer per contract — see stillToPay. Listing
        // it twice is how somebody in credit on one night ended up named as a
        // debtor for a shortfall their own money already covers.
        to_collect: collect.map(r => ({
          name: r.player_name, amount: round2(r.owed),
          games: r.games, last_game: r.last_game_date,
        })),
      };
    });

    return {
      generated_at: new Date().toISOString().slice(0, 10),
      since: from,
      weeks,
      kitty_total: round2(db.prepare('SELECT SUM(amount) t FROM kitty').get()?.t || 0),
      contracts,
      // One list, across everything, because that is the question the picture
      // is sent to answer.
      still_to_pay: stillToPay(),
    };
  },

  /**
   * One person, across every contract they hold — which no screen shows.
   *
   * The ledger is per contract by design, so somebody in credit on Mon/Thu and
   * in the red on Saturdays has to be looked up twice and added up by hand.
   * This is the answer to "where do I actually stand?" in one picture.
   */
  player(playerId, { weeks = 3 } = {}) {
    const p = db.prepare('SELECT id, name FROM players WHERE id = ?').get(playerId);
    if (!p) throw new Error('No such player');
    const from = since(weeks);

    const rateFor = Object.fromEntries(contractsRepo.all().map(c => [c.id, rateOf(c)]));
    const nameFor = Object.fromEntries(contractsRepo.all().map(c => [c.id, c.name]));

    const lines = ledgersRepo.forPlayer(playerId).map((l) => {
      const rate = rateFor[l.contract_id] || 0;
      return {
        contract_id: l.contract_id,
        contract_name: nameFor[l.contract_id] || l.contract_id,
        balance: l.present_balance,
        cash_owed: round2(l.cash_owed || 0),
        games: l.games,
        rate,
        games_left: rate > 0 ? Math.floor(l.present_balance / rate) : null,
      };
    });

    // A charge lands on whoever settles it, which is not always who played:
    // a guest is billed to the member who brought them, and a combined account
    // carries both people's games. Without saying so, two identical lines on
    // the same date look like the same game charged twice — which is the first
    // thing anyone would query, about a picture that exists to stop them having
    // to ask.
    const playedBy = db.prepare(`
      SELECT p.name FROM charges ch JOIN players p ON p.id = ch.player_id
      WHERE ch.id = ?`);

    // Every movement across every contract on one timeline, newest first. Each
    // one says which contract it belongs to, because the whole point of this
    // view is that they are being read together.
    const recent = [];
    for (const l of lines) {
      const { events } = statsRepo.playerTimeline(playerId, l.contract_id);
      for (const e of events) {
        if (e.date < from) continue;
        let label = e.description || e.comments
          || (e.type === 'charge' ? 'Game' : 'Payment');
        if (e.type === 'charge') {
          const who = playedBy.get(e.id)?.name;
          label = who && who !== p.name ? `Game — ${who}` : 'Game';
        }
        recent.push({
          date: e.date,
          contract: l.contract_name,
          type: e.type,
          label,
          amount: e.type === 'charge' ? -Math.abs(e.amount) : e.amount,
        });
      }
    }
    recent.sort((a, b) => String(b.date).localeCompare(String(a.date)));

    return {
      generated_at: new Date().toISOString().slice(0, 10),
      since: from,
      weeks,
      player: { id: p.id, name: p.name },
      contracts: lines,
      // Credit and debt are never netted anywhere else in this app and are not
      // netted here: "you have 200 on one and owe 130 on the other" is the
      // useful sentence, and a single 70 hides the fact that one of them needs
      // topping up before the next game.
      total_balance: round2(lines.reduce((s, l) => s + l.balance, 0)),
      total_cash_owed: round2(lines.reduce((s, l) => s + l.cash_owed, 0)),
      recent,
    };
  },
};
