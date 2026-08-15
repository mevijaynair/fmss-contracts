// external_events.js — admin panel to create and manage external events (meals, venue costs, etc.)
import { api } from '../api.js';
import { toast } from '../store.js';
import { $, esc } from '../util.js';
import { store } from '../store.js';

function renderEventForm() {
  const form = document.createElement('div');
  form.innerHTML = `
    <div class="form-group">
      <label>Event Title</label>
      <input type="text" id="eventTitle" placeholder="e.g., Team lunch at XYZ" required>
    </div>
    <div class="form-group">
      <label>Event Type</label>
      <select id="eventType" required>
        <option value="">Select type…</option>
        <option value="meal">Meal / Food</option>
        <option value="venue">Venue / Rental</option>
        <option value="equipment">Equipment</option>
        <option value="other">Other</option>
      </select>
    </div>
    <div class="form-group">
      <label>Date</label>
      <input type="date" id="eventDate" required>
    </div>
    <div class="form-group">
      <label>Description</label>
      <input type="text" id="eventDesc" placeholder="Optional notes">
    </div>
    <div class="form-group" style="background: var(--bg-subtle); padding: 1rem; border-radius: 8px; margin: 1rem 0;">
      <label style="font-weight: 600; color: var(--accent);">Who Paid the Bill?</label>
      <p class="hint" style="margin: 0.4rem 0 0.8rem;">This person will get credited for the full amount</p>
      <select id="eventPayer" required>
        <option value="">Select payer…</option>
      </select>
    </div>
    <div id="participantsSection" style="margin: 1.5rem 0;">
      <h4>Who Shares the Cost?</h4>
      <p class="hint" style="margin-bottom: 0.8rem;">Each person's share will be deducted from their balance:</p>
      <div id="participantsList" style="max-height: 300px; overflow-y: auto; border: 1px solid var(--border-color); padding: 0.8rem; border-radius: 8px;"></div>
      <button class="btn btn-secondary btn-sm" type="button" id="addParticipant" style="margin-top: 0.8rem;">+ Add participant</button>
    </div>
    <div class="form-group">
      <strong>Total Bill: <span id="totalAmount">0</span> AED</strong>
      <p class="hint" style="margin: 0.5rem 0 0;">Payer will be credited this amount</p>
    </div>
    <button type="button" class="btn" id="submitEvent">Create Event</button>
  `;
  return form;
}

