// gameweeks.js — game history list + detail modal.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money, fmtDate, contractSeg, openModal } from '../util.js';

let contractId = 'sat';

async function render() {
  const rows = await api.gameweeks(contractId);
  $('gwTable').querySelector('tbody').innerHTML = rows.map(g => `
    <tr data-gw="${g.id}" style="cursor:pointer;">
      <td class="num">${esc(fmtDate(g.date))}</td>
      <td>${g.gw_number || ''}${g.historical ? '' : ' <span class="tag tag-active">live</span>'}</td>
      <td>${g.num_players}</td>
      <td class="num">${money(g.charged)}</td>
      <td>${esc(g.score || '')}</td>
      <td class="row-actions">${g.historical ? '<span class="hint">imported</span>'
        : `<button class="link-btn" data-del="${g.id}">✕</button>`}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="hint">No games recorded.</td></tr>';

  $('gwTable').querySelectorAll('tr[data-gw]').forEach(tr =>
    tr.addEventListener('click', (e) => { if (!e.target.closest('[data-del]')) detail(tr.dataset.gw); }));
  $('gwTable').querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this game and refund its charges?')) return;
      try { await api.deleteGameweek(b.dataset.del); toast('Deleted'); render(); }
      catch (err) { toast(err.message, true); }
    }));
}

async function detail(id) {
  const g = await api.gameweek(id);
  const charges = (g.charges || []).map(c => `
    <div class="kv"><span class="k"><span class="team-dot team-${esc(c.team || 'Team 1')}"></span>${esc(c.player_name)}${c.is_captain ? '<span class="capt-badge">C</span>' : ''}</span>
      <span class="v">${money(c.amount)}</span></div>`).join('');
  openModal(`${fmtDate(g.date)} · ${esc((store.contracts.find(c=>c.id===g.contract_id)||{}).name||'')}`, `
    ${g.score ? `<p class="muted"><strong>Result:</strong> ${esc(g.score)}</p>` : ''}
    ${g.teams_raw ? `<div class="teams-raw mt">${esc(g.teams_raw)}</div>` : ''}
    <h4 class="mini-h mt">Charges (${g.num_players} players · ${money(g.charges?.reduce((s,c)=>s+c.amount,0)||0)} AED)</h4>
    ${charges || '<p class="hint">No charges.</p>'}`);
}

export function initGameweeks() {}

export function loadGameweeks() {
  contractSeg($('gwContractSeg'), store.contracts, contractId, (id) => { contractId = id; render(); });
  return render();
}
