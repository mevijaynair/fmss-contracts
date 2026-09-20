// finance.js — the Cashier screen.
//
// Every other money screen in the app is written on the accrual basis: a game
// deducts the pitch the night it is played, so the kitty is profit and loss.
// This screen is the other basis — cash. It answers the two questions the
// person who actually funds the club has to ask, and which nothing here could
// answer before:
//
//   am I up or down?   what is in my hands, and who has a claim on it
//   is it working?     what each contract earns against what it really costs
//
// The numbers are all the server's (server/repos/finance.js). Nothing is
// recomputed here, because a screen that does its own arithmetic is a second
// set of books.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money, fmtDate, today, openModal, closeModal } from '../util.js';

const signed = (n) => (Number(n) > 0 ? '+' : '') + money(n);
const cls = (n, invert = false) => {
  const v = Number(n) || 0;
  if (Math.abs(v) < 0.01) return '';
  return (invert ? v < 0 : v > 0) ? 'good' : 'bad';
};

/** One line of a statement: a label, an amount, and an optional note. */
function line(label, amount, { note = '', strong = false, sign = false } = {}) {
  return `<div class="fin-line${strong ? ' is-total' : ''}">
    <span class="fin-k">${esc(label)}${note ? ` <em>${esc(note)}</em>` : ''}</span>
    <span class="fin-v ${cls(sign ? amount : 0)}">${sign ? signed(amount) : money(amount)}</span>
  </div>`;
}

// ---------------------------------------------------------------------------
// The headline

function renderKpis(s) {
  const owed = s.claims.owed_to_venues;
  $('finKpi').innerHTML = [
    {
      v: money(s.in_hand), l: 'Cash you should be holding',
      // Negative means their own money is in the club, which is the one number
      // a cashier genuinely needs to see going the wrong way.
      cls: s.in_hand >= 0 ? 'good' : 'bad',
    },
    { v: money(owed), l: 'Owed to the venues so far', cls: owed > 0 ? 'warn' : 'good' },
    { v: money(s.claims.kitty), l: 'Club profit (the kitty)', cls: s.claims.kitty >= 0 ? '' : 'bad' },
    { v: money(s.claims.held_for_players), l: 'Held for players' },
    {
      v: signed(s.claims.own_account),
      l: `${s.cashier ? s.cashier.name + '’s' : 'Your'} own account`,
      cls: cls(s.claims.own_account),
    },
  ].map(x => `<div class="kpi ${x.cls || ''}"><div class="v">${x.v}</div>
      <div class="l">${esc(x.l)}</div></div>`).join('');
}

// ---------------------------------------------------------------------------
// Profit and loss, one block per contract

