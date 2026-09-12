// schedule.js — which dates a contract should have a game on, and whether each
// one has been accounted for.
//
// A contract plays on fixed weekdays, so the fixture list is derivable. That
// turns "did we ever enter last Thursday?" from something you have to remember
// into something the app can answer. Every expected date is in exactly one of
// three states:
//
//   played   — a gameweek exists on that date
//   no game  — explicitly recorded as not played (rained off, too few players)
//   missing  — nothing has been said about it either way
//
// The third is the one that matters. Without somewhere to record "no game",
// a week that genuinely had no fixture is indistinguishable from one that was
// simply never entered, and the gap stays open forever.
import { randomBytes } from 'node:crypto';
import { db } from '../db.js';

const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(`${s}T00:00:00Z`);

function config(contractId) {
  const c = db.prepare('SELECT id, name, game_days, season_start FROM contracts WHERE id = ?').get(contractId);
  if (!c) throw new Error('Contract not found');
  let days = [];
  try { days = JSON.parse(c.game_days || '[]'); } catch { days = []; }
  return { ...c, game_days: days };
}

export const scheduleRepo = {
  config,

  setConfig(contractId, { game_days, season_start }) {
    const cur = config(contractId);
    const days = game_days === undefined ? cur.game_days : game_days;
    if (!Array.isArray(days) || days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new Error('game_days must be whole numbers 0 (Sunday) to 6 (Saturday)');
    }
    const start = season_start === undefined ? cur.season_start : season_start;
    if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error('season_start must be YYYY-MM-DD');
    db.prepare('UPDATE contracts SET game_days = ?, season_start = ? WHERE id = ?')
      .run(JSON.stringify(days), start || null, contractId);
    return config(contractId);
  },

  // Every date matching the contract's weekdays between two dates inclusive.
  expectedDates(contractId, from, to) {
    const c = config(contractId);
    const start = parse(from || c.season_start || iso(new Date()));
    const end = parse(to || iso(new Date()));
    if (!c.game_days.length || end < start) return [];
    const out = [];
    for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      if (c.game_days.includes(d.getUTCDay())) out.push(iso(d));
    }
    return out;
  },

  markNoGame(contractId, date, reason = null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
    const played = db.prepare('SELECT id FROM gameweeks WHERE contract_id = ? AND date = ?').get(contractId, date);
    if (played) throw new Error('A game is already recorded on that date — delete it first if it did not happen.');
    db.prepare(
      `INSERT INTO no_game_days (id, contract_id, date, reason, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (contract_id, date) DO UPDATE SET reason = excluded.reason`
    ).run(randomBytes(8).toString('hex'), contractId, date, reason, new Date().toISOString());
    return this.status(contractId);
  },

  clearNoGame(contractId, date) {
    db.prepare('DELETE FROM no_game_days WHERE contract_id = ? AND date = ?').run(contractId, date);
    return this.status(contractId);
  },

  /**
   * The season so far, one row per expected fixture date.
   * `upto` defaults to today — there is no point reporting next month as missing.
   */
  status(contractId, upto = null) {
    const c = config(contractId);
    const today = iso(new Date());
    const end = upto && upto < today ? upto : today;
    const dates = this.expectedDates(contractId, c.season_start, end);

    const games = new Map(
      db.prepare('SELECT id, date, gw_number, num_players FROM gameweeks WHERE contract_id = ? AND date >= ?')
        .all(contractId, c.season_start || '0000-01-01').map(g => [g.date, g])
    );
    const skipped = new Map(
      db.prepare('SELECT date, reason FROM no_game_days WHERE contract_id = ?')
        .all(contractId).map(r => [r.date, r.reason])
    );

    const days = dates.map(date => {
      if (games.has(date)) {
        const g = games.get(date);
        return { date, state: 'played', gameweek_id: g.id, gw_number: g.gw_number, num_players: g.num_players };
      }
      if (skipped.has(date)) return { date, state: 'no_game', reason: skipped.get(date) };
      return { date, state: 'missing' };
    });

    // Games recorded on a date the schedule does not expect — a midweek friendly,
    // or a fixture moved. Worth surfacing rather than hiding, but not a gap.
    const expected = new Set(dates);
    const offSchedule = [...games.values()]
      .filter(g => !expected.has(g.date) && g.date <= end)
      .map(g => ({ date: g.date, gameweek_id: g.id, gw_number: g.gw_number }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const missing = days.filter(d => d.state === 'missing');
    return {
      contract_id: contractId,
      season_start: c.season_start,
      game_days: c.game_days,
      upto: end,
      days,
      off_schedule: offSchedule,
      counts: {
        expected: days.length,
        played: days.filter(d => d.state === 'played').length,
        no_game: days.filter(d => d.state === 'no_game').length,
        missing: missing.length,
      },
      // The oldest unaccounted-for date: where to carry on from.
      next_missing: missing.length ? missing[0].date : null,
    };
  },
};
