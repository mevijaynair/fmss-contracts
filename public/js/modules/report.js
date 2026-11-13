// report.js — the standing sheet that gets shared with the players.
//
// Deliberately built to be screenshotted: a dense, self-explanatory table with
// the period and its rules stated in the header, so a picture of it makes sense
// to someone who cannot see the app.
//
// This is one of two shapes of the Players screen, not a destination of its
// own — the working ledger is the other. It therefore owns no state: which
// contract is showing and which shape is on are the Players screen's business,
// and it is handed the first and renders empty slots for the controls of both.
// It used to keep its own `contractId`, which meant switching contract on one
// shape and flipping to the other showed you the wrong club.
import { api } from '../api.js';
import { esc, money, fmtDate } from '../util.js';

const STATUS_CLASS = {
  'In contract': 'rep-in',
  'Refill needed - No priority': 'rep-refill',
  'Out of contract': 'rep-out',
};

// The captaincy share is shaded by how much of it there is, the way the sheet
// does, so a glance finds whoever has been carrying the armband.
function captCell(pct) {
  if (pct === null || pct === undefined) return '<td class="num rep-na">NA</td>';
  const band = pct >= 75 ? 'is-high' : pct >= 40 ? 'is-mid' : pct > 0 ? 'is-low' : '';
  return `<td class="num rep-capt ${band}">${pct}%</td>`;
}

/**
 * Who still owes something, from the games this period has recorded.
 *
 * The sheet is read for one reason — to find out who to go and ask — and a
 * total of what has been collected does not answer that. Two kinds of debt,
 * kept apart because they are settled differently: a member is short on a
 * prepaid balance and tops it up, a guest owes cash for a night they played.
 * Adding them together would produce a figure that means nothing and cannot be
 * chased.
 */
function collectBlock(data) {
  const list = data.to_collect || [];
  if (!list.length) {
    return `<p class="hint rep-clear">Nothing outstanding — every player on this contract is
      square for the ${data.totals.played} game${data.totals.played === 1 ? '' : 's'}
      recorded since ${fmtDate(data.period_start)}.</p>`;
  }
  const topups = list.filter(r => r.kind === 'topup');
  const cash = list.filter(r => r.kind === 'cash');
  const names = (rows) => rows.map(r =>
    `<span class="rep-owe"><strong>${esc(r.name)}</strong> ${money(r.amount)}</span>`).join('');

  return `<div class="rep-collect">
    <div class="rep-collect-head">Still to collect —
      <strong>${money(data.to_collect_total)}</strong> from ${list.length}</div>
    ${topups.length ? `<div class="rep-collect-row">
      <span class="rep-collect-k">Top-ups owed</span>
      <span class="rep-collect-v">${names(topups)}</span></div>` : ''}
    ${cash.length ? `<div class="rep-collect-row">
      <span class="rep-collect-k">Cash for games played</span>
      <span class="rep-collect-v">${names(cash)}</span></div>` : ''}
  </div>`;
}

/**
 * What has happened lately, in one column.
 *
 * Two things a reader actually wants and the period columns cannot answer:
 * is this person still turning up, and have they put anything in. Both in one
 * cell rather than two more columns, because this sheet is read as a picture
 * and every column added is one fewer that fits on a phone.
 *
 * Nought games is stated as "none", not as a 0 — a blank or a nought in a
 * column of numbers reads as missing data, and "not seen" is the single most
 * useful thing this column says.
 */
function recentCell(r) {
  const n = r.recent?.played || 0;
  const paid = r.recent?.paid_in || 0;
  const out = r.recent?.taken_out || 0;
  const games = n
    ? `<strong>${n}</strong> game${n === 1 ? '' : 's'}`
    : '<span class="rep-na">none</span>';
  const money_in = paid > 0
    ? `<span class="rep-in">+${money(paid)}</span>`
      + (r.recent.payments > 1 ? ` <span class="hint">×${r.recent.payments}</span>` : '')
    : '<span class="rep-na">—</span>';
  // A balance cut in the window — a send-off collected from balances, a
  // transfer out — is shown beside the money in. Showing only what came in,
  // on a sheet somebody reads to work out why their balance moved, is how a
  // deduction becomes a surprise.
  const money_out = out > 0 ? ` <span class="rep-out">−${money(out)}</span>` : '';
  return `<td class="rep-recent">
    <span class="rep-recent-g">${games}</span>
    <span class="rep-recent-m">${money_in}${money_out}</span>
  </td>`;
}

function balanceCell(v, gamesLeft) {
  const cls = v < 0 ? 'rep-out' : (gamesLeft !== null && gamesLeft < 4) ? 'rep-refill' : 'rep-in';
  return `<td class="num rep-bal ${cls}">${money(v)}</td>`;
}

/**
 * Draw the standing sheet for one contract into `host`.
 *
 * Returns nothing and wires nothing: the caller owns the contract and the
 * shape, and wires the two control slots this leaves in the header.
 */
