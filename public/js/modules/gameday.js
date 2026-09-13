// gameday.js — paste WhatsApp teams → parse → editable preview → confirm & deduct.
import { api } from '../api.js';
import { store, toast, defaultContract } from '../store.js';
import { $, esc, money, today, contractSeg, rosterOptions } from '../util.js';
import { loadDashboard } from './dashboard.js';
import { fixtureDate, dayName, loadSchedule, markNoGame } from '../schedule-ui.js';

let contractId = null;   // resolved on first load — see defaultContract()
let rows = [];                 // current preview rows (mutable amounts)
let parseResult = null;        // full parser result with metadata

const RATE_LABEL = {
  contracted_10: 'Contract', contracted_12: 'Contract',
  captain_10: 'Captain', captain_12: 'Captain', noncontract: 'Guest rate',
};

// Parse team emojis from WhatsApp message
function parseTeamEmojis(text) {
  const red = ['🔴', '❤️', '❤', '🍎', '🌹'];
  const blue = ['🔵', '💙', '💎', '🌊', '🫐'];
  // ui-tokens-allow: kit colours are domain data (shirt colours), not UI theme tones.
  const redTeam = { emoji: '🔴', name: 'Red', color: '#d32f2f' };
  const blueTeam = { emoji: '🔵', name: 'Blue', color: '#1976d2' };

  // Check for emojis - be more permissive with emoji matching
  let hasRed = false, hasBlue = false;
  for (const e of red) {
    if (text.includes(e)) { hasRed = true; break; }
  }
  for (const e of blue) {
    if (text.includes(e)) { hasBlue = true; break; }
  }

  // Also check text indicators
  const textLower = text.toLowerCase();
  if (textLower.includes('red')) hasRed = true;
  if (textLower.includes('blue')) hasBlue = true;

  return { hasRed, hasBlue, redTeam, blueTeam };
}

// Parse score from message - handle various formats
function parseScore(text) {
  // Try multiple patterns: "13-9", "win 13-9", "13 - 9", etc.
  const patterns = [
    /(\d+)\s*[-–—]\s*(\d+)/,           // 13-9 or 13 - 9
    /\bwin[s]?\s+(\d+)[–-](\d+)/i,     // "win 13-9" or "wins 13-9"
    /(\d+)[–-](\d+)\b/,                // ends with score
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return { goalsA: parseInt(match[1]), goalsB: parseInt(match[2]) };
    }
  }
  return null;
}

// Detect captain from "(C)" or "C)" marker
function detectCaptains(text, playerNames) {
  const captains = new Set();
  // Look for "Name (C)" or "Name C)" patterns
  const captainPattern = /(\w+)\s*\(?C\)?/gi;
  let match;
  while ((match = captainPattern.exec(text)) !== null) {
    const name = match[1].trim();
    // Try to match with player names
    const found = playerNames.find(p => p.toLowerCase() === name.toLowerCase());
    if (found) captains.add(found);
  }
  return captains;
}

// The contract's rate card, whatever shape it arrives in.
function rateCard(contractId) {
  const c = store.contracts?.find(x => x.id === contractId);
  if (!c) return {};
  return typeof c.rates === 'string'
    ? (() => { try { return JSON.parse(c.rates || '{}'); } catch { return {}; } })()
    : (c.rates || {});
}

/**
 * Per-player rate for a rate type.
 *
 * This used to read cost_per_gw — the PITCH hire for the whole game — as if it
 * were a per-player rate, and looked for c.captain_rate / c.noncontract_rate,
 * which do not exist (the card is nested under c.rates). Any charge that was
 * zero got filled with the pitch cost, so one player could be billed 292.50.
 */
function getPresetRate(rateType, contractId) {
  const rates = rateCard(contractId);
  // `??`, not `||` — a rate card can legitimately set a rate to exactly 0 (e.g.
  // "captains play free"), and `||` would treat that real 0 as missing and
  // fall through to the next rate instead.
  return Number(rates[rateType] ?? rates.noncontract ?? 0);
}

/**
 * Recompute a row's rate after its contract status is changed by hand. Mirrors
 * the server rule in parser.js: being outside the contract decides the rate
 * before captaincy does, because the captain rate is a contract benefit.
 */
/**
 * The rate column in force. Follows the headcount as rows come and go — the
 * value captured at parse time goes stale the moment a duplicate is deleted —
 * unless it has been set by hand, in which case the choice stands.
 */
function currentBucket(meta) {
  if (meta?.bucketPinned) return meta.bucket;
  const derived = rows.length >= 11 ? '12' : '10';
  if (meta) meta.bucket = derived;
  return derived;
}

