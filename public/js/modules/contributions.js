// contributions.js — role-aware contributions view.
//  • Admin: direct "Add Contribution" + a Pending Approvals queue + full log.
//  • Player: self-service "Submit Contribution" (→ pending) + their own history.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money, balCell, fmtDate, today, rosterOptions, viewEl } from '../util.js';

function contractName(id) {
  return store.contracts.find(c => c.id === id)?.name.split(' ')[0] || (id || '—');
}

function isPlayer() { return store.user?.role === 'player'; }

/**
 * Ties a split row back to the payment it came from. Without this a 1500 bank
 * transfer shows up as an unrelated 1000 and 500, and reconciling the statement
 * means remembering they were once one line.
 */
export function splitNote(c) {
  if (!c.split_group || !c.split_total) return '';
  return ` <span class="split-note" data-split-group="${esc(c.split_group)}"
    title="One payment of ${money(c.split_total)} divided across ${c.split_parts} contracts. Click to see the other part${c.split_parts === 2 ? '' : 's'}.">
    ${money(c.amount)} of ${money(c.split_total)} split ${c.split_parts} ways</span>`;
}

/** Show the other legs of the payment, so a bank line can be reconciled whole. */
export async function wireSplitNotes(root) {
  root.querySelectorAll('[data-split-group]').forEach(el => {
    el.addEventListener('click', async () => {
      try {
        const parts = await api.splitSiblings(el.dataset.splitGroup);
        const total = parts.reduce((s, p) => s + p.amount, 0);
        toast(`${money(total)} on ${parts[0]?.date}: ${
          parts.map(p => `${money(p.amount)} to ${p.contract_name || p.contract_id}`).join(' + ')}`);
      } catch (e) { toast(e.message, true); }
    });
  });
}

// ---------------------------------------------------------------- ADMIN view

function fillSelects() {
  // A contribution tops up a contract balance, which is not a thing a guest has,
  // so guests are left out of the picker rather than sitting among the squad.
  const payable = rosterOptions(
    store.players.filter(p => p.special_role !== 'cashier'), '', { includeGuests: false });
  const everyone = rosterOptions(store.players);
  $('cf_player').innerHTML = '<option value="">— unassigned —</option>' + payable;
  $('cf_contract').innerHTML = store.contracts.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('contribFilter').innerHTML = '<option value="">All players</option>' + everyone;
}

