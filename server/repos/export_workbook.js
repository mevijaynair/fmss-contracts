// export_workbook.js — the whole club as a spreadsheet.
//
// What this is FOR decides everything about its shape. It is not the backup:
// `server/backup.js` already writes a JSON document that restores into a
// working system, and that is what you reload from. This is the file you take
// on a plane. It has to answer, with no app and no internet: what did each
// night cost, who has paid, what is the pot, where did this figure come from.
//
// Three rules follow from that.
//
// FIGURES COME FROM THE REPOS, not from fresh SQL. A balance here is
// `ledgersRepo`'s balance, the P&L is `financeRepo`'s P&L. A spreadsheet that
// quietly recomputes the club's money its own way is worse than no
// spreadsheet, because the disagreement only surfaces when somebody acts on
// the wrong one.
//
// IDs TRAVEL WITH THE ROWS. A charge sheet without its charge id and game id
// is a picture of the season, not something you can carry on from: reconciling
// an edit made offline back into the app needs the keys.
//
// NO CREDENTIALS, EVER. The JSON backup carries PINs and password hashes
// because a restore needs them. This file is going to be mailed to an
// accountant or opened on a shared laptop, so `auth_users`, `pin_history` and
// `login_devices` are not in it, and there is a test that fails if any of
// their contents appear.
import { db } from '../db.js';
import { buildWorkbook } from '../xlsx.js';
import { contractsRepo } from './contracts.js';
import { ledgersRepo } from './ledgers.js';
import { kittyRepo } from './kitty.js';
import { financeRepo } from './finance.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const yn = (v) => (Number(v) ? 'Yes' : '');

/** Tables deliberately left out, and why — read by the test that enforces it. */
export const NEVER_EXPORTED = {
  auth_users: 'PINs and password hashes',
  pin_history: 'old PIN hashes',
  login_devices: 'which addresses someone signs in from',
  admin_config: 'the admin password hash',
};

/**
 * Money columns are rounded on the way out.
 *
 * SQLite stores these as doubles, so a sum can arrive as 216.99999999999997.
 * In the app that is invisible behind a formatter; in a spreadsheet it is a
 * cell that looks wrong and then, once somebody sums a column of them, is
 * wrong by a fraction that nobody can source.
 */
const money = (v) => (v === null || v === undefined ? null : round2(v));

function nameMap() {
  return Object.fromEntries(db.prepare('SELECT id, name FROM players').all()
    .map(p => [p.id, p.name]));
}

function contractMap() {
  return Object.fromEntries(contractsRepo.all().map(c => [c.id, c.name]));
}

/** A contract's rates, whichever way they happen to be stored. */
function ratesOf(c) {
  if (typeof c.rates !== 'string') return c.rates || {};
  try { return JSON.parse(c.rates || '{}'); } catch { return {}; }
}

// ---------------------------------------------------------------------------
// The sheets. Each is { name, columns, rows } — see server/xlsx.js.

function aboutSheet(counts, when) {
  const cash = financeRepo.cashier();
  const rows = [
    ['FMSS Football Club', 'Everything the app holds, as at ' + when.slice(0, 10)],
    ['', ''],
    ['What this file is',
      'A readable copy of the club\'s books: every game, every charge, every '
      + 'payment, the pot, and what each contract has cost. Sort it, filter it, '
      + 'add your own columns — nothing here is read back into the app.'],
    ['What it is NOT',
      'This is not the backup. To move the club to another machine, or to undo '
      + 'a disaster, use Settings → Backup & restore, which writes a JSON file '
      + 'that restores into a working system. This one cannot be restored from.'],
    ['Nothing secret is in it',
      'Logins, PINs and password hashes are left out on purpose, so this file '
      + 'can be shared.'],
    ['', ''],
    ['How a balance works',
      'Opening + paid in − charged + adjustments. A positive balance is money '
      + 'the club is holding for that player; a negative one means their next '
      + 'game is not covered yet. Guests keep no balance — they pay cash per '
      + 'game, and what they still owe is on the "Guest cash" sheet.'],
    ['How the pot works',
      'The kitty is not a bank account. It is what every game has added or '
      + 'taken away, worked out from the charges — so it moves when a game is '
      + 'edited. The "Cashier" sheet is the other side of it: actual cash.'],
    ['', ''],
    ['Cash in hand, by the books', money(cash.in_hand)],
    ['Claims on that cash', money(cash.claims.total)],
    ['Difference (must be zero)', money(cash.drift)],
    ['Kitty balance', money(kittyRepo.balance().balance)],
    ['', ''],
    ['Rows on each sheet', ''],
    ...Object.entries(counts).map(([k, v]) => [k, v]),
  ];
  return {
    name: 'About this file',
    freeze: false,
    filter: false,
    columns: [
      { header: 'Item', key: 'a', type: 'text', width: 34 },
      { header: 'Detail', key: 'b', type: 'wrap', width: 96 },
    ],
    rows: rows.map(([a, b]) => ({ a, b })),
  };
}