function applyRate(r, meta) {
  const rates = rateCard(contractId);
  const bucket = currentBucket(meta);
  const outside = r.player_type === 'outside';

  if (outside) {
    r.rate_type = 'noncontract';
    r.amount = Number(r.outside_cost) > 0
      ? Number(r.outside_cost)
      : Number(rates.noncontract ?? 0);
  } else if (r.is_captain) {
    r.rate_type = `captain_${bucket}`;
    r.amount = Number(rates[`captain_${bucket}`] ?? rates[`contracted_${bucket}`] ?? 0);
  } else {
    r.rate_type = `contracted_${bucket}`;
    r.amount = Number(rates[`contracted_${bucket}`] ?? rates.noncontract ?? 0);
  }
}

// Match player including nicknames and cashier/admin
function findPlayerByToken(token) {
  const t = token.toLowerCase().trim();

  // Common nickname map
  const nicknames = {
    'vj': 'vijay',
    'v': 'vijay',
    'aj': 'arjun',
    'rj': 'raj',
    'sam': 'sameer',
    'ash': 'ashish',
  };

  // Check direct match first
  let p = store.players?.find(p =>
    p.name.toLowerCase() === t ||
    p.id === t
  );
  if (p) return p;

  // Check partial match (contains)
  p = store.players?.find(p =>
    p.name.toLowerCase().includes(t) ||
    t.includes(p.name.toLowerCase())
  );
  if (p) return p;

  // Check aliases and nicknames
  const expanded = nicknames[t] || t;
  p = store.players?.find(p =>
    p.name.toLowerCase().includes(expanded) ||
    expanded.includes(p.name.toLowerCase()) ||
    (p.aliases && p.aliases.some(a => a.toLowerCase() === t))
  );
  if (p) return p;

  return null;
}

async function showUnmatchedMapping(unmatched) {
  if (!unmatched.length) return;

  const mappedPlayers = {};
  for (const { token, suggestions } of unmatched) {
    // Try enhanced nickname/alias matching first
    const foundPlayer = findPlayerByToken(token);
    if (foundPlayer) {
      mappedPlayers[token] = foundPlayer.id;
      continue;
    }

    if (suggestions.length === 1) {
      mappedPlayers[token] = suggestions[0].id;
      continue;
    }

    if (suggestions.length === 0) {
      // No suggestion - skip (no dialogs, user can manually fix via dropdown if needed)
      continue;
    }

    // Multiple suggestions - auto-pick first (user can fix via dropdown if wrong)
    mappedPlayers[token] = suggestions[0].id;
  }

  // Apply mappings to rows
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.matched && mappedPlayers[r.token]) {
      const mapped = store.players.find(p => p.id === mappedPlayers[r.token]);
      if (mapped) {
        r.player_id = mapped.id;
        r.display_name = mapped.name;
        r.matched = true;
        r.introduced_by = mapped.introduced_by || null;
        r.player_type = mapped.player_type || 'regular';
        r.outside_cost = mapped.outside_cost || null;
      }
    }
  }
}

// Mark unidentified/outside players inline via dropdown (removed dialog prompts)

/**
 * Which fixture is being entered. The date box alone cannot answer "what do I
 * do next?", so this names the oldest date nothing has been said about and
 * offers the only two answers there are: it was played, or it was not.
 *
 * Dates already marked as no-game stay listed, because deciding a week later
 * that a game did happen is a normal correction, not an edge case.
 */
