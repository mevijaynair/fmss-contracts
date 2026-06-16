// dashboard.js — KPI strip, per-contract cards, refill watchlist.
import { api } from '../api.js';
import { $, esc, money, balCell } from '../util.js';

export async function loadDashboard() {
  const d = await api.dashboard();

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