function balancesSheet(cNames) {
  const rows = ledgersRepo.all().map(l => ({
    contract: cNames[l.contract_id] || l.contract_id,
    player: l.player_name,
    kind: l.player_type === 'outside' ? 'Guest' : 'Member',
    role: l.special_role || '',
    opening: money(l.opening_balance),
    paid_in: money(l.contributed),
    charged: money(l.charged),
    adjusted: money(l.adjusted),
    balance: money(l.present_balance),
    cash_owed: money(l.cash_owed),
    games: l.games,
    billed: l.games_billed,
    last_game: l.last_game_date,
    last_paid: l.last_incoming_date,
    status: l.status,
    left: yn(l.hide_from_sheet),
    player_id: l.player_id,
    contract_id: l.contract_id,
  }));
  return {
    name: 'Balances',
    columns: [
      { header: 'Contract', key: 'contract', type: 'text', width: 14 },
      { header: 'Player', key: 'player', type: 'text', width: 20 },
      { header: 'Member or guest', key: 'kind', type: 'text', width: 15 },
      { header: 'Club role', key: 'role', type: 'text', width: 12 },
      { header: 'Opening', key: 'opening', type: 'money' },
      { header: 'Paid in', key: 'paid_in', type: 'money' },
      { header: 'Charged', key: 'charged', type: 'money' },
      { header: 'Adjustments', key: 'adjusted', type: 'money' },
      { header: 'Balance now', key: 'balance', type: 'money', width: 14 },
      { header: 'Cash still owed', key: 'cash_owed', type: 'money', width: 15 },
      { header: 'Games', key: 'games', type: 'int' },
      { header: 'Billed games', key: 'billed', type: 'int', width: 13 },
      { header: 'Last game', key: 'last_game', type: 'date', width: 13 },
      { header: 'Last payment', key: 'last_paid', type: 'date', width: 13 },
      { header: 'Status', key: 'status', type: 'text', width: 24 },
      { header: 'Left the club', key: 'left', type: 'text', width: 13 },
      { header: 'Player id', key: 'player_id', type: 'text', width: 16 },
      { header: 'Contract id', key: 'contract_id', type: 'text', width: 13 },
    ],
    rows,
  };
}

function playersSheet(names) {
  const rows = db.prepare(`SELECT * FROM players ORDER BY name`).all().map(p => ({
    ...p,
    kind: (p.player_type || 'regular') === 'outside' ? 'Guest' : 'Member',
    introduced: p.introduced_by ? names[p.introduced_by] || p.introduced_by : '',
    left: yn(p.hide_from_sheet),
    aliases: (() => { try { return JSON.parse(p.aliases || '[]').join(', '); } catch { return p.aliases; } })(),
  }));
  return {
    name: 'Players',
    columns: [
      { header: 'Name', key: 'name', type: 'text', width: 22 },
      { header: 'Member or guest', key: 'kind', type: 'text', width: 15 },
      { header: 'Club role', key: 'special_role', type: 'text', width: 12 },
      { header: 'Guest rate', key: 'outside_cost', type: 'money', width: 12 },
      { header: 'Brought by', key: 'introduced', type: 'text', width: 16 },
      { header: 'Left the club', key: 'left', type: 'text', width: 13 },
      { header: 'Also known as', key: 'aliases', type: 'text', width: 26 },
      { header: 'Shared balance', key: 'balance_group_id', type: 'text', width: 16 },
      { header: 'Added', key: 'created_at', type: 'date', width: 13 },
      { header: 'Player id', key: 'id', type: 'text', width: 16 },
    ],
    rows,
  };
}

