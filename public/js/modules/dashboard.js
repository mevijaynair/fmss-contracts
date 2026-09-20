// dashboard.js — the first screen, for whoever is looking at it.
//
// A dashboard earns its place by answering "what do I need to do?" before it
// answers "what are the numbers?". Both sides of this one used to open with
// figures: the admin got four totals and a watchlist, the player got their
// balance and nothing about the football they had actually turned up for.
//
// So each now leads with a short list of things that need doing — and only
// things that do; an empty list says so and takes up one line — and the
// standing figures follow underneath.
import { api } from '../api.js';
import { $, esc, money, balCell, fmtDate } from '../util.js';
import { reportIssue, renderMyIssues } from './issues.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * The "do something" block. Each item is a sentence naming the thing and, where
 * there is one, a button that goes straight to it.
 *
 * Deliberately capped and ordered by urgency: a list of fifteen things is a
 * list nobody reads, and the point is that what is on it is worth looking at.
 */
function actionBlock(items) {
  const host = $('dashAction');
  if (!host) return;
  const live = items.filter(Boolean);
  if (!live.length) {
    host.innerHTML = '<p class="hint dash-clear">Nothing needs doing. ⚽</p>';
    return;
  }
  host.innerHTML = `<div class="panel panel-warn dash-actions">
    <div class="panel-title">Needs you</div>
    ${live.slice(0, 6).map(i => `<div class="panel-row">
      <span>${i.text}</span>
      ${i.goto ? `<button class="btn btn-sm" data-goto="${esc(i.goto)}">${esc(i.label)}</button>` : ''}
    </div>`).join('')}
  </div>`;
}

