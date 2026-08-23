// dashboard.js — KPI strip, per-contract cards, refill watchlist.
// Role-aware: admin sees club-wide aggregates; player sees only their balances.
import { api } from '../api.js';
import { $, esc, money, balCell, fmtDate } from '../util.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export async function loadDashboard() {
  const d = await api.dashboard();

  if (d.role === 'player') return renderPlayerDashboard(d);

  const cash = d.cash || {};
  const refills = d.contracts.reduce((s, c) => s + c.refill_count, 0);

  // Headline is the cash question a cashier actually has: does the pot cover what
  // players have already paid in? Netting credit against debt hid this, because
  // the two are opposite in kind — one is owed BY the club, the other TO it.
  const kpis = [
    {
      v: money(cash.kitty_balance ?? 0),
      l: cash.covered_pct === null ? 'Kitty (AED)'
        : `Kitty · covers ${cash.covered_pct}% of prepaid`,
      cls: (cash.cover ?? 0) >= 0 ? 'good' : 'bad',
    },
    { v: money(cash.credit_held ?? 0), l: 'Held in credit (owed by club)' },
    { v: money(cash.owed ?? 0), l: 'Owed to club', cls: (cash.owed ?? 0) > 0 ? 'warn' : 'good' },
    { v: refills, l: 'Need a top-up', cls: refills ? 'warn' : 'good' },
  ];
  $('kpiStrip').innerHTML = kpis.map(k =>
    `<div class="kpi ${k.cls || ''}"><div class="v">${k.v}</div><div class="l">${esc(k.l)}</div></div>`).join('');

  // Say plainly what the cash position means, rather than leaving a bare number.
  const shortfall = -(cash.cover ?? 0);
  const coverNote = cash.credit_held
    ? (shortfall > 0
      ? `<div class="panel panel-warn">
           <div class="panel-title">Kitty is ${money(shortfall)} short of prepayments</div>
           <div class="panel-body">Players hold ${money(cash.credit_held)} in credit but the kitty
             has ${money(cash.kitty_balance)}. That gap is prepaid money already spent — fine while
             games keep being played, worth knowing if several asked for a refund at once.</div>
         </div>`
      : `<div class="panel">
           <div class="panel-title">Kitty covers all prepayments</div>
           <div class="panel-body">${money(cash.kitty_balance)} against ${money(cash.credit_held)}
             held in credit, a surplus of ${money(cash.cover)}.</div>
         </div>`)
    : '';

  $('contractCards').innerHTML = d.contracts.map(c => {
    const stale = c.last_game
      ? Math.floor((Date.now() - new Date(c.last_game)) / 864e5)
      : null;
    return `
    <div class="sams-card">
      <div class="card-header"><h3 class="card-title">${esc(c.name)}</h3>
        <span class="card-sub">${esc(c.venue || '')}${c.rate ? ` · ${money(c.rate)}/game` : ''}</span></div>
      <div>
        <div class="kv"><span class="k">Players</span><span class="v">${c.players}</span></div>
        <div class="kv"><span class="k">Games recorded</span><span class="v">${c.games}</span></div>
        <div class="kv"><span class="k">Last game</span><span class="v">${
          c.last_game ? `${esc(fmtDate(c.last_game))}${stale > 21 ? ` <span class="hint">(${stale}d ago)</span>` : ''}`
                      : '<span class="hint">none</span>'}</span></div>
        <div class="kv"><span class="k">Games in last 30 days</span><span class="v">${c.games_30d}</span></div>
        <div class="kv"><span class="k">Held in credit</span><span class="v">${balCell(c.credit)}</span></div>
        <div class="kv"><span class="k">Owed to club</span><span class="v">${balCell(c.debt)}</span></div>
        <div class="kv"><span class="k">Already in debt</span><span class="v">${
          c.in_debt_count ? `<span class="tag tag-critical">${c.in_debt_count}</span>` : '0'}</span></div>
        <div class="kv"><span class="k">Under 2 games of credit</span><span class="v">${
          c.low_runway_count ? `<span class="tag tag-due">${c.low_runway_count}</span>` : '0'}</span></div>
      </div>
    </div>`;
  }).join('');

  // Chase list: deepest debt first, then whoever runs out next. Runway is shown
  // because "-34" and "2 games left" prompt different conversations.
  const watch = d.contracts.flatMap(c =>
    (c.watchlist || []).map(w => ({ ...w, contract: c.name.split(' ')[0], rate: c.rate })));
  const owedTotal = watch.filter(w => w.balance < 0).reduce((s, w) => s + Math.abs(w.balance), 0);

  $('watchlist').innerHTML = watch.length
    ? `<p class="hint" style="margin-bottom:.6rem">
         ${plural(watch.filter(w => w.balance < 0).length, 'player')} in debt totalling
         <strong>${money(owedTotal)}</strong>${
           watch.some(w => w.balance >= 0)
             ? ` · ${plural(watch.filter(w => w.balance >= 0).length, 'player')} nearly out of credit` : ''}
       </p>
       ${watch.map(w => `
         <span class="watch-chip ${w.balance < 0 ? 'is-debt' : ''}">
           ${esc(w.name)} <span class="hint">${esc(w.contract)}</span>
           ${w.balance < 0
             ? `<strong>${money(w.balance)}</strong>`
             : `<strong>${plural(w.games_left ?? 0, 'game')} left</strong>`}
         </span>`).join('')}
       ${coverNote}`
    : `<p class="hint">Everyone has credit for at least two more games. 🎉</p>${coverNote}`;
}

// Player dashboard: a personal balance snapshot per contract, no club aggregates.
function renderPlayerDashboard(d) {
  const totalBalance = d.contracts.reduce((s, c) => s + (c.present_balance || 0), 0);
  const inRed = d.contracts.filter(c => c.present_balance < 0).length;

  const kpis = [
    { v: money(totalBalance), l: 'My balance (AED)', cls: totalBalance >= 0 ? 'good' : 'bad' },
    { v: d.contracts.length, l: 'My contracts' },
    { v: inRed, l: 'Need refill', cls: inRed ? 'warn' : 'good' },
  ];
  $('kpiStrip').innerHTML = kpis.map(k =>
    `<div class="kpi ${k.cls || ''}"><div class="v">${k.v}</div><div class="l">${esc(k.l)}</div></div>`).join('');

  $('contractCards').innerHTML = d.contracts.map(c => `
    <div class="sams-card">
      <div class="card-header"><h3 class="card-title">${esc(c.name)}</h3>
        <span class="card-sub">${c.present_balance >= 0 ? 'In credit' : 'Refill needed'}</span></div>
      <div>
        <div class="kv"><span class="k">Opening balance</span><span class="v">${money(c.opening_balance)}</span></div>
        <div class="kv"><span class="k">Contributed</span><span class="v">${money(c.contributed)}</span></div>
        <div class="kv"><span class="k">Charged (games)</span><span class="v">${money(c.charged)}</span></div>
        <div class="kv"><span class="k">Games played</span><span class="v">${c.games}</span></div>
        <div class="kv"><span class="k">Present balance</span><span class="v">${balCell(c.present_balance)}</span></div>
      </div>
    </div>`).join('') || '<p class="hint">No contracts yet.</p>';

  $('watchlist').innerHTML = totalBalance >= 0
    ? '<p class="hint">You\'re in credit. ⚽</p>'
    : '<p class="hint">Your balance is in the red — please top up via the Contributions tab.</p>';
}