function contractsSheet() {
  const rows = contractsRepo.all().map(c => {
    const r = ratesOf(c);
    return {
      ...c,
      member_rate: money(r.contracted_10 ?? r.contracted),
      guest_rate: money(r.noncontract),
      captain_rate: money(r.captain ?? r.captain_rate),
      cost_per_gw: money(c.cost_per_gw),
    };
  });
  return {
    name: 'Contracts',
    columns: [
      { header: 'Contract', key: 'name', type: 'text', width: 16 },
      { header: 'Ground', key: 'venue', type: 'text', width: 22 },
      { header: 'Nights', key: 'game_days', type: 'text', width: 16 },
      { header: 'Pitch cost per game', key: 'cost_per_gw', type: 'money', width: 18 },
      { header: 'Member rate', key: 'member_rate', type: 'money', width: 13 },
      { header: 'Guest rate', key: 'guest_rate', type: 'money', width: 13 },
      { header: 'Captain rate', key: 'captain_rate', type: 'money', width: 13 },
      { header: 'Season start', key: 'season_start', type: 'date', width: 13 },
      { header: 'Contract id', key: 'id', type: 'text', width: 13 },
    ],
    rows,
  };
}

function gamesSheet(cNames) {
  // A game only carries a ground of its own when it was played somewhere other
  // than the contract's usual one, so the column has to fall back — otherwise
  // every ordinary night reads as having no ground at all.
  const rows = db.prepare(`
    SELECT g.*,
           COALESCE(NULLIF(TRIM(g.venue), ''), c.venue, '') AS ground,
           (SELECT COUNT(*) FROM charges ch WHERE ch.gameweek_id = g.id) AS players,
           (SELECT COALESCE(SUM(ch.amount),0) FROM charges ch WHERE ch.gameweek_id = g.id)
             AS charged,
           (SELECT COALESCE(SUM(CASE WHEN k.kind='income' THEN k.amount ELSE -k.amount END),0)
              FROM kitty k WHERE k.scope = g.id) AS kitty_net
    FROM gameweeks g LEFT JOIN contracts c ON c.id = g.contract_id
    ORDER BY g.date DESC, g.created_at DESC`).all().map(g => ({
    ...g,
    contract: cNames[g.contract_id] || g.contract_id,
    hours: Number(g.hours) || 1,
    cost_per_gw: money(g.cost_per_gw),
    game_cost: money(g.game_cost),
    charged: money(g.charged),
    kitty_net: money(g.kitty_net),
    result: g.scoreline || g.score || '',
    imported: yn(g.historical),
    captains: (g.captains_raw || '').replace(/\s+/g, ' ').trim(),
  }));
  return {
    name: 'Games',
    columns: [
      { header: 'Date', key: 'date', type: 'date', width: 12 },
      { header: 'Contract', key: 'contract', type: 'text', width: 14 },
      { header: 'Ground', key: 'ground', type: 'text', width: 20 },
      { header: 'Game no.', key: 'gw_number', type: 'int', width: 10 },
      { header: 'Hours', key: 'hours', type: 'number', width: 8 },
      { header: 'Players', key: 'players', type: 'int', width: 9 },
      { header: 'Pitch cost', key: 'cost_per_gw', type: 'money', width: 12 },
      { header: 'Water etc.', key: 'game_cost', type: 'money', width: 12 },
      { header: 'Water paid by', key: 'game_cost_paid_by', type: 'text', width: 14 },
      { header: 'Charged to players', key: 'charged', type: 'money', width: 17 },
      { header: 'Into the pot', key: 'kitty_net', type: 'money', width: 13 },
      { header: 'Result', key: 'result', type: 'text', width: 16 },
      { header: 'Captains', key: 'captains', type: 'text', width: 26 },
      { header: 'Tournament', key: 'tournament_name', type: 'text', width: 16 },
      { header: 'Imported season', key: 'imported', type: 'text', width: 15 },
      { header: 'Notes', key: 'comments', type: 'wrap', width: 40 },
      { header: 'Game id', key: 'id', type: 'text', width: 20 },
    ],
    rows,
  };
}

