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
      <td class="num">${r.deducted ? money(r.deducted) : '<span class="rep-na">0</span>'}</td>
      <td class="num">${r.played || '<span class="rep-na">0</span>'}</td>
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

      <div class="rep-summary">
        <span><strong>${t.players}</strong> players</span>
        <span class="rep-in"><strong>${t.in_contract}</strong> in contract</span>
        <span class="rep-refill"><strong>${t.refill}</strong> need a refill</span>
        <span class="rep-out"><strong>${t.out}</strong> out of contract</span>
        <span><strong>${t.played}</strong> games played</span>
        <span><strong>${money(t.deducted)}</strong> deducted</span>
      </div>

      <div style="overflow-x:auto;">
        <table class="sams-table rep-table">
          <thead>
            <tr>
              <th class="num">#</th>
              <th>Name</th>
              <th class="num">Present<br>Balance</th>
              <th>Status<br>from balance</th>
              <th class="num">Games<br>captained</th>
              <th class="num">Charged<br>this period</th>
              <th class="num">Games<br>played</th>
              <th class="num">Last<br>Contribution</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="8" class="hint">Nobody on this contract yet.</td></tr>'}</tbody>
        </table>
      </div>

      <p class="hint rep-key">
        Games captained is the share of this period's games the player led — NA until they have played.
        Status is how many games the balance still covers at ${money(data.rate)} a game: under one
        game is out of contract, under ${data.refill_below_games} needs a refill.${data.dormant_hidden
      ? ` ${data.dormant_hidden} player${data.dormant_hidden === 1 ? '' : 's'} holding no money and
         with nothing this period ${data.dormant_hidden === 1 ? 'is' : 'are'} not listed.`
      : ''}${data.flag_hidden
      ? ` ${data.flag_hidden} player${data.flag_hidden === 1 ? '' : 's'} marked as having left
         ${data.flag_hidden === 1 ? 'is' : 'are'} not listed${data.flag_hidden_balance
    ? `, still holding ${money(data.flag_hidden_balance)} between them` : ''} —
         you can put them back from the Players screen.`
      : ''}
      </p>
    </div>`;
}
