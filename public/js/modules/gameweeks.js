// gameweeks.js — game history list + detail modal.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money, fmtDate, contractSeg, openModal, closeModal, rosterOptions } from '../util.js';
import { fixtureDate, dayName, describeDays, loadSchedule, markNoGame, reopenDate } from '../schedule-ui.js';

let contractId = 'sat';

/**
 * The season as a run of fixture dates, so a week that was never entered is
 * visible instead of simply absent. A date is played, explicitly not played, or
 * unaccounted for — and it is the last of those this panel exists to surface.
 */
async function renderSchedule() {
  const host = $('gwSchedule');
  if (!host) return;

  const s = await loadSchedule(contractId);
  if (!s) {
    host.innerHTML = `<p class="hint" style="margin:0 0 1rem;">
      No fixture days set for this contract, so the season cannot be tracked.</p>`;
    return;
  }

  const { expected, played, no_game: noGame, missing } = s.counts;
  const pct = expected ? Math.round(((played + noGame) / expected) * 100) : 100;
  const playsOn = describeDays(s.game_days);

  const pill = (d) => {
    const label = fixtureDate(d.date);
    if (d.state === 'played') {
      return `<button class="sched-pill is-played" data-open-gw="${d.gameweek_id}"
        title="Game recorded — ${d.num_players || 0} players. Click to open.">✓ ${label}</button>`;
    }
    if (d.state === 'no_game') {
      return `<button class="sched-pill is-skipped" data-undo-nogame="${d.date}"
        title="${d.reason ? esc(d.reason) : 'No game'} — click to undo">— ${label}</button>`;
    }
    return `<button class="sched-pill is-missing" data-missing="${d.date}"
      title="Nothing recorded for this date">? ${label}</button>`;
  };

  host.innerHTML = `
    <div class="sched-panel">
      <div class="sched-head">
        <div>
          <strong>Season so far</strong>
          <span class="hint"> · plays ${esc(playsOn)} · from ${fixtureDate(s.season_start)}</span>
        </div>
        <div class="hint">
          ${played} played · ${noGame} no game ·
          <strong style="color:${missing ? 'var(--warning)' : 'var(--success)'}">${missing} unaccounted for</strong>
        </div>
      </div>
      <div class="sched-bar" title="${pct}% of fixture dates accounted for">
        <span style="width:${pct}%"></span>
      </div>
      ${s.next_missing ? `
        <div class="sched-next">
          <div>Next to account for: <strong>${fixtureDate(s.next_missing)}</strong>
            <span class="hint">(${dayName(s.next_missing)})</span></div>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
            <button class="btn btn-sm" data-enter="${s.next_missing}">Enter this game</button>
            <button class="btn btn-secondary btn-sm" data-nogame="${s.next_missing}">No game that day</button>
          </div>
        </div>` : `
        <p class="hint" style="margin:0.6rem 0 0;">Every fixture date up to today is accounted for.</p>`}
      <div class="sched-pills">${s.days.map(pill).join('')}</div>
      ${s.off_schedule.length ? `<p class="hint" style="margin:0.7rem 0 0;">
        Also recorded off the usual days: ${s.off_schedule.map(g => fixtureDate(g.date)).join(', ')}</p>` : ''}
    </div>`;

  const refresh = () => { renderSchedule(); render(); };

  host.querySelectorAll('[data-open-gw]').forEach(b =>
    b.addEventListener('click', () => detail(b.dataset.openGw)));

  host.querySelectorAll('[data-nogame], [data-missing]').forEach(b =>
    b.addEventListener('click', async () => {
      if (await markNoGame(contractId, b.dataset.nogame || b.dataset.missing)) refresh();
    }));

  host.querySelectorAll('[data-undo-nogame]').forEach(b =>
    b.addEventListener('click', async () => {
      if (await reopenDate(contractId, b.dataset.undoNogame)) refresh();
    }));

  host.querySelectorAll('[data-enter]').forEach(b =>
    b.addEventListener('click', () => {
      // Game Day is where a game is actually entered; carry the date across so
      // it does not have to be retyped.
      sessionStorage.setItem('fmss:gameDate', b.dataset.enter);
      document.querySelector('nav button[data-view="gameday"]')?.click();
    }));
}