async function renderLog() {
  const rows = await api.contributions(
    $('contribFilter').value ? { player_id: $('contribFilter').value } : {});
  $('contribTable').querySelector('tbody').innerHTML = rows.slice(0, 400).map(c => `
    <tr style="${c.historical ? 'opacity: 0.65; background-color: var(--bg-subtle);' : ''}">
      <td class="num">${esc(fmtDate(c.date))}</td>
      <td>${esc(c.player_name || c.name_raw || '—')}</td>
      <td>${esc(contractName(c.contract_id))}</td>
      <td class="num">${balCell(c.amount)}</td>
      <td>${esc(c.comments || '')}${splitNote(c)}</td>
      <td class="row-actions">${c.historical ? '<span class="tag" style="background: var(--bg-subtle); color: var(--text-muted);" title="Came in with the opening balances — already counted there, so it cannot be edited or removed">📋 Imported</span>'
        : `<button class="link-btn" data-del="${c.id}">✕</button>`}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="hint">No contributions.</td></tr>';

  wireSplitNotes($('contribTable'));

  $('contribTable').querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', async () => {
      try { await api.deleteContribution(b.dataset.del); toast('Removed'); renderLog(); }
      catch (e) { toast(e.message, true); }
    }));
}

// Pending approvals queue (admin only). Injected above the log card.
async function renderPendingApprovals() {
  let card = $('pendingApprovalsCard');
  if (!card) {
    card = document.createElement('div');
    card.className = 'sams-card';
    card.id = 'pendingApprovalsCard';
    const view = viewEl('contributions');
    view.insertBefore(card, view.children[1]);  // after the Add form, before the log
  }

  const pending = await api.pendingContributions();

  // If no pending, hide the card entirely
  if (pending.length === 0) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  card.innerHTML = `
    <div class="card-header"><h3 class="card-title">Pending approvals</h3>
      <span class="card-sub">${pending.length} awaiting review</span></div>
    <div style="overflow-x:auto;">
      <table class="sams-table">
        <thead><tr><th>Date</th><th>Player</th><th>Contract</th><th class="num">Amount</th><th>Method</th><th></th></tr></thead>
        <tbody>${pending.map(p => `
          <tr>
            <td class="num">${esc(fmtDate(p.date))}</td>
            <td>${esc(p.player_name || '—')}</td>
            <td>${esc(contractName(p.contract_id))}</td>
            <td class="num">${money(p.amount)}</td>
            <td><span class="tag">${esc(p.payment_method)}</span></td>
            <td class="row-actions" style="white-space:nowrap;">
              <button class="btn btn-sm" data-approve="${p.id}">✓ Approve</button>
              <button class="btn btn-secondary btn-sm" data-reject="${p.id}">✕ Reject</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  card.querySelectorAll('[data-approve]').forEach(b =>
    b.addEventListener('click', async () => {
      try { await api.approveContribution(b.dataset.approve); toast('Approved ✓'); refreshAdmin(); }
      catch (e) { toast(e.message, true); }
    }));
  card.querySelectorAll('[data-reject]').forEach(b =>
    b.addEventListener('click', async () => {
      try { await api.rejectContribution(b.dataset.reject); toast('Rejected'); refreshAdmin(); }
      catch (e) { toast(e.message, true); }
    }));
}

function refreshAdmin() { renderPendingApprovals(); renderLog(); }

function initAdmin() {
  $('cf_date').value = today();

  // The split panel builds itself once a player and an amount are both known.
  const contribForm = $('contribForm');
  const panel = document.createElement('div');
  panel.id = 'splitAllocationDiv';
  panel.className = 'alloc-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="alloc-head">
      <strong>Where this goes</strong>
      <button type="button" class="link-btn" id="splitReset">Reset to suggestion</button>
    </div>
    <p class="hint" id="splitWhy"></p>
    <div id="splitRows"></div>
    <p class="hint" id="splitSum"></p>`;
  contribForm.insertBefore(panel, contribForm.querySelector('button[type="submit"]'));

  $('splitReset').addEventListener('click', () => drawSplit(lastSuggestion, true));
  $('cf_player').addEventListener('change', askForSuggestion);
  $('cf_amount').addEventListener('input', askForSuggestion);

  $('contribForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const playerId = $('cf_player').value || null;
    const totalAmount = Number($('cf_amount').value) || 0;
    const date = $('cf_date').value;
    const comments = $('cf_comments').value;

    // Check if split is active
    const splitDiv = document.getElementById('splitAllocationDiv');
    const usingSplit = splitDiv && !splitDiv.hidden;

    if (usingSplit) {
      try {
        // Each split is a row DIV wrapping the select and the amount. This used
        // to select the SELECTS and then look for a [data-split-contract]
        // *inside* each one, which is never there — so .value threw on a null,
        // outside the try, and the submit died without saving anything or
        // saying why. A split payment simply appeared to do nothing.
        const splits = Array.from(document.querySelectorAll('#splitRows > div'))
          .map(row => ({
            contract_id: row.querySelector('[data-split-contract]')?.value || '',
            amount: Number(row.querySelector('[data-split-amount]')?.value) || 0,
          }))
          .filter(s => s.contract_id && s.amount > 0);

        if (!splits.length) {
          toast('Put an amount against at least one contract', true);
          return;
        }
        const splitTotal = splits.reduce((s, x) => s + x.amount, 0);
        if (Math.abs(splitTotal - totalAmount) > 0.01) {
          toast(`Split adds up to ${splitTotal}, but the payment is ${totalAmount}`, true);
          return;
        }

        // One id shared by every leg, so the rows stay provably the same bank
        // payment. The relationship is data now, not a phrase in a comment that
        // an edit could lose — and the comment stays the user's own words.
        //
        // A "split" of one leg is not a split: the panel proposes both nights
        // and the cashier is free to zero one of them, and calling the result
        // "1 of 300 split 1 way" everywhere it is read would be noise.
        const group = splits.length > 1
          ? `sp_${Date.now()}_${Math.random().toString(16).slice(2, 8)}` : null;
        for (const split of splits) {
          await api.createContribution({
            player_id: playerId,
            contract_id: split.contract_id,
            amount: split.amount,
            date, comments, split_group: group,
          });
        }
        toast(splits.length > 1
          ? `${money(totalAmount)} split across ${splits.length} contracts ✓`
          : 'Contribution added ✓');
        $('cf_amount').value = ''; $('cf_comments').value = '';
        askForSuggestion();
        renderLog();
      } catch (err) { toast(err.message, true); }
    } else {
      try {
        await api.createContribution({
          player_id: playerId,
          contract_id: $('cf_contract').value,
          amount: totalAmount,
          date, comments,
        });
        toast('Contribution added ✓');
        $('cf_amount').value = ''; $('cf_comments').value = '';
        renderLog();
      } catch (err) { toast(err.message, true); }
    }
  });
  $('contribFilter').addEventListener('change', renderLog);
}

// ---- where a payment should go ------------------------------------------
//
// Somebody hands over 300 in a car park. Working out where it is needed meant
// opening two ledgers, and the split form that existed offered two blank boxes
// and no opinion — so in practice everything went on one contract and the
// other night stayed in the red.
//
// The server proposes (see contributions.suggestSplit: what is owed first,
// then in proportion to how often they actually play each night) and this
// draws it with every figure editable. It is a suggestion in the real sense —
// the person paying sometimes says what the money is for, and that beats any
// rule.

let lastSuggestion = null;
let suggestKey = '';
let suggestTimer = null;

/** Ask the server where this payment should go, once the inputs settle. */
function askForSuggestion() {
  const playerId = $('cf_player').value;
  const amount = Math.round(Number($('cf_amount').value) || 0);
  const key = `${playerId}|${amount}`;
  if (key === suggestKey) return;
  suggestKey = key;

  clearTimeout(suggestTimer);
  if (!playerId || amount <= 0) { drawSplit(null); return; }
  // Typing "300" fires three times; only the number they stopped on matters.
  suggestTimer = setTimeout(async () => {
    try {
      const s = await api.suggestSplit(playerId, amount);
      if (suggestKey !== key) return;          // they carried on typing
      lastSuggestion = s;
      drawSplit(s, true);
    } catch (e) { toast(e.message, true); }
  }, 250);
}

/**
 * Draw the panel. `fresh` fills the boxes from the suggestion; without it the
 * numbers already typed are left alone and only the workings are redrawn.
 */
function drawSplit(s, fresh = false) {
  const panel = document.getElementById('splitAllocationDiv');
  const rows = document.getElementById('splitRows');
  if (!panel || !rows) return;

  if (!s || s.refused || !s.lines.length) {
    panel.hidden = true;
    $('cf_contract').disabled = false;
    if (s && s.refused) toast(s.refused, true);
    return;
  }

  // One contract in play: no panel at all, just point the contract picker at
  // it. A split form offering one row is a question with one answer.
  if (s.lines.length === 1) {
    panel.hidden = true;
    $('cf_contract').value = s.lines[0].contract_id;
    $('cf_contract').disabled = false;
    return;
  }

  panel.hidden = false;
  // Two answers to "which contract" on one form is one too many: while the
  // split is open, the picker above it decides nothing.
  $('cf_contract').disabled = true;
  document.getElementById('splitWhy').textContent = s.headline;

  if (fresh) {
    rows.innerHTML = s.lines.map(l => `
      <div class="alloc-row" data-balance="${l.balance}" data-cost="${l.cost_per_game}">
        <input type="hidden" data-split-contract value="${esc(l.contract_id)}">
        <div class="alloc-name">
          <strong>${esc(l.contract_name)}</strong>
          <span class="hint" data-split-why>${esc(l.why)}</span>
        </div>
        <div class="alloc-now">
          <span class="hint">now</span> ${balCell(l.balance)}
        </div>
        <input type="number" data-split-amount step="1" class="alloc-amt"
          value="${l.suggested}" aria-label="Amount for ${esc(l.contract_name)}">
      </div>`).join('');
    rows.querySelectorAll('[data-split-amount]').forEach(el =>
      el.addEventListener('input', updateSplitTotal));
  }
  updateSplitTotal();
}

/**
 * Keep the workings honest while the cashier edits.
 *
 * The consequence of a number is what makes it checkable — "covers 4 more
 * games" is the thing being decided, not the 108. Recomputed here rather than
 * re-asked of the server so it keeps up with typing.
 */
function updateSplitTotal() {
  const formAmount = Math.round(Number($('cf_amount').value) || 0);
  let total = 0;

  document.querySelectorAll('#splitRows .alloc-row').forEach((row) => {
    const put = Math.round(Number(row.querySelector('[data-split-amount]').value) || 0);
    total += put;
    const balance = Number(row.dataset.balance) || 0;
    const cost = Number(row.dataset.cost) || 0;
    const after = balance + put;
    const why = row.querySelector('[data-split-why]');
    if (!why) return;
    const games = cost > 0 ? Math.floor(after / cost) : null;
    why.textContent = after < 0
      ? `still ${money(-after)} short`
      : games === null ? `leaves ${money(after)}`
        : `leaves ${money(after)} — covers ${games} more game${games === 1 ? '' : 's'}`;
  });

  const sum = document.getElementById('splitSum');
  if (!sum) return;
  const gap = formAmount - total;
  sum.textContent = gap === 0
    ? `${money(total)} of ${money(formAmount)} allocated.`
    : gap > 0 ? `${money(gap)} not allocated yet — the total must match ${money(formAmount)}.`
      : `${money(-gap)} over — the total must match ${money(formAmount)}.`;
  sum.classList.toggle('rep-out', gap !== 0);
}


// --------------------------------------------------------------- PLAYER view

let playerInited = false;

function rebuildPlayerUI() {
  const view = viewEl('contributions');
  view.innerHTML = `
    <div class="sams-card">
      <div class="card-header"><h3 class="card-title">Submit a contribution</h3>
        <span class="card-sub">Your submission is reviewed by the cashier before it lands on your balance</span></div>
      <form id="myContribForm">
        <div class="form-row">
          <div class="form-group"><label>Contract</label><select id="mcf_contract"></select></div>
          <div class="form-group"><label>Amount (AED)</label><input type="number" id="mcf_amount" step="1" placeholder="300"></div>
        </div>
        <div class="form-row mt">
          <div class="form-group"><label>Payment method</label>
            <select id="mcf_method">
              <option value="cash">Cash</option>
              <option value="bank">Bank deposit</option>
              <option value="transfer">Bank transfer</option>
            </select></div>
          <div class="form-group"><label>Date paid</label><input type="date" id="mcf_date"></div>
        </div>
        <button type="submit" class="btn mt">Submit for approval</button>
      </form>
    </div>
    <div class="sams-card">
      <div class="card-header"><h3 class="card-title">My contributions</h3>
        <span class="card-sub">Pending submissions + approved payments</span></div>
      <div style="overflow-x:auto;">
        <table class="sams-table" id="myContribTable">
          <thead><tr><th>Date</th><th>Contract</th><th class="num">Amount</th><th>Method</th><th>Status</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>`;

  $('mcf_contract').innerHTML = store.contracts.map(c =>
    `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('mcf_date').value = today();

  $('myContribForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = Number($('mcf_amount').value) || 0;
    if (amount <= 0) { toast('Enter a positive amount', true); return; }
    try {
      await api.submitContribution({
        contract_id: $('mcf_contract').value,
        amount,
        payment_method: $('mcf_method').value,
        date: $('mcf_date').value,
      });
      toast('Submitted for approval ✓');
      $('mcf_amount').value = '';
      renderMyContributions();
    } catch (err) { toast(err.message, true); }
  });
}

const STATUS_TAG = {
  pending: '<span class="tag tag-due">⏳ Pending</span>',
  rejected: '<span class="tag tag-overdue">✕ Rejected</span>',
  approved: '<span class="tag tag-paid">✓ Approved</span>',
};

async function renderMyContributions() {
  const { approved, pending } = await api.myContributions();

  // Merge: pending/rejected submissions + approved live rows. Approved live rows
  // come from the contributions table; the matching pending row is also marked
  // approved, so to avoid double-listing we show pending(non-approved) + approved.
  const pendingRows = pending
    .filter(p => p.status !== 'approved')
    .map(p => ({
      date: p.date, contract_id: p.contract_id, amount: p.amount,
      method: p.payment_method, status: p.status,
    }));
  const approvedRows = approved.map(c => ({
    date: c.date, contract_id: c.contract_id, amount: c.amount,
    method: '—', status: 'approved',
  }));

  const all = [...pendingRows, ...approvedRows]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  $('myContribTable').querySelector('tbody').innerHTML = all.map(rw => `
    <tr>
      <td class="num">${esc(fmtDate(rw.date))}</td>
      <td>${esc(contractName(rw.contract_id))}</td>
      <td class="num">${money(rw.amount)}</td>
      <td>${rw.method === '—' ? '—' : `<span class="tag">${esc(rw.method)}</span>`}</td>
      <td>${STATUS_TAG[rw.status] || esc(rw.status)}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="hint">No contributions yet.</td></tr>';
}

// ------------------------------------------------------------------- exports

// --- money that moves without a game ----------------------------------------
//
// Paying somebody out of the pot, paying into it, or moving credit between two
// players. All three used to be faked with a contribution on one side and a
// hand-typed kitty entry on the other, with nothing tying the halves together —
// so a half-finished move invented or destroyed money silently.

const KITTY = 'kitty';

// The kitty is one pot with a share per contract, so each share is its own
// party. That is what makes "the Mon/Thu kitty covers a Saturday drop-in" a
// thing you can actually record: money leaves one share, lands in the other,
// and the club's total is unchanged.
function moveOptions() {
  const pots = [{ id: KITTY, name: '— Kitty: club-wide —' },
    ...(store.contracts || []).map(c => ({ id: `${KITTY}:${c.id}`, name: `— Kitty: ${c.name} —` }))];
  return pots.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')
    + rosterOptions(store.players);
}

function fillMoveSelects() {
  const opts = moveOptions();
  const from = $('mv_from'); const to = $('mv_to');
  if (!from || !to) return;
  from.innerHTML = opts;
  to.innerHTML = opts;
  from.value = KITTY;
  $('mv_contract').innerHTML = '<option value="">No contract — club money</option>'
    + (store.contracts || []).map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  if (!$('mv_date').value) $('mv_date').value = today();
  describeMove();
}

// Say what naming a contract will and will not do, because the two cases look
// identical on the form and behave completely differently.
function describeMove() {
  const note = $('mv_contract_note');
  if (!note) return;
  const isKitty = (v) => v === KITTY || String(v).startsWith(`${KITTY}:`);
  const from = $('mv_from')?.value; const to = $('mv_to')?.value;
  const field = $('mv_contract');

  if (isKitty(from) && isKitty(to)) {
    note.textContent = 'Not used — both ends are the kitty, so no balance moves. '
      + "The club's total is unchanged; the cost just sits where it belongs.";
    if (field) field.disabled = true;
    return;
  }
  if (field) field.disabled = false;
  note.textContent = !isKitty(from) && !isKitty(to)
    ? 'Required — a balance belongs to a contract.'
    : 'Leave blank to move real club money without touching any balance, '
      + "e.g. paying yourself back for something you bought. Name one and the player's balance moves too.";
}

async function renderMovements() {
  const host = $('mvLog');
  if (!host) return;
  let rows = [];
  try { rows = await api.movements(); } catch { host.innerHTML = ''; return; }
  if (!rows.length) { host.innerHTML = '<p class="hint">Nothing moved yet.</p>'; return; }
  host.innerHTML = `
    <table class="sams-table">
      <thead><tr><th>Date</th><th>From</th><th>To</th><th class="num">Amount</th><th>What for</th><th></th></tr></thead>
      <tbody>${rows.map(m => `
        <tr>
          <td>${esc(fmtDate(m.date))}</td>
          <td>${esc(m.from_name)}</td>
          <td>${esc(m.to_name)}</td>
          <td class="num"><strong>${money(m.amount)}</strong></td>
          <td>${esc(m.note || '—')}${m.contract_id
    ? ` <span class="hint">(${esc(m.contract_id)})</span>`
    : ' <span class="hint">(club money)</span>'}</td>
          <td class="row-actions"><button class="link-btn" data-mv-del="${esc(m.id)}"
            title="Undo this movement — both sides">✕</button></td>
        </tr>`).join('')}</tbody>
    </table>`;

  host.querySelectorAll('[data-mv-del]').forEach(b =>
    b.addEventListener('click', async () => {
      if (!confirm('Undo this movement? Both sides of it are reversed.')) return;
      try {
        await api.deleteMovement(b.dataset.mvDel);
        toast('Movement undone');
        renderMovements();
      } catch (e) { toast(e.message, true); }
    }));
}

function initMoveMoney() {
  const form = $('moveForm');
  if (!form) return;
  ['mv_from', 'mv_to'].forEach(id => $(id)?.addEventListener('change', describeMove));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.createMovement({
        from: $('mv_from').value,
        to: $('mv_to').value,
        amount: Number($('mv_amount').value),
        contract_id: $('mv_contract').value || null,
        date: $('mv_date').value || today(),
        note: $('mv_note').value.trim(),
      });
      toast('Moved ✓');
      $('mv_amount').value = ''; $('mv_note').value = '';
      renderMovements();
    } catch (err) { toast(err.message, true); }
  });
}

export function initContributions() {
  if (isPlayer()) return;   // player UI is built lazily on first load
  initAdmin();
  initMoveMoney();
}

export function loadContributions() {
  if (isPlayer()) {
    if (!playerInited) { rebuildPlayerUI(); playerInited = true; }
    return renderMyContributions();
  }
  fillSelects();
  fillMoveSelects();
  return Promise.all([renderPendingApprovals(), renderLog(), renderMovements()]);
}
