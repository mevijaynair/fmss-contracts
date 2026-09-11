// external_events.js — programmes: an Onam night, a tour, a team dinner.
//
// Two screens in one view. The list is the planning board; clicking a programme
// opens the sheet where the guest list and the money live. State is kept in a
// single `openId` rather than a router, because there are only ever two levels.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money } from '../util.js';

let openId = null;
let cache = null;        // the open programme's { event, attendees, summary }
let addingGuest = false; // which half of the add-attendee control is showing

const STATUS_STYLE = {
  planning: { label: 'Planning', color: 'var(--text-muted)' },
  open: { label: 'Open', color: 'var(--warning)' },
  closed: { label: 'Closed', color: 'var(--success)' },
};

const TYPES = [
  ['meal', 'Meal / Food'], ['venue', 'Venue / Rental'],
  ['trip', 'Trip / Tour'], ['equipment', 'Equipment'], ['other', 'Other'],
];

const root = () => $('eventsRoot');

// ---- list ------------------------------------------------------------------

async function renderList() {
  const events = await api.listEvents();
  const rows = events.map(e => {
    const st = STATUS_STYLE[e.status] || STATUS_STYLE.planning;
    // While still planning there is no actual spend to measure against, so the
    // budget stands in — otherwise every unstarted programme looks like pure profit.
    const net = Math.round((e.due_total - (e.actual_amount || e.budget_amount)) * 100) / 100;
    return `
      <tr data-open="${e.id}" style="cursor:pointer;">
        <td><strong>${esc(e.title)}</strong></td>
        <td>${esc(e.event_date)}</td>
        <td><span style="color:${st.color};font-weight:600;">${st.label}</span></td>
        <td class="num">${e.headcount}</td>
        <td class="num">${money(e.budget_amount)}</td>
        <td class="num">${e.actual_amount ? money(e.actual_amount) : '<span class="hint">—</span>'}</td>
        <td class="num" style="color:${net < 0 ? 'var(--danger)' : 'var(--success)'};font-weight:600;">
          ${net > 0 ? '+' : ''}${money(net)}
        </td>
      </tr>`;
  }).join('');

  root().innerHTML = `
    <div class="sams-card">
      <div class="card-header">
        <h3 class="card-title">Programmes</h3>
        <span class="card-sub">Events run alongside the football — budget them, price per head, track who has paid</span>
      </div>
      <div style="overflow-x:auto;">
        <table class="sams-table">
          <thead><tr>
            <th>Programme</th><th>Date</th><th>Status</th><th class="num">Heads</th>
            <th class="num">Budget</th><th class="num">Actual</th><th class="num">Net</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="7" class="hint">No programmes yet.</td></tr>'}</tbody>
        </table>
      </div>
    </div>

    <div class="sams-card" style="margin-top:1.5rem;">
      <h4 class="card-title">New programme</h4>
      <div class="form-group"><label>Title</label>
        <input type="text" id="evTitle" placeholder="e.g. Onam 2026"></div>
      <div style="display:flex;gap:1rem;flex-wrap:wrap;">
        <div class="form-group" style="flex:1;min-width:150px;"><label>Type</label>
          <select id="evType">${TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
        <div class="form-group" style="flex:1;min-width:150px;"><label>Date</label>
          <input type="date" id="evDate" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="form-group" style="flex:1;min-width:150px;"><label>Settle against</label>
          <select id="evContract">${(store.contracts || []).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      </div>
      <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:flex-end;">
        <div class="form-group" style="flex:1;min-width:120px;"><label>Budget (AED)</label>
          <input type="number" id="evBudget" value="0" min="0" step="1"></div>
        <div class="form-group" style="flex:1;min-width:110px;"><label>Adult rate</label>
          <input type="number" id="evAdult" value="0" min="0" step="1"></div>
        <div class="form-group" style="flex:1;min-width:110px;"><label>Child rate</label>
          <input type="number" id="evChild" value="0" min="0" step="1"></div>
        <div class="form-group" style="flex:1;min-width:110px;"><label>Infant rate</label>
          <input type="number" id="evInfant" value="0" min="0" step="1"></div>
      </div>
      <p class="hint" style="margin:0 0 0.8rem;">Per-head prices. Anyone can still be given their own amount later.</p>
      <button class="btn" id="evCreate">Create programme</button>
    </div>`;

  root().querySelectorAll('[data-open]').forEach(tr =>
    tr.addEventListener('click', () => openEvent(tr.dataset.open)));

  $('evCreate').addEventListener('click', async () => {
    const title = $('evTitle').value.trim();
    const contract_id = $('evContract').value;
    if (!title) return toast('Give the programme a title', true);
    if (!contract_id) return toast('Pick a contract to settle against', true);
    try {
      const ev = await api.createEvent({
        title, event_type: $('evType').value, event_date: $('evDate').value,
        contract_id, budget_amount: Number($('evBudget').value) || 0,
        tiers: {
          adult: Number($('evAdult').value) || 0,
          child: Number($('evChild').value) || 0,
          infant: Number($('evInfant').value) || 0,
        },
      });
      toast(`Created ${ev.title}`);
      openEvent(ev.id);
    } catch (e) { toast(e.message, true); }
  });
}

