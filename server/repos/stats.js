// stats.js — player statistics: timeline, team history, cost breakdown, attendance.
import { db } from '../db.js';
import { normaliseScore, winningTeam, isTournament } from '../results_import.js';

export const statsRepo = {
  /**
   * A player's match record: won/drawn/lost, goals and captaincy.
   *
   * Shares normaliseScore/winningTeam with the Results view on purpose. The
   * outcome depends on WHICH TEAM the player was on — a game is only a win for
   * the winning side — so both places must resolve it the same way or the same
   * player shows two different records.
   *
   * Rates are computed over games with a KNOWN result; a blank score cell counts
   * as neither a win nor a loss, and is reported separately as `unknown`.
   */
  matchRecord(playerId, contractId = null) {
    const rows = db.prepare(`
      SELECT ch.team, ch.is_captain, g.id AS gw, g.score, g.scoreline, g.game_type
      FROM charges ch
      JOIN gameweeks g ON g.id = ch.gameweek_id
      WHERE ch.player_id = ?${contractId ? ' AND g.contract_id = ?' : ''}`)
      .all(...(contractId ? [playerId, contractId] : [playerId]));

    const teamsOf = db.prepare(
      'SELECT DISTINCT team FROM charges WHERE gameweek_id = ? AND team != \'\'');
    const resultOf = db.prepare(`SELECT team_a_name, team_b_name, goals_team_a,
      goals_team_b, result FROM game_results WHERE gameweek_id = ?`);

    const r = {
      // Matches only. A tournament appearance is counted under `tournaments`,
      // so wins + draws + losses + unknown still adds up to `games`.
      games: 0, wins: 0, draws: 0, losses: 0, unknown: 0,
      // Two different reasons a game cannot be scored, worth telling apart: the
      // result was unreadable, or nobody recorded which side the player was on.
      // Seeded historical games have no team on any charge, so they can never be
      // won or lost — only imported/parsed games carry teams.
      no_score: 0, no_team: 0,
      gf: 0, ga: 0, captainGames: 0, captainDecided: 0, captainWins: 0,
      // Three-sided games are counted, never scored — see isTournament.
      tournaments: 0,
      // Goals are only added when somebody actually wrote them down, so the
      // games behind gf/ga are fewer than the games behind wins/losses. Saying
      // how many keeps "+14 across 9 games" honest about which nine.
      goalGames: 0,
    };

    for (const row of rows) {
      const teams = teamsOf.all(row.gw).map(t => t.team);
      if (isTournament(row.game_type, teams)) { r.tournaments++; continue; }
      r.games++;
      if (row.is_captain) r.captainGames++;
      // The game_results row is the authoritative answer — it names both sides
      // and who won — so prefer it over re-reading the text. The fallback below
      // stays for imported games, which have no result row.
      //
      // scoreline is bare goals ("7-5"), which says nothing about who won; score
      // carries the side ("Red win 7-5"). Taking the first truthy one meant a
      // game with both recorded counted as having no readable result, so each is
      // tried and whichever resolves is kept.
      const gr = resultOf.get(row.gw);
      let sc;
      if (gr) {
        sc = {
          winner: gr.result === 'draw' ? 'draw'
            : (gr.result === 'a_wins' ? gr.team_a_name : gr.team_b_name),
          goalsWin: Math.max(gr.goals_team_a, gr.goals_team_b),
          goalsLose: Math.min(gr.goals_team_a, gr.goals_team_b),
          known: true, goalsKnown: true,
        };
      } else {
        // Only the readable text, never the scoreline.
        //
        // A game is created with scoreline "0-0" whether or not anyone entered a
        // score, so an unplayed-out result is indistinguishable from a genuine
        // nil-nil — and parsing it counted both as draws. Mon/Thu's 17 August
        // and 10 September have no score at all, and every player who appeared
        // in them was credited with a draw: Jeetu read 75% instead of 100%,
        // Kartik 50% instead of 100%, and every rate on the contract was
        // deflated by phantom draws.
        //
        // `score` is only ever non-empty because somebody wrote a result, so it
        // carries no such ambiguity, and imported games have it while having no
        // scoreline at all.
        sc = normaliseScore(row.score);
      }
      const wt = winningTeam(sc.winner, teams);
      // A decided game the player has no side in cannot be won OR lost by them,
      // so it is not a game they captained to a result either. captainDecided
      // was incremented before that second test, putting games in the
      // denominator of a captain's win rate that could never be in the top.
      const hasSide = sc.winner === 'draw' || !!row.team;
      const decided = sc.known && (sc.winner === 'draw' || wt) && hasSide;
      if (decided && row.is_captain) r.captainDecided++;
      if (!decided) {
        r.unknown++;
        if (!sc.known) r.no_score++;
        else r.no_team++;          // no side on the charge, or one this game lacks
        continue;
      }

      // Goals are added only when the text or the result row actually carried
      // them. "Reds win" says who won and nothing about goals; inventing a 3–0
      // for it put 24 fabricated goals across 106 appearances into the goal
      // difference table, indistinguishable from the real ones.
      if (sc.goalsKnown) {
        r.goalGames++;
        const w = Number(sc.goalsWin) || 0;
        const l = Number(sc.goalsLose) || 0;
        if (sc.winner === 'draw') { r.gf += w; r.ga += w; }
        else if (row.team === wt) { r.gf += w; r.ga += l; }
        else { r.gf += l; r.ga += w; }
      }

      if (sc.winner === 'draw') r.draws++;
      else if (row.team === wt) {
        r.wins++;
        if (row.is_captain) r.captainWins++;
      } else r.losses++;
    }

    r.decided = r.wins + r.draws + r.losses;
    r.winRate = r.decided ? Math.round((r.wins / r.decided) * 100) : null;
    r.gd = r.gf - r.ga;
    // Per game that HAD goals, not per game played — the two differ now that a
    // winner without a scoreline contributes an outcome but no goals.
    r.gdPerGame = r.goalGames ? +(r.gd / r.goalGames).toFixed(2) : null;
    // Only games with a result can be won, so only those may sit under a win
    // rate. Dividing by every captained game deflated the figure by any game
    // nobody scored — and it disagreed with the same number on the Results
    // screen, which had already been corrected.
    r.captainWinRate = r.captainDecided
      ? Math.round((r.captainWins / r.captainDecided) * 100) : null;
    return r;
  },

  // Get player's full timeline: opening balance → contributions → charges → present
  playerTimeline(playerId, contractId) {
    const opening = db.prepare(`
      SELECT opening_balance FROM ledgers WHERE player_id = ? AND contract_id = ?`).get(playerId, contractId);

    const contributions = db.prepare(`
      SELECT id, amount, date, comments, 'contribution' as type
      FROM contributions
      WHERE player_id = ? AND contract_id = ? AND historical = 0
      ORDER BY date ASC`).all(playerId, contractId);

    /* The charges that land on THIS person's balance on THIS contract — the
       same three questions ledgers.js asks, and it has to be the same three or
       this screen contradicts the Standing sheet.

       It used to take every charge with this player_id on this contract, which
       ignored all of them:
         - charged_to      a guest's game is the bill of whoever brought them
         - settle_contract_id  a Saturday game can be settled from Mon/Thu credit
         - settles_cash    paid on the night, never on a balance
         - settled_from_kitty  the club pot carried it

       Twenty-five of sixty-two ledger rows disagreed with the Standing sheet as
       a result. Ali's own page showed −108 against a true 0; Kartik −70 against
       0; AWS −121 against −229. These are the numbers a player sees when they
       sign in, so they were the club's most visible wrong figures. */
    const charges = db.prepare(`
      SELECT ch.id, ch.amount, g.date, g.id as gameweek_id, ch.team, ch.is_captain,
             ch.rate_type, 'charge' as type
      FROM charges ch
      JOIN gameweeks g ON g.id = ch.gameweek_id
      LEFT JOIN players s ON s.id = COALESCE(NULLIF(ch.charged_to, ''), ch.player_id)
      WHERE COALESCE(NULLIF(ch.charged_to, ''), ch.player_id) = ?
        AND COALESCE(ch.settle_contract_id, g.contract_id) = ?
        AND g.historical = 0
        AND ch.settled_from_kitty = 0
        AND NOT (ch.settles_cash = 1 OR COALESCE(s.player_type, 'regular') = 'outside')
      ORDER BY g.date ASC`).all(playerId, contractId);

    // Transfers, event deductions and manual corrections. Already signed, and
    // excluded from the two tables above so they cannot be counted twice.
    const adjustments = db.prepare(`
      SELECT id, amount, COALESCE(created_at, updated_at) AS date, description AS comments,
             'adjustment' as type
      FROM transactions
      WHERE player_id = ? AND contract_id = ? AND status = 'approved'
        AND type NOT IN ('contribution', 'charge')
      ORDER BY date ASC`).all(playerId, contractId);

    // Merge and compute running balance
    const events = [
      ...contributions.map(c => ({ ...c, runningBalance: 0 })),
      ...adjustments.map(c => ({ ...c, runningBalance: 0 })),
      ...charges.map(c => ({ ...c, runningBalance: 0 }))
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    let balance = opening?.opening_balance || 0;
    for (const e of events) {
      // Contributions credit, charges debit, adjustments carry their own sign.
      balance += e.type === 'charge' ? -e.amount : e.amount;
      e.runningBalance = Math.round(balance * 100) / 100;
    }
    balance = Math.round(balance * 100) / 100;

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