async function renderFixture() {
  const host = $('gdFixture');
  if (!host) return;
  const s = await loadSchedule(contractId);
  if (!s) { host.innerHTML = ''; return; }

  const missing = s.days.filter(d => d.state === 'missing');
  const skipped = s.days.filter(d => d.state === 'no_game');
  const next = s.next_missing;

  // Pre-fill the date so the common case needs no input at all.
  const dateBox = $('gdDate');
  if (dateBox && !dateBox.dataset.touched) dateBox.value = next || today();

  const options = [
    ...missing.map(d => `<option value="${d.date}" ${d.date === next ? 'selected' : ''}>${fixtureDate(d.date)} — nothing recorded</option>`),
    ...skipped.map(d => `<option value="${d.date}">${fixtureDate(d.date)} — marked no game</option>`),
  ].join('');

  host.innerHTML = `
    <div class="gd-fixture">
      ${next ? `
        <div class="gd-fixture-lead">
          <span class="hint">Next to account for</span>
          <strong>${fixtureDate(next)}</strong>
        </div>
        <div class="gd-fixture-actions">
          <button class="btn btn-secondary btn-sm" id="gdNoGame">No game that day</button>
        </div>`
      : `<div class="gd-fixture-lead"><span class="hint">Every fixture up to today is accounted for.</span></div>`}
      ${options ? `
        <label class="gd-fixture-pick">
          <span class="hint">Entering</span>
          <select id="gdFixturePick" style="width:auto; display:inline-block;">
            ${options}
            <option value="">Another date…</option>
          </select>
        </label>` : ''}
    </div>
    <p class="hint" data-gd-reopen style="margin:0.4rem 0 0.8rem"></p>`;

  $('gdNoGame')?.addEventListener('click', async () => {
    if (await markNoGame(contractId, next)) renderFixture();
  });

  $('gdFixturePick')?.addEventListener('change', (e) => {
    const picked = e.target.value;
    const note = document.querySelector('[data-gd-reopen]');
    if (!picked) { if (note) note.textContent = 'Pick any date in the box below.'; return; }
    if (dateBox) { dateBox.value = picked; dateBox.dataset.touched = '1'; }
    const wasSkipped = skipped.some(d => d.date === picked);
    if (note) {
      note.textContent = wasSkipped
        ? `${fixtureDate(picked)} was marked as no game — confirming a game here will undo that.`
        : '';
    }
  });
}

/**
 * What confirming will actually do to this row — the question the preview was
 * silently not answering, since every row said "pending" whatever its fate.
 *
 * This is the same rule the ledger applies: the cost lands on whoever settles
 * it, and if that person has no prepaid balance it is money to collect rather
 * than money taken.
 */
function settlementOf(r) {
  const payerId = r.charged_to || r.player_id;
  const payer = rows.find(x => x.player_id === payerId)
    || (store.players || []).find(p => p.id === payerId);
  const payerName = payer?.display_name || payer?.name;
  const paysCash = !payerId
    || (payer?.player_type === 'outside')
    || (payer === r && (r.player_type === 'outside' || r.rate_type === 'noncontract'));

  if (paysCash) {
    // Cash can already be in your pocket by the time the game is entered, so
    // the only question the preview could answer was "still owed?" — now it can
    // say "already have it" too, and the kitty counts it accordingly.
    return r.paid
      ? {
        cls: 'is-collected', label: 'cash in hand', cash: true, collected: true,
        why: `${payerName || 'They'} paid on the day — click to put it back to owed.`,
      }
      : {
        cls: 'is-collect', label: 'to collect', cash: true, collected: false,
        why: payerId
          ? `${payerName || 'They'} have no prepaid balance, so this stays owed until you collect it. Click if you already have the cash.`
          : 'Nobody is prepaying this. Click if you already have the cash.',
      };
  }
  return {
    cls: 'is-balance', label: payerId === r.player_id ? 'from balance' : `${payerName} pays`,
    cash: false,
    why: payerId === r.player_id
      ? 'Comes straight off their contract balance when you confirm.'
      : `Comes off ${payerName}'s contract balance when you confirm.`,
  };
}

