// contributions.js — role-aware contributions view.
//  • Admin: direct "Add Contribution" + a Pending Approvals queue + full log.
//  • Player: self-service "Submit Contribution" (→ pending) + their own history.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money, balCell, fmtDate, today, rosterOptions, viewEl,
  openModal, closeModal } from '../util.js';
import { allocRowsHtml, allocRowHtml, refreshAllocs, readAllocs,
  splitGroupFor } from './split_panel.js';

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
  // "600 of 1,000 split 2 ways" never said what it was split ACROSS, and
  // sitting above a row reading "Shone 43 from Abhi" it read as split between
  // two people. It is contracts, and the useful half of the answer is which
  // one the rest went to — the row already shows this part's own amount.
  const peers = (c.split_peers || [])
    .map(p => `${money(p.amount)} to ${esc(p.contract_name)}`).join(', ');
  const where = peers ? ` — ${peers}` : ` split ${c.split_parts} ways`;
  return ` <span class="split-note" data-split-group="${esc(c.split_group)}"
    title="One payment of ${money(c.split_total)}, divided across ${c.split_parts} contracts. Click for the whole breakdown.">
    part of ${money(c.split_total)}${where}</span>`;
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

/**
 * The two names a movement has.
 *
 * A payment comes from the person whose name is on the row. A movement does
 * not: money that landed on Rojy came off Joe, and a row saying only "Rojy
 * +100" reads as money from nowhere. The row's own player is first, because
 * that is whose balance the amount belongs to, and the arrow says which way it
 * went.
 */
function movementWho(c) {
  const arrow = c.direction === 'out' ? '→' : '←';
  return `${esc(c.player_name || '—')} <span class="mv-other">${arrow} ${
    esc(c.counterparty || '—')}</span>`;
}