function pnlCard(p) {
  const perGame = p.profit_per_game;
  // The club prices a game to leave 15 in the pot. Saying so beside the figure
  // turns "profit 13.3 a game" from a number into an answer.
  const target = 15;
  const verdict = perGame === null ? ''
    : perGame >= target ? 'is-on'
      : perGame >= 0 ? 'is-thin' : 'is-loss';

  const contracted = p.cost.sessions_priced_from_a_contract > 0
    && p.cost.pitch_contracted !== p.cost.pitch_booked;

  return `<div class="sams-card fin-pnl">
    <div class="card-header">
      <h3 class="card-title">${esc(p.contract_name)}</h3>
      <span class="card-sub">${esc(p.venue)}${p.venue ? ' · ' : ''}${p.games} game${
  p.games === 1 ? '' : 's'} from ${fmtDate(p.from)}</span>
    </div>

    <div class="fin-hero ${verdict}">
      <div class="fin-hero-v">${signed(p.profit)}</div>
      <div class="fin-hero-l">${p.profit >= 0 ? 'profit' : 'loss'} over ${p.games} game${
  p.games === 1 ? '' : 's'}${perGame === null ? ''
    : ` · ${signed(perGame)} a game against the ${target} it is priced for`}</div>
    </div>

    ${line('Charged to balances', p.revenue.from_balances)}
    ${line('Guest cash collected', p.revenue.guest_cash_collected)}
    ${p.revenue.other_income ? line('Other income', p.revenue.other_income) : ''}
    ${line('Money earned', p.revenue.total, { strong: true })}

    ${line('Pitch', p.cost.pitch_booked, { note: 'as the games were booked' })}
    ${line('Water', p.cost.water)}
    ${p.cost.other_expense ? line('Other spending', p.cost.other_expense) : ''}
    ${line('What it cost', p.cost.total_booked, { strong: true })}

    ${contracted ? `<p class="hint fin-note">
      Priced from the venue booking instead, ${p.cost.sessions_priced_from_a_contract}
      of these ${p.games} game${p.games === 1 ? '' : 's'} cost
      ${money(p.cost.pitch_contracted)} rather than ${money(p.cost.pitch_booked)} —
      the real profit is <strong>${signed(p.profit_contracted)}</strong>
      (${signed(p.profit_per_game_contracted)} a game). The games have not been
      repriced; that would move money on nights already shared with the club.</p>` : ''}

    ${p.cost.sessions_priced_from_a_contract === 0 ? `<p class="hint fin-note">
      No venue booking is wired to this contract yet, so the pitch above is the
      ${money(p.games ? p.cost.pitch_booked / p.games : 0)} a night set on Settings rather
      than anything the venue has actually charged. Add the booking below and this
      becomes a real cost.</p>` : ''}

    ${p.not_counted.guest_cash_still_owed || p.not_counted.places_carried_by_the_kitty
    ? `<p class="hint fin-note">Not counted above:
        ${p.not_counted.guest_cash_still_owed
    ? `${money(p.not_counted.guest_cash_still_owed)} of guest cash nobody has handed over yet`
    : ''}${p.not_counted.guest_cash_still_owed && p.not_counted.places_carried_by_the_kitty
    ? '; ' : ''}${p.not_counted.places_carried_by_the_kitty
    ? `${money(p.not_counted.places_carried_by_the_kitty)} of places the kitty carried`
    : ''}.</p>` : ''}

    ${Math.abs(p.drift) >= 0.01 ? `<p class="hint fin-drift">
      This does not agree with the kitty, which says ${money(p.kitty_says)} —
      a difference of ${money(p.drift)}. One of the two is wrong; worth looking at.</p>` : ''}
  </div>`;
}

// ---------------------------------------------------------------------------
// Venue bookings