export async function loadDashboard() {
  const d = await api.dashboard();

  if (d.role === 'player') return renderPlayerDashboard(d);

  const cash = d.cash || {};
  const refills = d.contracts.reduce((s, c) => s + c.refill_count, 0);

  // Headline is the cash question a cashier actually has: does the pot cover what
  // players have already paid in? Netting credit against debt hid this, because
  // the two are opposite in kind — one is owed BY the club, the other TO it.
  const kpis = [
    {
      v: money(cash.kitty_balance ?? 0),
      l: cash.covered_pct === null ? 'Kitty (AED)'
        : `Kitty · covers ${cash.covered_pct}% of prepaid`,
      cls: (cash.cover ?? 0) >= 0 ? 'good' : 'bad',
    },
    { v: money(cash.credit_held ?? 0), l: 'Held in credit (owed by club)' },
    { v: money(cash.owed ?? 0), l: 'Owed to club', cls: (cash.owed ?? 0) > 0 ? 'warn' : 'good' },
    { v: refills, l: 'Need a top-up', cls: refills ? 'warn' : 'good' },
  ];
  $('kpiStrip').innerHTML = kpis.map(k =>
    `<div class="kpi ${k.cls || ''}"><div class="v">${k.v}</div><div class="l">${esc(k.l)}</div></div>`).join('');

  // What the admin actually has to act on today, in front of the totals.
  const gaps = d.contracts.filter(c => c.missing_results > 0);
  const stalest = d.contracts
    .map(c => ({ c, days: c.last_game ? Math.floor((Date.now() - new Date(c.last_game)) / 864e5) : null }))
    .filter(x => x.days !== null && x.days > 21);
  actionBlock([
    d.pending_contributions > 0 && {
      text: `<strong>${plural(d.pending_contributions, 'contribution')}</strong> waiting to be approved`,
      goto: 'contributions', label: 'Review',
    },
    d.open_issues > 0 && {
      text: `<strong>${plural(d.open_issues, 'player report')}</strong> about a result — somebody
             says a stat is wrong`,
      goto: 'gameweeks', label: 'See them',
    },
    gaps.length && {
      text: `<strong>${gaps.reduce((s, c) => s + c.missing_results, 0)} games</strong> with no
             result recorded (${gaps.map(c => esc(c.name)).join(', ')})`,
      goto: 'gameweeks', label: 'Fill them in',
    },
    refills > 0 && {
      text: `<strong>${plural(refills, 'player')}</strong> out of credit or nearly — the list is below`,
      goto: 'players', label: 'Standing sheet',
    },
    (cash.cover ?? 0) < 0 && {
      text: `The kitty is <strong>${money(-(cash.cover ?? 0))}</strong> short of what players
             have prepaid`,
      goto: 'finance', label: 'Cashier',
    },
    stalest.length && {
      text: `No game recorded on <strong>${stalest.map(x => esc(x.c.name)).join(', ')}</strong>
             for ${stalest[0].days} days`,
      goto: 'gameday', label: 'Enter one',
    },
  ]);

  // Say plainly what the cash position means, rather than leaving a bare number.
  const shortfall = -(cash.cover ?? 0);
  const coverNote = cash.credit_held
    ? (shortfall > 0
      ? `<div class="panel panel-warn">
           <div class="panel-title">Kitty is ${money(shortfall)} short of prepayments</div>
           <div class="panel-body">Players hold ${money(cash.credit_held)} in credit but the kitty
             has ${money(cash.kitty_balance)}. That gap is prepaid money already spent — fine while
             games keep being played, worth knowing if several asked for a refund at once.</div>
         </div>`
      : `<div class="panel">
           <div class="panel-title">Kitty covers all prepayments</div>
           <div class="panel-body">${money(cash.kitty_balance)} against ${money(cash.credit_held)}
             held in credit, a surplus of ${money(cash.cover)}.</div>
         </div>`)
    : '';

  $('contractCards').innerHTML = d.contracts.map(c => {
    const stale = c.last_game
      ? Math.floor((Date.now() - new Date(c.last_game)) / 864e5)
      : null;
    return `
    <div class="sams-card">
      <div class="card-header"><h3 class="card-title">${esc(c.name)}</h3>
        <span class="card-sub">${esc(c.venue || '')}${c.rate ? ` · ${money(c.rate)}/game` : ''}</span></div>
      <div>
        <div class="kv"><span class="k">Players</span><span class="v">${c.players}</span></div>
        <div class="kv"><span class="k">Games recorded</span><span class="v">${c.games}</span></div>
        <div class="kv"><span class="k">Last game</span><span class="v">${
          c.last_game ? `${esc(fmtDate(c.last_game))}${stale > 21 ? ` <span class="hint">(${stale}d ago)</span>` : ''}`
                      : '<span class="hint">none</span>'}</span></div>
        <div class="kv"><span class="k">Games in last 30 days</span><span class="v">${c.games_30d}</span></div>
        <div class="kv"><span class="k">Held in credit</span><span class="v">${balCell(c.credit)}</span></div>
        <div class="kv"><span class="k">Owed to club</span><span class="v">${
  c.debt > 0 ? `<span class="bal neg">${money(c.debt)}</span>` : '<span class="bal zero">0</span>'}</span></div>
        <div class="kv"><span class="k">Already in debt</span><span class="v">${
          c.in_debt_count ? `<span class="tag tag-critical">${c.in_debt_count}</span>` : '0'}</span></div>
        <div class="kv"><span class="k">Under 2 games of credit</span><span class="v">${
          c.low_runway_count ? `<span class="tag tag-due">${c.low_runway_count}</span>` : '0'}</span></div>
      </div>
    </div>`;
  }).join('');

  // Chase list: deepest debt first, then whoever runs out next. Runway is shown
  // because "-34" and "2 games left" prompt different conversations.
  const watch = d.contracts.flatMap(c =>
    (c.watchlist || []).map(w => ({ ...w, contract: c.name.split(' ')[0], rate: c.rate })));
  const owedTotal = watch.filter(w => w.balance < 0).reduce((s, w) => s + Math.abs(w.balance), 0);

  $('watchlist').innerHTML = watch.length
    ? `<p class="hint" style="margin-bottom:.6rem">
         ${plural(watch.filter(w => w.balance < 0).length, 'player')} in debt totalling
         <strong>${money(owedTotal)}</strong>${
           watch.some(w => w.balance >= 0)
             ? ` · ${plural(watch.filter(w => w.balance >= 0).length, 'player')} nearly out of credit` : ''}
       </p>
       ${watch.map(w => `
         <span class="watch-chip ${w.balance < 0 ? 'is-debt' : ''}">
           ${esc(w.name)} <span class="hint">${esc(w.contract)}</span>
           ${w.balance < 0
             ? `<strong>${money(w.balance)}</strong>`
             : `<strong>${plural(w.games_left ?? 0, 'game')} left</strong>`}
         </span>`).join('')}
       ${coverNote}`
    : `<p class="hint">Everyone has credit for at least two more games. 🎉</p>${coverNote}`;
}