function chargesSheet(cNames) {
  const rows = db.prepare(`
    SELECT ch.*, g.date, g.contract_id, g.historical,
           p.name AS player, s.name AS settler
    FROM charges ch
    JOIN gameweeks g ON g.id = ch.gameweek_id
    JOIN players p ON p.id = ch.player_id
    LEFT JOIN players s ON s.id = ch.charged_to
    ORDER BY g.date DESC, p.name`).all().map(ch => ({
    ...ch,
    contract: cNames[ch.contract_id] || ch.contract_id,
    settles_on: cNames[ch.settle_contract_id || ch.contract_id]
      || ch.settle_contract_id || ch.contract_id,
    // Who played and whose money it is are different questions, and the
    // second one is only interesting when the answer is somebody else.
    paid_by: ch.settler && ch.settler !== ch.player ? ch.settler : '',
    amount: money(ch.amount),
    captain: yn(ch.is_captain),
    settled_cash: yn(ch.settles_cash),
    from_kitty: yn(ch.settled_from_kitty),
    paid: yn(ch.paid),
    imported: yn(ch.historical),
  }));
  return {
    name: 'Charges',
    columns: [
      { header: 'Date', key: 'date', type: 'date', width: 12 },
      { header: 'Contract', key: 'contract', type: 'text', width: 14 },
      { header: 'Player', key: 'player', type: 'text', width: 18 },
      { header: 'Paid for by', key: 'paid_by', type: 'text', width: 16 },
      { header: 'Comes off', key: 'settles_on', type: 'text', width: 14 },
      { header: 'Amount', key: 'amount', type: 'money', width: 11 },
      { header: 'Rate', key: 'rate_type', type: 'text', width: 14 },
      { header: 'Team', key: 'team', type: 'text', width: 10 },
      { header: 'Captain', key: 'captain', type: 'text', width: 9 },
      { header: 'Cash charge', key: 'settled_cash', type: 'text', width: 12 },
      { header: 'Cash handed over', key: 'paid', type: 'text', width: 16 },
      { header: 'How', key: 'paid_method', type: 'text', width: 12 },
      { header: 'Paid on', key: 'paid_at', type: 'date', width: 12 },
      { header: 'Carried by the pot', key: 'from_kitty', type: 'text', width: 17 },
      { header: 'Imported season', key: 'imported', type: 'text', width: 15 },
      { header: 'Charge id', key: 'id', type: 'text', width: 22 },
      { header: 'Game id', key: 'gameweek_id', type: 'text', width: 20 },
    ],
    rows,
  };
}

function moneyInSheet(cNames, names) {
  const rows = db.prepare('SELECT * FROM contributions ORDER BY date DESC, created_at DESC')
    .all().map(c => ({
      ...c,
      player: c.player_id ? names[c.player_id] || c.player_id : c.name_raw,
      contract: cNames[c.contract_id] || c.contract_id || '',
      amount: money(c.amount),
      imported: yn(c.historical),
    }));
  return {
    name: 'Money in',
    columns: [
      { header: 'Date', key: 'date', type: 'date', width: 12 },
      { header: 'Player', key: 'player', type: 'text', width: 20 },
      { header: 'Contract', key: 'contract', type: 'text', width: 14 },
      { header: 'Amount', key: 'amount', type: 'money', width: 12 },
      { header: 'Notes', key: 'comments', type: 'wrap', width: 44 },
      { header: 'Imported season', key: 'imported', type: 'text', width: 15 },
      { header: 'Split of', key: 'split_group', type: 'text', width: 16 },
      { header: 'Entry id', key: 'id', type: 'text', width: 22 },
    ],
    rows,
  };
}

function kittySheet(cNames) {
  const rows = db.prepare('SELECT * FROM kitty ORDER BY date DESC, created_at DESC')
    .all().map(k => ({
      ...k,
      contract: cNames[k.contract_id] || k.contract_id || '',
      amount: money(k.amount),
      signed: money(k.kind === 'income' ? k.amount : -k.amount),
      imported: yn(k.historical),
      game: k.scope || '',
    }));

  // What was already in the pot when tracking began is not one of these rows —
  // it is a separate baseline figure. Without it on the sheet, summing the
  // column gives a number that is not the kitty and looks like one, which is
  // exactly the kind of quiet disagreement this file must not produce.
  const opening = kittyRepo.balance().opening;
  if (opening) {
    rows.push({
      date: '', kind: 'opening',
      label: 'In the pot when tracking began (a baseline, not a transaction)',
      amount: money(opening), signed: money(opening), contract: '', game: '', imported: '',
      id: '',
    });
  }
  return {
    name: 'Kitty',
    columns: [
      { header: 'Date', key: 'date', type: 'date', width: 12 },
      { header: 'In or out', key: 'kind', type: 'text', width: 11 },
      { header: 'What for', key: 'label', type: 'text', width: 40 },
      { header: 'Amount', key: 'amount', type: 'money', width: 12 },
      { header: 'Effect on the pot', key: 'signed', type: 'money', width: 17 },
      { header: 'Contract', key: 'contract', type: 'text', width: 14 },
      { header: 'Game it belongs to', key: 'game', type: 'text', width: 20 },
      { header: 'Imported season', key: 'imported', type: 'text', width: 15 },
      { header: 'Entry id', key: 'id', type: 'text', width: 22 },
    ],
    rows,
  };
}

