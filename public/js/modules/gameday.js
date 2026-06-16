// gameday.js — paste WhatsApp teams → parse → editable preview → confirm & deduct.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money, today, contractSeg } from '../util.js';
import { loadDashboard } from './dashboard.js';

let contractId = 'sat';
let rows = [];                 // current preview rows (mutable amounts)

const RATE_LABEL = {
  contracted_10: 'Contract', contracted_12: 'Contract',
  captain_10: 'Captain', captain_12: 'Captain', noncontract: 'Non-contract',
};

function statusLabel(r) {
  if (!r.matched) return '<span class="miss-badge">new / unmatched</span>';
  if (r.is_captain) return 'Captain';
  return r.rate_type === 'noncontract' ? 'Out of contract' : 'In contract';
}

function renderPreview(meta) {
  $('gdPreviewCard').hidden = false;
  $('gdMeta').textContent =
    `${rows.length} players · ${meta.teams.join(' / ')} · ${meta.bucket}-player rate`;
  $('gdTable').querySelector('tbody').innerHTML = rows.map((r, i) => `
    <tr>
      <td><strong>${esc(r.display_name)}</strong>${r.is_captain ? '<span class="capt-badge">C</span>' : ''}</td>
      <td><span class="team-dot team-${esc(r.team)}"></span>${esc(r.team)}</td>
      <td>${statusLabel(r)}</td>
      <td><span class="tag">${RATE_LABEL[r.rate_type] || r.rate_type}</span></td>
      <td style="text-align:right;"><input class="amt-input" type="number" step="1" data-i="${i}" value="${r.amount}"></td>
      <td class="row-actions"><button class="link-btn" data-del="${i}" title="Remove">✕</button></td>
    </tr>`).join('');

  $('gdTable').querySelectorAll('.amt-input').forEach(inp =>
    inp.addEventListener('input', () => { rows[inp.dataset.i].amount = Number(inp.value) || 0; recalcTotal(); }));
  $('gdTable').querySelectorAll('[data-del]').forEach(btn =>
    btn.addEventListener('click', () => { rows.splice(Number(btn.dataset.del), 1); renderPreview(meta); }));
  recalcTotal();
}

function recalcTotal() {
  const tot = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  $('gdTotal').textContent = money(tot);
  const c = store.contracts.find(x => x.id === contractId);
  const cost = c?.cost_per_gw || 0;
  const diff = tot - cost;
  $('gdVsCost').textContent = cost
    ? `pitch cost ${money(cost)} · ${diff >= 0 ? 'surplus' : 'short'} ${money(Math.abs(diff))}`
    : '';
}

async function doParse() {
  const text = $('gdText').value.trim();
  if (!text) { toast('Paste a team message first', true); return; }
  try {
    const res = await api.parse(contractId, text);
    rows = res.rows;
    if (!rows.length) { toast('No players detected', true); $('gdPreviewCard').hidden = true; return; }
    renderPreview(res);
    if (res.unmatched.length)
      toast(`${res.unmatched.length} unmatched: ${res.unmatched.join(', ')}`, true);
  } catch (e) { toast(e.message, true); }
}

async function doConfirm() {
  if (!rows.length) return;
  const gameweek = {
    contract_id: contractId,
    date: $('gdDate').value || today(),
    contract_number: Number($('gdContractNo').value) || 0,
    cost_per_gw: store.contracts.find(c => c.id === contractId)?.cost_per_gw || 0,
    teams_raw: $('gdText').value.trim(),
    score: $('gdScore').value.trim(),
    comments: $('gdComments').value.trim(),
  };
  const charges = rows.map(r => ({
    player_id: r.player_id, team: r.team, is_captain: r.is_captain,
    rate_type: r.rate_type, amount: Number(r.amount) || 0,
  }));
  // Unmatched players have no id — confirm whether to create them.
  const newOnes = rows.filter(r => !r.player_id);
  if (newOnes.length) {
    const names = newOnes.map(r => r.display_name).join(', ');
    if (!confirm(`Create ${newOnes.length} new player(s) and charge them?\n${names}`)) return;
    for (const r of newOnes) {
      const p = await api.createPlayer({ name: r.display_name });
      charges.find(c => c === undefined);   // no-op safety
      charges[rows.indexOf(r)].player_id = p.id;
    }
    store.players = await api.players();
  }
  try {
    await api.createGameweek(gameweek, charges);
    toast('Game recorded — balances deducted ✓');
    clearForm();
    await loadDashboard();
  } catch (e) { toast(e.message, true); }
}

function clearForm() {
  rows = [];
  $('gdText').value = '';
  ['gdScore', 'gdComments', 'gdContractNo'].forEach(id => $(id).value = '');
  $('gdPreviewCard').hidden = true;
}

export function initGameday() {
  contractSeg($('gdContractSeg'), store.contracts, contractId, (id) => { contractId = id; recalcTotal(); });
  $('gdDate').value = today();
  $('gdParse').addEventListener('click', doParse);
  $('gdConfirm').addEventListener('click', doConfirm);
  $('gdClear').addEventListener('click', clearForm);
}

export function loadGameday() {
  // Keep the contract segment in sync if contracts loaded after init.
  contractSeg($('gdContractSeg'), store.contracts, contractId, (id) => { contractId = id; recalcTotal(); });
}
