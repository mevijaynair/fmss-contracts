// players.js — per-contract ledger table + add player + timeline & stats detail.
import { api } from '../api.js';
import { store, toast, defaultContract } from '../store.js';
import { $, esc, money, balCell, contractSeg, openModal, closeModal, today, fmtDate } from '../util.js';
import { balanceLine, dividedBar, pairedBars, wireCharts } from '../charts.js';
import { initOpeningBalances, loadOpeningBalances } from './opening_balances.js';
import { splitNote, wireSplitNotes } from './contributions.js';
import { renderStandingSheet } from './report.js';
import { shareClubSnapshot, sharePlayerSnapshot } from './share.js';

let contractId = null;   // resolved on first load — see defaultContract()

// One screen, two shapes of the same money.
//
// The working ledger is what you act in: every player, filters, a Pay button
// and a ⋮ menu on each row. The standing sheet is the same balances laid out
// to be screenshotted and sent round, so it drops the guests, the dormant and
// the retired and carries its own period header.
//
// They were two destinations with a link and a back link, which meant the
// contract you had chosen did not follow you between them. One shape shows at
// a time — the sheet is not much use as a screenshot with a filter bar and an
// actions column in it.
let viewMode = 'ledger';   // 'ledger' | 'both' | 'sheet' | 'guests'
const MODES = [['ledger', 'Working', 'The squad on one contract, with filters and actions'],
  ['both', 'Both', 'Every member across both contracts at once — a view, not a merge'],
  ['sheet', 'Standing sheet', 'The same balances, laid out as the sheet you send round'],
  ['guests', 'Guests', 'One-off players who pay cash — who owes what']];

let currentDetailPlayerId = null;
let searchQuery = '';
let sortBy = 'name';
let filterStatus = 'all';
let filterBalance = 'all';
// Who is still turning up. Players drift away without announcing it, so the
// only way to find them was to remember who you had not seen — with a third of
// the roster dormant, that is not a thing anyone can do from a list of names.
// "Quiet" is a prompt, not a verdict: the app cannot know somebody has left,
// only that they have not played for a while. Marking them is still a person's
// decision, which is what hide_from_sheet records.
let filterActivity = 'all';   // all | quiet | left
const QUIET_DAYS = 90;

/** Whole days since an ISO date, or null when they have never played. */
function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}
// Guests are one-off outside players, and there are more of them than there
// are members — twenty-one against forty-two. They keep no balance and buy no
// games: they hand over cash on the day, and that is the whole of their
// involvement with the ledger. So they are not in it at all. A row of theirs
// would read 0, "Out of contract", no games left, which is three columns of
// nothing three times a week.
//
// What the club actually needs to know about a guest is who owes cash, and
// that has a tab of its own now. The old "show guests" tick was a way of
// putting them back into a sheet they do not belong in.

const STATUSES = ['In Contract', 'Refill needed', 'Out of contract'];

function isPlayer() { return store.user?.role === 'player'; }

// Status from RUNWAY, not a flat cash threshold — the same rule the dashboard
// uses. 60 AED is comfortable at 30/game and nearly spent at 35/game, and a fixed
// 150 could not tell those apart; the two views also disagreed as a result.
function statusFromBalance(balance, gamesLeft) {
  if (balance < 0) return { text: '🚨 Owes money', cls: 'tag-critical' };
  if (gamesLeft === null || gamesLeft === undefined) {
    return balance < 150
      ? { text: '⚠️ Refill needed', cls: 'tag-due' }
      : { text: '✓ In credit', cls: 'tag-paid' };
  }
  if (gamesLeft < 1) return { text: '⚠️ Cannot cover next game', cls: 'tag-due' };
  if (gamesLeft < 2) return { text: '⚠️ 1 game left', cls: 'tag-due' };
  return { text: `✓ ${gamesLeft} games left`, cls: 'tag-paid' };
}

/**
 * One record turns out to be two people.
 *
 * The club has two men called Rohit. A name in a team sheet resolves to
 * whichever record matches first, so one of them quietly collected the other's
 * games — and nothing on any screen said so.
 *
 * The modal asks the only question a person can answer: of these games, which
 * ones are the OTHER Rohit's? Everything is shown, nothing is guessed. The
 * server moves the ticked rows and refuses the whole thing unless the two
 * balances afterwards add up to the one balance before.
 */
async function splitPlayerModal(playerId) {
  let data;
  try { data = await api.get(`/admin/players/${playerId}/split-preview`); }
  catch (e) { toast(e.message, true); return; }

  const { player, charges, contributions } = data;
  if (!charges.length && !contributions.length) {
    toast(`${player.name} has no games or payments to divide`, true);
    return;
  }

  openModal(`Two people called ${player.name}`, `
    <p class="hint">Tick what belongs to the <strong>other</strong> person. Those rows move to a
      new record; everything left stays here. No amount changes and the pot does not move —
      this only says whose game was whose.</p>
    <div class="form-group mt"><label for="sp_name">The other person's name</label>
      <input type="text" id="sp_name" placeholder="e.g. ${esc(player.name)} 2, or a surname">
      <p class="hint" style="margin:0.35rem 0 0">It has to be tellable apart from
        ${esc(player.name)} in a pasted team sheet, or you are back where you started.</p></div>
    <label class="login-shared" style="margin:0 0 1rem"><input type="checkbox" id="sp_guest">
      <span>They are a guest — a walk-up who pays cash on the day and keeps no balance.
        This is the usual case when two people share a name: one is on a contract and the
        other is somebody who came along.</span></label>
    <h4 class="mini-h mt">Games (${charges.length})</h4>
    <div class="split-list">${charges.map(c => `
      <label class="split-row">
        <input type="checkbox" data-split-charge="${esc(c.id)}">
        <span><strong>${esc(fmtDate(c.date))}</strong>
          <span class="hint">${esc(c.contract_name || c.contract_id)}${c.team ? ` · ${esc(c.team)}` : ''}${
  c.is_captain ? ' · captain' : ''}${c.settles_cash ? ` · cash${c.paid ? ', paid' : ', owed'}` : ''}</span></span>
        <span class="num">${money(c.amount)}</span>
      </label>`).join('')}</div>
    ${contributions.length ? `<h4 class="mini-h mt">Payments in (${contributions.length})</h4>
    <div class="split-list">${contributions.map(q => `
      <label class="split-row">
        <input type="checkbox" data-split-contrib="${esc(q.id)}">
        <span><strong>${esc(fmtDate(q.date))}</strong>
          <span class="hint">${esc(q.comments || '')}</span></span>
        <span class="num">${money(q.amount)}</span>
      </label>`).join('')}</div>` : ''}
    <button class="btn full-w mt" id="sp_go">Split them apart</button>`, { wide: true });

  $('sp_go').addEventListener('click', async () => {
    const pick = (attr) => [...document.querySelectorAll(`[data-split-${attr}]:checked`)]
      .map(el => el.dataset[attr === 'charge' ? 'splitCharge' : 'splitContrib']);
    const chargeIds = pick('charge');
    const contributionIds = pick('contrib');
    const name = $('sp_name').value.trim();
    if (!name) { toast('The other person needs a name', true); return; }
    if (!chargeIds.length && !contributionIds.length) {
      toast('Tick what belongs to them', true); return;
    }
    if (!confirm(`Move ${chargeIds.length} game(s) and ${contributionIds.length} payment(s) `
      + `from ${player.name} to ${name}?\n\nNo amount changes. If the two balances do not add `
      + 'up to what they add up to now, nothing is written at all.')) return;
    try {
      const out = await api.post(`/admin/players/${playerId}/split`, {
        name, charge_ids: chargeIds, contribution_ids: contributionIds,
        player_type: $('sp_guest').checked ? 'outside' : 'regular',
      });
      closeModal();
      store.players = await api.players();
      toast(`${out.created.name} pulled out of ${out.original.name}'s record`);
      render();
    } catch (e) { toast(e.message, true); }
  });
}