function venueSheets() {
  const all = contractsRepo.all().flatMap(c => financeRepo.venueContracts(c.id));
  const contracts = {
    name: 'Venue contracts',
    columns: [
      { header: 'Vendor', key: 'vendor', type: 'text', width: 18 },
      { header: 'For', key: 'contract_name', type: 'text', width: 14 },
      { header: 'From', key: 'start_date', type: 'date', width: 12 },
      { header: 'To', key: 'end_date', type: 'date', width: 12 },
      { header: 'Hours bought', key: 'sessions_total', type: 'number', width: 13 },
      { header: 'Free hours', key: 'free_sessions', type: 'number', width: 11 },
      { header: 'Hours covered', key: 'sessions_covered', type: 'number', width: 14 },
      { header: 'Total price', key: 'amount_total', type: 'money', width: 13 },
      { header: 'Cost per hour', key: 'cost_per_session', type: 'money', width: 14 },
      { header: 'Paid so far', key: 'paid', type: 'money', width: 12 },
      { header: 'Still to pay', key: 'outstanding', type: 'money', width: 13 },
      { header: 'Hours played', key: 'hours_played', type: 'number', width: 13 },
      { header: 'Hours left', key: 'sessions_left', type: 'number', width: 11 },
      { header: 'Games booked at', key: 'booked_per_session', type: 'money', width: 16 },
      { header: 'Gap per hour', key: 'variance_per_session', type: 'money', width: 13 },
      { header: 'Gap in total', key: 'variance_total', type: 'money', width: 13 },
      { header: 'Notes', key: 'notes', type: 'wrap', width: 34 },
      { header: 'Booking id', key: 'id', type: 'text', width: 20 },
    ],
    rows: all.map(v => ({
      ...v,
      amount_total: money(v.amount_total),
      cost_per_session: money(v.cost_per_session),
      paid: money(v.paid),
      outstanding: money(v.outstanding),
    })),
  };

  const payments = {
    name: 'Venue payments',
    columns: [
      { header: 'Date', key: 'date', type: 'date', width: 12 },
      { header: 'Vendor', key: 'vendor', type: 'text', width: 18 },
      { header: 'For', key: 'contract_name', type: 'text', width: 14 },
      { header: 'Amount', key: 'amount', type: 'money', width: 12 },
      { header: 'Paid by', key: 'paid_by', type: 'text', width: 14 },
      { header: 'How', key: 'method', type: 'text', width: 12 },
      { header: 'Note', key: 'note', type: 'wrap', width: 34 },
      { header: 'Payment id', key: 'id', type: 'text', width: 20 },
    ],
    rows: all.flatMap(v => (v.payments || []).map(p => ({
      ...p, vendor: v.vendor, contract_name: v.contract_name, amount: money(p.amount),
    }))).sort((a, b) => String(b.date).localeCompare(String(a.date))),
  };

  return [contracts, payments];
}

/**
 * The cashier's statement, flattened.
 *
 * Kept as the statement reads on screen — opening, in, out, what you should be
 * holding, then every claim on it — rather than as one row per figure in some
 * other order. The reconciliation is the reason the sheet exists, and it only
 * reads as a reconciliation if the two halves are laid out as two halves.
 */
function cashierSheet() {
  const c = financeRepo.cashier();
  const line = (section, item, amount) => ({ section, item, amount: money(amount) });
  const rows = [
    line('Opening', 'Player credit already in hand', c.opening.player_credit),
    line('Opening', 'Kitty at the baseline', c.opening.kitty),
    line('Opening', 'Total', c.opening.total),
    line('Money in', 'Top-ups from players', c.money_in.top_ups),
    line('Money in', 'Guest cash collected', c.money_in.guest_cash_collected),
    line('Money in', 'Programme cash', c.money_in.programme_cash),
    line('Money in', 'Other', c.money_in.other),
    line('Money in', 'Total', c.money_in.total),
    line('Money out', 'Paid to venues', c.money_out.paid_to_venues),
    line('Money out', 'Water and match costs', c.money_out.water),
    line('Money out', 'Programmes you paid for', c.money_out.programmes_you_paid_for),
    line('Money out', 'Other', c.money_out.other),
    line('Money out', 'Total', c.money_out.total),
    line('In hand', 'Cash you should be holding', c.in_hand),
    line('Claims', 'Held for players in credit', c.claims.held_for_players),
    line('Claims', 'Owed by players in the red', -c.claims.owed_by_players),
    line('Claims', 'Your own account', c.claims.own_account),
    line('Claims', 'The kitty', c.claims.kitty),
    line('Claims', 'Owed to venues for games played', c.claims.owed_to_venues),
    line('Claims', 'Total', c.claims.total),
    line('Check', 'In hand less claims — must be zero', c.drift),
    ...c.per_contract.flatMap(p => [
      line(p.contract_name, 'Pitch charged for games played', p.pitch_accrued),
      line(p.contract_name, 'Paid to the venue', p.paid_to_venue),
      line(p.contract_name, 'Still owed to the venue', p.owed_to_venue),
    ]),
  ];
  return {
    name: 'Cashier',
    filter: false,
    columns: [
      { header: 'Section', key: 'section', type: 'text', width: 18 },
      { header: 'Line', key: 'item', type: 'text', width: 42 },
      { header: 'Amount', key: 'amount', type: 'money', width: 14 },
    ],
    rows,
  };
}