/**
 * The player's dashboard.
 *
 * It used to be a balance and a list of deductions — a bank statement for
 * something nobody joins a football club to do. What a player wants to know is
 * whether they are covered for Thursday, how they have been playing, and what
 * happened last time out. The money is still all there; it is just no longer
 * the only thing there.
 */
function renderPlayerDashboard(d) {
  renderHero(d);
  const totalBalance = d.contracts.reduce((s, c) => s + (c.present_balance || 0), 0);
  const shortest = d.contracts
    .filter(c => c.games_left !== null && c.games_left !== undefined)
    .sort((a, b) => a.games_left - b.games_left)[0];
  const rec = d.record || null;

  const kpis = [
    { v: money(totalBalance), l: 'Your balance (AED)', cls: totalBalance >= 0 ? 'good' : 'bad' },
    shortest
      ? {
        v: Math.max(0, shortest.games_left),
        l: `Games covered${d.contracts.length > 1 ? ` on ${shortest.name}` : ''}`,
        cls: shortest.games_left < 1 ? 'bad' : shortest.games_left < 3 ? 'warn' : 'good',
      }
      : { v: d.contracts.length, l: 'Your contracts' },
    { v: d.contracts.reduce((s, c) => s + (c.games || 0), 0), l: 'Games played' },
    rec && rec.decided
      ? { v: `${rec.wins}-${rec.draws}-${rec.losses}`, l: 'Won · drawn · lost' }
      : null,
  ].filter(Boolean);
  $('kpiStrip').innerHTML = kpis.map(k =>
    `<div class="kpi ${k.cls || ''}"><div class="v">${k.v}</div><div class="l">${esc(k.l)}</div></div>`).join('');

  // What THEY have to do. Almost always nothing, and saying so is the point.
  actionBlock([
    ...d.contracts.filter(c => c.present_balance < 0).map(c => ({
      text: `You are <strong>${money(-c.present_balance)}</strong> short on
             ${esc(c.name)} — top up before the next game`,
      goto: 'contributions', label: 'Pay in',
    })),
    ...d.contracts.filter(c => c.present_balance >= 0
      && c.games_left !== null && c.games_left < 2).map(c => ({
      text: `${esc(c.name)}: your balance covers
             ${c.games_left === 0 ? 'no more games' : 'one more game'}`,
      goto: 'contributions', label: 'Top up',
    })),
    d.cash_owed > 0 && {
      text: `<strong>${money(d.cash_owed)}</strong> of cash to hand over for games you played`,
    },
    d.pending_contributions > 0 && {
      text: `${plural(d.pending_contributions, 'payment')} you submitted is waiting for the
             admin to confirm`,
      goto: 'contributions', label: 'See it',
    },
  ]);

  $('contractCards').innerHTML = d.contracts.map(c => `
    <div class="sams-card">
      <div class="card-header"><h3 class="card-title">${esc(c.name)}</h3>
        <span class="card-sub">${c.present_balance < 0 ? 'Needs a top-up'
    : c.games_left !== null ? `Covers ${plural(Math.max(0, c.games_left), 'more game')}`
      : 'In credit'}</span></div>
      <div>
        <div class="kv"><span class="k">Balance now</span><span class="v">${balCell(c.present_balance)}</span></div>
        <div class="kv"><span class="k">Paid in</span><span class="v">${money(c.contributed)}</span></div>
        <div class="kv"><span class="k">Spent on games</span><span class="v">${money(c.charged)}</span></div>
        <div class="kv"><span class="k">Games played</span><span class="v">${c.games}</span></div>
        ${c.rate ? `<div class="kv"><span class="k">A game costs</span><span class="v">${money(c.rate)}</span></div>` : ''}
        <div class="kv"><span class="k">Started the season with</span><span class="v">${money(c.opening_balance)}</span></div>
      </div>
    </div>`).join('') || '<p class="hint">No contracts yet.</p>';

  renderMyGames();

  const title = $('watchTitle');
  const sub = $('watchSub');
  if (title) title.textContent = 'How you are playing';
  if (sub) sub.textContent = 'Your record since the club started tracking';
  $('watchlist').innerHTML = rec && rec.games
    ? `<div class="rec-strip">
        ${[['Played', rec.games], ['Won', rec.wins], ['Drawn', rec.draws], ['Lost', rec.losses],
    ['Captained', rec.captainGames]]
    .map(([k, v]) => `<span class="rec-item"><strong>${v}</strong>${esc(k)}</span>`).join('')}
      </div>
      ${rec.unknown ? `<p class="hint">${plural(rec.unknown, 'game')} has no result recorded,
        so it counts as neither.</p>` : ''}`
    : '<p class="hint">No games recorded for you yet.</p>';
}