function venueRow(v) {
  const per = v.cost_per_session;
  const prepaid = v.prepaid;
  return `<div class="fin-venue">
    <div class="fin-venue-head">
      <strong>${esc(v.vendor)}</strong>
      <span class="hint">${esc(v.contract_name)} · from ${fmtDate(v.start_date)}${
  v.end_date ? ` to ${fmtDate(v.end_date)}` : ' — still running'}</span>
      <span class="row-actions">
        <button class="btn btn-sm" data-pay="${esc(v.id)}">Record a payment</button>
        <button class="btn btn-secondary btn-sm" data-vedit="${esc(v.id)}">Edit</button>
        <button class="link-btn" data-vdel="${esc(v.id)}" title="Remove this booking and its payments">✕</button>
      </span>
    </div>
    <div class="fin-venue-grid">
      <div><span class="k">Signed for</span><span class="v">${money(v.amount_total)}</span></div>
      <div><span class="k">Nights bought</span><span class="v">${
  v.sessions_covered === null ? '<span class="hint">open</span>'
    : v.free_sessions
      ? `${v.sessions_covered} <span class="hint">(${v.sessions_total} + ${v.free_sessions} free)</span>`
      : v.sessions_covered}</span></div>
      <div><span class="k">A night costs</span><span class="v">${
  per === null ? '<span class="hint">not fixed</span>'
    : v.free_sessions
      ? `${money(per)} <span class="hint">(${money(v.cost_per_paid_session)} without the free ones)</span>`
      : money(per)}</span></div>
      <div><span class="k">Played so far</span><span class="v">${v.sessions_played}${
  v.sessions_covered === null ? '' : ` of ${v.sessions_covered}`}</span></div>
      <div><span class="k">Paid</span><span class="v">${money(v.paid)}${
  v.outstanding > 0.01 ? ` <span class="hint">(${money(v.outstanding)} still to pay)</span>` : ''}</span></div>
      <div><span class="k">${prepaid === null ? 'Paid vs played' : prepaid >= 0
    ? 'Paid ahead' : 'Behind'}</span><span class="v ${cls(prepaid)}">${
  prepaid === null ? '<span class="hint">—</span>' : money(Math.abs(prepaid))}</span></div>
    </div>
    ${v.variance_per_session !== null && Math.abs(v.variance_per_session) >= 0.01
    ? `<p class="hint fin-note">The games are booked at ${money(v.booked_per_session)} each and
        this contract charges ${money(per)} — ${v.variance_per_session > 0 ? 'the pot is keeping'
    : 'the club is short by'} ${money(Math.abs(v.variance_total))} over the
        ${v.sessions_played} game${v.sessions_played === 1 ? '' : 's'} played so far.
        Change the cost per game on Settings if you want the books to follow the contract.</p>`
    : ''}
    ${v.notes ? `<p class="hint fin-note">${esc(v.notes)}</p>` : ''}
    ${v.payments.length ? `<table class="sams-table fin-pay">
      <thead><tr><th>Paid on</th><th>How</th><th>Note</th><th class="num">Amount</th><th></th></tr></thead>
      <tbody>${v.payments.map(p => `<tr>
        <td>${fmtDate(p.date)}</td><td>${esc(p.method)}</td><td>${esc(p.note)}</td>
        <td class="num">${money(p.amount)}</td>
        <td class="row-actions"><button class="link-btn" data-pdel="${esc(p.id)}">✕</button></td>
      </tr>`).join('')}</tbody></table>`
    : '<p class="hint fin-note">Nothing paid against this booking yet.</p>'}
  </div>`;
}

function editModal(v) {
  openModal(`Edit the ${v.vendor} booking`, `
    <p class="hint">Changing these re-prices what the games cost in the P&amp;L. It does not
      touch a single game, a balance or the kitty — nothing about a booking ever does.</p>
    <div class="form-row mt">
      <div class="form-group"><label for="ve_vendor">Venue</label>
        <input type="text" id="ve_vendor" value="${esc(v.vendor)}"></div>
      <div class="form-group"><label for="ve_amount">Total paid for (AED)</label>
        <input type="number" id="ve_amount" step="0.01" value="${v.amount_total}"></div>
    </div>
    <div class="form-row mt">
      <div class="form-group"><label for="ve_start">From</label>
        <input type="date" id="ve_start" value="${esc(v.start_date)}"></div>
      <div class="form-group"><label for="ve_end">To (blank = still running)</label>
        <input type="date" id="ve_end" value="${esc(v.end_date || '')}"></div>
    </div>
    <div class="form-row mt">
      <div class="form-group"><label for="ve_sessions">Nights paid for</label>
        <input type="number" id="ve_sessions" step="1" min="0" value="${v.sessions_total ?? ''}"></div>
      <div class="form-group"><label for="ve_free">Nights thrown in free</label>
        <input type="number" id="ve_free" step="1" min="0" value="${v.free_sessions || 0}"></div>
    </div>
    <div class="form-group full mt"><label for="ve_notes">Note</label>
      <input type="text" id="ve_notes" value="${esc(v.notes || '')}" placeholder="e.g. invoice 0012-00045405"></div>
    <button class="btn full-w mt" id="ve_save">Save</button>`);

  $('ve_save').addEventListener('click', async () => {
    try {
      await api.updateVenueContract(v.id, {
        vendor: $('ve_vendor').value,
        amount_total: Number($('ve_amount').value || 0),
        start_date: $('ve_start').value,
        end_date: $('ve_end').value || null,
        sessions_total: $('ve_sessions').value === '' ? null : Number($('ve_sessions').value),
        free_sessions: Number($('ve_free').value || 0),
        notes: $('ve_notes').value,
      });
      closeModal();
      toast('Saved');
      load();
    } catch (e) { toast(e.message, true); }
  });
}