function pnlSheet() {
  const rows = [];
  for (const c of contractsRepo.all()) {
    let p;
    try { p = financeRepo.pnl(c.id); } catch { continue; }
    const line = (item, amount) => rows.push({
      contract: p.contract_name, item, amount: amount === null ? null : money(amount),
    });
    line('Games played', p.games);
    line('Hours played', p.hours);
    line('Players billed', p.players_billed);
    line('Revenue — off balances', p.revenue.from_balances);
    line('Revenue — guest cash collected', p.revenue.guest_cash_collected);
    line('Revenue — other income', p.revenue.other_income);
    line('Revenue — total', p.revenue.total);
    line('Cost — pitch, as the games were booked', p.cost.pitch_booked);
    line('Cost — pitch, at the contract rate', p.cost.pitch_contracted);
    line('Cost — water and extras', p.cost.water);
    line('Cost — other', p.cost.other_expense);
    line('Cost — total as booked', p.cost.total_booked);
    line('Cost — total at contract rates', p.cost.total_contracted);
    line('Profit as booked', p.profit);
    line('Profit at contract rates', p.profit_contracted);
    line('Profit per game', p.profit_per_game);
    line('Not counted — guest cash still owed', p.not_counted.guest_cash_still_owed);
    line('Not counted — places carried by the pot', p.not_counted.places_carried_by_the_kitty);
    line('The pot says', p.kitty_says);
    line('Difference — must be zero', p.drift);
  }
  return {
    name: 'Profit and loss',
    filter: false,
    columns: [
      { header: 'Contract', key: 'contract', type: 'text', width: 16 },
      { header: 'Line', key: 'item', type: 'text', width: 44 },
      { header: 'Amount', key: 'amount', type: 'money', width: 14 },
    ],
    rows,
  };
}

function guestCashSheet(cNames) {
  // Every unpaid game, not one line per guest: the question this sheet gets
  // asked offline is "which nights has he not paid for", and a single total
  // cannot answer it.
  const rows = ledgersRepo.cashOutstandingGames().map(r => ({
    ...r,
    contract: r.contract_name || cNames[r.contract_id] || r.contract_id || '',
    amount: money(r.amount),
    played_by: r.played_by && r.played_by !== r.player_name ? r.played_by : '',
  }));
  return {
    name: 'Guest cash',
    columns: [
      { header: 'Date', key: 'date', type: 'date', width: 12 },
      { header: 'Owed by', key: 'player_name', type: 'text', width: 20 },
      { header: 'Who played', key: 'played_by', type: 'text', width: 18 },
      { header: 'Contract', key: 'contract', type: 'text', width: 14 },
      { header: 'Owes', key: 'amount', type: 'money', width: 12 },
      { header: 'Rate', key: 'rate_type', type: 'text', width: 14 },
      { header: 'Charge id', key: 'charge_id', type: 'text', width: 22 },
      { header: 'Game id', key: 'gameweek_id', type: 'text', width: 20 },
    ],
    rows,
  };
}

function resultsSheet(cNames) {
  const rows = db.prepare(`
    SELECT r.*, g.date, g.contract_id FROM game_results r
    JOIN gameweeks g ON g.id = r.gameweek_id
    ORDER BY g.date DESC`).all().map(r => ({
    ...r, contract: cNames[r.contract_id] || r.contract_id,
  }));
  return {
    name: 'Results',
    columns: [
      { header: 'Date', key: 'date', type: 'date', width: 12 },
      { header: 'Contract', key: 'contract', type: 'text', width: 14 },
      { header: 'Team A', key: 'team_a_name', type: 'text', width: 14 },
      { header: 'Goals A', key: 'goals_team_a', type: 'int', width: 9 },
      { header: 'Team B', key: 'team_b_name', type: 'text', width: 14 },
      { header: 'Goals B', key: 'goals_team_b', type: 'int', width: 9 },
      { header: 'Result', key: 'result', type: 'text', width: 12 },
      { header: 'Game id', key: 'gameweek_id', type: 'text', width: 20 },
    ],
    rows,
  };
}