export async function renderStandingSheet(host, contractId) {
  if (!host) return;
  host.innerHTML = '<p class="hint">Loading…</p>';

  let data;
  try { data = await api.report(contractId); }
  catch (e) { host.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }

  const t = data.totals;
  const rows = data.rows.map((r, i) => `
    <tr>
      <td class="num rep-idx">${i + 1}</td>
      <td><strong>${esc(r.name)}</strong></td>
      ${balanceCell(r.present_balance, r.games_left)}
      <td class="${STATUS_CLASS[r.status] || ''} rep-status">${esc(r.status)}</td>
      ${captCell(r.capt_subsidy_pct)}
      <td class="num">${r.played || '<span class="rep-na">0</span>'}</td>
      ${recentCell(r)}
      <td class="num rep-last">${r.last_contribution_date
      ? `${fmtDate(r.last_contribution_date)} <span class="hint">(${money(r.last_contribution_amount)})</span>`
      : '<span class="rep-na">—</span>'}</td>
    </tr>`).join('');

  host.innerHTML = `
    <div class="sams-card">
      <div class="card-header" style="align-items:flex-start;">
        <div>
          <h3 class="card-title">${esc(data.contract_name)} — Credit Tracking</h3>
          <span class="card-sub">
            Period from ${fmtDate(data.period_start)} · as at ${fmtDate(data.generated_at)} ·
            counts reset when a new contract starts
          </span>
        </div>
      </div>

      <!-- What was charged and collected over the period used to sit here as a
           running total. It is a true number that nobody acts on: the sheet is
           read to find out who to chase, and a season total tells you nothing
           about that. The names below do. -->
      <div class="rep-summary">
        <span><strong>${t.players}</strong> players</span>
        <span class="rep-in"><strong>${t.in_contract}</strong> in contract</span>
        <span class="rep-refill"><strong>${t.refill}</strong> need a refill</span>
        <span class="rep-out"><strong>${t.out}</strong> out of contract</span>
        <span><strong>${t.played}</strong> games played</span>
      </div>

      <!-- The window, said once and in words, so the column heading can stay
           short and nobody has to work out which five weeks are meant. -->
      <div class="rep-summary rep-summary-recent">
        <span class="rep-recent-k">Last ${data.recent_weeks} weeks</span>
        <span>from ${fmtDate(data.recent_from)}</span>
        <span><strong>${data.recent_gameweeks}</strong>
          game${data.recent_gameweeks === 1 ? '' : 's'} played on this contract</span>
        <span><strong>${t.recent_played}</strong> turnout${t.recent_played === 1 ? '' : 's'}
          between them</span>
        <span class="rep-in"><strong>${money(t.recent_paid_in)}</strong> paid in
          by ${t.recent_payers}</span>
        ${t.recent_taken_out
      ? `<span class="rep-out"><strong>${money(t.recent_taken_out)}</strong> taken off
            balances</span>` : ''}
        ${t.recent_absent
      ? `<span class="rep-na"><strong>${t.recent_absent}</strong> not seen</span>` : ''}
      </div>

      ${collectBlock(data)}

      <div style="overflow-x:auto;">
        <table class="sams-table rep-table">
          <thead>
            <tr>
              <th class="num">#</th>
              <th>Name</th>
              <th class="num">Present<br>Balance</th>
              <th>Status<br>from balance</th>
              <th class="num">Games<br>captained</th>
              <th class="num">Games<br>played</th>
              <th>Last ${data.recent_weeks} weeks<br>
                <span class="hint">games · paid in</span></th>
              <th class="num">Last<br>Contribution</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="8" class="hint">Nobody on this contract yet.</td></tr>'}</tbody>
        </table>
      </div>

      <p class="hint rep-key">
        Last ${data.recent_weeks} weeks counts games played since
        ${fmtDate(data.recent_from)}${data.recent_clipped
      ? ' — the start of this contract, so the window is shorter than that' : ''},
        and money that went onto the balance in the same time: a top-up, a transfer in, an
        adjustment. A figure in red beside it came off the balance in that window — a
        programme or a send-off settled from contract credit, not a game.
        Games captained is the share of this period's games the player led — NA until they have played.
        Status is how many games the balance still covers at ${money(data.rate)} a game: under one
        game is out of contract, under ${data.refill_below_games} needs a refill.${data.dormant_hidden
      ? ` ${data.dormant_hidden} player${data.dormant_hidden === 1 ? '' : 's'} holding no money and
         with nothing this period ${data.dormant_hidden === 1 ? 'is' : 'are'} not listed.`
      : ''}${data.flag_hidden
      ? ` ${data.flag_hidden} player${data.flag_hidden === 1 ? '' : 's'} set aside as not
         playing ${data.flag_hidden === 1 ? 'is' : 'are'} not listed${data.flag_hidden_balance
    ? `, still holding ${money(data.flag_hidden_balance)} between them` : ''} —
         you can put them back from the Players screen.`
      : ''}
      </p>
    </div>`;
}