/**
 * The guests, and the only thing about them the club needs: who owes cash.
 *
 * They are out of the ledger and out of the standing sheet, and both are
 * better for it — twenty-one one-off names at a 0 balance and "Out of
 * contract" is three columns of nothing, three times a week, on top of the
 * squad you are actually trying to read. But out of sight is not the same as
 * gone: a guest who played and has not paid is real money, and this is where
 * it is chased.
 *
 * It lists ANYONE who owes cash, guest or not — a member can settle a single
 * night in cash too, and splitting that across two screens by what kind of
 * person they are would be organising the list by the wrong thing. What these
 * rows have in common is that somebody has to hand over notes.
 *
 * Collecting is marked on the game itself, in Game History, because that is
 * what banks it in the pot. Offering a second button here would be a second
 * way to move the same money.
 */
/**
 * Doing the same thing to a dozen people at once.
 *
 * A third of the roster is walk-ups sitting in the ledger who ought to be on
 * the guest list, and another handful have stopped turning up. One at a time
 * through a ⋮ menu, that is forty clicks and a job nobody does — so the list
 * stays wrong, which is the actual problem.
 *
 * Applied PER PERSON on the server, not all or nothing: one member with games
 * settled off a balance must not stop the twelve beside them being moved. The
 * refusals come back by name and are shown, because a bulk action that
 * silently skips people is worse than one that refuses outright.
 */
function wireBulk() {
  const bar = $('plBulkBar');
  const all = $('plSelAll');
  if (!bar) return;
  const boxes = () => [...$('playersTable').querySelectorAll('.pl-pick')];
  const picked = () => boxes().filter(b => b.checked).map(b => b.value);

  const sync = () => {
    const n = picked().length;
    bar.hidden = n === 0;
    $('plSelCount').textContent = n;
    if (all) all.checked = n > 0 && n === boxes().length;
  };
  boxes().forEach(b => b.addEventListener('change', sync));
  if (all) {
    all.checked = false;
    all.onchange = () => { boxes().forEach(b => { b.checked = all.checked; }); sync(); };
  }
  sync();

  const run = async (label, body, confirmText) => {
    const ids = picked();
    if (!ids.length) return;
    if (!confirm(`${confirmText}\n\n${ids.length} player(s) selected.`)) return;
    try {
      const out = await api.post('/admin/players/bulk', { ids, ...body });
      store.players = await api.players();
      toast(out.refused.length
        ? `${out.done.length} ${label}. ${out.refused.length} refused — see below.`
        : `${out.done.length} ${label}`);
      if (out.refused.length) {
        // Named, with the reason each was refused. A list of what did not
        // happen is the whole value of a per-person bulk action.
        openModal('Some were not changed', `
          <p class="hint">${out.done.length} went through. These did not, and why:</p>
          <div class="split-list mt">${out.refused.map(r => `
            <div class="split-row"><span></span>
              <span><strong>${esc(r.name)}</strong><br>
                <span class="hint">${esc(r.why)}</span></span><span></span></div>`).join('')}</div>
          <button class="btn full-w mt" onclick="document.getElementById('modalClose').click()">Close</button>`,
        { wide: true });
      }
      render();
    } catch (e) { toast(e.message, true); }
  };

  bar.querySelectorAll('[data-bulk]').forEach(btn => {
    btn.onclick = () => {
      const what = btn.dataset.bulk;
      if (what === 'none') { boxes().forEach(b => { b.checked = false; }); sync(); return; }
      if (what === 'aside') {
        return run('set aside', { action: 'sheet', hidden: true },
          'Set these players aside as not playing?\n\nThey come off the Standing sheet and the '
          + 'rankings and keep their balance, their history and their place on this screen. '
          + 'No money moves.');
      }
      if (what === 'back') {
        return run('back on the sheet', { action: 'sheet', hidden: false },
          'Put these players back on the Standing sheet and the rankings?');
      }
      return run('moved to the guest list', { action: 'kind', kind: 'outside' },
        'Move these players to the guest list?\n\nGuests pay cash on the day and keep no '
        + 'balance, so they leave the ledger and the standing sheet.\n\nAnyone whose games '
        + 'were settled off a balance is refused and listed, because moving them would turn '
        + 'football they have paid for into cash they owe.');
    };
  });
}

/**
 * Every member's money across both nights at once.
 *
 * Not a merge — the balances stay exactly where they are and every charge
 * keeps the contract it was played on. This adds them up, the way Results
 * already reads a season across both nights, and it answers the question a
 * cashier asks before chasing anybody: does this person owe the club
 * anything, or are they simply short on one night and in credit on the other?
 *
 * The split is on the row beside the total, because "300 in credit" without
 * knowing it is all on Saturdays does not tell you whether they can play on
 * Monday. Runway is given per contract for the same reason: the same money
 * buys fewer Saturdays than Mondays, and one averaged number would be true of
 * neither night.
 */
async function renderCombined(host) {
  host.innerHTML = '<p class="hint">Loading…</p>';
  let rows = [];
  try { rows = await api.ledgers('combined') || []; }
  catch (e) { host.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }

  const cs = store.contracts || [];
  const members = rows.filter(l => l.player_type !== 'outside' && !l.is_sandbox
    && (l.present_balance !== 0 || l.games > 0));
  const chaseable = members.filter(l => l.special_role !== 'cashier');
  // Short on one night, covered once you look at both. Chasing these is
  // chasing money the club is already holding.
  const evensOut = chaseable.filter(l => l.present_balance >= 0
    && Object.values(l.contracts).some(c => c.present_balance < 0));
  const reallyOwes = chaseable.filter(l => l.present_balance < 0);
  const owedTotal = reallyOwes.reduce((s, l) => s + l.present_balance, 0);

  members.sort((a, b) => a.present_balance - b.present_balance);

  host.innerHTML = `
    <div class="sams-card">
      <div class="card-header">
        <h3 class="card-title">Both contracts together</h3>
        <span class="card-sub">A view, not a merge — every balance stays where it is</span>
      </div>
      ${evensOut.length ? `<div class="rep-collect">
        <div class="rep-collect-head">${evensOut.length} ${evensOut.length === 1
    ? 'player is' : 'players are'} in the red on one night but square across both</div>
        <div class="rep-collect-row"><span class="rep-collect-k">No need to chase</span>
          <span class="rep-collect-v">${evensOut.map(l =>
    `<span class="rep-owe"><strong>${esc(l.player_name)}</strong> ${money(l.present_balance)}</span>`)
    .join('')}</span></div>
      </div>` : ''}
      ${reallyOwes.length ? `<p class="hint">
        <strong>${reallyOwes.length}</strong> genuinely short, ${money(Math.abs(owedTotal))} in all.</p>` : ''}
      <div class="table-scroll">
        <table class="sams-table">
          <thead><tr><th>Player</th>
            ${cs.map(c => `<th class="num">${esc(c.name)}</th>`).join('')}
            <th class="num">Together</th>
            <!-- No sub-label: "Mon / Saturdays" reads as nonsense, and the
                 two figures are in the same order as the two balance columns
                 immediately to the left, which says it without saying it.
                 Each cell carries the full names and rates on hover. -->
            <th class="num" title="More games the whole balance buys on each contract, in the same order as the columns to the left">Covers</th>
            <th class="num">Games</th><th class="num">Paid in</th></tr></thead>
          <tbody>${members.map(l => `
            <tr>
              <td><strong>${esc(l.player_name)}</strong>${l.special_role === 'cashier'
    ? ' <span class="hint">cashier</span>' : ''}${l.hide_from_sheet
    ? ' <span class="hint">left</span>' : ''}</td>
              ${cs.map((c) => {
    const s = l.contracts[c.id];
    return `<td class="num">${s ? balCell(s.present_balance)
      : '<span class="hint">—</span>'}</td>`;
  }).join('')}
              <td class="num">${l.special_role === 'cashier'
    ? `<span class="bal zero" title="The float. Money put in up front to run the contracts.">${money(l.present_balance)}</span>`
    : balCell(l.present_balance)}</td>
              <td class="num" title="${esc((l.covers || [])
    .map(c => `${c.name}: ${Math.max(0, c.games_left ?? 0)} more at ${c.rate} a game`)
    .join(' · '))}">${l.special_role === 'cashier' ? '<span class="hint">—</span>'
    : (l.covers || []).map(c => `${Math.max(0, c.games_left ?? 0)}`).join(' / ')}</td>
              <td class="num">${l.games || 0}</td>
              <td class="num">${money(l.contributed)}</td>
            </tr>`).join('') || `<tr><td colspan="${cs.length + 5}" class="hint">Nobody yet.</td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="hint rep-key">Guests are not here — they keep no balance. "Covers" is how many
        more games the whole balance buys on each contract; the same money buys fewer of the
        dearer night, so it is given per contract rather than averaged into a figure that is
        true of neither.</p>
    </div>`;
}

async function renderGuests(host) {
  host.innerHTML = '<p class="hint">Loading…</p>';
  let owed = [];
  try { owed = await api.cashOutstanding(contractId) || []; }
  catch (e) { host.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }

  const guests = (store.players || []).filter(p => p.player_type === 'outside');
  const total = owed.reduce((s, r) => s + r.owed, 0);
  const nameOf = Object.fromEntries((store.players || []).map(p => [p.id, p]));

  host.innerHTML = `
    <div class="sams-card">
      <div class="card-header">
        <h3 class="card-title">Cash to collect</h3>
        <span class="card-sub">${guests.length} guest${guests.length === 1 ? '' : 's'} on the
          roster · they keep no balance, so nothing here is a ledger figure</span>
      </div>
      ${owed.length ? `
      <div class="rep-collect">
        <div class="rep-collect-head">${owed.length} ${owed.length === 1 ? 'person owes' : 'people owe'}
          <strong>${money(total)}</strong> between them</div>
      </div>
      <div class="table-scroll">
        <table class="sams-table">
          <thead><tr><th>Who</th><th>Contract</th><th class="num">Games</th>
            <th class="num">Owes</th><th>Last played</th><th></th></tr></thead>
          <tbody>${owed.map(r => `
            <tr>
              <td><strong>${esc(r.player_name || 'Guest')}</strong>${
  (nameOf[r.player_id]?.player_type || 'regular') !== 'outside'
    ? ' <span class="hint">member, paying cash</span>' : ''}</td>
              <td>${esc(store.contracts.find(c => c.id === r.contract_id)?.name || r.contract_id)}</td>
              <td class="num">${r.games}</td>
              <td class="num"><span class="bal neg">${money(r.owed)}</span></td>
              <td>${esc(fmtDate(r.last_game_date))}</td>
              <td class="row-actions">
                <button class="btn btn-secondary btn-sm" data-goto="gameweeks"
                  title="Marking it collected on the game is what puts the cash in the pot">Collect</button>
                ${(nameOf[r.player_id]?.player_type || 'regular') === 'outside'
    ? `<button class="btn btn-sm" data-kind="${esc(r.player_id)}" data-to="regular"
        title="They have joined a contract: move them to the squad, where they keep a balance">→ Squad</button>`
    : ''}
              </td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
      <p class="hint rep-key">Collecting is marked on the game itself, in Game history — that is
        what banks it in the kitty. A second button here would be a second way to move the same
        money.</p>`
    : `<div class="empty-state"><div class="es-icon">✅</div>
        <div class="es-title">Nothing to collect</div>
        <div class="es-sub">Every guest who has played has settled up.</div></div>`}
    </div>`;
}