function movementsSheet(cNames, names) {
  const moves = db.prepare('SELECT * FROM movements ORDER BY date DESC, created_at DESC')
    .all().map(m => ({
      kind: 'Movement',
      date: m.date,
      from: m.from_party,
      to: m.to_party,
      amount: money(m.amount),
      contract: cNames[m.contract_id] || m.contract_id || '',
      note: m.note,
      id: m.id,
    }));
  const tx = db.prepare('SELECT * FROM transactions ORDER BY created_at DESC').all().map(t => ({
    kind: t.type || 'Transfer',
    date: (t.created_at || '').slice(0, 10),
    from: names[t.player_id] || t.player_id || '',
    to: names[t.related_player_id] || t.related_player_id || '',
    amount: money(t.amount),
    contract: cNames[t.contract_id] || t.contract_id || '',
    note: [t.description, t.status && `(${t.status})`].filter(Boolean).join(' '),
    id: t.id,
  }));
  return {
    name: 'Transfers',
    columns: [
      { header: 'Date', key: 'date', type: 'date', width: 12 },
      { header: 'Kind', key: 'kind', type: 'text', width: 16 },
      { header: 'From', key: 'from', type: 'text', width: 18 },
      { header: 'To', key: 'to', type: 'text', width: 18 },
      { header: 'Amount', key: 'amount', type: 'money', width: 12 },
      { header: 'Contract', key: 'contract', type: 'text', width: 14 },
      { header: 'Note', key: 'note', type: 'wrap', width: 44 },
      { header: 'Entry id', key: 'id', type: 'text', width: 22 },
    ],
    rows: [...moves, ...tx].sort((a, b) => String(b.date).localeCompare(String(a.date))),
  };
}

function openingSheet(cNames, names) {
  const rows = db.prepare(
    'SELECT * FROM opening_balances_snapshot ORDER BY contract_id, player_id').all().map(o => ({
    ...o,
    contract: cNames[o.contract_id] || o.contract_id,
    player: names[o.player_id] || o.player_id,
    opening_balance: money(o.opening_balance),
    locked: o.locked_at ? 'Locked' : '',
  }));
  return {
    name: 'Opening balances',
    columns: [
      { header: 'Contract', key: 'contract', type: 'text', width: 14 },
      { header: 'Player', key: 'player', type: 'text', width: 20 },
      { header: 'Opening balance', key: 'opening_balance', type: 'money', width: 16 },
      { header: 'As at', key: 'snapshot_date', type: 'date', width: 12 },
      { header: 'Locked', key: 'locked', type: 'text', width: 10 },
      { header: 'Imported by', key: 'imported_by', type: 'text', width: 14 },
      { header: 'Batch', key: 'import_batch', type: 'text', width: 20 },
      { header: 'Notes', key: 'notes', type: 'wrap', width: 30 },
    ],
    rows,
  };
}

function changesSheet(names) {
  const edits = db.prepare(`
    SELECT a.*, p.name AS player, g.date
    FROM charge_audit a
    LEFT JOIN charges ch ON ch.id = a.charge_id
    LEFT JOIN players p ON p.id = ch.player_id
    LEFT JOIN gameweeks g ON g.id = ch.gameweek_id
    ORDER BY a.created_at DESC`).all().map(a => ({
    when: (a.created_at || '').slice(0, 10),
    what: 'Charge corrected',
    who: a.changed_by || '',
    detail: [a.player, a.date, a.reason].filter(Boolean).join(' · '),
    from: money(a.original_amount),
    to: money(a.new_amount),
    id: a.charge_id,
  }));
  // The general log, without the address and browser it also records: those
  // are for investigating a login, and this file is meant to be shareable.
  const log = db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 5000')
    .all().map(a => ({
      when: (a.created_at || '').slice(0, 10),
      what: a.action || '',
      who: a.user_id || '',
      detail: [a.player_id ? names[a.player_id] || a.player_id : '', a.details]
        .filter(Boolean).join(' · '),
      from: null,
      to: null,
      id: a.id,
    }));
  return {
    name: 'Changes',
    columns: [
      { header: 'When', key: 'when', type: 'date', width: 12 },
      { header: 'What happened', key: 'what', type: 'text', width: 24 },
      { header: 'By', key: 'who', type: 'text', width: 14 },
      { header: 'Detail', key: 'detail', type: 'wrap', width: 54 },
      { header: 'From', key: 'from', type: 'money', width: 11 },
      { header: 'To', key: 'to', type: 'money', width: 11 },
      { header: 'Reference', key: 'id', type: 'text', width: 22 },
    ],
    rows: [...edits, ...log].sort((a, b) => String(b.when).localeCompare(String(a.when))),
  };
}

