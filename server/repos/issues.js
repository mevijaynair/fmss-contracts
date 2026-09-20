// issues.js — a player saying "that is not what happened".
//
// Results are entered by one person from a WhatsApp message. The people who
// would spot a mistake are the twelve who were on the pitch, and they had
// nowhere in the app to say so — a wrong score either reached the cashier as a
// message he had to act on from memory, or it stood.
//
// Two design choices worth stating:
//
//   A report NAMES THE STAT. `field` comes from a fixed list, so what arrives
//   is "the score on 12 Sep is wrong, it was 8-6" and not "something is wrong
//   with last Thursday". The first can be checked in ten seconds; the second
//   is a conversation.
//
//   A report CHANGES NOTHING. It is a message with a subject line. Letting a
//   player edit a result — even their own line of it — would put the record of
//   what happened in the hands of whoever cared most about it. An admin makes
//   the correction, and the report is closed against it.
import { db } from '../db.js';

// What can be reported, and what each one is called on screen. A fixed list so
// the thing being disputed is always a thing the app can point at.
export const ISSUE_FIELDS = {
  score: 'The final score',
  winner: 'Which side won',
  goals: 'Goals credited to me',
  team: 'Which side I was on',
  captain: 'Who captained',
  attendance: 'Whether I played',
  charge: 'What I was charged',
  other: 'Something else',
};

const now = () => new Date().toISOString();

/** What the app currently believes about that stat, so the report carries both sides. */
function currentValue(gameweekId, playerId, field) {
  if (!gameweekId) return '';
  const g = db.prepare('SELECT date, score, scoreline FROM gameweeks WHERE id = ?').get(gameweekId);
  if (!g) return '';
  const mine = db.prepare(
    `SELECT team, is_captain, amount FROM charges
     WHERE gameweek_id = ? AND (player_id = ? OR charged_to = ?) LIMIT 1`)
    .get(gameweekId, playerId, playerId);
  const capt = db.prepare(
    `SELECT p.name, ch.team FROM charges ch JOIN players p ON p.id = ch.player_id
     WHERE ch.gameweek_id = ? AND ch.is_captain = 1`).all(gameweekId)
    .map(r => `${r.team}: ${r.name}`).join(', ');

  switch (field) {
    case 'score': case 'winner': return g.score || g.scoreline || 'no result recorded';
    case 'team': return mine?.team || 'no side recorded';
    case 'captain': return capt || 'nobody recorded as captain';
    case 'attendance': return mine ? 'recorded as playing' : 'not recorded as playing';
    case 'charge': return mine ? String(mine.amount) : 'no charge recorded';
    default: return g.score || '';
  }
}

export const issuesRepo = {
  fields: ISSUE_FIELDS,

  /**
   * File a report. `says` is filled in from the record rather than from the
   * browser, so the report cannot disagree with what the app actually held at
   * the time it was made.
   */
  create({ player_id, gameweek_id, field, should_be }) {
    if (!player_id) throw new Error('A report has to come from somebody');
    if (!ISSUE_FIELDS[field]) throw new Error('Pick what is wrong');
    if (gameweek_id && !db.prepare('SELECT id FROM gameweeks WHERE id = ?').get(gameweek_id)) {
      throw new Error('No such game');
    }
    const text = String(should_be || '').trim();
    if (!text) throw new Error('Say what it should be');
    if (text.length > 500) throw new Error('Keep it under 500 characters');

    // One open report per person per stat per game. Pressing the button twice
    // is the common case and should not make two things for the admin to read.
    const dup = db.prepare(
      `SELECT id FROM issue_reports WHERE player_id = ? AND field = ? AND status = 'open'
         AND COALESCE(gameweek_id,'') = COALESCE(?,'')`).get(player_id, field, gameweek_id || null);
    if (dup) {
      db.prepare('UPDATE issue_reports SET should_be = ?, created_at = ? WHERE id = ?')
        .run(text, now(), dup.id);
      return this.get(dup.id);
    }

    const id = `ir_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    db.prepare(`INSERT INTO issue_reports
      (id, player_id, gameweek_id, field, says, should_be, status, created_at)
      VALUES (?,?,?,?,?,?,'open',?)`)
      .run(id, player_id, gameweek_id || null, field,
        currentValue(gameweek_id, player_id, field), text, now());
    return this.get(id);
  },

  get(id) {
    return this.list({ id })[0] || null;
  },

  list({ status = null, playerId = null, id = null, limit = 200 } = {}) {
    const where = [];
    const args = [];
    if (status) { where.push('i.status = ?'); args.push(status); }
    if (playerId) { where.push('i.player_id = ?'); args.push(playerId); }
    if (id) { where.push('i.id = ?'); args.push(id); }
    args.push(limit);
    return db.prepare(`
      SELECT i.*, p.name AS player_name, g.date AS game_date, g.score AS game_score,
             c.name AS contract_name
      FROM issue_reports i
      JOIN players p ON p.id = i.player_id
      LEFT JOIN gameweeks g ON g.id = i.gameweek_id
      LEFT JOIN contracts c ON c.id = g.contract_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY i.status = 'open' DESC, i.created_at DESC LIMIT ?`).all(...args)
      .map(r => ({ ...r, field_label: ISSUE_FIELDS[r.field] || r.field }));
  },

  openCount() {
    return db.prepare("SELECT COUNT(*) n FROM issue_reports WHERE status = 'open'").get().n;
  },

  /** Close a report. The correction itself is made wherever it belongs. */
  resolve(id, { status = 'resolved', resolution = '', by = 'admin' } = {}) {
    if (!['resolved', 'declined'].includes(status)) throw new Error('Unknown outcome');
    const info = db.prepare(
      `UPDATE issue_reports SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ?
       WHERE id = ? AND status = 'open'`)
      .run(status, String(resolution || '').trim(), by, now(), id);
    if (!info.changes) throw new Error('No such open report');
    return this.get(id);
  },

  /** Reopen one closed by mistake. */
  reopen(id) {
    const info = db.prepare(
      `UPDATE issue_reports SET status = 'open', resolution = '', resolved_by = NULL,
       resolved_at = NULL WHERE id = ?`).run(id);
    if (!info.changes) throw new Error('No such report');
    return this.get(id);
  },
};