async function render() {
  const rows = await api.gameweeks(contractId);
  const rowsList = Array.isArray(rows) ? rows : [];
  const gwTable = $('gwTable');
  if (!gwTable || !gwTable.querySelector('tbody')) return;

  const tbody = gwTable.querySelector('tbody');
  tbody.innerHTML = rowsList.map(g => {
    // The gameweeks LIST used to carry no payment-status data at all — only
    // num_players and a charged total — so Settlement/Collected had nothing to
    // work with and showed "—" on every row, even for games with real charges.
    // The repo now computes paid_count/pending_amount per row the same way it
    // already computes charged/charges_count, so the list can show real status
    // without fetching every game's full charge detail.
    // Prefer charges_count over num_players — the latter counts everyone named in
    // the original message, including unmatched people who were never billed.
    const playerCount = g.charges_count ?? Number(g.num_players) ?? 0;
    const totalCharged = Number(g.charged) || 0;

    const known = playerCount > 0;
    const paidCount = Number(g.paid_count) || 0;
    const pendingAmount = Number(g.pending_amount) || 0;
    // A game can carry charges that are all worth 0 — the bulk-imported seasons
    // are attendance records, not bills. pending_amount is 0 for those too, so
    // without this they read as "✓ Collected" when nothing was ever billed.
    const billed = totalCharged > 0;
    const collectionRate = known && billed ? Math.round((paidCount / playerCount) * 100) : null;

    // A pre-baseline game was settled on the credit sheets before any of this
    // existed. Saying "no charges" about it invites someone to go looking for
    // the missing money; saying where it was settled does not.
    const statusColor = !known || !billed ? 'var(--text-muted)'
      : pendingAmount === 0 ? 'var(--success)'
        : pendingAmount < totalCharged / 2 ? 'var(--warning)' : 'var(--danger)';
    // Who still owes, and how much each. A total says money is out there without
    // saying whose pocket it is in, which is the one thing you need in order to
    // go and get it — and the names ride along in the row the total came from.
    const owing = (g.pending_names || '').split(';').filter(Boolean)
      .map((pair) => {
        const cut = pair.lastIndexOf('|');
        return { name: pair.slice(0, cut), amount: Number(pair.slice(cut + 1)) || 0 };
      })
      .sort((a, b) => b.amount - a.amount);

    const statusText = g.historical && !billed
      ? '<span title="Played before this app tracked money. Settled on the credit sheets, and already inside the opening balances.">settled in the sheets</span>'
      : !known ? '—'
        : !billed ? 'no charges'
          : pendingAmount === 0 ? '✓ Collected' : `⏳ ${money(pendingAmount)} pending`;

    return `
      <tr data-gw="${g.id}" style="cursor:pointer;">
        <td><input type="checkbox" class="gw-pick" data-id="${g.id}" title="Select for bulk delete"></td>
        <td class="num"><strong>${esc(fmtDate(g.date))}</strong></td>
        <td class="num">#${g.contract_number || '—'}</td>
        <td class="num">${playerCount} players</td>
        <td class="num"><strong>${money(totalCharged)}</strong></td>
        <td><span style="color: ${statusColor}; font-weight: 600;">${statusText}</span></td>
        <td class="num" style="font-size: 0.85rem; color: var(--text-muted);">${collectionRate === null ? '—' : collectionRate + '%'}</td>
        <td>${owing.length
    ? owing.map(o => `<div style="white-space:nowrap">${esc(o.name)}
          <strong style="color: var(--danger)">${money(o.amount)}</strong></div>`).join('')
    : '<span class="hint">—</span>'}</td>
        <td>${esc(g.score || '—')}</td>
        <td class="row-actions">
          ${!g.historical ? `<button class="btn btn-sm" data-gw-edit="${g.id}" style="padding: 0.3rem 0.6rem;">✏️</button>` : '<span class="hint">📋</span>'}
        </td>
      </tr>`;
  }).join('') || '<tr><td colspan="10" class="hint">No gameweeks recorded.</td></tr>';

  gwTable.querySelectorAll('tr[data-gw]').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (!e.target.closest('[data-gw-edit]')) detail(tr.dataset.gw);
    });
  });

  // Bulk delete — imported seasons often need a re-do, and removing 30 games one
  // dialog at a time is unusable.
  const picks = () => [...gwTable.querySelectorAll('.gw-pick:checked')].map(c => c.dataset.id);
  const syncBulk = () => {
    const n = picks().length;
    const bar = $('gwBulkBar');
    if (bar) { bar.hidden = n === 0; }
    const count = $('gwSelCount');
    if (count) count.textContent = String(n);
  };
  gwTable.querySelectorAll('.gw-pick').forEach(cb => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', syncBulk);
  });
  const all = $('gwSelectAll');
  if (all) {
    all.checked = false;
    all.onclick = (e) => e.stopPropagation();
    all.onchange = () => {
      gwTable.querySelectorAll('.gw-pick').forEach(cb => { cb.checked = all.checked; });
      syncBulk();
    };
  }
  syncBulk();
  const del = $('gwBulkDelete');
  if (del) del.onclick = () => confirmBulkDelete(picks(), rowsList);

  gwTable.querySelectorAll('[data-gw-edit]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Opens the same game panel the row itself opens. This used to open a
      // separate Record Payments modal that was handed a LIST row — which
      // carries no charges — so it bailed out with a toast every time and had
      // been unreachable for as long as the list stopped returning them.
      detail(btn.dataset.gwEdit);
    });
  });
}

