// report.js — the standing sheet that gets shared with the players.
//
// Deliberately built to be screenshotted: a dense, self-explanatory table with
// the period and its rules stated in the header, so a picture of it makes sense
// to someone who cannot see the app.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money, fmtDate, contractSeg } from '../util.js';

let contractId = 'sat';
let data = null;

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

async function render() {
  const host = $('reportRoot');
  if (!host) return;
  host.innerHTML = '<p class="hint">Loading…</p>';

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
        <span class="seg" id="repContractSeg"></span>
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
              <th>Contract Status<br>According to Balance</th>
              <th class="num">Capt<br>Subsidy</th>
              <th class="num">Deducted Amount<br>(Played in Contract)</th>
              <th class="num">Played Count<br>(in this Contract)</th>
              <th class="num">Last<br>Contribution</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="8" class="hint">Nobody on this contract yet.</td></tr>'}</tbody>
        </table>
      </div>

      <p class="hint rep-key">
        Capt Subsidy is the share of this period's games the player captained — NA until they have played.
        Status follows runway at ${money(data.rate)} a game: under one game is out of contract,
        under ${data.refill_below_games} needs a refill.${data.dormant_hidden
      ? ` ${data.dormant_hidden} dormant player${data.dormant_hidden === 1 ? '' : 's'} with no balance and no games this period ${data.dormant_hidden === 1 ? 'is' : 'are'} not listed.`
      : ''}
      </p>
    </div>`;

  contractSeg($('repContractSeg'), store.contracts, contractId, (id) => { contractId = id; render(); });
}

export function initReport() {}

export function loadReport() {
  return render();
}