// ---- one programme ---------------------------------------------------------

async function openEvent(id) {
  openId = id;
  cache = await api.getEvent(id);
  renderDetail();
}

function moneyPanel(s, ev) {
  const cell = (label, value, color) => `
    <div style="flex:1;min-width:110px;">
      <div class="hint" style="margin-bottom:0.2rem;">${label}</div>
      <div style="font-size:1.15rem;font-weight:600;${color ? `color:${color};` : ''}">${value}</div>
    </div>`;
  const netColor = s.net < 0 ? 'var(--danger)' : 'var(--success)';
  const varColor = s.budget_variance > 0 ? 'var(--danger)' : 'var(--success)';
  return `
    <div style="display:flex;gap:1.2rem;flex-wrap:wrap;padding:1rem;background:var(--bg-subtle);border-radius:8px;margin-bottom:1rem;">
      ${cell('Heads', `${s.headcount} <span class="hint" style="font-size:0.8rem;">(${s.members} members, ${s.guests} guests)</span>`)}
      ${cell('Budget', money(s.budget))}
      ${cell('Actual', s.actual ? money(s.actual) : '<span class="hint">not set</span>',
    s.actual ? varColor : null)}
      ${cell('Owed by attendees', money(s.due_total))}
      ${cell('Cash in', money(s.cash_collected))}
      ${cell('Cash outstanding', money(s.cash_outstanding), s.cash_outstanding ? 'var(--warning)' : null)}
      ${cell('From balances', money(s.balance_charged))}
      ${cell(s.net < 0 ? 'Shortfall' : 'Surplus', `${s.net > 0 ? '+' : ''}${money(s.net)}`, netColor)}
    </div>
    ${s.actual ? '' : '<p class="hint" style="margin:-0.5rem 0 1rem;">Net is measured against the budget until you record what it actually cost.</p>'}`;
}