/**
 * The strip above the content: which contract, and which shape.
 *
 * Redrawn on every render rather than once on load, because both controls
 * reflect state either of them can change.
 */
function drawScreenControls() {
  // Which contract has no meaning on a view that spans them, so it is put
  // away rather than left showing a choice that changes nothing.
  const seg = $('plContractSeg');
  seg.hidden = viewMode === 'both';
  contractSeg(seg, store.contracts, contractId,
    (id) => { contractId = id; render(); });

  document.querySelectorAll('[data-pl-modeseg]').forEach(seg => {
    seg.innerHTML = MODES.map(([id, label, why]) =>
      `<button data-pl-mode="${id}" class="${viewMode === id ? 'active' : ''}"
        title="${esc(why)}">${label}</button>`).join('');
    seg.querySelectorAll('[data-pl-mode]').forEach(b =>
      b.addEventListener('click', () => {
        if (viewMode === b.dataset.plMode) return;
        viewMode = b.dataset.plMode;
        render();
      }));
  });
}

async function render() {
  if (isPlayer()) return renderPlayerLedger();

  const ledgerCard = $('plLedgerCard');
  const sheetHost = $('reportRoot');
  // Adding a player and importing a roster are things you do to the ledger.
  // They mean nothing on a sheet you are about to send to the club.
  $('plLedgerActions').style.display = viewMode === 'ledger' ? 'flex' : 'none';

  if (viewMode === 'sheet') {
    // The detail panel belongs to the working ledger — leaving it open under a
    // sheet you are about to screenshot puts one player's timeline in it.
    closePlayerDetail();
    ledgerCard.hidden = true;
    sheetHost.hidden = false;
    await renderStandingSheet(sheetHost, contractId);
    drawScreenControls();
    return;
  }

  if (viewMode === 'guests' || viewMode === 'both') {
    closePlayerDetail();
    ledgerCard.hidden = true;
    sheetHost.hidden = false;
    await (viewMode === 'both' ? renderCombined(sheetHost) : renderGuests(sheetHost));
    drawScreenControls();
    return;
  }

  ledgerCard.hidden = false;
  sheetHost.hidden = true;

  // Guest debt comes from the charges, not from ledger rows: a guest who pays
  // cash is given no account at all now, so there is no row of theirs to read.
  const [ledgers, cashOwed] = await Promise.all([
    api.ledgers(contractId),
    api.cashOutstanding(contractId).catch(() => []),
  ]);
  const roleOf = Object.fromEntries(store.players.map(p => [p.id, p.special_role]));

  // Filter
  let filtered = ledgers.filter(l => {
    // Exclude test players by ID or name pattern
    const testPatterns = ['test', 'fixtestplayer', 'newtestplayer', 'testplayer999'];
    const isTestPlayer = testPatterns.some(p =>
      l.player_id.toLowerCase().includes(p.toLowerCase()) ||
      l.player_name.toLowerCase().includes(p.toLowerCase())
    );
    if (isTestPlayer) return false;
    // Guests are never in the ledger — see the note above. They have their
    // own tab, because what matters about them is cash owed, not a balance.
    if (l.player_type === 'outside') return false;
    // Search by name
    if (searchQuery && !l.player_name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    // Filter by status
    if (filterStatus !== 'all' && l.status?.toLowerCase() !== filterStatus.toLowerCase()) return false;
    // Filter by balance
    if (filterBalance === 'positive' && l.present_balance <= 0) return false;
    if (filterBalance === 'negative' && l.present_balance >= 0) return false;
    // Filter by activity. Players already marked as having left are not also
    // offered as "quiet" — they have been dealt with, and leaving them in the
    // list of people to consider means the list never empties.
    if (filterActivity === 'left' && !l.hide_from_sheet) return false;
    if (filterActivity === 'quiet') {
      if (l.hide_from_sheet) return false;
      const d = daysSince(l.last_game_date);
      if (d !== null && d < QUIET_DAYS) return false;
    }
    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    if (sortBy === 'name') return a.player_name.localeCompare(b.player_name);
    if (sortBy === 'balance') return b.present_balance - a.present_balance;
    if (sortBy === 'status') return (a.status || '').localeCompare(b.status || '');
    if (sortBy === 'games') return b.games - a.games;
    return 0;
  });

  // Counted over everyone on the contract, not over what the other filters
  // left behind — a count that shrinks as you narrow the list cannot tell you
  // how many people there are to deal with.
  const members = ledgers.filter(l => l.player_type !== 'outside');
  const leftCount = members.filter(l => l.hide_from_sheet).length;
  const quietCount = members.filter(l => {
    if (l.hide_from_sheet) return false;
    const d = daysSince(l.last_game_date);
    return d === null || d >= QUIET_DAYS;
  }).length;

  // Render controls
  const controlsPanel = document.querySelector('[data-player-controls]') || document.createElement('div');
  controlsPanel.setAttribute('data-player-controls', '');
  controlsPanel.className = 'filter-bar';
  controlsPanel.innerHTML = `
    <input type="text" id="pl_search" placeholder="🔍 Search by name..." value="${searchQuery}">
    <select id="pl_sort">
      <option value="name" ${sortBy === 'name' ? 'selected' : ''}>Sort by name</option>
      <option value="balance" ${sortBy === 'balance' ? 'selected' : ''}>Sort by balance</option>
      <option value="status" ${sortBy === 'status' ? 'selected' : ''}>Sort by status</option>
      <option value="games" ${sortBy === 'games' ? 'selected' : ''}>Sort by games</option>
    </select>
    <select id="pl_filter_status">
      <option value="all" ${filterStatus === 'all' ? 'selected' : ''}>All statuses</option>
      <option value="in contract" ${filterStatus === 'in contract' ? 'selected' : ''}>In contract</option>
      <option value="out of contract" ${filterStatus === 'out of contract' ? 'selected' : ''}>Out of contract</option>
    </select>
    <select id="pl_filter_balance">
      <option value="all" ${filterBalance === 'all' ? 'selected' : ''}>Any balance</option>
      <option value="positive" ${filterBalance === 'positive' ? 'selected' : ''}>In credit</option>
      <option value="negative" ${filterBalance === 'negative' ? 'selected' : ''}>In the red</option>
    </select>
    <select id="pl_filter_activity" title="Find players who have stopped turning up">
      <option value="all" ${filterActivity === 'all' ? 'selected' : ''}>Everyone</option>
      <option value="quiet" ${filterActivity === 'quiet' ? 'selected' : ''}>Not played in ${QUIET_DAYS}+ days${
  quietCount ? ` (${quietCount})` : ''}</option>
      <option value="left" ${filterActivity === 'left' ? 'selected' : ''}>Set aside — not playing${
  leftCount ? ` (${leftCount})` : ''}</option>
    </select>
  `;

  // A guest owes through cash_owed, not through a negative balance: they keep
  // no prepaid balance to go into the red. Kept here because a MEMBER can also
  // settle a game in cash, and their row should say so.
  const owedById = Object.fromEntries((cashOwed || []).map(c => [c.player_id, c.owed]));
  const hiddenIds = new Set((store.players || [])
    .filter(p => p.hide_from_sheet).map(p => p.id));
  const guestsOwing = cashOwed.filter(c => c.owed > 0);
  const guestDebt = guestsOwing.reduce((a, c) => a + c.owed, 0);

  // The mount point is in index.html, outside the table's scroll box. It used to
  // be created here and inserted beside the table, which put the search box and
  // every filter INSIDE the horizontal scroller — so scrolling a nine-column
  // table sideways slid the controls off the screen.
  if (!controlsPanel.isConnected) {
    $('playersTable').closest('.sams-card').insertBefore(
      controlsPanel, $('playersTable').closest('.table-scroll'));
  }

  // Add event listeners
  const updateRender = () => render();
  $('pl_search').addEventListener('input', (e) => { searchQuery = e.target.value; updateRender(); });
  $('pl_sort').addEventListener('change', (e) => { sortBy = e.target.value; updateRender(); });
  $('pl_filter_status').addEventListener('change', (e) => { filterStatus = e.target.value; updateRender(); });
  $('pl_filter_balance').addEventListener('change', (e) => { filterBalance = e.target.value; updateRender(); });
  $('pl_filter_activity').addEventListener('change', (e) => { filterActivity = e.target.value; updateRender(); });


  // Fetch last transaction for each player
  const lastTransactionMap = {};
  await Promise.all(filtered.map(async l => {
    try {
      const txns = await api.playerTransactions(l.player_id, 1);
      if (txns && txns.length > 0) {
        lastTransactionMap[l.player_id] = txns[0];
      }
    } catch (e) {
      console.error(`Failed to load transactions for ${l.player_id}:`, e);
    }
  }));

  // Render as clean card grid instead of cluttered table
  const cardsHtml = filtered.map(l => {
    const isCashier = roleOf[l.player_id] === 'cashier';
    // The cashier funds the contracts up front and takes the fees back in, so
    // they never contribute and their balance only falls as they play. Painting
    // that red says they owe the club money, when it is the other way round.
    const status = isCashier
      ? { text: '💰 Club float', cls: 'tag-cashier' }
      : statusFromBalance(l.present_balance, l.games_left);
    const lastTxn = lastTransactionMap[l.player_id];
    let lastTxnHtml = '<span class="hint">—</span>';
    if (lastTxn) {
      const isPositive = lastTxn.amount > 0;
      const emoji = isPositive ? '🟢' : '🔴';
      const sign = isPositive ? '+' : '';
      const dateStr = lastTxn.date?.split('T')[0] || '';
      const dateObj = new Date(dateStr);
      const formattedDate = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      lastTxnHtml = `<span style="white-space: nowrap;">${emoji} ${sign}${money(Math.abs(lastTxn.amount))} • ${formattedDate}</span>`;
    }

    // A guest with cash still to collect is as much an alert as a member in the
    // red — it is just a different kind of money, so it is flagged on its own.
    const owed = owedById[l.player_id] || 0;

    return `
    <tr class="${!isCashier && (l.present_balance < 0 || owed > 0) ? 'row-alert' : ''}">
      <td class="num"><input type="checkbox" class="pl-pick" value="${esc(l.player_id)}"></td>
      <td><strong class="link-name" onclick="window.showPlayerDetail('${l.player_id}')">${esc(l.player_name)}</strong>${isCashier ? ' <span class="tag tag-cashier" title="Cashier — excluded from contributions">💰 Cashier</span>' : ''}${
        l.player_type === 'outside' ? ' <span class="tag tag-due" title="Guest — not on a contract">Guest</span>' : ''}${
        owed > 0 ? ` <span class="tag tag-due" title="Cash still to collect">to collect ${money(owed)}</span>` : ''}${
        l.balance_group_id ? ' <span class="tag tag-cashier" title="Shares a balance with another player">🔗 Shared</span>' : ''}${
        // Both states are shown on the row itself. The toggle lives behind the
        // ⋮ menu, so without this the only way to tell whether someone was
        // hidden was to open the menu for each of them one at a time.
        hiddenIds.has(l.player_id)
    ? ' <span class="tag" title="Set aside as not playing — kept out of the Standing sheet and the rankings. Their balance and history are untouched.">⏸ Not playing</span>'
    : (() => {
      const d = daysSince(l.last_game_date);
      if (d === null) return ' <span class="tag" title="Has never played a game">never played</span>';
      return d >= QUIET_DAYS
        ? ` <span class="tag" title="Last played ${esc(fmtDate(l.last_game_date))}">quiet ${
          Math.floor(d / 30)}m</span>`
        : '';
    })()}</td>
      <td><span class="tag ${status.cls}">${status.text}</span></td>
      <td class="num">${money(l.opening_balance)}</td>
      <td class="num">${money(l.contributed)}</td>
      <td class="num"><span class="charged-cell ${l.charged > 0 ? 'is-charged' : ''}">-${money(l.charged)}</span></td>
      <td class="num">${l.games ?? 0}</td>
      <td class="num">${isCashier
    ? `<span class="bal zero" title="Money put in up front to run the contracts, drawn down as they play. The club owes this, not the other way round.">${money(l.present_balance)}</span>`
    : balCell(l.present_balance)}</td>
      <td class="num">${isCashier ? '<span class="hint">—</span>'
    : l.games_left === null || l.games_left === undefined ? '<span class="hint">—</span>'
        : `<span class="${l.games_left < 1 ? 'charged-cell is-charged' : 'hint'}">${l.games_left}</span>`}</td>
      <td class="row-actions">
        ${isCashier ? '<span class="hint">no contributions</span>'
          : `<button class="btn btn-secondary btn-sm" data-pay="${l.player_id}">+ Pay</button>`}
        <button class="btn btn-sm" data-menu="${l.player_id}" title="More options" style="font-size: 1rem; padding: 0.3rem 0.4rem; min-width: auto;">⋮</button>
      </td>
      <td style="display: none;" data-actions="${l.player_id}">
        <button class="btn btn-sm" data-sheet="${l.player_id}" data-hidden="${hiddenIds.has(l.player_id) ? 1 : 0}"
          title="Takes them off the Standing sheet and out of the rankings until they are back. They keep their balance, their history and their place on this screen — it moves no money at all. For somebody who has stopped turning up, whether for a season or for good."
          style="opacity: 0.6; font-size: 0.8rem; padding: 0.3rem 0.5rem; margin-right: 0.25rem;">${
  hiddenIds.has(l.player_id) ? '▶ Playing again' : '⏸ Not playing now'}</button>
        <button class="btn btn-sm" data-kind="${l.player_id}" data-to="outside"
          title="Move them to the guest list: somebody who turns up now and then and pays cash, rather than a member on a contract. They leave the ledger and the standing sheet. Refused if any of their games were settled off a balance, because that would turn football they have paid for into cash they owe."
          style="opacity: 0.6; font-size: 0.8rem; padding: 0.3rem 0.5rem; margin-right: 0.25rem;">→ Guest list</button>
        <button class="btn btn-sm" data-split="${l.player_id}"
          title="One record, two people with the same name — pull the second one out, taking their games with them"
          style="opacity: 0.6; font-size: 0.8rem; padding: 0.3rem 0.5rem; margin-right: 0.25rem;">⑂ Two people</button>
        <button class="btn btn-sm" data-reset="${l.player_id}" title="Clear contributions, keep charges" style="opacity: 0.6; font-size: 0.8rem; padding: 0.3rem 0.5rem; margin-right: 0.25rem;">↺ Reset</button>
        <button class="btn btn-sm" data-delete="${l.player_id}" title="Permanently remove player" style="opacity: 0.5; font-size: 0.8rem; padding: 0.3rem 0.5rem; color: var(--danger);">✕ Delete</button>
      </td>
    </tr>`
  // Counted from the header rather than typed, so a column added later cannot
  // leave the empty state spanning the wrong width.
  }).join('') || `<tr><td colspan="${
  $('playersTable').querySelectorAll('thead th').length}" class="hint">No players in this contract yet.</td></tr>`;

  $('playersTable').querySelector('tbody').innerHTML = cardsHtml;

  $('playersTable').querySelectorAll('[data-pay]').forEach(btn =>
    btn.addEventListener('click', () => payModal(btn.dataset.pay)));

  // Menu button (⋮) toggles Reset/Delete visibility
  $('playersTable').querySelectorAll('[data-menu]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const playerId = btn.dataset.menu;
      const actionsCell = $('playersTable').querySelector(`[data-actions="${playerId}"]`);
      const isVisible = actionsCell.style.display !== 'none';
      actionsCell.style.display = isVisible ? 'none' : 'table-cell';
    });
  });

  // Close menu when clicking elsewhere
  document.addEventListener('click', () => {
    $('playersTable').querySelectorAll('[data-actions]').forEach(cell => {
      cell.style.display = 'none';
    });
  });

  wireBulk();
  $('playersTable').querySelectorAll('[data-kind]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const name = store.players.find(p => p.id === btn.dataset.kind)?.name || 'them';
      if (!confirm(`Move ${name} to the guest list?\n\n`
        + 'Guests pay cash on the day and keep no balance, so they leave the ledger and the '
        + 'standing sheet and appear under Guests instead.\n\n'
        + 'Nothing is written if it would change what they hold.')) return;
      try {
        await api.put(`/admin/players/${btn.dataset.kind}/kind`, { kind: btn.dataset.to });
        store.players = await api.players();
        toast(`${name} is on the guest list now`);
        render();
      } catch (e) { toast(e.message, true); }
    }));
  $('playersTable').querySelectorAll('[data-split]').forEach(btn =>
    btn.addEventListener('click', () => splitPlayerModal(btn.dataset.split)));
  $('playersTable').querySelectorAll('[data-reset]').forEach(btn =>
    btn.addEventListener('click', () => resetPlayerModal(btn.dataset.reset)));
  $('playersTable').querySelectorAll('[data-delete]').forEach(btn =>
    btn.addEventListener('click', () => deletePlayerModal(btn.dataset.delete)));

  // Visibility only. No confirmation, because nothing about it is destructive —
  // it moves no money and is one click to undo.
  $('playersTable').querySelectorAll('[data-sheet]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const hide = btn.dataset.hidden !== '1';
      try {
        await api.updatePlayer(btn.dataset.sheet, { hide_from_sheet: hide });
        store.players = await api.players();
        toast(hide
          ? 'Set aside — off the Standing sheet and the rankings, balance untouched'
          : 'Back on the Standing sheet and the rankings');
        render();
      } catch (e) { toast(e.message, true); }
    }));

  drawScreenControls();
}