function paymentModal(venue) {
  openModal(`Pay ${venue.vendor}`, `
    <p class="hint">Money leaving your hands. It does not touch the kitty — the pitch is
      already charged to the pot once a game, and booking it twice would make the club
      look poorer than it is.</p>
    <div class="form-row mt">
      <div class="form-group"><label for="vp_amount">Amount (AED)</label>
        <input type="number" id="vp_amount" step="0.01" value="${venue.outstanding > 0
    ? venue.outstanding : ''}"></div>
      <div class="form-group"><label for="vp_date">Date</label>
        <input type="date" id="vp_date" value="${today()}"></div>
    </div>
    <div class="form-row mt">
      <div class="form-group"><label for="vp_method">How</label>
        <select id="vp_method">
          <option value="bank">Bank transfer</option>
          <option value="card">Card</option>
          <option value="cash">Cash</option>
          <option value="cheque">Cheque</option>
        </select></div>
      <div class="form-group"><label for="vp_note">Note</label>
        <input type="text" id="vp_note" placeholder="e.g. first instalment"></div>
    </div>
    <button class="btn full-w mt" id="vp_save">Record it</button>`);

  $('vp_save').addEventListener('click', async () => {
    const amount = Number($('vp_amount').value || 0);
    if (!(amount > 0)) { toast('Enter an amount', true); return; }
    try {
      await api.addVenuePayment(venue.id, {
        amount, date: $('vp_date').value || today(),
        method: $('vp_method').value, note: $('vp_note').value,
      });
      closeModal();
      toast(`Recorded ${money(amount)} to ${venue.vendor}`);
      load();
    } catch (e) { toast(e.message, true); }
  });
}

// ---------------------------------------------------------------------------
// The cash statement

function renderStatement(s) {
  const c = s.claims;
  $('finStatement').innerHTML = `
    <div class="fin-cols">
      <div class="fin-col">
        <div class="fin-col-title">Where the cash came from</div>
        ${line('Held when tracking began', s.opening.total,
    { note: `${money(s.opening.player_credit)} of player credit, ${money(s.opening.kitty)} in the pot` })}
        ${line('Top-ups from players', s.money_in.top_ups)}
        ${line('Guest cash collected', s.money_in.guest_cash_collected)}
        ${s.money_in.programme_cash ? line('Programme cash', s.money_in.programme_cash) : ''}
        ${s.money_in.other ? line('Other money in', s.money_in.other) : ''}
        ${line('Paid to the venues', -s.money_out.paid_to_venues)}
        ${line('Water for games', -s.money_out.water)}
        ${s.money_out.programmes_you_paid_for
    ? line('Programmes you paid for', -s.money_out.programmes_you_paid_for) : ''}
        ${s.money_out.other ? line('Other money out', -s.money_out.other) : ''}
        ${line('You should be holding', s.in_hand, { strong: true })}
      </div>
      <div class="fin-col">
        <div class="fin-col-title">Who has a claim on it</div>
        ${line('Players’ unspent credit', c.held_for_players)}
        ${line('Less what players owe you', -c.owed_by_players)}
        ${line('Your own games, not paid in', c.own_account,
    { note: 'you are blocked from contributing, so this only falls' })}
        ${line('The club’s profit', c.kitty)}
        ${line('Owed to the venues for games played', c.owed_to_venues)}
        ${line('Adds back to', c.total, { strong: true })}
      </div>
    </div>
    ${Math.abs(s.drift) >= 0.01
    ? `<p class="hint fin-drift">The two sides differ by ${money(s.drift)}. They are built
        from different tables by different routes, so this is money the books cannot
        account for — an adjustment or an event deduction that moved a balance without
        cash moving. Worth finding.</p>`
    : '<p class="hint fin-note">The two sides agree exactly, so every dirham in hand is accounted for.</p>'}
    <div class="fin-cols mt">
      ${s.per_contract.map(r => `<div class="fin-col">
        <div class="fin-col-title">${esc(r.contract_name)}${r.venue ? ` · ${esc(r.venue)}` : ''}</div>
        ${line('Pitch used so far', r.pitch_accrued)}
        ${line('Paid to the venue', r.paid_to_venue)}
        ${line(r.owed_to_venue >= 0 ? 'Still to pay them' : 'Paid ahead',
    Math.abs(r.owed_to_venue), { strong: true })}
        ${r.has_booking ? '' : '<p class="hint">No booking entered yet — the pitch cost here '
      + 'is the figure on Settings, not a contract.</p>'}
      </div>`).join('')}
    </div>`;
}