function attendeeRow(a, ev) {
  const locked = ev.status === 'closed';
  const name = a.player_name || a.guest_name;
  const sub = a.player_name ? 'member' : (a.host_name ? `guest of ${esc(a.host_name)}` : 'guest');
  const tiers = Object.keys(ev.tiers || {});
  return `
    <tr>
      <td><strong>${esc(name)}</strong><br><span class="hint" style="font-size:0.8rem;">${sub}</span></td>
      <td>
        <select class="att-tier" data-id="${a.id}" ${locked ? 'disabled' : ''} style="padding:0.3rem;">
          ${tiers.map(t => `<option value="${t}" ${a.tier === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        </select>
      </td>
      <td class="num">
        <input type="number" class="att-amt" data-id="${a.id}" value="${a.amount_due}"
               ${locked ? 'disabled' : ''} step="1" min="0" style="width:80px;padding:0.3rem;text-align:right;">
      </td>
      <td>
        <select class="att-method" data-id="${a.id}" ${locked ? 'disabled' : ''} style="padding:0.3rem;">
          <option value="cash" ${a.pay_method === 'cash' ? 'selected' : ''}>Cash</option>
          <option value="balance" ${a.pay_method === 'balance' ? 'selected' : ''}>Balance</option>
        </select>
      </td>
      <td style="text-align:center;">
        ${a.pay_method === 'balance'
      ? '<span class="hint" title="Already taken from their contract balance">settled</span>'
      // Once closed the checkbox is dead weight, but whether they actually paid
      // is exactly what you come back to a closed programme to find out.
      : locked
        ? (a.paid ? '<span style="color:var(--success);">✓ paid</span>' : '<span class="hint">unpaid</span>')
        : `<input type="checkbox" class="att-paid" data-id="${a.id}" ${a.paid ? 'checked' : ''}>`}
      </td>
      <td class="row-actions">
        ${locked ? '' : `<button class="link-btn" data-remove="${a.id}" title="Remove">✕</button>`}
      </td>
    </tr>`;
}

function renderDetail() {
  const { event: ev, attendees, summary: s } = cache;
  const st = STATUS_STYLE[ev.status] || STATUS_STYLE.planning;
  const locked = ev.status === 'closed';
  const members = (store.players || []).filter(p => !attendees.some(a => a.player_id === p.id));

  root().innerHTML = `
    <div class="sams-card">
      <div class="card-header" style="align-items:center;">
        <div>
          <button class="link-btn" id="evBack">← All programmes</button>
          <h3 class="card-title" style="margin-top:0.4rem;">${esc(ev.title)}
            <span style="color:${st.color};font-size:0.8rem;margin-left:0.5rem;">${st.label}</span></h3>
          <span class="card-sub">${esc(ev.event_date)} · ${esc(ev.event_type)}</span>
        </div>
      </div>

      ${moneyPanel(s, ev)}

      <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:flex-end;margin-bottom:1rem;">
        <div class="form-group" style="flex:1;min-width:130px;margin:0;"><label>Budget</label>
          <input type="number" id="evEditBudget" value="${ev.budget_amount}" ${locked ? 'disabled' : ''} step="1" min="0"></div>
        <div class="form-group" style="flex:1;min-width:130px;margin:0;"><label>What it actually cost</label>
          <input type="number" id="evEditActual" value="${ev.actual_amount}" ${locked ? 'disabled' : ''} step="1" min="0"></div>
        <div class="form-group" style="flex:1;min-width:160px;margin:0;"><label>Who fronted it</label>
          <select id="evEditPaidBy" ${locked ? 'disabled' : ''}>
            <option value="">Nobody / club funds</option>
            ${(store.players || []).map(p => `<option value="${p.id}" ${ev.paid_by_player_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select></div>
        <button class="btn btn-secondary" id="evSave" ${locked ? 'disabled' : ''}>Save</button>
      </div>
      <p class="hint" style="margin:-0.5rem 0 1rem;">Whoever fronted the money is credited what it cost, so they are not left out of pocket.</p>
    </div>

    <div class="sams-card" style="margin-top:1.5rem;">
      <h4 class="card-title">Who is coming</h4>
      <div style="overflow-x:auto;">
        <table class="sams-table">
          <thead><tr><th>Name</th><th>Tier</th><th class="num">Amount</th><th>Pays by</th><th>Paid</th><th></th></tr></thead>
          <tbody>${attendees.map(a => attendeeRow(a, ev)).join('')
      || '<tr><td colspan="6" class="hint">Nobody added yet.</td></tr>'}</tbody>
        </table>
      </div>

      ${locked ? '' : `
        <div style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--border-color);">
          <div style="display:flex;gap:0.5rem;margin-bottom:0.8rem;">
            <button class="btn btn-sm ${addingGuest ? 'btn-secondary' : ''}" id="tabMember">Add member</button>
            <button class="btn btn-sm ${addingGuest ? '' : 'btn-secondary'}" id="tabGuest">Add guest</button>
          </div>
          <div style="display:flex;gap:0.6rem;flex-wrap:wrap;align-items:flex-end;">
            ${addingGuest ? `
              <div class="form-group" style="flex:2;min-width:150px;margin:0;"><label>Guest name</label>
                <input type="text" id="addName" placeholder="e.g. Priya (wife)"></div>
              <div class="form-group" style="flex:2;min-width:150px;margin:0;"><label>Guest of</label>
                <select id="addHost"><option value="">Nobody — pays directly</option>
                  ${(store.players || []).map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
            ` : `
              <div class="form-group" style="flex:2;min-width:180px;margin:0;"><label>Member</label>
                <select id="addPlayer">${members.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')
        || '<option value="">Everyone is already added</option>'}</select></div>
            `}
            <div class="form-group" style="flex:1;min-width:110px;margin:0;"><label>Tier</label>
              <select id="addTier">${Object.entries(ev.tiers || {}).map(([t, rate]) =>
          `<option value="${t}">${esc(t)} (${rate})</option>`).join('')}</select></div>
            <div class="form-group" style="flex:1;min-width:110px;margin:0;"><label>Pays by</label>
              <select id="addMethod"><option value="cash">Cash</option><option value="balance">Balance</option></select></div>
            <button class="btn" id="addGo">Add</button>
          </div>
          <p class="hint" style="margin:0.6rem 0 0;">A guest paying from a balance needs a host — they have no ledger of their own.</p>
        </div>`}
    </div>

    <div class="sams-card" style="margin-top:1.5rem;">
      <h4 class="card-title">Closing up</h4>
      <div style="display:flex;gap:0.6rem;flex-wrap:wrap;align-items:center;">
        ${locked
      ? '<button class="btn btn-secondary" id="evReopen">Reopen</button>'
      : '<button class="btn" id="evClose">Close programme</button>'}
        <button class="btn btn-secondary" id="evKitty">
          Post ${s.net < 0 ? 'shortfall' : 'surplus'} of ${money(Math.abs(s.net))} to kitty
        </button>
        <button class="link-btn" id="evDelete" style="color:var(--danger);margin-left:auto;">Delete programme</button>
      </div>
      <p class="hint" style="margin:0.7rem 0 0;">
        Nothing reaches the kitty on its own. Posting again replaces the entry rather than adding a second one.
      </p>
    </div>`;

  wireDetail(ev, locked);
}

function wireDetail(ev, locked) {
  const refresh = async () => { cache = await api.getEvent(openId); renderDetail(); };
  const guard = (fn) => async (...args) => {
    try { await fn(...args); await refresh(); } catch (e) { toast(e.message, true); await refresh(); }
  };

  $('evBack').addEventListener('click', () => { openId = null; cache = null; renderList(); });

  if (!locked) {
    $('evSave').addEventListener('click', guard(async () => {
      await api.updateEvent(openId, {
        budget_amount: Number($('evEditBudget').value) || 0,
        actual_amount: Number($('evEditActual').value) || 0,
        paid_by_player_id: $('evEditPaidBy').value || null,
      });
      toast('Saved');
    }));

    $('tabMember').addEventListener('click', () => { addingGuest = false; renderDetail(); });
    $('tabGuest').addEventListener('click', () => { addingGuest = true; renderDetail(); });

    $('addGo').addEventListener('click', guard(async () => {
      const payload = {
        tier: $('addTier').value,
        pay_method: $('addMethod').value,
      };
      if (addingGuest) {
        payload.guest_name = $('addName').value.trim();
        payload.host_player_id = $('addHost').value || null;
        if (!payload.guest_name) throw new Error('Give the guest a name');
      } else {
        payload.player_id = $('addPlayer').value;
        if (!payload.player_id) throw new Error('Pick a member');
      }
      await api.addAttendee(openId, payload);
    }));

    root().querySelectorAll('.att-tier').forEach(sel => sel.addEventListener('change',
      guard(() => api.updateAttendee(sel.dataset.id, { tier: sel.value }))));
    root().querySelectorAll('.att-method').forEach(sel => sel.addEventListener('change',
      guard(() => api.updateAttendee(sel.dataset.id, { pay_method: sel.value }))));
    root().querySelectorAll('.att-amt').forEach(inp => inp.addEventListener('change',
      guard(() => api.updateAttendee(inp.dataset.id, { amount_due: Number(inp.value) || 0 }))));
    root().querySelectorAll('.att-paid').forEach(cb => cb.addEventListener('change',
      guard(() => api.setAttendeePaid(cb.dataset.id, cb.checked))));
    root().querySelectorAll('[data-remove]').forEach(btn => btn.addEventListener('click',
      guard(() => api.removeAttendee(btn.dataset.remove))));

    $('evClose')?.addEventListener('click', guard(async () => {
      await api.closeEvent(openId);
      toast('Programme closed');
    }));
  } else {
    $('evReopen')?.addEventListener('click', guard(async () => {
      await api.reopenEvent(openId);
      toast('Reopened');
    }));
  }

  $('evKitty').addEventListener('click', guard(async () => {
    const res = await api.postEventToKitty(openId);
    toast(res.posted ? `Posted ${money(res.posted)} to the kitty as ${res.kind}` : 'Nothing to post — the programme broke even');
  }));

  $('evDelete').addEventListener('click', async () => {
    if (!confirm('Delete this programme? Every charge it made is reversed.')) return;
    try {
      await api.deleteEvent(openId);
      toast('Programme deleted');
      openId = null; cache = null;
      renderList();
    } catch (e) { toast(e.message, true); }
  });
}

// ---- entry points ----------------------------------------------------------

export function initExternalEvents() {
  // The view owns its markup, so there is nothing to wire until it is shown.
}

export function loadExternalEvents() {
  if (!root()) return;
  return openId ? openEvent(openId) : renderList();
}