// Player "My Ledger": their own balances across all contracts (read-only), and
// clicking a contract row opens their timeline for that contract.
async function renderPlayerLedger() {
  const ledgers = await api.myLedgers();
  $('playersTable').querySelector('tbody').innerHTML = ledgers.map(l => `
    <tr>
      <td><strong onclick="window.showPlayerDetailFor('${l.player_id}','${l.contract_id}')" style="cursor:pointer; color:var(--sport);">${esc(contractLabel(l.contract_id))}</strong></td>
      <td>${esc(l.status || '—')}</td>
      <td class="num">${money(l.opening_balance)}</td>
      <td class="num">${money(l.contributed)}</td>
      <td class="num">${money(l.charged)}</td>
      <td class="num">${balCell(l.present_balance)}</td>
      <td>${l.games}</td>
      <td class="row-actions"></td>
    </tr>`).join('') || '<tr><td colspan="8" class="hint">No contracts yet.</td></tr>';
}

function contractLabel(id) {
  return store.contracts.find(c => c.id === id)?.name || id;
}

// Player-scoped detail: load own stats for a specific contract.
window.showPlayerDetailFor = async (playerId, cId) => {
  try {
    const stats = await api.get(`/players/${playerId}/stats?contract_id=${cId}`);
    const player = { id: playerId, name: store.user?.email || 'My account' };
    const prevContract = contractId;
    contractId = cId;  // so renderPlayerDetail's contract lookup resolves
    await renderPlayerDetail(player, stats);
    contractId = prevContract;
  } catch (e) {
    toast(`Failed to load stats: ${e.message}`, true);
  }
};

