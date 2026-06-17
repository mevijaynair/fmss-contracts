// stats.js — player statistics: timeline, team history, cost breakdown, attendance.
import { db } from '../db.js';

export const statsRepo = {
  // Get player's full timeline: opening balance → contributions → charges → present
  playerTimeline(playerId, contractId) {
    const opening = db.prepare(`
      SELECT opening_balance FROM ledgers WHERE player_id = ? AND contract_id = ?`).get(playerId, contractId);

    const contributions = db.prepare(`
      SELECT id, amount, date, comments, 'contribution' as type
      FROM contributions
      WHERE player_id = ? AND contract_id = ? AND historical = 0
      ORDER BY date ASC`).all(playerId, contractId);

    const charges = db.prepare(`
      SELECT ch.id, ch.amount, g.date, g.id as gameweek_id, ch.team, ch.is_captain, ch.rate_type,
             'charge' as type
      FROM charges ch
      JOIN gameweeks g ON g.id = ch.gameweek_id
      WHERE ch.player_id = ? AND g.contract_id = ? AND g.historical = 0
      ORDER BY g.date ASC`).all(playerId, contractId);

    // Merge and compute running balance
    const events = [
      ...contributions.map(c => ({ ...c, runningBalance: 0 })),
      ...charges.map(c => ({ ...c, runningBalance: 0 }))
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    let balance = opening?.opening_balance || 0;
    for (const e of events) {
      balance += (e.type === 'contribution' ? 1 : -1) * e.amount;
      e.runningBalance = Math.round(balance * 100) / 100;
    }

    return { opening: opening?.opening_balance || 0, events, presentBalance: balance };
  },

  // Descriptive stats (team history, games, costs, streaks) intentionally include
  // BOTH historical (imported) and live games — they answer "what are this player's
  // results across all past games", independent of the live-balance reconciliation.
  // Only playerTimeline() is live-only, because it must reconcile to present balance.

  // Get player's team history across all games in contract
  playerTeamHistory(playerId, contractId) {
    return db.prepare(`
      SELECT DISTINCT ch.team, COUNT(*) as count
      FROM charges ch
      JOIN gameweeks g ON g.id = ch.gameweek_id
      WHERE ch.player_id = ? AND g.contract_id = ? AND ch.team != ''
      GROUP BY ch.team
      ORDER BY count DESC`).all(playerId, contractId);
  },

  // Games played count
  gamesPlayedCount(playerId, contractId) {
    return db.prepare(`
      SELECT COUNT(DISTINCT ch.gameweek_id) as games
      FROM charges ch
      JOIN gameweeks g ON g.id = ch.gameweek_id
      WHERE ch.player_id = ? AND g.contract_id = ?`).get(playerId, contractId).games;
  },

  // Cost breakdown: how many games at each rate type
  costBreakdown(playerId, contractId) {
    return db.prepare(`
      SELECT ch.rate_type, COUNT(*) as gameCount, SUM(ch.amount) as totalAmount
      FROM charges ch
      JOIN gameweeks g ON g.id = ch.gameweek_id
      WHERE ch.player_id = ? AND g.contract_id = ?
      GROUP BY ch.rate_type
      ORDER BY gameCount DESC`).all(playerId, contractId);
  },

  // Attendance streak: consecutive weeks with at least one charge
  attendanceStreak(playerId, contractId) {
    const games = db.prepare(`
      SELECT DISTINCT g.date FROM charges ch
      JOIN gameweeks g ON g.id = ch.gameweek_id
      WHERE ch.player_id = ? AND g.contract_id = ?
      ORDER BY g.date DESC`).all(playerId, contractId);

    if (!games.length) return { current: 0, longest: 0 };

    let current = 1, longest = 1;
    for (let i = 1; i < games.length; i++) {
      const d1 = new Date(games[i - 1].date);
      const d2 = new Date(games[i].date);
      const daysDiff = (d1 - d2) / (1000 * 60 * 60 * 24);
      if (daysDiff <= 7) current++;  // within a week = streak continues
      else { longest = Math.max(longest, current); current = 1; }
    }
    longest = Math.max(longest, current);
    return { current, longest };
  },

  // Full player stats card
  playerStats(playerId, contractId) {
    const games = this.gamesPlayedCount(playerId, contractId);
    const teams = this.playerTeamHistory(playerId, contractId);
    const costs = this.costBreakdown(playerId, contractId);
    const streaks = this.attendanceStreak(playerId, contractId);

    return { games, teams, costs, streaks };
  },
};
