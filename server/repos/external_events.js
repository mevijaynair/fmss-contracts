// external_events.js — manage shared expenses (meals, venue costs, etc.)
// One event (e.g., "Team lunch") splits costs across multiple players.
// Creates transactions for each player deduction with full audit trail.

import { randomBytes } from 'node:crypto';

function generateId() {
  return randomBytes(8).toString('hex');
}

export const externalEventsRepo = {
  // Create an external event and deduct from selected players' balances.
  // payload: { title, description, event_type, event_date, participants: [{player_id, contract_id, amount}] }
  createEvent(db, authUsersRepo, adminUserId, payload) {
    const { title, description, event_type, event_date, participants } = payload;
    if (!title || !event_type || !event_date || !participants?.length) {
      throw new Error('title, event_type, event_date, and participants required');
    }

    const eventId = generateId();
    const now = new Date().toISOString();

    // Create the event
    db.prepare(
      `INSERT INTO external_events (id, title, description, event_type, event_date, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(eventId, title, description, event_type, event_date, adminUserId, now, now);

    // Create a transaction for each participant (deduction from their balance)
    for (const p of participants) {
      if (!p.player_id || p.amount === undefined) {
        throw new Error('Each participant needs player_id and amount');
      }
      db.prepare(
        `INSERT INTO transactions (id, player_id, contract_id, type, amount, description, event_id, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'event_deduction', ?, ?, ?, 'approved', ?, ?, ?)`
      ).run(
        generateId(), p.player_id, p.contract_id || null,
        -Math.abs(p.amount),  // negative = deduction
        title, eventId, adminUserId, now, now
      );
    }

    // Audit log
    authUsersRepo.auditLog?.(db, {
      action: 'external_event_created',
      details: { event_id: eventId, title, participant_count: participants.length }
    });

    return { id: eventId, title, event_type, total_deducted: participants.reduce((s, p) => s + p.amount, 0) };
  },

  // Get all external events with participant breakdown
  listEvents(db, filter = {}) {
    let query = `SELECT e.*, COUNT(DISTINCT t.player_id) as participant_count, SUM(ABS(t.amount)) as total
                 FROM external_events e
                 LEFT JOIN transactions t ON t.event_id = e.id
                 WHERE 1=1`;
    const params = [];

    if (filter.event_type) {
      query += ' AND e.event_type = ?';
      params.push(filter.event_type);
    }
    if (filter.since) {
      query += ' AND e.event_date >= ?';
      params.push(filter.since);
    }

    query += ' GROUP BY e.id ORDER BY e.event_date DESC LIMIT ?';
    params.push(filter.limit || 100);

    return db.prepare(query).all(...params);
  },

  // Get transactions for an event (who paid what)
  getEventTransactions(db, eventId) {
    return db.prepare(
      `SELECT t.id, t.player_id, p.name, t.contract_id, t.amount, t.created_at
       FROM transactions t
       JOIN players p ON p.id = t.player_id
       WHERE t.event_id = ?
       ORDER BY p.name`
    ).all(eventId);
  },

  // Delete an event (refunds all participants)
  deleteEvent(db, eventId) {
    db.prepare('DELETE FROM transactions WHERE event_id = ?').run(eventId);
    db.prepare('DELETE FROM external_events WHERE id = ?').run(eventId);
  },
};