window.showPlayerDetail = async (playerId) => {
  try {
    const [stats, record] = await Promise.all([
      api.get(`/players/${playerId}/stats?contract_id=${contractId}`),
      // Match record across ALL contracts — the detail card is not contract-scoped.
      api.get(`/players/${playerId}/record`).catch(() => null),
    ]);
    const player = store.players.find(p => p.id === playerId);
    await renderPlayerDetail(player, stats, record);
  } catch (e) {
    toast(`Failed to load player stats: ${e.message}`, true);
  }
};

// Match record. Shown only when there is something to show, and it states WHY a
// game could not be scored rather than reporting a misleading 0%: seeded
// historical games carry no team on their charges, so they can never be won or
// lost, only imported or parsed ones can.
function tile(label, value, colour = '', sub = '') {
  return `
    <div style="padding: 1rem; background: var(--bg-subtle); border-radius: 8px;">
      <div style="color: var(--text-muted); font-size: 0.9rem;">${label}</div>
      <div style="font-size: 1.8rem; font-weight: 700;${colour ? ` color: ${colour};` : ''}">${value}</div>
      ${sub ? `<div class="hint" style="font-size: 0.78rem; margin-top: 0.2rem;">${sub}</div>` : ''}
    </div>`;
}

/**
 * Playing record only — no money. Win rate and captaincy share are single
 * numbers and stay as numbers; the two genuine compositions get a divided bar,
 * because "12 / 3 / 11" makes the reader do the arithmetic that a bar does for
 * them.
 */
