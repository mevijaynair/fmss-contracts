// split_panel.js — "where does this payment go", drawn the same way everywhere.
//
// Two screens record a payment: the Contributions form, and the + Pay button
// on a player's row. Both have to offer the same split, because a suggestion
// that only appears on one of them is worse than none — it teaches the cashier
// that the app sometimes knows and sometimes does not, and they stop reading
// it on both.
//
// The server decides the numbers (contributions.suggestSplit). This owns only
// how they are shown and edited: the rows, the running consequence under each
// one, and whether the parts still add up to the payment.
import { esc, money, balCell } from '../util.js';

/**
 * The editable rows for a suggestion.
 *
 * Each row carries the balance and the cost of a game as data, so the
 * consequence of an edit can be recomputed here without asking the server
 * again — the point of the line under the box is that it keeps up with typing.
 */
export function allocRowsHtml(lines) {
  return lines.map(l => allocRowHtml(l)).join('');
}

/**
 * One row of "where this money goes".
 *
 * `for_player` is set when the row credits SOMEBODY ELSE — Abhi pays 175 and
 * 75 of it belongs on Nihas's balance. The money still lands on one person's
 * one contract, which is why it is the same row shape; the only difference
 * is whose name is on it, and that the row can be taken off again.
 */
export function allocRowHtml(l) {
  const other = l.for_player_id ? ` <span class="alloc-for">for ${esc(l.for_player)}</span>` : '';
  return `
    <div class="alloc-row" data-balance="${l.balance || 0}" data-cost="${l.cost_per_game || 0}">
      <input type="hidden" data-split-contract value="${esc(l.contract_id)}">
      ${l.for_player_id
    ? `<input type="hidden" data-split-for value="${esc(l.for_player_id)}">` : ''}
      <div class="alloc-name">
        <strong>${esc(l.contract_name)}${other}</strong>
        <span class="hint" data-split-why>${esc(l.why || '')}</span>
      </div>
      <div class="alloc-now"><span class="hint">now</span> ${balCell(l.balance || 0)}</div>
      <input type="number" data-split-amount step="1" class="alloc-amt"
        value="${l.suggested ?? 0}" aria-label="Amount for ${esc(l.contract_name)}">
      ${l.for_player_id
    ? '<button type="button" class="link-btn" data-split-drop title="Take this off">✕</button>'
    : ''}
    </div>`;
}

/**
 * Redraw what each row's number means, and say whether the parts add up.
 *
 * The consequence is what makes a number checkable — "covers 4 more games" is
 * the thing being decided, not the 108.
 */
export function refreshAllocs(host, total, sumEl) {
  let put = 0;
  host.querySelectorAll('.alloc-row').forEach((row) => {
    const amount = Math.round(Number(row.querySelector('[data-split-amount]').value) || 0);
    put += amount;
    const balance = Number(row.dataset.balance) || 0;
    const cost = Number(row.dataset.cost) || 0;
    const after = balance + amount;
    const why = row.querySelector('[data-split-why]');
    if (!why) return;
    const games = cost > 0 ? Math.floor(after / cost) : null;
    why.textContent = after < 0
      ? `still ${money(-after)} short`
      : games === null ? `leaves ${money(after)}`
        : `leaves ${money(after)} — covers ${games} more game${games === 1 ? '' : 's'}`;
  });

  if (sumEl) {
    const gap = Math.round(total) - put;
    sumEl.textContent = gap === 0
      ? `${money(put)} of ${money(total)} allocated.`
      : gap > 0 ? `${money(gap)} not allocated yet — the total must match ${money(total)}.`
        : `${money(-gap)} over — the total must match ${money(total)}.`;
    sumEl.classList.toggle('rep-out', gap !== 0);
  }
  return put;
}

/** What the rows currently say, ready to be written. Zeroes are dropped. */
export function readAllocs(host) {
  return [...host.querySelectorAll('.alloc-row')].map(row => ({
    contract_id: row.querySelector('[data-split-contract]')?.value || '',
    // Null when the row is for the payer themselves, which is the ordinary
    // case and what the caller already knows.
    for_player_id: row.querySelector('[data-split-for]')?.value || null,
    amount: Math.round(Number(row.querySelector('[data-split-amount]')?.value) || 0),
  })).filter(s => s.contract_id && s.amount > 0);
}

/**
 * One id shared by every leg, so the rows stay provably the same payment.
 *
 * A "split" of one leg is not a split, and labelling it as one everywhere it
 * is read would be noise — so a single-legged write gets no group at all.
 */
export function splitGroupFor(parts) {
  return parts.length > 1
    ? `sp_${Date.now()}_${Math.random().toString(16).slice(2, 8)}` : null;
}
