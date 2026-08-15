// game_results.js — manage team-level game results (Team A vs Team B, score, goals)
import { randomUUID } from 'node:crypto';

export const gameResultsRepo = {
  create(db, gameweekId, teamAName, teamBName, goalsTeamA, goalsTeamB) {
    const id = randomUUID();
    const result = goalsTeamA > goalsTeamB ? 'a_wins' : goalsTeamA < goalsTeamB ? 'b_wins' : 'draw';

    db.prepare(`
      INSERT INTO game_results (id, gameweek_id, team_a_name, team_b_name, goals_team_a, goals_team_b, result, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, gameweekId, teamAName, teamBName, goalsTeamA, goalsTeamB, result, new Date().toISOString());

    return { id, gameweekId, teamAName, teamBName, goalsTeamA, goalsTeamB, result };
  },

  getByGameweekId(db, gameweekId) {
    return db.prepare('SELECT * FROM game_results WHERE gameweek_id = ?').get(gameweekId);
  },

  update(db, gameweekId, teamAName, teamBName, goalsTeamA, goalsTeamB) {
    const result = goalsTeamA > goalsTeamB ? 'a_wins' : goalsTeamA < goalsTeamB ? 'b_wins' : 'draw';

    db.prepare(`
      UPDATE game_results
      SET team_a_name = ?, team_b_name = ?, goals_team_a = ?, goals_team_b = ?, result = ?
      WHERE gameweek_id = ?
    `).run(teamAName, teamBName, goalsTeamA, goalsTeamB, result, gameweekId);
  },

  delete(db, gameweekId) {
    db.prepare('DELETE FROM game_results WHERE gameweek_id = ?').run(gameweekId);
  }
};