function renderPreview(meta) {
  $('gdPreviewCard').hidden = false;
  const outsideCount = rows.filter(r => r.player_type === 'outside').length;
  const unmatchedCount = rows.filter(r => !r.matched).length;
  // The rate column was inferred from headcount and only ever mentioned in
  // passing, so a game priced off the wrong column looked identical to one
  // priced correctly. It is now stated and changeable.
  const bucket = currentBucket(meta);
  let metaText = `${rows.length} players · ${meta.teams.join(' / ')}`;
  if (outsideCount) metaText += ` · ${outsideCount} outside`;
  if (unmatchedCount) metaText += ` · ${unmatchedCount} unidentified`;
  $('gdMeta').innerHTML = `${esc(metaText)}
    · priced on the
    <select id="gdBucket" style="width:auto; display:inline-block; padding:0.1rem 0.3rem; font-size:0.85rem;">
      <option value="10" ${bucket === '10' ? 'selected' : ''}>10-a-side</option>
      <option value="12" ${bucket === '12' ? 'selected' : ''}>12-a-side</option>
    </select> card`;
  $('gdBucket').addEventListener('change', (e) => {
    meta.bucket = e.target.value;
    meta.bucketPinned = true;   // a deliberate choice outranks the headcount
    // Re-price everyone off the new column, keeping any hand-typed guest rate.
    rows.forEach(r => applyRate(r, meta));
    renderPreview(meta);
    toast(`Re-priced on the ${meta.bucket}-a-side card`, false);
  });

  $('gdTable').querySelector('tbody').innerHTML = rows.map((r, i) => {
    // Auto-populate preset amount if empty
    if (!r.amount || r.amount === 0) {
      r.amount = getPresetRate(r.rate_type, contractId);
    }

    // Every player gets this control, not only the unmatched ones. A regular can
    // turn up as a guest for one game and a guest can be signed up, and the
    // preview was the one place that could not say so — the status was fixed text
    // for anyone the parser recognised.
    const isOutside = r.player_type === 'outside' || r.rate_type === 'noncontract';
    const typeControl = `
      <select class="player-type-select" data-i="${i}" style="padding:0.3rem; font-size:0.85rem;">
        <option value="regular" ${!isOutside ? 'selected' : ''}>In contract</option>
        <option value="outside" ${isOutside ? 'selected' : ''}>Out of contract</option>
      </select>`;

    // Who settles this charge. Offered for EVERY row, including names the parser
    // did not recognise — a guest nobody can identify is exactly the one most
    // likely to need billing to the member who brought them, and this control
    // used to be withheld from them.
    //
    // The list is every player, not only the ones in this game: whoever vouches
    // for a guest is not always on the pitch that night.
    // Who covered them last time. A guest brought by the same member most weeks
    // should not have to be re-linked every week — and forgetting it is how you
    // lose track of who came from whom.
    if (r.charged_to === undefined && r.introduced_by && r.introduced_by !== r.player_id) {
      r.charged_to = r.introduced_by;
    }
    const settlesId = r.charged_to || r.player_id || '';
    const introducer = r.introduced_by
      ? (store.players || []).find(p => p.id === r.introduced_by)?.name
      : null;
    // Squad first, guests in their own group — sixty names in one flat list was
    // mostly walk-ups sitting on top of the twenty people you pick from.
    const playerOptions = rosterOptions(store.players, settlesId);
    const selfLabel = r.matched ? 'Themselves' : 'Themselves (new player)';
    const introNote = introducer && settlesId === r.introduced_by
      ? `<span class="intro-note" title="Remembered from a previous game">usually ${esc(introducer)}</span>`
      : '';
    const chargedToControl = `
      <select class="charged-to-select" data-i="${i}" style="padding:0.3rem; font-size:0.85rem; width:150px;">
        <option value="" ${!r.charged_to ? 'selected' : ''}>${selfLabel}</option>
        ${playerOptions}
      </select>`;

    const s = settlementOf(r);

    return `
    <tr>
      <td><strong>${esc(r.display_name)}</strong>${r.is_captain ? '<span class="capt-badge">C</span>' : ''}${
        !r.matched ? ' <span class="miss-badge">new / unmatched</span>' : ''}</td>
      <td><span class="team-dot team-${esc(r.team)}"></span>${esc(r.team)}</td>
      <td>${typeControl}</td>
      <td><span class="tag">${RATE_LABEL[r.rate_type] || r.rate_type}</span></td>
      <td style="text-align:right;"><input class="amt-input" type="number" step="1" data-i="${i}" value="${r.amount}"></td>
      <td style="text-align:center; font-size:0.85rem;">
        <span class="hint">Charged to:</span><br>${chargedToControl}${introNote}
      </td>
      <td style="text-align:center;">
        <span class="settle-badge ${s.cls}${s.cash ? ' is-toggle' : ''}"
          ${s.cash ? `data-cash="${i}" role="button" tabindex="0"` : ''}
          title="${esc(s.why)}">${s.label}</span>
      </td>
      <td class="row-actions"><button class="link-btn" data-del="${i}" title="Remove">✕</button></td>
    </tr>`;
  }).join('');

  $('gdTable').querySelectorAll('.player-type-select').forEach(sel =>
    sel.addEventListener('change', () => {
      const row = rows[sel.dataset.i];
      row.player_type = sel.value;
      if (sel.value === 'outside') row.outside_handling = 'relationship';
      // Re-price on the spot, otherwise the status says one thing and the amount
      // still reflects the old one.
      applyRate(row, meta);
      renderPreview(meta);
    }));

  // Handle charge reassignment to different player
  // Who SETTLES the charge, which is not the same as who played it. This used to
  // assign the chosen id to row.player_id, replacing the player themselves: point
  // Sikku's charge at Toby and Sikku left the game entirely, leaving two Toby
  // rows that the once-per-gameweek guard then rejected on confirm.
  $('gdTable').querySelectorAll('.charged-to-select').forEach(sel =>
    sel.addEventListener('change', () => {
      const row = rows[sel.dataset.i];
      const payerId = sel.value;             // '' means they settle it themselves
      if (payerId === (row.charged_to || '')) return;
      row.charged_to = payerId || null;
      const payer = store.players?.find(p => p.id === payerId)?.name;
      toast(payerId
        ? `${row.display_name} still plays — ${payer} pays for them`
        : `${row.display_name} settles their own charge`, false);
      renderPreview(meta);
    }));

  // Cash rows toggle between owed and already-collected.
  $('gdTable').querySelectorAll('[data-cash]').forEach(el => {
    const flip = () => {
      const row = rows[el.dataset.cash];
      row.paid = !row.paid;
      toast(row.paid
        ? `${row.display_name}'s cash is in hand`
        : `${row.display_name} still to collect`, false);
      renderPreview(meta);
    };
    el.addEventListener('click', flip);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
    });
  });

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

  // Say plainly what pressing Confirm will do, split the way the money actually
  // splits: some comes off balances now, the rest is cash still to chase.
  const summary = document.querySelector('[data-gd-summary]');
  if (summary) {
    // Three fates, not two: taken from a balance, cash already in hand, and
    // cash still owed. Folding the middle one into "to collect" told you to go
    // and chase money that was already in your pocket.
    const fates = rows.map(r => ({ r, s: settlementOf(r) }));
    const sum = (f) => f.reduce((s, x) => s + (Number(x.r.amount) || 0), 0);
    const onBalance = fates.filter(f => !f.s.cash);
    const inHand = fates.filter(f => f.s.cash && f.s.collected);
    const owed = fates.filter(f => f.s.cash && !f.s.collected);

    summary.innerHTML = rows.length ? `
      <span><strong>${money(sum(onBalance))}</strong> off balances now
        <span class="hint">(${onBalance.length} player${onBalance.length === 1 ? '' : 's'})</span></span>
      ${inHand.length ? `<span><strong>${money(sum(inHand))}</strong> cash in hand
        <span class="hint">(${inHand.map(f => f.r.display_name).join(', ')})</span></span>` : ''}
      ${owed.length ? `<span><strong>${money(sum(owed))}</strong> still to collect
        <span class="hint">(${owed.map(f => f.r.display_name).join(', ')})</span></span>` : ''}
      <span>Total charged <strong>${money(tot)}</strong></span>` : '';
  }

  // recalcTotal() takes no arguments and isn't nested inside renderPreview(),
  // so it has no `meta` in scope — this referenced a free `meta` identifier
  // that doesn't exist anywhere in the module, throwing a ReferenceError on
  // every call (every re-render, every amount edit, every contract switch)
  // and silently skipping the rate-warning gate and kitty auto-calc below it.
  // parseResult is the module-level equivalent of what callers pass as `meta`.
  showRateWarning(parseResult, tot);
  recomputeKitty();
}