function formBlock(r, totalGames, billedGames, recordOnlyGames) {
  const pct = (v) => (v === null || v === undefined ? '—' : v + '%');
  const caveat = [];
  if (r?.no_score) caveat.push(`${r.no_score} with no result recorded`);
  if (r?.no_team) caveat.push(`${r.no_team} with no team recorded`);

  const played = `
    <div class="pd-chart-card">
      <h5>Games played</h5>
      <p class="hint" style="margin:0">Billed games cost them money; the rest are attendance records from the imported seasons.</p>
      ${dividedBar([
    { label: 'Billed', value: billedGames, cls: 'ch-accent' },
    { label: 'Record only', value: recordOnlyGames, cls: 'ch-muted' },
  ])}
    </div>`;

  if (!r || !r.games) {
    return `<div class="auto-grid" style="--col-min: 240px;">${played}</div>`;
  }

  const results = `
    <div class="pd-chart-card">
      <h5>Results</h5>
      <p class="hint" style="margin:0">${r.decided
      ? `Across the ${r.decided} game${r.decided === 1 ? '' : 's'} with a usable result.`
      : 'None of these games can be won or lost yet.'}</p>
      ${dividedBar([
        { label: 'Won', value: r.wins, cls: 'ch-win' },
        { label: 'Drawn', value: r.draws, cls: 'ch-draw' },
        { label: 'Lost', value: r.losses, cls: 'ch-loss' },
      ])}
    </div>`;

  const goals = `
    <div class="pd-chart-card">
      <h5>Goals</h5>
      <p class="hint" style="margin:0">Scored by their team while they were on it, against conceded.</p>
      ${pairedBars([
        { label: 'For', value: r.gf, cls: 'ch-win' },
        { label: 'Against', value: r.ga, cls: 'ch-loss' },
      ])}
      <p class="hint" style="margin:0.6rem 0 0">Goal difference
        <strong>${r.gd > 0 ? '+' : ''}${r.gd}</strong></p>
    </div>`;

  return `
    <div class="auto-grid" style="--col-min: 150px; margin-bottom: 1rem;">
      ${tile('Played', totalGames, '', `${billedGames} billed`)}
      ${tile('Win rate', pct(r.winRate), 'var(--success)',
    r.decided ? `of ${r.decided} games with a score` : '')}
      ${tile('Captained', r.captainGames || 0, 'var(--sport)',
    r.captainGames
      ? `won ${r.captainWins} of ${r.captainDecided || 0} played out${
        r.captainWinRate === null ? '' : ` · ${r.captainWinRate}%`}`
      : 'never worn the armband')}
    </div>
    <div class="auto-grid" style="--col-min: 240px;">${results}${goals}${played}</div>
    ${caveat.length ? `<p class="hint" style="margin-top:0.8rem">Excluded: ${caveat.join(', ')}.</p>` : ''}`;
}

function matchRecordBlock(r) {
  if (!r || !r.games) return '';
  const pct = (v) => (v === null || v === undefined ? '—' : v + '%');
  const signed = (n) => (n > 0 ? '+' + n : String(n));
  const tile = (label, value, cls = '') => `
    <div class="res-quarter" style="border-top-color: var(--sport)">
      <div class="hint">${label}</div>
      <div class="res-q-label" style="margin:0;padding:0;border:0">
        <span class="${cls}">${value}</span></div>
    </div>`;

  const caveat = [];
  if (r.no_score) caveat.push(`${r.no_score} with no result recorded`);
  if (r.no_team) caveat.push(`${r.no_team} with no team recorded`);

  return `
    <h4 class="mini-h mt">Match record</h4>
    ${r.decided ? '' : `<p class="hint">None of these games can be won or lost yet — see below.</p>`}
    <div class="auto-grid" style="--col-min: 130px;">
      ${tile('Played', r.games)}
      ${tile('W / D / L', `${r.wins} / ${r.draws} / ${r.losses}`)}
      ${tile('Win rate', pct(r.winRate), 'is-win')}
      ${tile('Goals for / against', `${r.gf} / ${r.ga}`)}
      ${tile('Goal difference', signed(r.gd), r.gd >= 0 ? 'is-win' : '')}
      ${tile('Captained', r.captainGames
    ? `${r.captainWins}/${r.captainDecided || 0} (${pct(r.captainWinRate)})` : '—')}
    </div>
    ${caveat.length ? `<p class="hint mt">Rates cover the ${r.decided} game(s) with a usable
      result. Excluded: ${caveat.join(', ')}.</p>` : ''}`;
}

// Render audit trail (grouped by date with color coding)
function renderAuditTrail(transactions) {
  if (!transactions || transactions.length === 0) {
    return '<div class="hint">No transactions yet.</div>';
  }

  // Group transactions by date
  const grouped = {};
  transactions.forEach(t => {
    const dateStr = t.date?.split('T')[0] || 'Unknown';
    if (!grouped[dateStr]) {
      grouped[dateStr] = [];
    }
    grouped[dateStr].push(t);
  });

  // Sort dates descending
  const sortedDates = Object.keys(grouped).sort().reverse();

  let html = '<div style="font-size: 0.9rem;">';

  sortedDates.forEach(dateStr => {
    const items = grouped[dateStr];
    const totalAmount = items.reduce((sum, t) => sum + (t.amount || 0), 0);
    const hasPositive = items.some(t => t.amount > 0);
    const hasNegative = items.some(t => t.amount < 0);

    const dateObj = new Date(dateStr);
    const formattedDate = dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

    if (items.length === 1) {
      const t = items[0];
      const typeLabel = t.type === 'contribution' ? 'Contribution'
        : t.type === 'event_deduction' ? (t.event_title || 'Event Deduction')
        : t.type === 'charge' ? 'Game Charge'
        : t.type === 'transfer_out' ? 'Transfer Out'
        : t.type === 'transfer_in' ? 'Transfer In'
        : 'Transaction';
      const isPositive = t.amount > 0;
      const emoji = isPositive ? '🟢' : '🔴';
      const sign = isPositive ? '+' : '';
      const color = isPositive ? 'var(--success)' : 'var(--danger)';

      html += `
        <div style="padding: 0.75rem; margin-bottom: 0.5rem; background: var(--bg-subtle); border-radius: 6px; border-left: 3px solid ${color};">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-weight: 500;">${emoji} ${formattedDate}</div>
              <div style="color: var(--text-muted); font-size: 0.85rem; margin-top: 0.2rem;">${esc(typeLabel)}</div>
            </div>
            <div style="text-align: right; font-weight: 600; color: ${color};">${sign}${money(Math.abs(t.amount))}</div>
          </div>
        </div>
      `;
    } else {
      // Multiple items on same date
      const emoji = hasPositive && !hasNegative ? '🟢' : hasNegative && !hasPositive ? '🔴' : '⚪';
      const sign = totalAmount > 0 ? '+' : '';

      let detailsHtml = '';
      items.forEach(t => {
        const typeLabel = t.type === 'contribution' ? 'Contribution'
          : t.type === 'event_deduction' ? (t.event_title || 'Event Deduction')
          : t.type === 'charge' ? 'Game Charge'
          : t.type === 'transfer_out' ? 'Transfer Out'
          : t.type === 'transfer_in' ? 'Transfer In'
          : 'Transaction';
        const isPos = t.amount > 0;
        const eIcon = isPos ? '🟢' : '🔴';
        const s = isPos ? '+' : '';
        const color = isPos ? 'var(--success)' : 'var(--danger)';

        detailsHtml += `<div style="display: flex; justify-content: space-between; font-size: 0.85rem; color: var(--text-muted);">
          <span>${eIcon} ${esc(typeLabel)}</span>
          <span style="color: ${color}; font-weight: 500;">${s}${money(Math.abs(t.amount))}</span>
        </div>`;
      });

      html += `
        <div style="padding: 0.75rem; margin-bottom: 0.5rem; background: var(--bg-subtle); border-radius: 6px; border-left: 3px solid var(--border-color);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
            <div style="font-weight: 500;">${emoji} ${items.length} items on ${formattedDate}</div>
            <div style="text-align: right; font-weight: 600; color: var(--text-muted);">${sign}${money(Math.abs(totalAmount))}</div>
          </div>
          <div style="display: grid; gap: 0.3rem; margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border-color);">
            ${detailsHtml}
          </div>
        </div>
      `;
    }
  });

  html += '</div>';
  return html;
}