// ---------------------------------------------------------------------------

async function load() {
  const kpi = $('finKpi');
  if (!kpi) return;
  kpi.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const [statement, pnl, venues] = await Promise.all([
      api.cashierStatement(), api.pnl(), api.venueContracts(),
    ]);

    renderKpis(statement);
    $('finPnl').innerHTML = pnl.contracts.map(pnlCard).join('');
    $('finVenues').innerHTML = venues.length
      ? venues.map(venueRow).join('')
      : `<div class="empty-state"><div class="es-icon">🧾</div>
          <div class="es-title">No venue bookings yet</div>
          <div class="es-sub">Add the O365 deal below and the profit on Mon/Thu stops being
            a guess at what a pitch costs.</div></div>`;
    renderStatement(statement);

    const byId = new Map(venues.map(v => [v.id, v]));
    $('finVenues').querySelectorAll('[data-pay]').forEach(b =>
      b.addEventListener('click', () => paymentModal(byId.get(b.dataset.pay))));
    $('finVenues').querySelectorAll('[data-vedit]').forEach(b =>
      b.addEventListener('click', () => editModal(byId.get(b.dataset.vedit))));
    $('finVenues').querySelectorAll('[data-vdel]').forEach(b =>
      b.addEventListener('click', async () => {
        const v = byId.get(b.dataset.vdel);
        if (!confirm(`Remove the ${v.vendor} booking and its ${v.payments.length} payment(s)?`
          + '\n\nBalances and the kitty are not affected — a booking has never touched them.')) return;
        try { await api.deleteVenueContract(v.id); toast('Removed'); load(); }
        catch (e) { toast(e.message, true); }
      }));
    $('finVenues').querySelectorAll('[data-pdel]').forEach(b =>
      b.addEventListener('click', async () => {
        if (!confirm('Remove this payment?')) return;
        try { await api.deleteVenuePayment(b.dataset.pdel); toast('Removed'); load(); }
        catch (e) { toast(e.message, true); }
      }));
  } catch (e) {
    kpi.innerHTML = `<p class="hint">${esc(e.message)}</p>`;
  }
}

export function initFinance() {
  const form = $('finVenueForm');
  if (!form) return;
  $('vf_contract').innerHTML = (store.contracts || [])
    .map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  $('vf_start').value = today();

  // The venue's name is nearly always the one already on the contract, so it is
  // filled in rather than asked for — and still editable, because a club can
  // change where it plays without changing the contract it sells to players.
  const fillVendor = () => {
    const c = (store.contracts || []).find(x => x.id === $('vf_contract').value);
    if (c && !$('vf_vendor').dataset.touched) $('vf_vendor').value = c.venue || '';
  };
  $('vf_contract').addEventListener('change', fillVendor);
  $('vf_vendor').addEventListener('input', () => { $('vf_vendor').dataset.touched = '1'; });
  fillVendor();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.createVenueContract({
        contract_id: $('vf_contract').value,
        vendor: $('vf_vendor').value,
        start_date: $('vf_start').value,
        end_date: $('vf_end').value || null,
        sessions_total: $('vf_sessions').value === '' ? null : Number($('vf_sessions').value),
        free_sessions: Number($('vf_free').value || 0),
        amount_total: Number($('vf_amount').value || 0),
      });
      toast('Booking added ✓');
      $('vf_amount').value = ''; $('vf_sessions').value = ''; $('vf_end').value = '';
      load();
    } catch (err) { toast(err.message, true); }
  });
}

export function loadFinance() { return load(); }