// A contract with no rate card charges everyone 0 and says nothing, which is
// indistinguishable from a deliberately free game. Say it plainly and disable the
// confirm, rather than letting a worthless game be written.
function showRateWarning(meta, total) {
  let el = document.querySelector('[data-gd-ratewarn]');
  if (!el) {
    el = document.createElement('div');
    el.setAttribute('data-gd-ratewarn', '');
    $('gdTable').parentElement.insertBefore(el, $('gdTable'));
  }
  const noRates = meta?.rates_missing;
  const zero = total === 0 && rows.length > 0;
  const confirmBtn = $('gdConfirm');

  if (!noRates && !zero) {
    el.innerHTML = '';
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.title = ''; }
    return;
  }
  el.innerHTML = `
    <div class="panel panel-danger">
      <div class="panel-title">${noRates
        ? 'This contract has no rate card'
        : 'Every charge on this game is 0'}</div>
      <div class="panel-body">
        ${noRates
          ? 'No per-player rates are configured, so every player is being charged 0.'
          : 'The rate card may be incomplete, or the amounts were cleared by hand.'}
        Set them under <strong>Settings &rarr; Contract Settings &amp; Rate Cards</strong>,
        then parse again. Committing now would record a game worth nothing and move
        no balances.
      </div>
    </div>`;
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.title = 'Set the contract rates first';
  }
}

// Kitty earned is the game's actual profit: what the players were charged, less
// the pitch and water costs. It was a free-text box that defaulted to 0, so the
// figure only ever reflected what someone remembered to type. Editing it still
// works — a manual value is kept and marked as an override.
const payerName = (id) =>
  store.players?.find(p => p.id === id)?.name || 'whoever bought it';

