// gameday.js — paste WhatsApp teams → parse → editable preview → confirm & deduct.
import { api } from '../api.js';
import { store, toast } from '../store.js';
import { $, esc, money, today, contractSeg } from '../util.js';
import { loadDashboard } from './dashboard.js';

let contractId = 'sat';
let rows = [];                 // current preview rows (mutable amounts)
let parseResult = null;        // full parser result with metadata

const RATE_LABEL = {
  contracted_10: 'Contract', contracted_12: 'Contract',
  captain_10: 'Captain', captain_12: 'Captain', noncontract: 'Non-contract',
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

// Get preset rate for player type
function getPresetRate(rateType, contractId) {
  const c = store.contracts?.find(x => x.id === contractId);
  if (!c) return 0;

  // Use cost_per_gw as the base rate (set from contract)
  const baseRate = Number(c.cost_per_gw) || 0;
  const captainRate = Number(c.captain_rate) || baseRate;
  const noncontractRate = Number(c.noncontract_rate) || baseRate;

  if (rateType === 'captain_10' || rateType === 'captain_12') return captainRate;
  if (rateType === 'contracted_10' || rateType === 'contracted_12') return baseRate;
  if (rateType === 'noncontract') return noncontractRate;
  return baseRate;
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

function statusLabel(r) {
  if (!r.matched) return '<span class="miss-badge">new / unmatched</span>';
  if (r.is_captain) return 'Captain';
  if (r.player_type === 'outside') return `<span class="outside-badge">outside (${r.outside_cost} AED)</span>`;
  return r.rate_type === 'noncontract' ? 'Out of contract' : 'In contract';
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

function renderPreview(meta) {
  $('gdPreviewCard').hidden = false;
  const outsideCount = rows.filter(r => r.player_type === 'outside').length;
  const unmatchedCount = rows.filter(r => !r.matched).length;
  let metaText = `${rows.length} players · ${meta.teams.join(' / ')} · ${meta.bucket}-player rate`;
  if (outsideCount) metaText += ` · ${outsideCount} outside`;
  if (unmatchedCount) metaText += ` · ${unmatchedCount} unidentified`;
  $('gdMeta').textContent = metaText;

  $('gdTable').querySelector('tbody').innerHTML = rows.map((r, i) => {
    // Auto-populate preset amount if empty
    if (!r.amount || r.amount === 0) {
      r.amount = getPresetRate(r.rate_type, contractId);
    }

    // Allow marking unmatched players as outside vs regular
    const typeControl = !r.matched ? `
      <select class="player-type-select" data-i="${i}" style="padding:0.3rem; font-size:0.85rem;">
        <option value="regular" ${r.player_type !== 'outside' ? 'selected' : ''}>Contract</option>
        <option value="outside" ${r.player_type === 'outside' ? 'selected' : ''}>Outside</option>
      </select>` : statusLabel(r);

    // Allow reassigning charge to another player (for transfers)
    const playerOptions = rows.map(p => `<option value="${p.player_id}" ${p.player_id === r.player_id ? 'selected' : ''}>${esc(p.display_name)}</option>`).join('');
    const chargedToControl = r.matched ? `
      <select class="charged-to-select" data-i="${i}" style="padding:0.3rem; font-size:0.85rem; width:140px;">
        ${playerOptions}
      </select>` : '<span class="hint">—</span>';

    return `
    <tr>
      <td><strong>${esc(r.display_name)}</strong>${r.is_captain ? '<span class="capt-badge">C</span>' : ''}</td>
      <td><span class="team-dot team-${esc(r.team)}"></span>${esc(r.team)}</td>
      <td>${typeControl}</td>
      <td><span class="tag">${RATE_LABEL[r.rate_type] || r.rate_type}</span></td>
      <td style="text-align:right;"><input class="amt-input" type="number" step="1" data-i="${i}" value="${r.amount}"></td>
      <td style="text-align:center; font-size:0.85rem;">
        <span class="hint">Charged to:</span><br>${chargedToControl}
      </td>
      <td style="text-align:center; font-size:0.9rem;"><span class="pending-badge" data-i="${i}">pending</span></td>
      <td class="row-actions"><button class="link-btn" data-del="${i}" title="Remove">✕</button></td>
    </tr>`;
  }).join('');

  $('gdTable').querySelectorAll('.player-type-select').forEach(sel =>
    sel.addEventListener('change', () => {
      rows[sel.dataset.i].player_type = sel.value;
      if (sel.value === 'outside') {
        rows[sel.dataset.i].outside_handling = 'relationship';
      }
      renderPreview(meta);
    }));

  // Handle charge reassignment to different player
  $('gdTable').querySelectorAll('.charged-to-select').forEach(sel =>
    sel.addEventListener('change', () => {
      const newPlayerId = sel.value;
      if (newPlayerId && newPlayerId !== rows[sel.dataset.i].player_id) {
        const origPlayer = rows[sel.dataset.i].display_name;
        rows[sel.dataset.i].player_id = newPlayerId;
        const newPlayer = rows.find(r => r.player_id === newPlayerId)?.display_name || newPlayerId;
        toast(`${origPlayer}'s charge reassigned to ${newPlayer}`, false);
      }
    }));

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
    // New game accounting fields
    scoreline: `${Number($('gdTeamAGoals').value) || 0}-${Number($('gdTeamBGoals').value) || 0}`,
    teams_json: JSON.stringify(rows.map(r => ({ player_id: r.player_id, team: r.team }))),
    whatsapp_message: $('gdGameMessage').value.trim(),
    game_cost: Number($('gdGameCost').value) || 0,
    game_cost_paid_by: $('gdCostPaidBy').value || 'self',
    kitty_earned: Number($('gdKittyEarned').value) || 0,
  };
  const charges = rows.map(r => ({
    player_id: r.player_id, team: r.team, is_captain: r.is_captain,
    rate_type: r.rate_type, amount: Number(r.amount) || 0,
    player_type: r.player_type,
    outside_cost: r.outside_cost,
    introduced_by: r.introduced_by,
    outside_handling: r.outside_handling || 'relationship',  // default to relationship
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

  try {
    const gwResult = await api.createGameweek(gameweek, charges);

    // Handle outside player charges with introducer credits
    const outsidePlayers = charges.filter(c => c.player_type === 'outside' && c.introduced_by);
    for (const outside of outsidePlayers) {
      if (outside.outside_handling === 'relationship') {
        await api.post(`/gameweeks/${gwResult.id}/outside-player-charge`, {
          outside_player_id: outside.player_id,
          introducer_id: outside.introduced_by,
          cost: outside.outside_cost,
        });
      }
    }

    // If team scores provided, record the game result
    const teamAName = $('gdTeamAName').value.trim();
    const teamBName = $('gdTeamBName').value.trim();
    const goalsA = Number($('gdTeamAGoals').value) || 0;
    const goalsB = Number($('gdTeamBGoals').value) || 0;
    if (teamAName && teamBName) {
      await api.post(`/gameweeks/${gwResult.id}/accounting`, {
        scoreline: `${goalsA}-${goalsB}`,
        team_a_name: teamAName,
        team_b_name: teamBName,
        goals_team_a: goalsA,
        goals_team_b: goalsB,
        teams_json: gameweek.teams_json,
        whatsapp_message: gameweek.whatsapp_message,
        game_cost: gameweek.game_cost,
        game_cost_paid_by: gameweek.game_cost_paid_by,
        kitty_earned: gameweek.kitty_earned,
      });
    }

    toast('Game recorded — balances deducted ✓');

    // Offer to commit gameweek result to kitty
    const contractedCharges = charges.filter(c => c.player_type !== 'outside');
    const contractedTotal = contractedCharges.reduce((s, c) => s + c.amount, 0);
    const pitchCost = gameweek.cost_per_gw || 0;
    const gwProfit = contractedTotal - pitchCost;

    if (contractedTotal > 0) {
      const commitMsg = gwProfit >= 0
        ? `Commit profit ${money(gwProfit)} to kitty? (Collected ${money(contractedTotal)} - Pitch cost ${money(pitchCost)})`
        : `Commit loss ${money(gwProfit)} to kitty? (Collected ${money(contractedTotal)} - Pitch cost ${money(pitchCost)})`;

      if (confirm(commitMsg)) {
        try {
          await api.createKitty({
            kind: gwProfit >= 0 ? 'income' : 'expense',
            amount: Math.abs(gwProfit),
            label: `GW Result (${gameweek.date}) - Pending outside players`,
            date: gameweek.date,
          });
          toast(`✓ Committed ${money(Math.abs(gwProfit))} to kitty (pending adjustments)`, false);
        } catch (e) {
          toast(`Could not commit to kitty: ${e.message}`, true);
        }
      }
    }

    clearForm();
    await loadDashboard();
  } catch (e) { toast(e.message, true); }
}

// === GAMEWEEK P/L MANAGEMENT ===

// Calculate P/L for a gameweek (contracted players only, before outside players pay)
function calculateContractedPL(charges, pitchCost) {
  const contracted = charges.filter(c => c.player_type !== 'outside');
  const total = contracted.reduce((s, c) => s + c.amount, 0);
  return total - pitchCost;
}

// Adjust gameweek commit when outside players pay
async function adjustGameweekCommit(gameweekDate, actualOutsideIncome, kittyEntryId) {
  try {
    // First, delete the provisional entry
    if (kittyEntryId) {
      await api.deleteKitty(kittyEntryId);
    }

    // Then add the adjusted entry
    await api.createKitty({
      kind: 'income',
      amount: actualOutsideIncome,
      label: `GW Result Adjusted (${gameweekDate}) - Outside players paid`,
      date: gameweekDate,
    });

    toast(`✓ Updated gameweek commit with actual outside income ${money(actualOutsideIncome)}`, false);
    return true;
  } catch (e) {
    toast(`Failed to adjust commit: ${e.message}`, true);
    return false;
  }
}

function clearForm() {
  rows = [];
  $('gdText').value = '';
  ['gdScore', 'gdComments', 'gdContractNo', 'gdTeamAName', 'gdTeamBName', 'gdTeamAGoals', 'gdTeamBGoals', 'gdGameCost', 'gdGameMessage'].forEach(id => $(id).value = '');
  $('gdKittyEarned').value = '';
  $('gdCostPaidBy').value = 'self';
  $('gdGameCost').value = '15'; // Reset to default water cost
  $('gdPreviewCard').hidden = true;
}

export function initGameday() {
  contractSeg($('gdContractSeg'), store.contracts, contractId, (id) => { contractId = id; recalcTotal(); });
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
  $('gdConfirm').addEventListener('click', doConfirm);
  $('gdClear').addEventListener('click', clearForm);
}

export function loadGameday() {
  // Keep the contract segment in sync if contracts loaded after init.
  contractSeg($('gdContractSeg'), store.contracts, contractId, (id) => { contractId = id; recalcTotal(); });
}
