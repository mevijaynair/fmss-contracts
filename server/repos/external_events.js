// external_events.js — programmes run alongside the football: an Onam night, a
// tour, a team dinner. Unlike a gameweek these have guests, per-head pricing by
// tier, a budget set before anything is spent, and a mix of people paying cash
// on the day and people drawing on their contract balance.
//
// Money rules, in one place so they can be checked against:
//   - An attendee paying 'cash' touches no ledger. They are a row with a paid
//     flag; the cash lands in your hand, not in the app.
//   - An attendee paying 'balance' is debited through the unified ledger (see
//     repos/ledgers.js) as an approved 'event_deduction' naming the event's
//     contract. A guest cannot do this on their own — a guest has no ledger —
//     so a balance-paying guest must hang off a host member, who is debited.
//   - Whoever fronted the real spend is credited the actual amount, the same
//     way, so they are not left out of pocket.
//   - Nothing moves to the kitty by itself. The net is reported and posting it
//     is a deliberate act (postNetToKitty).
import { randomBytes } from 'node:crypto';

function generateId() {
  return randomBytes(8).toString('hex');
}

const parseTiers = (raw) => {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
};

// Deterministic ids, so a rewrite replaces exactly the row it wrote before and
// there is never a second copy of the same debit.
const attendeeTxnId = (attendeeId) => `t_att_${attendeeId}`;
const frontedTxnId = (eventId) => `t_evpaid_${eventId}`;

// Who carries an attendee's cost: the member themselves, or a guest's host.
function billedPlayer(att) {
  return att.player_id || att.host_player_id || null;
}