function recomputeKitty() {
  const el = $('gdKittyEarned');
  if (!el) return;
  if (el.dataset.override === '1') return;      // user typed their own figure

  // A charge settled from a prepaid balance is money the club already holds. A
  // guest paying cash on the day is not — it is owed until collected. Adding the
  // two together and calling the result profit puts money in the kitty that is
  // still in somebody's pocket, so they are counted separately.
  //
  // settlementOf is the one place that decides which of those a charge is, and
  // it is what each row's badge already shows. This used to keep a second copy
  // that looked the payer up in `rows` alone: point a guest's charge at someone
  // who is not playing that night and the lookup missed, fell back to the guest
  // themselves, and went on calling it cash — so the badge said "Toby pays"
  // while the kitty behind it had not moved at all.
  const amount = (r) => Number(r.amount) || 0;
  const fates = rows.map(r => ({ r, s: settlementOf(r) }));
  const sum = (f) => f.reduce((s, x) => s + amount(x.r), 0);
  const collected = sum(fates.filter(f => !f.s.cash || f.s.collected));
  const pending = sum(fates.filter(f => f.s.cash && !f.s.collected));

  const c = store.contracts.find(x => x.id === contractId);
  const pitch = Number(c?.cost_per_gw) || 0;
  // Only water the club itself bought comes off the pot. When a player buys it
  // they are credited for it instead, so the cash never left the kitty — this
  // subtracted it either way, which charged the club twice and made the figure
  // sit still while the payer changed underneath it.
  const waterCost = Number($('gdGameCost')?.value) || 0;
  const waterPayer = $('gdCostPaidBy')?.value || 'self';
  const water = waterPayer === 'self' ? waterCost : 0;
  const round = (n) => Math.round(n * 100) / 100;
  const inHand = round(collected - pitch - water);
  const expected = round(collected + pending - pitch - water);

  // Only what is actually in hand is banked. The rest arrives as each guest is
  // marked paid from Game History, which credits the kitty then.
  el.value = inHand;
  const note = document.querySelector('[data-gd-kittynote]');
  if (note) {
    // Say why the water is or is not in the sum, so changing the payer visibly
    // changes the arithmetic rather than leaving the number looking stuck.
    const waterBit = water
      ? ` &minus; water ${money(water)}`
      : (waterCost
        ? ` <span class="hint">(water ${money(waterCost)} credited to ${esc(payerName(waterPayer))}, not taken from the kitty)</span>`
        : '');
    note.innerHTML = pending
      ? `In hand: collected ${money(collected)} &minus; pitch ${money(pitch)}${waterBit}
         = <strong>${money(inHand)}</strong><br>
         Once the ${money(pending)} of guest cash is collected: <strong>${money(expected)}</strong>.
         Mark each guest paid in Game History and the kitty tops up then.
         <button type="button" class="link-btn" id="gdKittyReset">reset</button>`
      : `charged ${money(collected)} &minus; pitch ${money(pitch)}${waterBit}
         = <strong>${money(inHand)}</strong>
         <button type="button" class="link-btn" id="gdKittyReset">reset</button>`;
    $('gdKittyReset')?.addEventListener('click', () => {
      el.dataset.override = '0'; recomputeKitty();
    });
  }
}

async function doParse() {
  const text = $('gdText').value.trim();
  if (!text) { toast('Paste a team message first', true); return; }
  try {
    parseResult = await api.parse(contractId, text);
    rows = parseResult.rows;
    if (!rows.length) { toast('No players detected', true); $('gdPreviewCard').hidden = true; return; }

    // Detect captains from "(C)" marker
    const playerNames = rows.map(r => r.display_name);
    const captains = detectCaptains(text, playerNames);
    rows.forEach(r => {
      if (captains.has(r.display_name)) {
        r.is_captain = true;
        // Update rate_type to captain variant if contracted
        if (r.rate_type === 'contracted_10') r.rate_type = 'captain_10';
        if (r.rate_type === 'contracted_12') r.rate_type = 'captain_12';
      }
    });

    // Auto-parse score from message
    const scoreData = parseScore(text);
    if (scoreData) {
      $('gdTeamAGoals').value = scoreData.goalsA;
      $('gdTeamBGoals').value = scoreData.goalsB;
      toast(`Auto-parsed score: ${scoreData.goalsA}-${scoreData.goalsB}`, false);
    }

    // Auto-parse team emojis/colors
    const teamData = parseTeamEmojis(text);
    if (teamData.hasRed) $('gdTeamAName').value = teamData.redTeam.name;
    if (teamData.hasBlue) $('gdTeamBName').value = teamData.blueTeam.name;

    // Show unmatched players with mapping suggestions
    const unmatchedTokens = parseResult.unmatched;
    if (unmatchedTokens.length) {
      await showUnmatchedMapping(unmatchedTokens);
      renderPreview(parseResult);
      toast(`Mapped ${unmatchedTokens.length} unmatched players. Mark outside/unidentified via dropdown.`, false);
    } else {
      renderPreview(parseResult);
    }
  } catch (e) { toast(e.message, true); }
}