async function renderLog() {
  const rows = await api.contributions(
    $('contribFilter').value ? { player_id: $('contribFilter').value } : {});
  $('contribTable').querySelector('tbody').innerHTML = rows.slice(0, 400).map(c => {
    const moved = c.kind === 'movement';
    return `
    <tr style="${c.historical ? 'opacity: 0.65; background-color: var(--bg-subtle);' : ''}">
      <td class="num">${esc(fmtDate(c.date))}</td>
      <td>${moved ? movementWho(c) : `${esc(c.player_name || c.name_raw || '—')}${
  // Whose hand it came out of, where that is not whose balance it landed
  // on. This used to live in the comment as prose — "Nihas 75 from Abhi".
  c.paid_by_name
    ? ` <span class="mv-other" title="Handed over by ${esc(c.paid_by_name)}">← ${
      esc(c.paid_by_name)}</span>` : ''}`}</td>
      <td>${esc(contractName(c.contract_id))}</td>
      <td class="num">${balCell(c.amount)}</td>
      <td>${moved
    ? `<span class="tag tag-moved" title="Not a payment into the club — money moved between two balances, recorded in Move money above">⇄ Moved</span> ${esc(c.comments || '')}`
    : `${esc(c.comments || '')}${splitNote(c)}`}</td>
      <td class="row-actions">${c.historical ? '<span class="tag" style="background: var(--bg-subtle); color: var(--text-muted);" title="Came in with the opening balances — already counted there, so it cannot be edited or removed">📋 Imported</span>'
    : moved
      ? `<button class="link-btn" data-mv-undo="${esc(c.movement_id)}"
             title="Undo the whole movement — both sides of it">✕</button>`
      : `<button class="link-btn" data-edit="${c.id}"
             title="Change the note or the date. The amount is not editable here — see the note in the box.">✎</button>
           <button class="link-btn" data-del="${c.id}">✕</button>`}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="hint">No contributions.</td></tr>';

  wireSplitNotes($('contribTable'));

  $('contribTable').querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', () => removeContributionModal(
      rows.find(r => r.id === b.dataset.del))));

  // The same undo as the Move money list above. A movement has two halves and
  // the log shows both, so the confirmation says what the single ✕ does to the
  // other one.
  $('contribTable').querySelectorAll('[data-mv-undo]').forEach(b =>
    b.addEventListener('click', async () => {
      if (!confirm('Undo this movement? Both balances it touched go back as they were.')) return;
      try {
        await api.deleteMovement(b.dataset.mvUndo);
        toast('Movement undone');
        ledgerCache.clear();
        renderLog();
        renderMovements();
      } catch (e) { toast(e.message, true); }
    }));

  $('contribTable').querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', () => editContributionModal(
      rows.find(r => r.id === b.dataset.edit))));
}

/**
 * Taking a payment off somebody's balance, with something in the way.
 *
 * This was a bare ✕ that deleted on the first click. A payment is the one
 * entry a player disputes, and the mis-click costs real money off a real
 * balance with nothing left on screen to say it ever existed.
 *
 * Three things stand in the way now: the figures are shown back, the balance
 * it lands on is worked out before anything happens, and a reason is typed.
 * The reason is not bureaucracy — it is the answer to the question a
 * restored payment always raises, and this is the only moment anybody knows
 * it.
 */
function removeContributionModal(c) {
  if (!c) { toast('That payment is no longer on the list', true); return; }
  if (c.historical) { toast('An imported payment cannot be removed', true); return; }
  openModal('Remove this payment?', `
    <div class="kv"><span class="k">Player</span>
      <span class="v">${esc(c.player_name || c.name_raw || '—')}</span></div>
    <div class="kv"><span class="k">Contract</span>
      <span class="v">${esc(contractName(c.contract_id))}</span></div>
    <div class="kv"><span class="k">Amount</span><span class="v">${money(c.amount)}</span></div>
    <div class="kv"><span class="k">Dated</span><span class="v">${esc(fmtDate(c.date))}</span></div>
    ${c.split_group ? `<p class="hint mt">This is one part of a payment of ${
    money(c.split_total)}. The other part${c.split_parts === 2 ? '' : 's'} stay${
    c.split_parts === 2 ? 's' : ''} where ${c.split_parts === 2 ? 'it is' : 'they are'} —
      remove ${c.split_parts === 2 ? 'it' : 'them'} separately if the whole payment is wrong.</p>` : ''}
    <p class="hint mt">Their ${esc(contractName(c.contract_id))} balance goes down by
      <strong>${money(c.amount)}</strong>. Nothing is destroyed: it moves to the removed
      list below the log, and can be put back from there.</p>
    <div class="form-group mt"><label for="rm_why">Why is it being removed?</label>
      <input type="text" id="rm_why" maxlength="200" autocomplete="off"
        placeholder="e.g. entered twice, or the cash never arrived"></div>
    <button class="btn btn-danger full-w mt" id="rm_go">Remove ${money(c.amount)}</button>`);

  $('rm_go').addEventListener('click', async () => {
    const why = $('rm_why').value.trim();
    if (!why) { toast('Say why — it is the one thing nobody remembers later', true); return; }
    try {
      await api.deleteContribution(c.id, why);
      closeModal();
      toast(`${money(c.amount)} removed — it is in the removed list if that was wrong`);
      renderLog();
      renderRemoved();
    } catch (e) { toast(e.message, true); }
  });
}

/** The window to undo a removal in. Empty most of the time, and then absent. */
async function renderRemoved() {
  const host = $('removedLog');
  if (!host) return;
  let rows = [];
  try { rows = await api.removedContributions(14); } catch { host.innerHTML = ''; return; }
  if (!rows.length) { host.innerHTML = ''; return; }

  host.innerHTML = `
    <div class="sams-card">
      <div class="card-header"><h3 class="card-title">Removed recently</h3>
        <span class="card-sub">${rows.length} payment${rows.length === 1 ? '' : 's'}
          taken off in the last 14 days · nothing here is counted in any balance</span></div>
      <div class="table-scroll">
        <table class="sams-table">
          <thead><tr><th>Removed</th><th>Player</th><th>Contract</th>
            <th class="num">Amount</th><th>Why</th><th></th></tr></thead>
          <tbody>${rows.map(r => `
            <tr>
              <td class="num">${esc(String(r.removed_at).slice(0, 10))}</td>
              <td>${esc(r.player_name || '—')}</td>
              <td>${esc(contractName(r.contract_id))}</td>
              <td class="num">${money(r.amount)}</td>
              <td>${esc(r.reason || '—')} <span class="hint">dated ${esc(fmtDate(r.date))}</span></td>
              <td class="row-actions"><button class="btn btn-secondary btn-sm"
                data-restore="${esc(r.id)}">Put it back</button></td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
      <p class="hint">Older removals are kept too — they just stop showing here. Ask if you
        need one back.</p>
    </div>`;

  host.querySelectorAll('[data-restore]').forEach(b =>
    b.addEventListener('click', async () => {
      const r = rows.find(x => x.id === b.dataset.restore);
      const why = prompt(`Put ${money(r.amount)} back on ${r.player_name}'s `
        + `${contractName(r.contract_id)} balance?\n\nIt was removed because: ${r.reason}`
        + '\n\nWhy is it going back? (added to the payment\'s note)');
      if (why === null) return;
      try {
        await api.restoreContribution(r.id, why);
        toast(`${money(r.amount)} put back`);
        renderLog();
        renderRemoved();
      } catch (e) { toast(e.message, true); }
    }));
}

/**
 * Change what a payment says, not what it is worth.
 *
 * A payment can be right to the fil and still need correcting: a date typed
 * wrong, or — as with the 96 that had sat unexplained since May — no note
 * saying why it is there at all, which leaves anyone checking to guess at it
 * and eventually to guess wrong.
 *
 * The amount, the player and the contract are shown and not editable. Those
 * are the money; changing one of them here would move a balance with nothing
 * in the log to say so, and the honest way to fix them is the delete button
 * next door followed by a fresh entry.
 */
function editContributionModal(c) {
  if (!c) { toast('That payment is no longer on the list', true); return; }
  openModal('Correct this payment', `
    <div class="kv"><span class="k">Player</span>
      <span class="v">${esc(c.player_name || c.name_raw || '—')}</span></div>
    <div class="kv"><span class="k">Contract</span>
      <span class="v">${esc(contractName(c.contract_id))}</span></div>
    <div class="kv"><span class="k">Amount</span><span class="v">${money(c.amount)}</span></div>
    <p class="hint mt">Those three are the money itself and are not changed here. If one of
      them is wrong, remove this payment and enter it again — that way the correction shows
      up in the log instead of happening quietly.</p>
    <div class="form-group mt"><label for="ec_date">Date paid</label>
      <input type="date" id="ec_date" value="${esc(c.date || '')}"></div>
    <div class="form-group mt"><label for="ec_note">Note</label>
      <input type="text" id="ec_note" maxlength="500" value="${esc(c.comments || '')}"
        placeholder="e.g. cash, or why this is dated before the opening balance"></div>
    <button class="btn full-w mt" id="ec_save">Save</button>`);

  $('ec_save').addEventListener('click', async () => {
    try {
      await api.editContribution(c.id,
        { comments: $('ec_note').value, date: $('ec_date').value });
      closeModal();
      toast('Saved ✓');
      renderLog();
    } catch (e) { toast(e.message, true); }
  });
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
    <p class="hint" id="splitSum"></p>
    <!-- Abhi hands over 175 and 118 of it is for Nihas and Shone. Until now
         the only way to record that was to credit them and type "from Abhi"
         in the comment, which left nothing at all on Abhi's own record. -->
    <div class="alloc-add">
      <span class="hint">Some of it is for someone else?</span>
      <select id="splitForWho" aria-label="Pay towards another player"></select>
      <select id="splitForContract" aria-label="Which of their balances"></select>
      <button type="button" class="btn btn-secondary btn-sm" id="splitAddWho">Add</button>
    </div>`;
  contribForm.insertBefore(panel, contribForm.querySelector('button[type="submit"]'));

  $('splitReset').addEventListener('click', () => drawSplit(lastSuggestion, true));
  $('splitAddWho').addEventListener('click', addSomeoneElse);
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
        const splits = readAllocs(document.getElementById('splitRows'));

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
        const group = splitGroupFor(splits);
        for (const split of splits) {
          // A row naming somebody else credits THEIR balance, and records
          // whose hand the money came out of. Nothing of it lands on the
          // payer: that is the whole point of the row.
          await api.createContribution({
            player_id: split.for_player_id || playerId,
            contract_id: split.contract_id,
            amount: split.amount,
            paid_by: split.for_player_id ? playerId : null,
            date, comments, split_group: group,
          });
        }
        const others = splits.filter(s => s.for_player_id).length;
        toast(others
          ? `${money(totalAmount)} recorded — ${others} part${others === 1 ? '' : 's'} on somebody else's balance ✓`
          : splits.length > 1
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

/** A row crediting somebody other than the person who handed the money over. */
async function addSomeoneElse() {
  const who = $('splitForWho').value;
  const cid = $('splitForContract').value;
  const rows = document.getElementById('splitRows');
  if (!who || !cid || !rows) return;
  if (who === $('cf_player').value) {
    toast('That is the person paying — their own share is already a row', true);
    return;
  }
  if (rows.querySelector(`[data-split-for][value="${CSS.escape(who)}"]`)
    && [...rows.querySelectorAll('.alloc-row')].some(r =>
      r.querySelector('[data-split-for]')?.value === who
      && r.querySelector('[data-split-contract]')?.value === cid)) {
    toast('That balance is already on the list', true);
    return;
  }

  // Their current balance, so the row can say what the payment does to it —
  // the same thing every other row says.
  let balance = 0;
  try {
    const ls = await api.get(`/players/${who}/ledgers`) || [];
    balance = Number(ls.find(l => l.contract_id === cid)?.present_balance) || 0;
  } catch { /* the row still works, it just cannot show the consequence */ }

  rows.insertAdjacentHTML('beforeend', allocRowHtml({
    contract_id: cid,
    contract_name: contractName(cid),
    for_player_id: who,
    for_player: store.players.find(p => p.id === who)?.name || who,
    balance,
    cost_per_game: 0,
    suggested: 0,
    why: '',
  }));
  wireSplitRows();
  updateSplitTotal();
}

/** (Re)attach the handlers every allocation row needs. */
function wireSplitRows() {
  const rows = document.getElementById('splitRows');
  if (!rows) return;
  rows.querySelectorAll('[data-split-amount]').forEach((el) => {
    el.removeEventListener('input', updateSplitTotal);
    el.addEventListener('input', updateSplitTotal);
  });
  rows.querySelectorAll('[data-split-drop]').forEach(b => {
    b.onclick = () => { b.closest('.alloc-row').remove(); updateSplitTotal(); };
  });
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

  // Shown even for a single contract now. It used to hide, on the grounds
  // that a split form offering one row is a question with one answer — but
  // the panel is no longer only about splitting across contracts. It is
  // where money is sent to somebody else, and that question has an answer
  // worth asking however many contracts the payer is on.
  panel.hidden = false;
  // Two answers to "which contract" on one form is one too many: while the
  // split is open, the picker above it decides nothing.
  $('cf_contract').disabled = true;
  document.getElementById('splitWhy').textContent = s.headline;

  if (fresh) {
    rows.innerHTML = allocRowsHtml(s.lines);
    wireSplitRows();
  }
  fillSomeoneElsePickers();
  updateSplitTotal();
}

/** The two pickers under the rows: who else, and which of their balances. */
function fillSomeoneElsePickers() {
  const who = $('splitForWho');
  const cid = $('splitForContract');
  if (!who || !cid) return;
  const payer = $('cf_player').value;
  const keep = who.value;
  who.innerHTML = '<option value="">someone else…</option>'
    + rosterOptions(store.players.filter(p =>
      p.id !== payer && p.special_role !== 'cashier'), '', { includeGuests: false });
  if (keep) who.value = keep;
  if (!cid.options.length) {
    cid.innerHTML = (store.contracts || [])
      .map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  }
}

/**
 * Keep the workings honest while the cashier edits. The arithmetic is shared
 * with the + Pay modal on the Players screen — see split_panel.js.
 */
function updateSplitTotal() {
  const host = document.getElementById('splitRows');
  if (!host) return;
  refreshAllocs(host, Math.round(Number($('cf_amount').value) || 0),
    document.getElementById('splitSum'));
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

// ---- what the move will actually do ----------------------------------------
//
// The form asks three questions — from, to, and a contract — and the answer to
// the one that matters, WHICH BALANCE GOES DOWN AND WHICH GOES UP, was left to
// be inferred from the fact that there is only one contract field. There is
// only one because the two balances are two ends of the same contract: money
// moving between two people moves inside one book. Saying so, with the two
// numbers before and after, is the difference between a form you can use and
// one you hope you have understood.

const isKittyParty = (v) => v === KITTY || String(v).startsWith(`${KITTY}:`);

// Balances are fetched per player and reused; the preview redraws on every
// keystroke in the amount box and must not fetch on every one of them.
const ledgerCache = new Map();

async function balancesFor(playerId) {
  if (!playerId || isKittyParty(playerId)) return null;
  if (!ledgerCache.has(playerId)) {
    try {
      const rows = await api.get(`/players/${playerId}/ledgers`) || [];
      ledgerCache.set(playerId, Object.fromEntries(
        rows.map(l => [l.contract_id, Number(l.present_balance) || 0])));
    } catch { ledgerCache.set(playerId, null); }   // say less rather than guess
  }
  return ledgerCache.get(playerId);
}

function partyLabel(v) {
  if (v === KITTY) return 'the club kitty';
  if (isKittyParty(v)) {
    return `the ${contractName(String(v).slice(KITTY.length + 1))} kitty`;
  }
  return store.players.find(p => p.id === v)?.name || v || 'nobody';
}

/** One side of the sentence, with the balance before and after when known. */
function sideText(party, contractId, delta, balances) {
  const who = partyLabel(party);
  if (isKittyParty(party) || !contractId) return who;
  const before = balances?.[contractId];
  if (before === undefined || before === null) {
    return `${who}'s ${contractName(contractId)} balance`;
  }
  return `${who}'s ${contractName(contractId)} balance `
    + `<span class="mv-swing">${money(before)} → ${money(before + delta)}</span>`;
}

async function drawMovePreview() {
  const box = $('mv_preview');
  if (!box) return;
  const from = $('mv_from')?.value;
  const to = $('mv_to')?.value;
  const amount = Math.round(Number($('mv_amount')?.value) || 0);
  const contractId = $('mv_contract')?.disabled ? '' : $('mv_contract')?.value;

  if (!from || !to || from === to || amount <= 0) { box.hidden = true; return; }

  const [fromBal, toBal] = await Promise.all([balancesFor(from), balancesFor(to)]);
  // They may have carried on typing while those were in flight.
  if ($('mv_from').value !== from || $('mv_to').value !== to) return;

  const bothKitty = isKittyParty(from) && isKittyParty(to);
  const lines = [];

  if (bothKitty) {
    lines.push(`<strong>${money(amount)}</strong> moves from ${partyLabel(from)} `
      + `to ${partyLabel(to)}. No player balance changes, and the club still holds `
      + 'the same money — it is just sitting under the other night.');
  } else if (!contractId) {
    if (!isKittyParty(from) && !isKittyParty(to)) {
      lines.push('<span class="mv-warn">Pick a contract.</span> A balance belongs to one, '
        + 'so between two people there is nowhere for this to land.');
    } else {
      const out = isKittyParty(from);
      lines.push(`<strong>${money(amount)}</strong> ${out ? 'leaves' : 'goes into'} `
        + `${partyLabel(out ? from : to)}, as cash `
        + `${out ? 'paid to' : 'received from'} ${partyLabel(out ? to : from)}.`);
      lines.push('<span class="mv-warn">No contract named, so no balance moves.</span> '
        + 'Name one above if this should also change what the club owes them.');
    }
  } else {
    lines.push(`<strong>${money(amount)}</strong> comes off `
      + `${sideText(from, contractId, -amount, fromBal)} and goes onto `
      + `${sideText(to, contractId, amount, toBal)}.`);
    if (!isKittyParty(from) && !isKittyParty(to)) {
      lines.push(`Both ends move on ${contractName(contractId)} — `
        + 'one contract, so the club owes exactly what it owed before.');
    }
    // Not a block — the club does carry people — but it should never happen by
    // accident, and "only holds 540" is a different sentence from "is already
    // at -95" however much the arithmetic agrees.
    const held = fromBal?.[contractId];
    if (!isKittyParty(from) && typeof held === 'number' && amount > held) {
      lines.push(`<span class="mv-warn">${partyLabel(from)} `
        + (held > 0 ? `only holds ${money(held)} there` : `is already at ${money(held)} there`)
        + `, so this leaves them at ${money(held - amount)}.</span> `
        + 'Allowed, but say what it is for below.');
    }
  }

  box.innerHTML = lines.map(l => `<p>${l}</p>`).join('');
  box.hidden = false;
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
  // The same person on both ends is not a movement between two parties — it is
  // one person's money moving between their own two balances, which is a
  // different shape (one party, two contracts) and lives on the Players
  // screen. Saying where, rather than failing with "from and to must differ".
  if (from && from === to && !isKitty(from)) {
    note.textContent = 'Same person on both ends. To move their own money between their two '
      + 'contracts, use ⇄ on the Players screen — the ⋮ menu on their row, or the Both view.';
    if (field) field.disabled = true;
    return;
  }

  if (field) field.disabled = false;
  note.textContent = !isKitty(from) && !isKitty(to)
    ? 'Required, and it is the same contract at both ends — the amount comes off '
      + 'this balance for the first person and goes onto it for the second.'
    : 'Leave blank to move real club money without touching any balance, '
      + "e.g. paying yourself back for something you bought. Name one and the player's balance moves too.";
}

async function renderMovements() {
  const host = $('mvLog');
  if (!host) return;
  let rows = [];
  try { rows = await api.movements(); } catch { host.innerHTML = ''; return; }
  if (!rows.length) { host.innerHTML = '<p class="hint">Nothing moved yet.</p>'; return; }
  // The only table on this screen that was not in a scroller, which on a phone
  // pushed the whole page sideways — the Contributions log below has had one
  // all along.
  host.innerHTML = `
    <div class="table-scroll">
    <table class="sams-table">
      <thead><tr><th>Date</th><th>From</th><th>To</th><th class="num">Amount</th><th>What for</th><th></th></tr></thead>
      <tbody>${rows.map(m => `
        <tr>
          <td>${esc(fmtDate(m.date))}</td>
          <td>${esc(m.from_name)}</td>
          <td>${esc(m.to_name)}</td>
          <td class="num"><strong>${money(m.amount)}</strong></td>
          <td>${esc(m.note || '—')}${m.contract_id
    ? ` <span class="hint">(on the ${esc(m.contract_name || contractName(m.contract_id))} balance)</span>`
    : ' <span class="hint">(club money — no balance moved)</span>'}</td>
          <td class="row-actions"><button class="link-btn" data-mv-del="${esc(m.id)}"
            title="Undo this movement — both sides">✕</button></td>
        </tr>`).join('')}</tbody>
    </table>
    </div>`;

  host.querySelectorAll('[data-mv-del]').forEach(b =>
    b.addEventListener('click', async () => {
      if (!confirm('Undo this movement? Both sides of it are reversed.')) return;
      try {
        await api.deleteMovement(b.dataset.mvDel);
        toast('Movement undone');
        ledgerCache.clear();
        renderMovements();
        renderLog();
      } catch (e) { toast(e.message, true); }
    }));
}

/**
 * Move money, on demand rather than permanently on screen.
 *
 * This was a card with six fields, a live preview and a log of its own,
 * sitting under the payment form on every visit. One movement has ever been
 * recorded, against thirty-five payments — it was half a screen of controls
 * for something done once a year, and it is most of what made this page
 * hard to read. The form is unchanged; it just waits to be asked for.
 */
export function moveMoneyModal() {
  openModal('Move money', `
    <p class="hint">Between a player and the kitty, or between two players.
      This is not a payment into the club — it is money that already exists
      changing hands.</p>
    <form id="moveForm" class="mt">
      <div class="form-row">
        <div class="form-group"><label for="mv_from">Take it out of</label>
          <select id="mv_from"></select></div>
        <div class="form-group"><label for="mv_to">Put it into</label>
          <select id="mv_to"></select></div>
      </div>
      <div class="form-row mt">
        <div class="form-group"><label for="mv_amount">Amount (AED)</label>
          <input type="number" id="mv_amount" step="1" placeholder="120"></div>
        <div class="form-group"><label for="mv_date">Date</label>
          <input type="date" id="mv_date"></div>
      </div>
      <div class="form-row mt">
        <div class="form-group"><label for="mv_contract">Which balance it moves on</label>
          <select id="mv_contract"></select>
          <p class="hint" style="margin:0.3rem 0 0" id="mv_contract_note"></p></div>
        <div class="form-group"><label for="mv_note">What for</label>
          <input type="text" id="mv_note" placeholder="e.g. reimbursed for the shirts"></div>
      </div>
      <div class="mv-preview mt" id="mv_preview" hidden></div>
      <button type="submit" class="btn mt">Move it</button>
    </form>
    <h4 class="mini-h mt">Moved before</h4>
    <div id="mvLog"></div>`, { wide: true });

  fillMoveSelects();
  initMoveMoney();
  renderMovements();
}

function initMoveMoney() {
  const form = $('moveForm');
  if (!form) return;
  // describeMove decides whether the contract field applies at all, so it runs
  // first and the preview reads the result.
  ['mv_from', 'mv_to'].forEach(id => $(id)?.addEventListener('change', () => {
    describeMove(); drawMovePreview();
  }));
  ['mv_amount', 'mv_contract'].forEach(id =>
    $(id)?.addEventListener('input', drawMovePreview));
  $('mv_contract')?.addEventListener('change', drawMovePreview);
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
      // Both balances just changed, so the cached ones would show the move
      // again from where it started.
      ledgerCache.clear();
      $('mv_preview').hidden = true;
      renderMovements();
      renderLog();          // it lands in the log below as well, now
    } catch (err) { toast(err.message, true); }
  });
}

export function initContributions() {
  if (isPlayer()) return;   // player UI is built lazily on first load
  initAdmin();
  // The move form is built when the button is pressed, so there is nothing
  // to wire here — only the button that asks for it.
  $('openMoveMoney')?.addEventListener('click', moveMoneyModal);
}

export function loadContributions() {
  if (isPlayer()) {
    if (!playerInited) { rebuildPlayerUI(); playerInited = true; }
    return renderMyContributions();
  }
  fillSelects();
  return Promise.all([renderPendingApprovals(), renderLog(), renderRemoved()]);
}