/** Initials, for the badge. Two at most — "AK", not "AKMN". */
const initials = (name) => String(name || '?').trim().split(/\s+/)
  .slice(0, 2).map(w => w[0]).join('').toUpperCase();

/** Morning, afternoon or evening, from the reader's own clock. */
function partOfDay() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/**
 * The player's own header.
 *
 * Their page opened with four grey KPI tiles and no indication whose page it
 * was. A name, what they are a member of, and when they last played costs one
 * strip of screen and is the difference between a report and somewhere you
 * belong.
 */
function renderHero(d) {
  const host = $('dashHero');
  if (!host) return;
  const last = d.last_game;
  const said = { won: 'you won', drawn: 'a draw', lost: 'you lost' }[last?.outcome];
  const memberships = d.contracts.map(c => esc(c.name)).join(' · ');

  host.innerHTML = `
    <div class="dash-hero">
      <span class="hero-badge" aria-hidden="true">${esc(initials(d.name))}</span>
      <div class="hero-text">
        <div class="hero-hi">${partOfDay()},</div>
        <h2 class="hero-name">${esc(d.name || 'there')}</h2>
        <div class="hero-sub">
          ${memberships ? `<span>${memberships}</span>` : ''}
          ${last ? `<span>Last out ${esc(fmtDate(last.date))}${last.score
    ? ` — ${esc(last.score)}${said ? `, ${said}` : ''}` : ''}</span>` : ''}
        </div>
      </div>
    </div>`;
}

/**
 * The player's last few games, with a way to say one of them is wrong.
 *
 * The report button is the whole reason this is a list of matches rather than
 * a list of deductions: the twelve who were there are the only people who can
 * catch a mistyped score, and they have never had anywhere to say so.
 */
async function renderMyGames() {
  const card = $('myGamesCard');
  const host = $('myGames');
  if (!card || !host) return;
  card.hidden = false;
  host.innerHTML = '<p class="hint">Loading…</p>';

  let games = [];
  let mine = { reports: [] };
  try {
    [games, mine] = await Promise.all([
      api.get('/my/games?limit=8'),
      api.get('/my/issues').catch(() => ({ reports: [] })),
    ]);
  } catch (e) {
    host.innerHTML = `<p class="hint">${esc(e.message)}</p>`;
    return;
  }

  if (!games.length) {
    host.innerHTML = '<p class="hint">You have not been in a recorded game yet.</p>';
    return;
  }

  const badge = { won: ['is-won', 'Won'], drawn: ['is-drawn', 'Drew'], lost: ['is-lost', 'Lost'] };
  host.innerHTML = renderMyIssues(mine.reports) + games.map((g, i) => {
    const [cls, word] = badge[g.outcome] || ['is-unknown', g.tournament ? 'Tournament' : 'No result'];
    const capts = g.captains.map(c => `${esc(c.team)}: ${esc(c.name)}`).join(' · ');
    return `<div class="game-row">
      <div class="game-when">
        <strong>${esc(fmtDate(g.date))}</strong>
        <span class="hint">${esc(g.contract_name)}</span>
      </div>
      <div class="game-what">
        <span class="game-badge ${cls}">${word}</span>
        <span class="game-score">${g.score ? esc(g.score) : '<span class="hint">not recorded</span>'}</span>
        <span class="hint">${g.my_team ? `you played for ${esc(g.my_team)}` : 'side not recorded'}${
  g.was_captain ? ' · you captained' : ''}${capts ? ` · ${capts}` : ''}</span>
      </div>
      <div class="game-cost">${g.charged ? money(g.charged) : '<span class="hint">—</span>'}</div>
      <button class="link-btn game-report" data-report="${i}">Something wrong?</button>
    </div>`;
  }).join('');

  host.querySelectorAll('[data-report]').forEach(b =>
    b.addEventListener('click', () => reportIssue(games[Number(b.dataset.report)])));
}