/**
 * Fill in what the score and the parsed teams already imply, so "7-5" does not
 * have to be retyped into four more boxes. Anything set by hand wins.
 */
function derivedGame() {
  const teams = parseResult?.teams || [];
  const scoreText = ($('gdScore')?.value || '').trim();
  const m = scoreText.match(/(\d+)\s*[-–—:]\s*(\d+)/);
  const typed = (id) => {
    const v = $(id)?.value;
    return v === '' || v === undefined || v === null ? null : v;
  };
  return {
    aName: typed('gdTeamAName') ?? teams[0] ?? 'A',
    bName: typed('gdTeamBName') ?? teams[1] ?? 'B',
    aGoals: Number(typed('gdTeamAGoals') ?? (m ? m[1] : 0)) || 0,
    bGoals: Number(typed('gdTeamBGoals') ?? (m ? m[2] : 0)) || 0,
    hasScore: !!m,
  };
}

/** Say out loud what the single score box was understood to mean. */
function showScoreNote() {
  const note = document.querySelector('[data-gd-scorenote]');
  if (!note) return;
  const d = derivedGame();
  const raw = ($('gdScore')?.value || '').trim();
  note.textContent = !raw
    ? 'Leave blank if it was not recorded.'
    : d.hasScore
      ? `${d.aName} ${d.aGoals} — ${d.bName} ${d.bGoals}${d.aGoals === d.bGoals ? ' (draw)'
        : ` · ${d.aGoals > d.bGoals ? d.aName : d.bName} win`}`
      : 'Could not read a score from that — enter it as two numbers, like 7-5.';
}

async function doConfirm() {
  if (!rows.length) return;
  const d = derivedGame();
  const gameweek = {
    contract_id: contractId,
    date: $('gdDate').value || today(),
    contract_number: Number($('gdContractNo').value) || 0,
    cost_per_gw: store.contracts.find(c => c.id === contractId)?.cost_per_gw || 0,
    teams_raw: $('gdText').value.trim(),
    // A readable result built from the one score box, rather than asking for the
    // same thing again in words.
    score: d.hasScore
      ? (d.aGoals === d.bGoals
        ? `${d.aName} ${d.aGoals} - ${d.bName} ${d.bGoals} (draw)`
        : `${d.aGoals > d.bGoals ? d.aName : d.bName} win ${Math.max(d.aGoals, d.bGoals)}-${Math.min(d.aGoals, d.bGoals)}`)
      : $('gdScore').value.trim(),
    comments: $('gdComments').value.trim(),
    scoreline: `${d.aGoals}-${d.bGoals}`,
    teams_json: JSON.stringify(rows.map(r => ({ player_id: r.player_id, team: r.team }))),
    whatsapp_message: $('gdGameMessage').value.trim(),
    game_cost: Number($('gdGameCost').value) || 0,
    game_cost_paid_by: $('gdCostPaidBy').value || 'self',
    kitty_earned: Number($('gdKittyEarned').value) || 0,
    // Only a figure typed over the calculated one travels as an override. Left
    // alone, the server derives the kitty from the charges itself, so there is
    // no second number to drift out of step with the first.
    kitty_override: $('gdKittyEarned').dataset.override === '1',
  };
  const charges = rows.map(r => ({
    player_id: r.player_id, team: r.team, is_captain: r.is_captain,
    rate_type: r.rate_type, amount: Number(r.amount) || 0,
    player_type: r.player_type,
    outside_cost: r.outside_cost,
    introduced_by: r.introduced_by,
    outside_handling: r.outside_handling || 'relationship',  // default to relationship
    // Who actually settles this charge. Usually the player, but an outside guest
    // is billed to the contracted player who brought them.
    charged_to: r.charged_to || r.player_id,
    // Whether this one is cash is decided here, on the night, and must travel
    // with the charge. It used to be inferred server-side from the player's
    // permanent record, so marking a regular player as a cash guest for one game
    // was honoured in this preview and then silently dropped on save.
    settles_cash: settlementOf(r).cash ? 1 : 0,
    // Payments often arrive after the game is entered, so a charge starts unpaid
    // and is settled later from Game History.
    paid: r.paid ? 1 : 0,
  }));

  // Unmatched players have no id — confirm whether to create them.
  const newOnes = rows.filter(r => !r.player_id);
  if (newOnes.length) {
    const names = newOnes.map(r => r.display_name).join(', ');
    if (!confirm(`Create ${newOnes.length} new player(s) and charge them?\n${names}`)) return;
    for (const r of newOnes) {
      const p = await api.createPlayer({ name: r.display_name });
      charges[rows.indexOf(r)].player_id = p.id;
    }
    store.players = await api.players();
  }

  // The result travels with the game rather than following it in a second call,
  // so a game can never end up saved with its score lost. The guest-introducer
  // round-trip that used to run here is gone too: a guest is billed through
  // charged_to, and the transactions it wrote were excluded from every balance,
  // so they were a second set of books that moved nothing.
  if (d.hasScore) {
    gameweek.result = {
      team_a_name: d.aName, team_b_name: d.bName,
      goals_team_a: d.aGoals, goals_team_b: d.bGoals,
    };
  }

  try {
    await api.createGameweek(gameweek, charges);

    // The kitty is committed by the server inside the same transaction as the
    // game, so there is nothing left to ask here. This used to be a confirm()
    // that ran after the save had already gone through: declining it, or any
    // error in between, left the game recorded and its money nowhere.
    toast(`Game recorded — balances deducted, ${money(gameweek.kitty_earned)} to the kitty ✓`);

    clearForm();
    await loadDashboard();
  } catch (e) { toast(e.message, true); }
}