// Deleting a game reverses its charges, so say plainly what is going to happen.
function confirmBulkDelete(ids, rowsList) {
  if (!ids.length) { toast('Nothing selected', true); return; }
  const games = rowsList.filter(g => ids.includes(g.id));
  const charged = games.reduce((s, g) => s + (Number(g.charged) || 0), 0);

  openModal(`Delete ${ids.length} game(s)?`, `
    <div class="panel panel-danger">
      <div class="panel-title">⚠️ This cannot be undone</div>
      <div class="panel-body">
        ${ids.length} game(s) and every charge on them will be removed.
        ${charged ? `<strong>${money(charged)} AED</strong> of charges will be reversed, so the
           players involved will see their balances change.`
          : 'These carry no charges, so no balance will move.'}
      </div>
    </div>
    <div class="panel-scroll">
      ${games.map(g => `<div class="panel-row"><strong>${esc(fmtDate(g.date))}</strong>
        <span class="hint">${g.charges_count ?? g.num_players ?? 0} players</span>
        <span class="hint">${money(Number(g.charged) || 0)}</span></div>`).join('')}
    </div>
    <label class="confirm-check">
      <input type="checkbox" id="gwDelOk">
      <span>Yes, delete these ${ids.length} game(s)</span>
    </label>
    <div class="btn-row mt">
      <button class="btn btn-danger" id="gwDelGo" disabled>Delete</button>
      <button class="btn btn-secondary" id="gwDelCancel">Cancel</button>
    </div>`);

  $('gwDelOk').addEventListener('change', (e) => { $('gwDelGo').disabled = !e.target.checked; });
  $('gwDelCancel').addEventListener('click', closeModal);
  $('gwDelGo').addEventListener('click', async () => {
    $('gwDelGo').disabled = true;
    let ok = 0;
    const failed = [];
    for (const id of ids) {
      try { await api.deleteGameweek(id); ok++; }
      catch (e) { failed.push(`${id}: ${e.message}`); }
    }
    closeModal();
    toast(failed.length ? `Deleted ${ok}, ${failed.length} failed` : `✓ Deleted ${ok} game(s)`, !!failed.length);
    if (failed.length) console.error('bulk delete failures', failed);
    render();
  });
}