async function renderPlayerDetail(player, stats, record) {
  const detailCard = $('playerDetailCard');
  $('playerDetailName').textContent = `${player.name}`;

  // Fetch ALL contributions for this player (across all contracts)
  let allContributions = [];
  try {
    const data = await api.get(`/contributions?player_id=${player.id}`);
    allContributions = data || [];
  } catch (e) {
    console.error('Failed to load contributions:', e);
  }

  // Fetch ledgers for all contracts
  let allLedgers = [];
  try {
    const data = await api.get(`/players/${player.id}/ledgers`);
    allLedgers = data || [];
  } catch (e) {
    console.error('Failed to load ledgers:', e);
  }

  // Fetch all transactions (audit trail)
  let allTransactions = [];
  try {
    const data = await api.playerTransactions(player.id, 500);
    allTransactions = data || [];
  } catch (e) {
    console.error('Failed to load transactions:', e);
  }

  // Cross-contract stats. Every figure here spans BOTH contracts, which is why
  // the balance shown will not match the single-contract row the panel was
  // opened from — the labels say so rather than leaving it to be guessed at.
  const totalGames = allLedgers.reduce((sum, l) => sum + (l.games || 0), 0);
  const billedGames = allLedgers.reduce((sum, l) => sum + (l.games_billed || 0), 0);
  const recordOnlyGames = totalGames - billedGames;
  const totalContributions = allContributions.reduce((sum, c) => sum + (c.amount || 0), 0);
  const totalBalance = allLedgers.reduce((sum, l) => sum + (l.present_balance || 0), 0);
  const perContract = allLedgers
    .map(l => `${l.contract_id} ${money(l.present_balance)}`).join(' · ');

  // Running balance for the chart. Timeline is per-contract, so plot the one
  // they are most active on rather than summing two unrelated running totals
  // into a line that means nothing.
  let timelinePoints = [];
  let timelineNote = '';
  const busiest = [...allLedgers].sort((a, b) => (b.games || 0) - (a.games || 0))[0];
  if (busiest) {
    try {
      const { timeline: t } = await api.playerStats(player.id, busiest.contract_id);
      const live = (t?.events || []).filter(e => e.date);
      timelinePoints = [
        { label: 'Opening', balance: t.opening },
        ...live.map(e => ({
          label: `${fmtDate(e.date)} · ${e.type === 'contribution' ? 'paid in' : 'game'}`,
          balance: e.runningBalance,
        })),
      ];
      timelineNote = `${busiest.contract_id} · ${live.length} movement${live.length === 1 ? '' : 's'} since the opening balance`;
    } catch { timelinePoints = []; }
  }

  // Build modular tabs
  let tabsHtml = `
    <div class="tab-bar">
      <button class="tab-btn active" data-tab="overview">Overview</button>
      <button class="tab-btn" data-tab="audit-trail">Audit Trail</button>
      <button class="tab-btn" data-tab="contributions">Contributions</button>
      <button class="tab-btn" data-tab="charges">Charges</button>
      <button class="tab-btn" data-tab="contracts">By Contract</button>
    </div>

    <!-- OVERVIEW TAB — money and form kept apart, because they answer different
         questions and mixing them made "Games Played" sit beside a balance as
         though one explained the other. -->
    <div class="tab-content" data-tab="overview">
      <section class="pd-section">
        <div class="pd-section-head">
          <h4>Money</h4><span class="hint">what they hold and what they have paid in</span>
        </div>
        <div class="auto-grid" style="--col-min: 150px;">
          ${tile('Balance, both contracts', money(totalBalance),
      totalBalance < 0 ? 'var(--danger)' : 'var(--success)', esc(perContract))}
          ${tile('Paid in, both contracts', `+${money(totalContributions)}`, 'var(--success)',
        `${allContributions.length} payment${allContributions.length === 1 ? '' : 's'}`)}
          ${tile('Contracts', allLedgers.length, '', perContract ? 'active on both' : '')}
        </div>
        <div class="pd-chart-card" style="margin-top: 1rem;">
          <h5>Balance over time</h5>
          <p class="hint" style="margin:0">${esc(timelineNote)}</p>
          ${balanceLine(timelinePoints)}
        </div>
      </section>

      <section class="pd-section">
        <div class="pd-section-head">
          <h4>Form</h4><span class="hint">how they have played, independent of what they owe</span>
        </div>
        ${formBlock(record, totalGames, billedGames, recordOnlyGames)}
      </section>
    </div>

    <!-- AUDIT TRAIL TAB (all transactions: contributions + external events + charges) -->
    <div class="tab-content" data-tab="audit-trail" hidden>
      ${renderAuditTrail(allTransactions)}
    </div>

    <!-- CONTRIBUTIONS TAB -->
    <div class="tab-content" data-tab="contributions" hidden>
      ${allContributions.length > 0
        ? `<table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
            <thead style="background: var(--bg-subtle);">
              <tr>
                <th style="padding: 0.5rem; text-align: left; border-bottom: 1px solid var(--border-color);">Date</th>
                <th style="padding: 0.5rem; text-align: left; border-bottom: 1px solid var(--border-color);">Contract</th>
                <th style="padding: 0.5rem; text-align: right; border-bottom: 1px solid var(--border-color);">Amount</th>
                <th style="padding: 0.5rem; text-align: left; border-bottom: 1px solid var(--border-color);">Comments</th>
              </tr>
            </thead>
            <tbody>
              ${allContributions.map(c => `
                <tr style="border-bottom: 1px solid var(--border-color);">
                  <td style="padding: 0.5rem;">${c.date || '—'}</td>
                  <td style="padding: 0.5rem; color: var(--text-muted);">${esc(store.contracts.find(x => x.id === c.contract_id)?.name || c.contract_id)}</td>
                  <td style="padding: 0.5rem; text-align: right; font-weight: 600; color: ${c.amount > 0 ? 'var(--success)' : 'var(--danger)'};">${c.amount > 0 ? '+' : ''}${money(c.amount)}</td>
                  <td style="padding: 0.5rem; color: var(--text-muted); font-size: 0.85rem;">${esc(c.comments || '—')}${splitNote(c)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>`
        : '<div class="hint">No contributions yet.</div>'
      }
    </div>

    <!-- CHARGES TAB -->
    <div class="tab-content" data-tab="charges" hidden>
      <div class="hint">Game charges from current contract (${store.contracts.find(c => c.id === contractId)?.name || ''}):</div>
      ${stats.timeline?.events?.filter(e => e.type !== 'contribution').length > 0
        ? stats.timeline.events
            .filter(e => e.type !== 'contribution')
            .map(e => `
              <div style="padding: 0.75rem; margin-bottom: 0.5rem; background: var(--bg-subtle); border-radius: 6px; font-size: 0.9rem;">
                <div style="font-weight: 500;">${e.date} · ${e.team || '—'}</div>
                <div style="color: var(--text-muted); font-size: 0.85rem;">${e.rate_type || '—'}</div>
                <div style="margin-top: 0.25rem; color: var(--danger); font-weight: 600;">-${money(e.amount)}</div>
              </div>
            `).join('')
        : '<div class="hint">No charges in this contract yet.</div>'
      }
    </div>

    <!-- BY CONTRACT TAB -->
    <div class="tab-content" data-tab="contracts" hidden>
      <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
        <thead style="background: var(--bg-subtle);">
          <tr>
            <th style="padding: 0.5rem; text-align: left; border-bottom: 1px solid var(--border-color);">Contract</th>
            <th style="padding: 0.5rem; text-align: right; border-bottom: 1px solid var(--border-color);">Balance</th>
            <th style="padding: 0.5rem; text-align: right; border-bottom: 1px solid var(--border-color);">Games</th>
            <th style="padding: 0.5rem; text-align: right; border-bottom: 1px solid var(--border-color);">Status</th>
          </tr>
        </thead>
        <tbody>
          ${allLedgers.map(l => `
            <tr style="border-bottom: 1px solid var(--border-color);">
              <td style="padding: 0.5rem;">${esc(store.contracts.find(c => c.id === l.contract_id)?.name || l.contract_id)}</td>
              <td style="padding: 0.5rem; text-align: right; font-weight: 600; color: ${l.present_balance > 0 ? 'var(--success)' : 'var(--danger)'};">${money(l.present_balance)}</td>
              <td style="padding: 0.5rem; text-align: right;">${l.games || 0}</td>
              <td style="padding: 0.5rem; text-align: right; font-size: 0.85rem; color: var(--text-muted);">${l.status || 'In Contract'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  $('playerStatsGrid').innerHTML = tabsHtml;
  wireCharts($('playerStatsGrid'));
  wireSplitNotes($('playerStatsGrid'));

  // Tab switching
  $('playerStatsGrid').querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      $('playerStatsGrid').querySelectorAll('.tab-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === tab));
      $('playerStatsGrid').querySelectorAll('.tab-content').forEach(tc => {
        tc.hidden = tc.dataset.tab !== tab;
      });
    });
  });

  detailCard.hidden = false;
  currentDetailPlayerId = player.id;
}

function closePlayerDetail() {
  $('playerDetailCard').hidden = true;
  currentDetailPlayerId = null;
}

function payModal(playerId) {
  const p = store.players.find(x => x.id === playerId);
  openModal(`Add contribution — ${p?.name || ''}`, `
    <div class="form-group"><label>Amount (AED)</label><input type="number" id="pm_amount" step="1" placeholder="300"></div>
    <div class="form-group mt"><label>Date</label><input type="date" id="pm_date" value="${today()}"></div>
    <div class="form-group mt"><label>Comments</label><input type="text" id="pm_comments" placeholder="cash / transfer"></div>
    <button class="btn full-w mt" id="pm_save">Add to ${esc((store.contracts.find(c=>c.id===contractId)||{}).name||'')}</button>`);
  $('pm_save').addEventListener('click', async () => {
    try {
      await api.createContribution({
        player_id: playerId, contract_id: contractId,
        amount: Number($('pm_amount').value) || 0,
        date: $('pm_date').value, comments: $('pm_comments').value,
      });
      closeModal(); toast('Contribution added ✓'); render();
    } catch (e) { toast(e.message, true); }
  });
}

function resetPlayerModal(playerId) {
  const p = store.players.find(x => x.id === playerId);
  const checkboxId = `reset_confirm_${Date.now()}`;
  const name = esc(p?.name || 'this player');
  openModal(`Reset ${esc(p?.name || 'player')}?`, `
    <div class="panel panel-warn">
      <div class="panel-title">What will happen</div>
      <div class="panel-body">
        ✓ Clear all money (contributions)<br>
        ✓ Reset balance to 0<br>
        ✓ Keep game records (history stays)
      </div>
    </div>
    <label class="confirm-check">
      <input type="checkbox" id="${checkboxId}">
      <span>Yes, reset ${name}</span>
    </label>
    <div class="btn-row mt">
      <button class="btn" id="confirm_reset" disabled>Reset</button>
      <button class="btn btn-secondary" id="cancel_reset">Cancel</button>
    </div>`);

  const checkbox = $(`${checkboxId}`);
  const confirmBtn = $('confirm_reset');

  checkbox.addEventListener('change', () => {
    confirmBtn.disabled = !checkbox.checked;
  });

  confirmBtn.addEventListener('click', async () => {
    try {
      await api.post(`/admin/players/${playerId}/reset`, {});
      store.players = await api.players();
      closeModal(); toast('Player reset ✓'); render();
    } catch (e) { toast(e.message, true); }
  });
  $('cancel_reset').addEventListener('click', closeModal);
}

function deletePlayerModal(playerId) {
  const p = store.players.find(x => x.id === playerId);
  const playerName = p?.name || 'this player';
  const checkboxId = `delete_confirm_${Date.now()}`;
  const safeName = esc(playerName);
  openModal(`⚠️ Delete ${safeName}?`, `
    <div class="panel panel-danger">
      <div class="panel-title">⚠️ WARNING — cannot undo</div>
      <div class="panel-body">
        ✗ Player will be deleted<br>
        ✗ All payments/money records gone<br>
        ✗ All game history gone<br>
        ✗ No way to get it back
      </div>
    </div>
    <label class="confirm-check">
      <input type="checkbox" id="${checkboxId}">
      <span>Yes, delete ${safeName} forever</span>
    </label>
    <div class="btn-row mt">
      <button class="btn btn-danger" id="confirm_delete" disabled>DELETE</button>
      <button class="btn btn-secondary" id="cancel_delete">Cancel</button>
    </div>`);

  const checkbox = $(`${checkboxId}`);
  const confirmBtn = $('confirm_delete');

  checkbox.addEventListener('change', () => {
    confirmBtn.disabled = !checkbox.checked;
  });

  confirmBtn.addEventListener('click', async () => {
    try {
      await api.delete(`/admin/players/${playerId}`);
      store.players = await api.players();
      closeModal(); toast('Player deleted ✓'); render();
    } catch (e) { toast(e.message, true); }
  });
  $('cancel_delete').addEventListener('click', closeModal);
}

function addPlayerModal() {
  openModal('Add player', `
    <div class="form-group"><label>Name</label><input type="text" id="np_name" placeholder="Player name"></div>
    <div class="form-group mt"><label>WhatsApp aliases (comma-separated)</label>
      <input type="text" id="np_aliases" placeholder="e.g. Tush, Tushi"></div>
    <label class="login-shared mt"><input type="checkbox" id="np_guest">
      <span>A guest — pays cash on the day, keeps no balance, and stays off the ledger and
        the standing sheet. Leave this off for anyone joining a contract.</span></label>
    <button class="btn full-w mt" id="np_save">Create player</button>`);
  $('np_save').addEventListener('click', async () => {
    const name = $('np_name').value.trim();
    if (!name) { toast('Name required', true); return; }
    try {
      await api.createPlayer({
        name,
        aliases: $('np_aliases').value.split(',').map(s => s.trim()).filter(Boolean),
        player_type: $('np_guest').checked ? 'outside' : 'regular',
      });
      store.players = await api.players();
      closeModal(); toast('Player created ✓'); render();
    } catch (e) { toast(e.message, true); }
  });
}

function bulkImportModal() {
  openModal('Bulk Import Players & Balances', `
    <div style="margin-bottom: 1.5rem;">
      <label style="display: block; font-weight: 600; margin-bottom: 0.5rem;">Select Contract</label>
      <select id="bi_contract" required style="width: 100%; padding: 0.6rem; border: 1px solid var(--border-color); border-radius: 8px;">
        <option value="">Choose contract…</option>
        ${store.contracts.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
      </select>
    </div>

    <div style="margin-bottom: 1rem;">
      <label style="display: block; font-weight: 600; margin-bottom: 0.5rem;">Paste Data (Name + Balance)</label>
      <p class="hint" style="margin: 0 0 0.8rem; font-size: 0.85rem;">
        Copy from Excel: Name in column 1, Opening Balance in column 2. One per line.
      </p>
      <textarea id="bi_data" placeholder="Toby&#9;-700
Vijay&#9;0
Joe&#9;223
..." style="width: 100%; min-height: 200px; padding: 0.8rem; font-family: monospace; font-size: 0.9rem; border: 1px solid var(--border-color); border-radius: 8px;"></textarea>
    </div>

    <button class="btn full-w" id="bi_import">Import</button>`);

  $('bi_import').addEventListener('click', async () => {
    const contractId = $('bi_contract').value;
    const data = $('bi_data').value;

    if (!contractId) { toast('Select a contract', true); return; }
    if (!data.trim()) { toast('Paste data', true); return; }

    try {
      const result = await api.bulkImportPlayersAndBalances(contractId, data);
      store.players = await api.players();
      closeModal();
      toast(`✓ Imported: ${result.created} players, ${result.updated} balances`);
      render();
    } catch (e) { toast(e.message, true); }
  });
}

export function initPlayers() {
  if (!isPlayer()) {
    $('plAdd').addEventListener('click', addPlayerModal);

    // Add bulk import button
    const bulkImportBtn = document.createElement('button');
    bulkImportBtn.className = 'btn btn-secondary';
    bulkImportBtn.textContent = '📥 Bulk Import';
    bulkImportBtn.addEventListener('click', bulkImportModal);
    $('plAdd').parentElement.appendChild(bulkImportBtn);
  }
  $('playerDetailClose').addEventListener('click', closePlayerDetail);

  // Both snapshots cover every contract at once, so neither is tied to the
  // contract currently on screen.
  $('plShare').addEventListener('click', () => shareClubSnapshot());
  $('plSharePlayer').addEventListener('click', () => {
    if (currentDetailPlayerId) sharePlayerSnapshot(currentDetailPlayerId);
  });
}


export function loadPlayers() {
  contractId ??= defaultContract();
  if (isPlayer()) {
    // Hide admin-only chrome; "My Ledger" lists all contracts as rows.
    // The standing sheet is the club's view of everybody, so a player has no
    // shape to switch to and the switch itself would be a dead control.
    $('plScreenControls').hidden = true;
    const banner = $('setupBanner');
    if (banner) banner.style.display = 'none';
    return render();
  }

  return render();
}