// The provisional-then-adjust pair that used to live here (post a guess at the
// profit, delete and repost it once the guests paid) is gone. Each guest's cash
// is now its own kitty entry written when they are marked paid, so the pot tops
// itself up and there is no provisional figure to go back and correct.

function clearForm() {
  rows = [];
  $('gdText').value = '';
  ['gdScore', 'gdComments', 'gdContractNo', 'gdTeamAName', 'gdTeamBName', 'gdTeamAGoals', 'gdTeamBGoals', 'gdGameCost', 'gdGameMessage'].forEach(id => $(id).value = '');
  $('gdKittyEarned').value = '';
  $('gdCostPaidBy').value = 'self';
  $('gdGameCost').value = '15'; // Reset to default water cost
  $('gdPreviewCard').hidden = true;
  // Release the date so the next fixture can prefill it again, and re-read the
  // schedule — the game just entered is no longer outstanding.
  delete $('gdDate').dataset.touched;
  showScoreNote();
  renderFixture();
}

export function initGameday() {
  contractSeg($('gdContractSeg'), store.contracts, contractId, (id) => {
    contractId = id; recalcTotal(); renderFixture();
  });
  $('gdDate').value = today();
  $('gdGameCost').value = '15'; // Default water cost

  // Populate "Who Paid Water Cost" dropdown with players
  const costPaidBySelect = $('gdCostPaidBy');
  if (costPaidBySelect && store.players?.length) {
    const options = '<option value="self">Me (Vijay)</option>' +
      store.players
        .filter(p => p.special_role !== 'cashier') // Exclude cashier
        .map(p => `<option value="${p.id}">${esc(p.name)}</option>`)
        .join('');
    costPaidBySelect.innerHTML = options;
  }

  $('gdParse').addEventListener('click', doParse);
  // Typing in the kitty box means "I know better" — stop recomputing over it.
  $('gdKittyEarned')?.addEventListener('input', (e) => {
    e.target.dataset.override = '1';
  });
  // The water cost feeds the profit, so a change to it should flow through.
  $('gdGameCost')?.addEventListener('input', () => recomputeKitty());
  // Who bought the water decides whether its cost comes off the pot or is owed
  // back to a player, so the figure has to move when the payer does.
  $('gdCostPaidBy')?.addEventListener('change', () => recomputeKitty());

  $('gdScore').addEventListener('input', showScoreNote);
  // A date the user set themselves must not be overwritten by the next fixture.
  $('gdDate').addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
  $('gdConfirm').addEventListener('click', doConfirm);
  $('gdClear').addEventListener('click', clearForm);
  showScoreNote();
}

export function loadGameday() {
  contractId ??= defaultContract();
  // Keep the contract segment in sync if contracts loaded after init.
  contractSeg($('gdContractSeg'), store.contracts, contractId, (id) => {
    contractId = id; recalcTotal(); renderFixture();
  });
  renderFixture();

  // Arriving from "Enter this game" on the season schedule: prefill the date
  // being caught up on, rather than making it be retyped and risking today's
  // date being recorded against an older fixture.
  const pending = sessionStorage.getItem('fmss:gameDate');
  if (pending) {
    sessionStorage.removeItem('fmss:gameDate');
    $('gdDate').value = pending;
    toast(`Entering the game for ${pending}`);
  }
}