// Gameweek detail — shows the ORIGINAL pasted text alongside the linked players,
// so names the importer could not match can be spotted and added by hand.
async function detail(id) {
  const g = await api.gameweek(id);
  const contract = (store.contracts.find(c => c.id === g.contract_id) || {}).name || '';
  const charges = g.charges || [];
  const teams = [...new Set(charges.map(c => c.team).filter(Boolean))];
  const total = charges.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const toCollect = charges
    .filter(c => c.is_cash && !c.paid)
    .reduce((s, c) => s + (Number(c.amount) || 0), 0);

  // Which names in the raw text have no linked player? Rough, but it is the
  // whole point of showing the raw text — it points at what to add.
  const linked = new Set(charges.map(c => String(c.player_name || '').toLowerCase()));
  const rawWords = (g.teams_raw || '').split(/[\s,:]+/)
    .map(w => w.replace(/[^\p{L}\p{N}'-]/gu, '').trim())
    .filter(w => w.length > 2 && !/^(red|blue|white|black|green|yellow|team|vs|game|no|capt)$/i.test(w));
  const possiblyMissing = [...new Set(rawWords.filter(w =>
    ![...linked].some(n => n.includes(w.toLowerCase()) || w.toLowerCase().includes(n))))];

  const teamOptions = (sel) => ['', ...teams, 'Red', 'Blue', 'White']
    .filter((t, i, a) => a.indexOf(t) === i)
    .map(t => `<option value="${esc(t)}" ${t === sel ? 'selected' : ''}>${esc(t || '—')}</option>`).join('');

  // Only a guest settling their own charge has anything to collect. A contract
  // player's charge came off a balance the club already holds the moment the
  // game was saved, and their `paid` flag is never set by anything — so showing
  // every row as an unticked "owes" box said the whole team still owed for a
  // game that was already paid for, and offered a tickbox that changed nothing.
  const settleCell = (c) => {
    // An imported game was settled on the credit sheets before any of this
    // existed, so none of the three modes describes it and saying "on balance"
    // would claim a deduction that never happened.
    if (g.historical) {
      return `<span class="hint"
               title="Played before this app tracked money. Settled on the credit sheets and already inside the opening balances.">settled in the sheets</span>`;
    }
    if (c.settle_mode === 'kitty') {
      return `<span class="tag"
               title="The club pot carries this place: nobody is billed and nobody owes it.">kitty covers it</span>`;
    }
    if (!c.is_cash) {
      const elsewhere = c.settled_by !== c.player_id;
      return `<span class="hint"
               title="Came off ${esc(elsewhere ? `${c.settler_name || 'someone else'}'s` : 'their own')} balance when this game was recorded. Nothing to collect.">${
  elsewhere ? `${esc(c.settler_name || 'someone else')} pays` : 'on balance'}</span>`;
    }
    return `<label class="tag ${c.paid ? 'tag-paid' : 'tag-due'}"
             style="display:inline-flex;align-items:center;gap:.35rem;cursor:pointer"
             title="${c.paid
    ? 'Cash collected' + (c.paid_method ? ' by ' + esc(c.paid_method) : '') + ' — untick to put it back to owed.'
    : 'Cash still to collect. Tick it once you have the money and the kitty tops up.'}">
        <input type="checkbox" class="ch-paid" data-charge="${c.id}" ${c.paid ? 'checked' : ''}>
        ${c.paid ? 'collected' : 'to collect'}
      </label>`;
  };

  // Who carries this charge. Anyone can, including someone who did not play —
  // a member covering a guest is usually not on the pitch that night.
  const payerOptions = (c) =>
    `<option value="" ${c.settled_by === c.player_id ? 'selected' : ''}>themselves</option>`
    + rosterOptions(store.players, c.settled_by, { includeGuests: false });

  const rows = charges.map(c => {
    const owing = c.is_cash && !c.paid;
    // An imported game is an attendance record behind a closed baseline: its
    // charges are all worth 0 and move nothing. Offering settlement controls on
    // it invites edits that cannot mean anything, and printing "0.00" twelve
    // times is noise standing in for information.
    const readOnly = g.historical;
    return `
    <div class="charge-row${owing ? ' is-owing' : ''}" data-charge="${c.id}">
      <div class="cr-who">
        <span class="cr-name">${esc(c.player_name)}</span>
        ${c.is_captain ? '<span class="tag">C</span>' : ''}
        ${c.team ? `<span class="hint">${esc(c.team)}</span>` : ''}
        ${settleCell(c)}
      </div>
      <div class="cr-amount">${readOnly && !c.amount
    ? '<span class="hint">—</span>' : money(c.amount)}</div>
      ${readOnly ? '' : `
      <div class="cr-controls">
        <select class="ch-mode" data-charge="${c.id}"
                title="Off a contract balance, cash still to collect, or carried by the club pot">
          <option value="balance" ${c.settle_mode === 'balance' ? 'selected' : ''}>off balance</option>
          <option value="cash" ${c.settle_mode === 'cash' ? 'selected' : ''}>cash to collect</option>
          <option value="kitty" ${c.settle_mode === 'kitty' ? 'selected' : ''}>kitty covers it</option>
        </select>
        <select class="ch-payer" data-charge="${c.id}"
                title="Whose money settles this charge">${payerOptions(c)}</select>
        <select class="ch-fund" data-charge="${c.id}" ${c.settle_mode === 'balance' ? '' : 'disabled'}
                title="Which of their balances it comes off — a Mon/Thu regular playing one odd Saturday can pay from their Mon/Thu credit">
          ${(store.contracts || []).map(ct => `<option value="${esc(ct.id)}"${
  ct.id === c.settle_contract_id ? ' selected' : ''}>from ${esc(ct.name)}</option>`).join('')}
        </select>
        <select class="ch-team" data-charge="${c.id}">${teamOptions(c.team)}</select>
        <label class="hint" style="display:flex;align-items:center;gap:.3rem;white-space:nowrap">
          <input type="checkbox" class="ch-capt" data-charge="${c.id}" ${c.is_captain ? 'checked' : ''}> captain
        </label>
        <span class="cr-spacer"></span>
        <button class="link-btn" data-remove="${c.id}" title="Remove from this game">✕ remove</button>
      </div>`}
    </div>`;
  }).join('');

  const players = (store.players || []).filter(p => !charges.some(c => c.player_id === p.id));

  openModal(`${fmtDate(g.date)} · ${esc(contract)}`, `
    ${g.score ? `<p class="muted"><strong>Result:</strong> ${esc(g.score)}</p>` : ''}

    <h4 class="mini-h mt">Original text</h4>
    <pre class="raw-block">${esc(g.teams_raw || '(none recorded)')}</pre>
    ${g.captains_raw ? `<p class="hint">Captains column: ${esc(g.captains_raw)}</p>` : ''}

    ${possiblyMissing.length ? `
      <div class="panel panel-warn mt">
        <div class="panel-title">${possiblyMissing.length} name(s) in the text with no linked player</div>
        <div class="panel-body">${possiblyMissing.map(esc).join(' · ')}</div>
      </div>` : ''}

    <h4 class="mini-h mt">Players (${charges.length}${total ? ` · ${money(total)} AED` : ''})</h4>
    ${g.historical
    ? `<p class="hint">Imported from the results sheet — who played, not what it cost.
        These games were settled on the credit sheets and are already inside the
        opening balances, so there is nothing here to change.</p>`
    : `${toCollect > 0
      ? `<p class="hint">${money(total - toCollect)} came off balances when this game was
          recorded. <strong>${money(toCollect)}</strong> is guest cash still to collect.</p>`
      : ''}
      <p class="hint">Every change here is saved the moment you make it — balances and
        the kitty follow straight away. There is nothing to submit.</p>`}
    <div id="gwCharges">${rows || '<p class="hint">Nobody linked yet.</p>'}</div>

    ${g.historical ? '' : `
    <h4 class="mini-h mt">Add a player</h4>
    <div class="quick-row">
      <select id="gwAddPlayer" style="flex:1 1 150px">
        <option value="">Select player…</option>
        ${rosterOptions(players)}
      </select>
      <select id="gwAddTeam" style="flex:0 1 110px">${teamOptions(teams[0] || '')}</select>
      <label class="hint" style="display:flex;align-items:center;gap:.3rem"><input type="checkbox" id="gwAddCapt"> Captain</label>
      <input type="number" id="gwAddAmount" class="qw-amount" value="0" min="0" step="0.5" title="0 records the appearance without charging">
      <button class="btn btn-sm" id="gwAddBtn">Add</button>
    </div>
    <p class="hint">Amount 0 records the appearance without moving any balance.</p>

    <div class="quick-row mt">
      <button class="btn btn-secondary" onclick="window.editGameweekClick('${g.id}')">Edit amounts / result</button>
      <span class="cr-spacer"></span>
      <button class="btn" data-gw-done>Done</button>
    </div>`}`);

  const reopen = () => detail(id);

  // Nothing to save — every control writes as it changes — but a panel with no
  // way out but the ✕ reads as an unfinished form. Done just closes it.
  document.querySelector('[data-gw-done]')?.addEventListener('click', closeModal);

  $('gwAddBtn')?.addEventListener('click', async () => {
    const pid = $('gwAddPlayer').value;
    if (!pid) { toast('Pick a player', true); return; }
    try {
      await api.addCharge(id, {
        player_id: pid,
        team: $('gwAddTeam').value,
        is_captain: $('gwAddCapt').checked,
        amount: Number($('gwAddAmount').value) || 0,
      });
      toast('Player added ✓'); reopen(); render();
    } catch (e) { toast(e.message, true); }
  });

  document.querySelectorAll('[data-remove]').forEach(b =>
    b.addEventListener('click', async () => {
      try { await api.removeCharge(id, b.dataset.remove); toast('Removed'); reopen(); render(); }
      catch (e) { toast(e.message, true); }
    }));

  const patch = async (chargeId) => {
    const team = document.querySelector(`.ch-team[data-charge="${chargeId}"]`).value;
    const capt = document.querySelector(`.ch-capt[data-charge="${chargeId}"]`).checked;
    try { await api.updateCharge(id, chargeId, { team, is_captain: capt }); toast('Updated'); }
    catch (e) { toast(e.message, true); }
  };
  document.querySelectorAll('.ch-paid').forEach(el =>
    el.addEventListener('change', async () => {
      try {
        await api.setChargePaid(id, el.dataset.charge, el.checked, el.checked ? 'cash' : null);
        toast(el.checked ? 'Marked paid' : 'Marked unpaid');
        reopen(); render();
      } catch (e) { toast(e.message, true); el.checked = !el.checked; }
    }));

  document.querySelectorAll('.ch-team').forEach(el =>
    el.addEventListener('change', () => patch(el.dataset.charge)));
  document.querySelectorAll('.ch-capt').forEach(el =>
    el.addEventListener('change', () => patch(el.dataset.charge)));

  // Both corrections go through one call, because they are one decision: how
  // this charge is settled. Sending them separately would briefly leave the
  // charge in a state neither control asked for.
  const resettle = async (chargeId) => {
    const mode = document.querySelector(`.ch-mode[data-charge="${chargeId}"]`);
    const payer = document.querySelector(`.ch-payer[data-charge="${chargeId}"]`);
    const fund = document.querySelector(`.ch-fund[data-charge="${chargeId}"]`);
    try {
      await api.setChargeSettlement(id, chargeId, {
        mode: mode.value,
        charged_to: payer.value || null,
        // Only send it when it differs from the game's own contract, so an
        // ordinary charge keeps a NULL and behaves exactly as before.
        settle_contract_id: fund && fund.value !== g.contract_id ? fund.value : null,
      });
      toast({ cash: 'Now cash to collect', kitty: 'The kitty covers this place',
        balance: 'Now settled off a balance' }[mode.value]);
    } catch (e) {
      toast(e.message, true);
    }
    // Re-read either way. On success the balances and the kitty have moved; on
    // failure the controls must go back to what the server actually holds
    // rather than sit there showing a change it refused.
    reopen(); render();
  };
  document.querySelectorAll('.ch-mode, .ch-payer, .ch-fund').forEach(el =>
    el.addEventListener('change', () => resettle(el.dataset.charge)));
}

// The Record Payments modal that stood here is gone. Every part of it was
// either dead or wrong: it read `charges` off a list row that has none, so it
// never rendered; its "Mark Paid" button only raised a toast and changed
// nothing; and its "Add to Ledger" wrote a CONTRIBUTION equal to the charge,
// which for guest cash credited the guest's balance instead of putting the money
// in the kitty — inventing a balance for someone who does not keep one.
//
// The game panel does all of it properly: collect a guest's cash, move a charge
// between cash and a balance, change who settles it, and the kitty follows.

// Edit gameweek — populate and show modal
window.editGameweekClick = async (gameweekId) => {
  try {
    const g = await api.gameweek(gameweekId);
    editGameweekModal(g);
  } catch (e) {
    toast(`Failed to load game: ${e.message}`, true);
  }
};

function editGameweekModal(g) {
  const modal = $('editGameweekModal');
  $('egTitle').textContent = `Edit ${fmtDate(g.date)}`;
  $('egGameType').value = g.game_type || 'regular';
  $('egTournamentName').value = g.tournament_name || '';
  $('egScore').value = g.score || '';
  $('egComments').value = g.comments || '';

  // Populate charges table
  const tbody = $('egChargesTable').querySelector('tbody');
  tbody.innerHTML = (g.charges || []).map(ch => `
    <tr>
      <td>${esc(ch.player_name)}</td>
      <td>${ch.team || '—'}</td>
      <td>${ch.is_captain ? '✓' : ''}</td>
      <td><input type="text" class="input-mini" value="${ch.rate_type}" disabled></td>
      <td class="num"><span class="muted">${money(ch.amount)}</span></td>
      <td class="num"><input type="number" class="input-mini" value="${ch.amount}" data-charge-id="${ch.id}" step="1"></td>
      <td class="num"><span class="charge-delta" data-charge-id="${ch.id}">0</span></td>
    </tr>
  `).join('');

  // Wire up preview
  $('egPreview').onclick = () => previewImpact(g.id);
  $('egSave').onclick = () => saveGameweekEdits(g.id);
  $('egClose').onclick = () => { modal.hidden = true; };

  modal.hidden = false;
}

async function previewImpact(gameweekId) {
  try {
    const edits = Array.from($('egChargesTable').querySelectorAll('input[type="number"]')).map(inp => ({
      chargeId: inp.dataset.chargeId,
      newAmount: Number(inp.value),
    }));

    const impact = await api.get(`/gameweeks/${gameweekId}/impact?chargeEdits=${JSON.stringify(edits)}`);
    const preview = $('egImpactPreview');
    preview.style.display = 'block';
    $('egImpactText').innerHTML = `
      <strong>${impact.changedCount} charges changed</strong><br>
      Original total: ${money(impact.originalTotal)} AED<br>
      New total: ${money(impact.newTotal)} AED<br>
      Delta: ${money(impact.totalDelta)} AED<br>
      ${impact.playerImpacts.map(pi => `<div class="hint">${pi.playerName}: ${money(pi.oldAmount)} → ${money(pi.newAmount)}</div>`).join('')}
    `;
  } catch (e) {
    toast(`Failed to calculate impact: ${e.message}`, true);
  }
}

async function saveGameweekEdits(gameweekId) {
  try {
    const edits = Array.from($('egChargesTable').querySelectorAll('input[type="number"]')).map(inp => ({
      chargeId: inp.dataset.chargeId,
      newAmount: Number(inp.value),
    }));

    await api.put(`/gameweeks/${gameweekId}`, {
      metadata: {
        game_type: $('egGameType').value,
        tournament_name: $('egTournamentName').value,
        score: $('egScore').value,
        comments: $('egComments').value,
      },
      chargeEdits: edits,
      reason: 'Web UI edit',
      autoRecalculate: $('egAutoRecalc').checked,
    });

    $('editGameweekModal').hidden = true;
    toast('Game updated with audit trail ✓');
    render();
  } catch (e) {
    toast(`Failed to save: ${e.message}`, true);
  }
}

export function initGameweeks() {}

export function loadGameweeks() {
  contractSeg($('gwContractSeg'), store.contracts, contractId, (id) => {
    contractId = id; render(); renderSchedule();
  });
  return Promise.all([render(), renderSchedule()]);
}
