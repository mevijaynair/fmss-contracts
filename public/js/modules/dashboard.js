// dashboard.js — KPI strip, per-contract cards, refill watchlist.
// Role-aware: admin sees club-wide aggregates; player sees only their balances.
import { api } from '../api.js';
import { $, esc, money, balCell } from '../util.js';

export async function loadDashboard() {
  const d = await api.dashboard();

  if (d.role === 'player') return renderPlayerDashboard(d);

  const totalNet = d.contracts.reduce((s, c) => s + c.net, 0);
  const totalRefills = d.contracts.reduce((s, c) => s + c.refill_count, 0);
  const kpis = [
    { v: d.players, l: 'Players' },
    { v: money(totalNet), l: 'Net club credit (AED)', cls: totalNet >= 0 ? 'good' : 'bad' },
    { v: totalRefills, l: 'Need refill', cls: totalRefills ? 'warn' : 'good' },
    { v: money(d.kitty.balance), l: 'Kitty (AED)', cls: d.kitty.balance >= 0 ? 'good' : 'bad' },
  ];
  $('kpiStrip').innerHTML = kpis.map(k =>
    `<div class="kpi ${k.cls || ''}"><div class="v">${k.v}</div><div class="l">${esc(k.l)}</div></div>`).join('');

  $('contractCards').innerHTML = d.contracts.map(c => `
    <div class="sams-card">
      <div class="card-header"><h3 class="card-title">${esc(c.name)}</h3>
        <span class="card-sub">${esc(c.venue || '')}</span></div>
      <div>
        <div class="kv"><span class="k">Players</span><span class="v">${c.players}</span></div>
        <div class="kv"><span class="k">Games recorded</span><span class="v">${c.games}</span></div>
        <div class="kv"><span class="k">Total credit held</span><span class="v">${balCell(c.credit)}</span></div>
        <div class="kv"><span class="k">Total owed (in red)</span><span class="v">${balCell(c.debt)}</span></div>
        <div class="kv"><span class="k">Net standing</span><span class="v">${balCell(c.net)}</span></div>
        <div class="kv"><span class="k">Need refill</span><span class="v">${c.refill_count}</span></div>
      </div>
    </div>`).join('');

  const watch = d.contracts.flatMap(c =>
    c.watchlist.map(w => ({ ...w, contract: c.name.split(' ')[0] })));
  $('watchlist').innerHTML = watch.length
    ? watch.map(w => `<span class="watch-chip">${esc(w.name)} · ${esc(w.contract)} ${money(w.balance)}</span>`).join('')
    : '<p class="hint">Everyone is in credit. 🎉</p>';
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

  // Watchlist card not relevant to a single player — show a friendly note.
  $('watchlist').innerHTML = totalBalance >= 0
    ? '<p class="hint">You\'re in credit. ⚽</p>'
    : '<p class="hint">Your balance is in the red — please top up via the Contributions tab.</p>';
}
