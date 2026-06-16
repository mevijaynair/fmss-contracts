// settings.js — edit each contract's venue, cost per game, and rate card.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc } from '../util.js';

const RATE_FIELDS = [
  ['contracted_10', 'Contract rate (10-player)'],
  ['contracted_12', 'Contract rate (12-player)'],
  ['captain_10', 'Captain rate (10-player)'],
  ['captain_12', 'Captain rate (12-player)'],
  ['noncontract', 'Non-contract rate'],
];

function card(c) {
  return `
  <div class="sams-card" style="margin-bottom:1.25rem;">
    <div class="card-header"><h3 class="card-title">${esc(c.name)}</h3></div>
    <div class="form-row">
      <div class="form-group"><label>Name</label><input id="s_${c.id}_name" value="${esc(c.name)}"></div>
      <div class="form-group"><label>Venue</label><input id="s_${c.id}_venue" value="${esc(c.venue || '')}"></div>
    </div>
    <div class="form-group mt" style="max-width:240px;"><label>Cost per game (AED)</label>
      <input type="number" id="s_${c.id}_cost" value="${c.cost_per_gw}"></div>
    <h4 class="mini-h mt">Rate card (AED per player)</h4>
    <div class="form-row">
      ${RATE_FIELDS.map(([k, lbl]) =>
        `<div class="form-group"><label>${lbl}</label>
          <input type="number" id="s_${c.id}_${k}" value="${c.rates[k] ?? 0}"></div>`).join('')}
    </div>
    <button class="btn mt" data-save="${c.id}">Save ${esc(c.name.split(' ')[0])}</button>
  </div>`;
}

export function initSettings() {}

export async function loadSettings() {
  store.contracts = await api.contracts();
  $('settingsCards').innerHTML = store.contracts.map(card).join('');
  $('settingsCards').querySelectorAll('[data-save]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const id = btn.dataset.save;
      const rates = {};
      RATE_FIELDS.forEach(([k]) => rates[k] = Number($(`s_${id}_${k}`).value) || 0);
      try {
        await api.updateContract(id, {
          name: $(`s_${id}_name`).value, venue: $(`s_${id}_venue`).value,
          cost_per_gw: Number($(`s_${id}_cost`).value) || 0, rates,
        });
        store.contracts = await api.contracts();
        toast('Contract saved ✓');
      } catch (e) { toast(e.message, true); }
    }));
}
