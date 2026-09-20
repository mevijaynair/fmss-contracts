// standing.js — where the whole club stands, for everybody.
//
// The club sends this out every week as a picture in the group chat, so the
// figures were never private; what was private was being able to look them up
// when you wanted to. A player could see their own balance and nothing else,
// which makes the one question everybody actually asks — am I the only one
// behind? — unanswerable except by squinting at last week's screenshot.
//
// So this is that picture, as a screen: who still has to pay across both
// contracts, then each contract's squad. Same endpoint and same rules as the
// picture, so the two cannot disagree. The reader's own row is marked, because
// the first thing anyone does with a list of forty names is look for theirs.
//
// Read-only, and with no way through to anybody else's detail. That the club
// knows Jeetu is 600 short is what the group chat already says; his payment
// history is a different thing, and nobody asked for it.
import { api } from '../api.js';
import { store } from '../store.js';
import { esc, money, fmtDate } from '../util.js';

// The three words the standing sheet uses, with the sheet's own classes so
// this screen and that one cannot drift apart visually either.
function statusOf(row) {
  const s = (row.status || '').toLowerCase();
  if (row.balance < 0 || s.includes('out of contract')) return { word: 'Empty', cls: 'rep-out' };
  if (s.includes('refill')) return { word: 'Top up', cls: 'rep-refill' };
  return { word: 'OK', cls: 'rep-in' };
}

// Nought is neither. Tinting it green says "in credit" about somebody who has
// nothing, which on the Saturdays column of the top-up table is most of the
// people who have never played there.
const balCell = (v) => `<td class="num rep-bal ${v < 0 ? 'rep-out' : v > 0 ? 'rep-in' : ''}">`
  + `${money(v)}</td>`;
const youTag = ' <span class="rep-you">you</span>';

function squadTable(c, me) {
  const rows = c.squad.map((p) => {
    const st = statusOf(p);
    const mine = me && p.name === me;
    return `<tr class="${mine ? 'rep-me' : ''}">
      <td>${esc(p.name)}${mine ? youTag : ''}</td>
      <td class="num">${p.played ?? ''}</td>
      ${balCell(p.balance)}
      <td class="rep-status ${st.cls}">${st.word}</td>
    </tr>`;
  }).join('');

  return `
    <div class="sams-card">
      <div class="card-header">
        <h3 class="card-title">${esc(c.name)}</h3>
        <span class="card-sub">${esc(c.venue || '')}${c.venue ? ' · ' : ''}
          ${money(c.rate)} per game</span>
      </div>
      <div class="rep-summary">
        <span><strong>${c.totals.players}</strong> players</span>
        <span class="rep-in"><strong>${c.totals.in_contract}</strong> OK</span>
        <span class="rep-refill"><strong>${c.totals.refill}</strong> top up</span>
        <span class="rep-out"><strong>${c.totals.out}</strong> empty</span>
      </div>
      <div class="table-scroll">
        <table class="sams-table rep-table">
          <thead><tr><th>Player</th><th class="num">Games</th>
            <th class="num">Balance</th><th>Next game</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4" class="hint">Nobody yet.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

/**
 * Who still has to pay, once, across everything — one column per contract.
 *
 * Laid out the same way as the picture, for the same reason: two per-contract
 * lists name somebody as a debtor for a shortfall their own credit on the
 * other night already covers, and never show what they owe altogether.
 */
function stillToPayTable(d, me) {
  const pay = d.still_to_pay || { top_up: [], cash: [] };
  const cols = d.contracts;

  const topUp = pay.top_up.map((r) => {
    const mine = me && r.name === me;
    const cells = cols.map((c) => {
      const part = r.parts.find(p => p.contract_id === c.id);
      // A dash is not a nought: it says they are not on that contract at all.
      if (!part) return '<td class="num rep-na">—</td>';
      return balCell(part.balance);
    }).join('');
    return `<tr class="${mine ? 'rep-me' : ''}">
      <td>${esc(r.name)}${mine ? youTag : ''}</td>
      ${cells}<td class="num rep-bal rep-out"><strong>${money(r.total)}</strong></td></tr>`;
  }).join('');

  const cash = pay.cash.map(r => `<tr>
      <td>${esc(r.name)}</td>
      <td class="num">${r.games}</td>
      <td class="num rep-bal rep-refill"><strong>${money(r.amount)}</strong></td></tr>`).join('');

  return `
    <div class="sams-card">
      <div class="card-header"><h3 class="card-title">Still to pay</h3>
        <span class="card-sub">Both contracts together</span></div>
      ${pay.top_up.length ? `
        <div class="rep-collect-head">Members to top up —
          <strong>${money(-pay.top_up_total)}</strong> from ${pay.top_up.length}</div>
        <div class="table-scroll">
          <table class="sams-table rep-table">
            <thead><tr><th>Player</th>
              ${cols.map(c => `<th class="num">${esc(c.name)}</th>`).join('')}
              <th class="num">Total</th></tr></thead>
            <tbody>${topUp}</tbody>
          </table>
        </div>`
    : '<p class="hint rep-clear">Nobody is short — every balance covers the next game.</p>'}
      ${pay.cash.length ? `
        <div class="rep-collect-head" style="margin-top:1rem">Guests —
          <strong>${money(pay.cash_total)}</strong> cash to hand over</div>
        <p class="hint">Outside players are not on a contract. They pay for each game in cash.</p>
        <div class="table-scroll">
          <table class="sams-table rep-table">
            <thead><tr><th>Guest</th><th class="num">Games</th><th class="num">Cash</th></tr></thead>
            <tbody>${cash}</tbody>
          </table>
        </div>` : ''}
    </div>`;
}

function recentGames(d) {
  const blocks = d.contracts.filter(c => c.recent_games.length).map(c => `
    <div>
      <p class="hint"><strong>${esc(c.name)}</strong></p>
      ${c.recent_games.slice(0, 8).map(g =>
    `<div class="hint">${fmtDate(g.date)} · ${g.players} played</div>`).join('')}
    </div>`).join('');
  if (!blocks) return '';
  return `
    <div class="sams-card">
      <div class="card-header"><h3 class="card-title">Last ${d.weeks} weeks</h3></div>
      <div class="auto-grid" style="--col-min: 200px;">${blocks}</div>
    </div>`;
}

/**
 * Draw the club's standing into `host`.
 *
 * Matched to the reader by NAME, not by id: the rows come from the standing
 * sheet, which is about people rather than accounts, and a guest brought by a
 * member has no account of their own to match against.
 */
export async function renderClubStanding(host, { weeks = 3 } = {}) {
  if (!host) return;
  host.innerHTML = '<p class="hint">Loading…</p>';

  let d;
  try { d = await api.get(`/standing?weeks=${weeks}`); }
  catch (e) { host.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }

  const me = store.players?.find(p => p.id === store.user?.playerId)?.name || null;

  host.innerHTML = `
    <p class="hint">Everyone's standing, as at ${fmtDate(d.generated_at)}. A balance is money
      already paid in; <span class="rep-out">empty</span> means the next game is not covered
      yet. Guests pay cash per game and keep no balance.</p>
    ${stillToPayTable(d, me)}
    ${d.contracts.map(c => squadTable(c, me)).join('')}
    ${recentGames(d)}`;
}