function updateParticipantsList(players) {
  const list = $('participantsList');
  if (!list) return;

  // Get current selections from form
  const rows = list.querySelectorAll('.participant-row');
  const selected = new Map(rows.map(r => [r.dataset.playerId, {
    contract_id: r.querySelector('select').value,
    amount: parseFloat(r.querySelector('input').value) || 0
  }]));

  list.innerHTML = '';

  store.players.forEach(p => {
    if (p.special_role === 'cashier') return; // Skip cashier

    const sel = selected.get(p.id) || { contract_id: '', amount: 0 };
    const row = document.createElement('div');
    row.className = 'participant-row';
    row.dataset.playerId = p.id;
    row.style.display = 'flex';
    row.style.gap = '0.5rem';
    row.style.alignItems = 'center';
    row.style.marginBottom = '0.6rem';
    row.style.paddingBottom = '0.6rem';
    row.style.borderBottom = '1px solid var(--bg-subtle)';

    row.innerHTML = `
      <input type="checkbox" class="participant-check" ${sel.amount > 0 ? 'checked' : ''} style="width: 16px; height: 16px;">
      <span style="flex: 1; min-width: 100px;">${esc(p.name)}</span>
      <select class="participant-contract" style="width: 120px; padding: 0.3rem;">
        <option value="">Both</option>
        ${store.contracts.map(c => `<option value="${c.id}" ${sel.contract_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <input type="number" class="participant-amount" placeholder="0" value="${sel.amount || ''}" style="width: 80px; padding: 0.3rem;" step="0.1" min="0">
      <span style="width: 40px; text-align: right; font-weight: 600;">AED</span>
    `;

    row.querySelector('.participant-check').addEventListener('change', (e) => {
      row.querySelector('.participant-amount').disabled = !e.target.checked;
      row.querySelector('.participant-contract').disabled = !e.target.checked;
      updateTotal();
    });

    row.querySelector('.participant-amount').addEventListener('input', updateTotal);
    if (!sel.amount) row.querySelector('.participant-amount').disabled = true;
    if (!sel.amount) row.querySelector('.participant-contract').disabled = true;

    list.appendChild(row);
  });
}

function updateTotal() {
  const total = Array.from($('participantsList').querySelectorAll('.participant-row'))
    .filter(r => r.querySelector('.participant-check').checked)
    .reduce((sum, r) => sum + (parseFloat(r.querySelector('.participant-amount').value) || 0), 0);
  $('totalAmount').textContent = total.toFixed(1);
}

function renderEventsList(events) {
  const list = $('eventsTable').querySelector('tbody');
  if (!events?.length) {
    list.innerHTML = '<tr><td colspan="7" class="hint">No events yet.</td></tr>';
    return;
  }

  list.innerHTML = events.map(e => {
    const payerName = store.players?.find(p => p.id === e.payer_id)?.name || 'Unknown';
    return `
    <tr>
      <td><strong>${esc(e.title)}</strong></td>
      <td><span style="color: var(--success); font-weight: 600;">Paid by ${esc(payerName)}</span></td>
      <td>${e.event_type}</td>
      <td>${e.event_date}</td>
      <td>${e.participant_count || 0} share</td>
      <td>AED ${(e.total || 0).toFixed(2)}</td>
      <td class="row-actions">
        <button class="btn btn-danger btn-sm" data-delete-event="${e.id}">Delete</button>
      </td>
    </tr>`;
  }).join('');

  // Wire buttons
  list.querySelectorAll('[data-delete-event]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this event? (Refunds all participants)')) return;
      try {
        await api.deleteEvent(btn.dataset.deleteEvent);
        toast('Event deleted and refunded');
        load();
      } catch (e) { toast(e.message, true); }
    });
  });
}

async function load() {
  const events = await api.listEvents({ limit: 100 });
  renderEventsList(events);
}

export function initExternalEvents() {
  // Render the form into the container
  const formContainer = $('eventFormContainer');
  if (formContainer) {
    formContainer.appendChild(renderEventForm());
  }

  // Populate payer dropdown
  const payerSelect = $('eventPayer');
  if (payerSelect && store.players) {
    payerSelect.innerHTML = '<option value="">Select payer…</option>' +
      store.players
        .filter(p => p.special_role !== 'cashier')
        .map(p => `<option value="${p.id}">${esc(p.name)}</option>`)
        .join('');
  }

  $('submitEvent').addEventListener('click', async () => {
    const title = $('eventTitle').value;
    const event_type = $('eventType').value;
    const event_date = $('eventDate').value;
    const description = $('eventDesc').value;
    const payer_id = $('eventPayer').value;

    if (!title || !event_type || !event_date || !payer_id) {
      toast('Title, type, date, and payer required', true);
      return;
    }

    const participants = Array.from($('participantsList').querySelectorAll('.participant-row'))
      .filter(r => r.querySelector('.participant-check').checked)
      .map(r => ({
        player_id: r.dataset.playerId,
        contract_id: r.querySelector('.participant-contract').value || null,
        amount: parseFloat(r.querySelector('.participant-amount').value)
      }));

    if (!participants.length) {
      toast('Select at least one player to share the cost', true);
      return;
    }

    try {
      const event = await api.createEvent(title, event_type, event_date, participants, description, payer_id);
      toast(`Event created: ${event.title} (AED ${event.total_paid.toFixed(2)} credited to payer)`);
      $('eventTitle').value = '';
      $('eventType').value = '';
      $('eventDate').value = new Date().toISOString().split('T')[0];
      $('eventDesc').value = '';
      $('eventPayer').value = '';
      updateParticipantsList(store.players);
      load();
    } catch (e) { toast(e.message, true); }
  });

  $('addParticipant').addEventListener('click', () => {
    updateParticipantsList(store.players);
  });

  // Initialize with today's date
  $('eventDate').value = new Date().toISOString().split('T')[0];
  updateParticipantsList(store.players);
}

export function loadExternalEvents() {
  return load();
}