function programmesSheet(names) {
  const events = db.prepare('SELECT * FROM external_events ORDER BY event_date DESC').all();
  const rows = events.map(e => ({
    ...e,
    budget_amount: money(e.budget_amount),
    actual_amount: money(e.actual_amount),
    paid_by: e.paid_by_player_id ? names[e.paid_by_player_id] || e.paid_by_player_id : '',
    heads: db.prepare('SELECT COUNT(*) n FROM event_attendees WHERE event_id = ?').get(e.id).n,
    collected: money(db.prepare(
      'SELECT COALESCE(SUM(amount_due),0) s FROM event_attendees WHERE event_id = ? AND paid = 1')
      .get(e.id).s),
  }));
  return {
    name: 'Programmes',
    columns: [
      { header: 'Date', key: 'event_date', type: 'date', width: 12 },
      { header: 'Programme', key: 'title', type: 'text', width: 28 },
      { header: 'Kind', key: 'event_type', type: 'text', width: 14 },
      { header: 'Budget', key: 'budget_amount', type: 'money', width: 12 },
      { header: 'Actual', key: 'actual_amount', type: 'money', width: 12 },
      { header: 'Paid for by', key: 'paid_by', type: 'text', width: 16 },
      { header: 'Heads', key: 'heads', type: 'int', width: 9 },
      { header: 'Collected', key: 'collected', type: 'money', width: 12 },
      { header: 'Status', key: 'status', type: 'text', width: 12 },
      { header: 'Notes', key: 'description', type: 'wrap', width: 44 },
      { header: 'Programme id', key: 'id', type: 'text', width: 20 },
    ],
    rows,
  };
}

function issuesSheet(names) {
  const rows = db.prepare(`
    SELECT i.*, g.date FROM issue_reports i
    LEFT JOIN gameweeks g ON g.id = i.gameweek_id
    ORDER BY i.created_at DESC`).all().map(i => ({
    ...i,
    reported_on: (i.created_at || '').slice(0, 10),
    player: names[i.player_id] || i.player_id,
  }));
  return {
    name: 'Reported issues',
    columns: [
      { header: 'Reported on', key: 'reported_on', type: 'date', width: 13 },
      { header: 'By', key: 'player', type: 'text', width: 18 },
      { header: 'Game', key: 'date', type: 'date', width: 12 },
      { header: 'About', key: 'field', type: 'text', width: 16 },
      { header: 'Says', key: 'says', type: 'wrap', width: 30 },
      { header: 'Should be', key: 'should_be', type: 'wrap', width: 30 },
      { header: 'Status', key: 'status', type: 'text', width: 12 },
      { header: 'Outcome', key: 'resolution', type: 'wrap', width: 34 },
    ],
    rows,
  };
}

// ---------------------------------------------------------------------------

/** Every sheet, in reading order: the answer first, the workings after. */
export function workbookSheets() {
  const cNames = contractMap();
  const names = nameMap();

  const sheets = [
    balancesSheet(cNames),
    gamesSheet(cNames),
    chargesSheet(cNames),
    moneyInSheet(cNames, names),
    kittySheet(cNames),
    cashierSheet(),
    pnlSheet(),
    ...venueSheets(),
    guestCashSheet(cNames),
    playersSheet(names),
    contractsSheet(),
    resultsSheet(cNames),
    movementsSheet(cNames, names),
    openingSheet(cNames, names),
    programmesSheet(names),
    issuesSheet(names),
    changesSheet(names),
  ];

  const counts = Object.fromEntries(sheets.map(s => [s.name, s.rows.length]));
  // The contents page goes first, but it reports on the others, so it is built
  // last. Anything else means keeping a list of row counts up to date by hand.
  return [aboutSheet(counts, new Date().toISOString()), ...sheets];
}

/** The workbook, as a Buffer, plus what went into it. */
export function exportWorkbook() {
  const sheets = workbookSheets();
  const buffer = buildWorkbook(sheets);
  return {
    buffer,
    sheets: sheets.map(s => ({ name: s.name, rows: s.rows.length })),
    total_rows: sheets.reduce((n, s) => n + s.rows.length, 0),
  };
}