function writeTxn(db, { id, playerId, contractId, amount, description, eventId, createdBy }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO transactions (id, player_id, contract_id, type, amount, description, event_id, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'event_deduction', ?, ?, ?, 'approved', ?, ?, ?)`
  ).run(id, playerId, contractId, amount, description ?? null, eventId, createdBy ?? null, now, now);
}

export const externalEventsRepo = {
  // ---- the event itself -------------------------------------------------

  createEvent(db, authUsersRepo, adminUserId, payload) {
    const {
      title, description, event_type, event_date, contract_id,
      budget_amount = 0, tiers = {}, status = 'planning',
    } = payload;

    if (!title || !event_type || !event_date) {
      throw new Error('title, event_type and event_date are required');
    }
    // A balance-charged attendee has to be billed against some ledger, and the
    // event is the only thing that knows which. Demanding it here means a debit
    // can never be written with a NULL contract, which would silently reach no
    // balance at all.
    if (!contract_id) {
      throw new Error('contract_id is required — an event settles against a contract ledger');
    }

    const id = generateId();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO external_events
         (id, title, description, event_type, event_date, contract_id,
          budget_amount, actual_amount, tiers, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
    ).run(
      id, title, description ?? null, event_type, event_date, contract_id,
      Number(budget_amount) || 0, JSON.stringify(tiers || {}), status,
      // An admin signed in with the shared password has no auth_users row.
      adminUserId ?? null, now, now
    );

    authUsersRepo?.auditLog?.(db, {
      action: 'external_event_created',
      details: { event_id: id, title, budget: Number(budget_amount) || 0 },
    });
    return this.getEvent(db, id);
  },

  getEvent(db, eventId) {
    const e = db.prepare('SELECT * FROM external_events WHERE id = ?').get(eventId);
    return e ? { ...e, tiers: parseTiers(e.tiers) } : null;
  },

  // Patch-style: only the keys present are touched, so a caller editing the
  // budget cannot blank the tier list by omitting it.
  updateEvent(db, eventId, patch) {
    const existing = this.getEvent(db, eventId);
    if (!existing) throw new Error('Event not found');
    if (existing.status === 'closed' && patch.status !== 'open') {
      throw new Error('This event is closed — reopen it before editing.');
    }

    const fields = [];
    const values = [];
    const set = (col, val) => { fields.push(`${col} = ?`); values.push(val); };

    if (patch.title !== undefined) set('title', patch.title);
    if (patch.description !== undefined) set('description', patch.description ?? null);
    if (patch.event_type !== undefined) set('event_type', patch.event_type);
    if (patch.event_date !== undefined) set('event_date', patch.event_date);
    if (patch.budget_amount !== undefined) set('budget_amount', Number(patch.budget_amount) || 0);
    if (patch.actual_amount !== undefined) set('actual_amount', Number(patch.actual_amount) || 0);
    if (patch.tiers !== undefined) set('tiers', JSON.stringify(patch.tiers || {}));
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.paid_by_player_id !== undefined) set('paid_by_player_id', patch.paid_by_player_id || null);
    if (!fields.length) return existing;

    set('updated_at', new Date().toISOString());
    db.prepare(`UPDATE external_events SET ${fields.join(', ')} WHERE id = ?`).run(...values, eventId);

    // The reimbursement depends on actual_amount and on who fronted it, so any
    // edit to either has to redraw it.
    this.syncFrontedCredit(db, eventId);
    return this.getEvent(db, eventId);
  },

  listEvents(db, filter = {}) {
    let sql = `SELECT e.*,
                 (SELECT COUNT(*) FROM event_attendees a WHERE a.event_id = e.id) AS headcount,
                 (SELECT COALESCE(SUM(a.amount_due), 0) FROM event_attendees a WHERE a.event_id = e.id) AS due_total,
                 (SELECT COALESCE(SUM(CASE WHEN a.pay_method = 'cash' AND a.paid = 1 THEN a.amount_due ELSE 0 END), 0)
                    FROM event_attendees a WHERE a.event_id = e.id) AS cash_collected,
                 (SELECT COALESCE(SUM(CASE WHEN a.pay_method = 'balance' THEN a.amount_due ELSE 0 END), 0)
                    FROM event_attendees a WHERE a.event_id = e.id) AS balance_charged
               FROM external_events e WHERE 1 = 1`;
    const params = [];
    if (filter.event_type) { sql += ' AND e.event_type = ?'; params.push(filter.event_type); }
    if (filter.status) { sql += ' AND e.status = ?'; params.push(filter.status); }
    if (filter.since) { sql += ' AND e.event_date >= ?'; params.push(filter.since); }
    sql += ' ORDER BY e.event_date DESC LIMIT ?';
    params.push(filter.limit || 100);
    return db.prepare(sql).all(...params).map(e => ({ ...e, tiers: parseTiers(e.tiers) }));
  },

  // ---- attendees --------------------------------------------------------

  listAttendees(db, eventId) {
    return db.prepare(
      `SELECT a.*, p.name AS player_name, h.name AS host_name
       FROM event_attendees a
       LEFT JOIN players p ON p.id = a.player_id
       LEFT JOIN players h ON h.id = a.host_player_id
       WHERE a.event_id = ?
       ORDER BY COALESCE(p.name, h.name, a.guest_name), a.guest_name`
    ).all(eventId);
  },

  addAttendee(db, eventId, payload) {
    const event = this.getEvent(db, eventId);
    if (!event) throw new Error('Event not found');
    if (event.status === 'closed') throw new Error('This event is closed — reopen it to change the guest list.');

    const {
      player_id = null, guest_name = null, host_player_id = null,
      tier = 'adult', pay_method = 'cash', amount_due, notes = null,
    } = payload;

    if (!player_id && !guest_name) {
      throw new Error('An attendee needs either a player_id or a guest_name');
    }
    if (player_id && guest_name) {
      throw new Error('An attendee is either a member or a guest, not both');
    }
    // A guest has no ledger of their own. Without a host there is nobody to
    // debit, so let them pay cash rather than writing a debit into the void.
    if (!player_id && pay_method === 'balance' && !host_player_id) {
      throw new Error(`${guest_name} is a guest with no host, so there is no balance to charge — mark them as paying cash or give them a host.`);
    }
    if (player_id) {
      const exists = db.prepare('SELECT 1 FROM event_attendees WHERE event_id = ? AND player_id = ?')
        .get(eventId, player_id);
      if (exists) throw new Error('That member is already on this event');
    }

    // The tier price is the default, not a cage — a negotiated rate for one
    // family should not need a whole new tier.
    const due = amount_due !== undefined && amount_due !== null && amount_due !== ''
      ? Number(amount_due)
      : Number(event.tiers?.[tier] ?? 0);
    if (!Number.isFinite(due) || due < 0) throw new Error(`Invalid amount for ${guest_name || player_id}`);

    const id = generateId();
    db.prepare(
      `INSERT INTO event_attendees
         (id, event_id, player_id, guest_name, host_player_id, tier, amount_due, pay_method, paid, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(id, eventId, player_id, guest_name, host_player_id, tier, due, pay_method, notes, new Date().toISOString());

    this.syncAttendeeTxn(db, eventId, id);
    return db.prepare('SELECT * FROM event_attendees WHERE id = ?').get(id);
  },

  updateAttendee(db, attendeeId, patch) {
    const att = db.prepare('SELECT * FROM event_attendees WHERE id = ?').get(attendeeId);
    if (!att) throw new Error('Attendee not found');
    const event = this.getEvent(db, att.event_id);
    if (event.status === 'closed') throw new Error('This event is closed — reopen it to change the guest list.');

    const next = {
      tier: patch.tier ?? att.tier,
      pay_method: patch.pay_method ?? att.pay_method,
      host_player_id: patch.host_player_id !== undefined ? (patch.host_player_id || null) : att.host_player_id,
      notes: patch.notes !== undefined ? patch.notes : att.notes,
    };
    if (!att.player_id && next.pay_method === 'balance' && !next.host_player_id) {
      throw new Error(`${att.guest_name} is a guest with no host, so there is no balance to charge.`);
    }
    // Retiering re-prices, unless an explicit amount is supplied.
    const due = patch.amount_due !== undefined && patch.amount_due !== null && patch.amount_due !== ''
      ? Number(patch.amount_due)
      : (patch.tier !== undefined ? Number(event.tiers?.[next.tier] ?? 0) : att.amount_due);
    if (!Number.isFinite(due) || due < 0) throw new Error('Invalid amount');

    db.prepare(
      `UPDATE event_attendees SET tier = ?, pay_method = ?, host_player_id = ?, amount_due = ?, notes = ?
       WHERE id = ?`
    ).run(next.tier, next.pay_method, next.host_player_id, due, next.notes, attendeeId);

    // Switching to cash must clear a debit that is no longer owed.
    this.syncAttendeeTxn(db, att.event_id, attendeeId);
    return db.prepare('SELECT * FROM event_attendees WHERE id = ?').get(attendeeId);
  },

  removeAttendee(db, attendeeId) {
    const att = db.prepare('SELECT * FROM event_attendees WHERE id = ?').get(attendeeId);
    if (!att) return;
    const event = this.getEvent(db, att.event_id);
    if (event?.status === 'closed') throw new Error('This event is closed — reopen it to change the guest list.');
    // Drop the debit first; leaving it would bill someone for a head that is no
    // longer attending.
    db.prepare('DELETE FROM transactions WHERE id = ?').run(attendeeTxnId(attendeeId));
    db.prepare('DELETE FROM event_attendees WHERE id = ?').run(attendeeId);
  },

  // Cash only. A balance attendee is settled the moment they are added, so a
  // paid flag there would be a second, contradictory record of the same money.
  setAttendeePaid(db, attendeeId, paid) {
    const att = db.prepare('SELECT * FROM event_attendees WHERE id = ?').get(attendeeId);
    if (!att) throw new Error('Attendee not found');
    if (att.pay_method !== 'cash') {
      throw new Error('This attendee pays from their balance, which is already settled — nothing to mark.');
    }
    db.prepare('UPDATE event_attendees SET paid = ?, paid_at = ? WHERE id = ?')
      .run(paid ? 1 : 0, paid ? new Date().toISOString() : null, attendeeId);
    return db.prepare('SELECT * FROM event_attendees WHERE id = ?').get(attendeeId);
  },

  // ---- ledger sync ------------------------------------------------------

  // Rewrite the one debit this attendee is responsible for. Delete-then-insert
  // rather than upsert, because the row should simply not exist when they pay
  // cash — an amount of 0 would still show up as a line on someone's statement.
  syncAttendeeTxn(db, eventId, attendeeId) {
    const event = this.getEvent(db, eventId);
    const att = db.prepare('SELECT * FROM event_attendees WHERE id = ?').get(attendeeId);
    const txnId = attendeeTxnId(attendeeId);
    db.prepare('DELETE FROM transactions WHERE id = ?').run(txnId);
    if (!event || !att || att.pay_method !== 'balance') return;

    const playerId = billedPlayer(att);
    if (!playerId) return;
    const amount = Number(att.amount_due) || 0;
    if (amount <= 0) return;

    const who = att.guest_name ? `${att.guest_name} (guest)` : 'attendance';
    writeTxn(db, {
      id: txnId, playerId, contractId: event.contract_id,
      amount: -Math.abs(amount),
      description: `${event.title} — ${who}`,
      eventId, createdBy: event.created_by,
    });
  },

  // Credit whoever actually paid the bill, so fronting the money for the club
  // does not quietly cost them.
  syncFrontedCredit(db, eventId) {
    const event = this.getEvent(db, eventId);
    const txnId = frontedTxnId(eventId);
    db.prepare('DELETE FROM transactions WHERE id = ?').run(txnId);
    if (!event?.paid_by_player_id) return;
    const amount = Number(event.actual_amount) || 0;
    if (amount <= 0) return;

    writeTxn(db, {
      id: txnId, playerId: event.paid_by_player_id, contractId: event.contract_id,
      amount: Math.abs(amount),
      description: `Paid for ${event.title}`,
      eventId, createdBy: event.created_by,
    });
  },

  // ---- money picture ----------------------------------------------------

  summary(db, eventId) {
    const event = this.getEvent(db, eventId);
    if (!event) throw new Error('Event not found');
    const attendees = this.listAttendees(db, eventId);

    const sum = (f) => attendees.reduce((s, a) => s + (f(a) ? Number(a.amount_due) || 0 : 0), 0);
    const dueTotal = sum(() => true);
    const cashCollected = sum(a => a.pay_method === 'cash' && a.paid);
    const cashOutstanding = sum(a => a.pay_method === 'cash' && !a.paid);
    const balanceCharged = sum(a => a.pay_method === 'balance');

    const byTier = {};
    for (const a of attendees) {
      const t = byTier[a.tier] || (byTier[a.tier] = { heads: 0, due: 0 });
      t.heads += 1;
      t.due += Number(a.amount_due) || 0;
    }

    const round = (n) => Math.round(n * 100) / 100;
    const actual = Number(event.actual_amount) || 0;
    const budget = Number(event.budget_amount) || 0;

    return {
      event_id: eventId,
      title: event.title,
      status: event.status,
      headcount: attendees.length,
      guests: attendees.filter(a => !a.player_id).length,
      members: attendees.filter(a => a.player_id).length,
      by_tier: byTier,
      budget,
      actual,
      // Positive means it cost more than planned.
      budget_variance: round(actual - budget),
      due_total: round(dueTotal),
      cash_collected: round(cashCollected),
      cash_outstanding: round(cashOutstanding),
      balance_charged: round(balanceCharged),
      // What the programme made or lost: everything owed against what it cost.
      // Against actual once it is known, against budget while still planning.
      net: round(dueTotal - (actual || budget)),
      // Money still to come in. Balance charges are already settled.
      uncollected: round(cashOutstanding),
    };
  },

  // ---- closure ----------------------------------------------------------

  close(db, eventId) {
    const s = this.summary(db, eventId);
    if (s.cash_outstanding > 0) {
      throw new Error(`${s.cash_outstanding} AED is still to be collected in cash — mark it in or write it off before closing.`);
    }
    db.prepare('UPDATE external_events SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?')
      .run('closed', new Date().toISOString(), new Date().toISOString(), eventId);
    return this.getEvent(db, eventId);
  },

  reopen(db, eventId) {
    db.prepare('UPDATE external_events SET status = ?, closed_at = NULL, updated_at = ? WHERE id = ?')
      .run('open', new Date().toISOString(), eventId);
    return this.getEvent(db, eventId);
  },

  // Deliberate, never automatic: the surplus or shortfall only reaches the club
  // fund when someone decides it should. Keyed to the event so posting twice
  // replaces the entry rather than doubling it.
  postNetToKitty(db, kittyRepo, eventId) {
    const event = this.getEvent(db, eventId);
    if (!event) throw new Error('Event not found');
    const s = this.summary(db, eventId);
    const kittyId = `k_event_${eventId}`;
    db.prepare('DELETE FROM kitty WHERE id = ?').run(kittyId);
    if (!s.net) return { posted: 0, net: 0 };

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO kitty (id, kind, label, amount, date, scope, historical, created_at)
       VALUES (?, ?, ?, ?, ?, '', 0, ?)`
    ).run(
      kittyId, s.net > 0 ? 'income' : 'expense',
      `${event.title} (${s.net > 0 ? 'surplus' : 'shortfall'})`,
      Math.abs(s.net), event.event_date, now
    );
    return { posted: Math.abs(s.net), net: s.net, kind: s.net > 0 ? 'income' : 'expense' };
  },

  getEventTransactions(db, eventId) {
    return db.prepare(
      `SELECT t.id, t.player_id, p.name, t.contract_id, t.amount, t.description, t.created_at
       FROM transactions t
       JOIN players p ON p.id = t.player_id
       WHERE t.event_id = ?
       ORDER BY p.name`
    ).all(eventId);
  },

  // Unwinds everything the event wrote: debits, the reimbursement, its kitty
  // entry, and the guest list.
  deleteEvent(db, eventId) {
    db.prepare('DELETE FROM transactions WHERE event_id = ?').run(eventId);
    db.prepare('DELETE FROM kitty WHERE id = ?').run(`k_event_${eventId}`);
    db.prepare('DELETE FROM event_attendees WHERE event_id = ?').run(eventId);
    db.prepare('DELETE FROM external_events WHERE id = ?').run(eventId);
  },
};
