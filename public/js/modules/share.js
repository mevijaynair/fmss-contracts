// share.js — the snapshot images that get sent to WhatsApp.
//
// The club already shared its standing by screenshotting the sheet, and that
// does not survive the trip: the table is eight columns wide, so a phone-shaped
// crop loses the right-hand half, and what arrives is a picture of part of a
// spreadsheet. So this does not photograph the screen. It draws a picture whose
// only job is to be read in a chat window: one column, phone proportions,
// nothing on it that a player would not want to see.
//
// Drawn on a canvas rather than rendered as HTML and captured, because capturing
// HTML needs a library the app does not have, and because the thing you send to
// forty people should not change shape with the reader's window.
//
// EVERY NUMBER COMES FROM THE SERVER. Nothing is recomputed here — see
// server/repos/share.js. A picture that disagrees with the app is worse than no
// picture, and it is the one artefact nobody can check against the app because
// by then it is in someone else's chat.
import { api } from '../api.js';
import { toast } from '../store.js';

// Phone proportions. 1080 is what a phone camera produces and what every chat
// app is tuned for; drawing at 2× and scaling down keeps the text crisp on a
// high-density screen, which is where this will almost always be read.
const W = 1080;
const DPR = 2;
const PAD = 44;

/**
 * The picture's palette, taken from the live stylesheet.
 *
 * A canvas cannot use a CSS variable, so the values have to be resolved to
 * concrete colours before anything is drawn. Reading them from the document
 * rather than restating them means the image looks like the app — including
 * whichever theme the person is actually in — and cannot drift from it when
 * the palette changes.
 *
 * The fallbacks are what to draw with if the stylesheet has not loaded. They
 * are the only raw colours in the front end, and they exist so that a missing
 * variable produces a plain-looking picture instead of an invisible one:
 * getComputedStyle returns '' for an unknown property, and canvas silently
 * ignores an empty fillStyle, which would draw text in whatever colour was
 * last used. ui-tokens-allow
 */
function palette() {
  const s = getComputedStyle(document.body);
  const t = (name, fallback) => s.getPropertyValue(name).trim() || fallback;
  return {
    bg: t('--bg-main', '#0d1018'),        // ui-tokens-allow
    card: t('--bg-card', '#161b27'),      // ui-tokens-allow
    line: t('--border-color', '#28303f'), // ui-tokens-allow
    text: t('--text-main', '#eef1f7'),    // ui-tokens-allow
    muted: t('--text-muted', '#9aa3b6'),  // ui-tokens-allow
    faint: t('--text-faint', '#6b748a'),  // ui-tokens-allow
    gold: t('--sport', '#FFD700'),        // ui-tokens-allow
    good: t('--success', '#22c55e'),      // ui-tokens-allow
    bad: t('--danger', '#f87171'),        // ui-tokens-allow
    warn: t('--warning', '#fbbf24'),      // ui-tokens-allow
  };
}

// Resolved once per picture, in render(). Module scope so the painters can
// reach it without threading it through every call.
let C = palette();

const money = (n) => new Intl.NumberFormat('en-AE', { maximumFractionDigits: 0 })
  .format(Math.round(Number(n) || 0));
const signed = (n) => (n > 0 ? '+' : '') + money(n);
const shortDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};
const longDate = (iso) => new Date(iso).toLocaleDateString('en-GB',
  { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * A pen that can draw, or just work out how tall the drawing would be.
 *
 * The canvas has to be the right height BEFORE anything is drawn on it, and the
 * height depends on how many players there are, how many games, how much was
 * paid in. Rather than compute that twice — once as arithmetic and once as
 * drawing, which is how the two drift apart — the whole picture is painted
 * twice: once with the pen lifted to find the height, then again for real.
 */
class Pen {
  constructor(ctx) { this.ctx = ctx; this.y = 0; this.dry = !ctx; }

  gap(h) { this.y += h; }

  rect(x, w, h, fill, r = 0) {
    if (!this.dry) {
      const c = this.ctx;
      c.fillStyle = fill;
      c.beginPath();
      if (c.roundRect) c.roundRect(x, this.y, w, h, r); else c.rect(x, this.y, w, h);
      c.fill();
    }
    return h;
  }

  /** One line of text. Advances by `lead`; pass 0 to draw without moving down. */
  text(str, x, { size = 26, weight = 400, color = C.text, align = 'left', lead = size * 1.45 } = {}) {
    if (!this.dry) {
      const c = this.ctx;
      c.font = `${weight} ${size}px "Segoe UI", system-ui, -apple-system, Roboto, sans-serif`;
      c.fillStyle = color;
      c.textAlign = align;
      c.textBaseline = 'alphabetic';
      c.fillText(str, x, this.y + size * 0.82);
    }
    this.y += lead;
    return lead;
  }

  /** Several pieces of text on one line, then move down once. */
  row(pieces, lead) {
    const start = this.y;
    let max = 0;
    for (const p of pieces) {
      this.y = start;
      max = Math.max(max, this.text(p.str, p.x, { ...p, lead: p.size ? p.size * 1.45 : undefined }));
    }
    this.y = start + (lead ?? max);
  }

  hr(x, w, color = C.line) {
    if (!this.dry) { this.ctx.fillStyle = color; this.ctx.fillRect(x, this.y, w, 1); }
    this.y += 1;
  }
}

/** Shorten a status to something that fits beside a number. */
const shortStatus = (s) => (s || '').replace('Refill needed - No priority', 'Top up')
  .replace('Out of contract', 'Empty').replace('In contract', 'OK');

/** Wrap a comma-joined list to the available width, returning the lines. */
function wrapList(ctx, items, width, size) {
  if (!items.length || !ctx) return [];
  ctx.font = `400 ${size}px "Segoe UI", system-ui, sans-serif`;
  const lines = [];
  let line = '';
  for (const it of items) {
    const next = line ? `${line}  ·  ${it}` : it;
    if (ctx.measureText(next).width > width && line) { lines.push(line); line = it; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

// ---------------------------------------------------------------------------
// The club snapshot — one picture for the group.

function paintClub(pen, d, ctx) {
  const x = PAD;
  const w = W - PAD * 2;

  pen.gap(PAD);
  pen.text('FMSS FOOTBALL CLUB', x, { size: 38, weight: 700, color: C.gold, lead: 46 });
  pen.text(`Where everyone stands · ${longDate(d.generated_at)}`, x,
    { size: 24, color: C.muted, lead: 40 });

  for (const c of d.contracts) {
    // ---- contract header
    pen.rect(x, w, 4, C.gold, 2);
    pen.gap(20);
    pen.row([
      { str: c.name, x, size: 32, weight: 700, color: C.text },
      { str: `${money(c.rate)}/game`, x: x + w, size: 26, color: C.gold, align: 'right' },
    ], 42);
    pen.text(`${c.venue}${c.venue ? ' · ' : ''}${c.totals.players} players  ·  ` +
      `${c.totals.in_contract} in credit  ·  ${c.totals.refill} need a top-up  ·  ` +
      `${c.totals.out} out of contract`, x, { size: 22, color: C.faint, lead: 36 });

    // ---- the squad, in two columns so the picture stays phone-shaped
    const colW = (w - 28) / 2;
    const half = Math.ceil(c.squad.length / 2);
    const cols = [c.squad.slice(0, half), c.squad.slice(half)];
    const rowH = 38;
    const tableTop = pen.y;
    const tableH = 14 + half * rowH + 12;
    pen.rect(x, w, tableH, C.card, 14);
    pen.y = tableTop + 14;

    for (let i = 0; i < half; i++) {
      const lineY = pen.y;
      cols.forEach((col, ci) => {
        const p = col[i];
        if (!p) return;
        const cx = x + 18 + ci * (colW + 28);
        const bal = p.balance;
        const colour = bal < 0 ? C.bad : (p.games_left !== null && p.games_left < 2) ? C.warn : C.good;
        pen.y = lineY;
        pen.row([
          { str: p.name, x: cx, size: 24, color: C.text },
          { str: money(bal), x: cx + colW - 96, size: 24, weight: 600, color: colour, align: 'right' },
          { str: shortStatus(p.status), x: cx + colW - 26, size: 20, color: C.faint, align: 'right' },
        ], rowH);
      });
      pen.y = lineY + rowH;
    }
    pen.y = tableTop + tableH;
    pen.gap(16);

    // ---- what happened lately
    //
    // Dates and turnout only. What each night collected used to be here: a
    // true figure nobody reading this can act on, which invites a
    // conversation about the club's takings instead of about the one thing
    // this picture is for.
    const games = c.recent_games;
    if (games.length) {
      pen.text(`Last ${d.weeks} weeks`, x, { size: 22, weight: 600, color: C.muted, lead: 32 });
      for (const l of wrapList(ctx,
        games.slice(0, 8).map(g => `${shortDate(g.date)} · ${g.players}`), w - 16, 22)) {
        pen.text(l, x + 8, { size: 22, color: C.faint, lead: 30 });
      }
      pen.gap(12);
    }

    pen.gap(14);
  }

  // ---- who still has to pay, ONCE, across everything
  //
  // This was two lists, one per contract, so Jeetu was shown as -159 and
  // -441 and never as the -600 he owes — and Toby, 487 in hand across the
  // two, was named as a debtor for a shortfall his own money already covers.
  const pay = d.still_to_pay || { top_up: [], cash: [] };
  pen.rect(x, w, 4, C.gold, 2);
  pen.gap(20);
  pen.text('Still to pay', x, { size: 32, weight: 700, lead: 40 });
  pen.text('Both contracts together — one line each, so this is what you owe in all.', x,
    { size: 21, color: C.faint, lead: 36 });

  if (pay.top_up.length) {
    pen.text(`Top up before your next game — ${money(-pay.top_up_total)} from `
      + `${pay.top_up.length}`, x, { size: 23, weight: 600, color: C.bad, lead: 34 });
    for (const r of pay.top_up) {
      // The split beside the total, because somebody 600 down wants to know
      // which night it is on before they decide what to send.
      // The contract's own name, not a first word: splitting "Mon/Thu" on the
      // slash leaves "Mon", which is a different night.
      const split = r.parts.length > 1
        ? r.parts.map(p => `${p.contract} ${money(p.balance)}`).join(' · ')
        : '';
      pen.row([
        { str: r.name, x: x + 8, size: 23, color: C.text },
        { str: split, x: x + 250, size: 20, color: C.faint },
        { str: money(r.total), x: x + w - 8, size: 23, weight: 700, color: C.bad, align: 'right' },
      ], 33);
    }
    pen.gap(14);
  } else {
    pen.text('Nobody is short — every balance covers the next game.', x,
      { size: 22, color: C.good, lead: 32 });
  }

  if (pay.cash.length) {
    pen.text(`Cash to hand over — ${money(pay.cash_total)}`, x,
      { size: 23, weight: 600, color: C.warn, lead: 34 });
    for (const l of wrapList(ctx,
      pay.cash.map(r => `${r.name} ${money(r.amount)}`), w - 16, 22)) {
      pen.text(l, x + 8, { size: 22, color: C.muted, lead: 30 });
    }
    pen.gap(10);
  }

  pen.gap(14);
  pen.hr(x, w);
  pen.gap(16);
  pen.text('A balance is money you have already put in. "Empty" means the next game '
    + 'is not covered yet.', x, { size: 19, color: C.faint, lead: 26 });
  pen.text('Sent from the FMSS contract manager · figures as at '
    + longDate(d.generated_at), x, { size: 19, color: C.faint, lead: 26 });
  pen.gap(PAD);
}

// ---------------------------------------------------------------------------
// The player snapshot — one person, across every contract at once.

function paintPlayer(pen, d, ctx) {
  const x = PAD;
  const w = W - PAD * 2;

  pen.gap(PAD);
  pen.text('FMSS FOOTBALL CLUB', x, { size: 24, weight: 700, color: C.gold, lead: 34 });
  pen.text(d.player.name, x, { size: 46, weight: 700, lead: 54 });
  pen.text(`Where you stand · ${longDate(d.generated_at)}`, x,
    { size: 23, color: C.muted, lead: 40 });

  // One card per contract. Credit and debt are never netted into one figure —
  // "you have 200 here and owe 130 there" is the useful sentence, and a single
  // number hides that one of them needs topping up before the next game.
  for (const c of d.contracts) {
    const top = pen.y;
    const h = 150;
    pen.rect(x, w, h, C.card, 14);
    pen.y = top + 22;
    pen.row([
      { str: c.contract_name, x: x + 22, size: 28, weight: 600, color: C.text },
      { str: money(c.balance), x: x + w - 22, size: 40, weight: 700, align: 'right',
        color: c.balance < 0 ? C.bad : C.good },
    ], 50);
    pen.row([
      { str: `${c.games} game${c.games === 1 ? '' : 's'} played  ·  ${money(c.rate)}/game`,
        x: x + 22, size: 21, color: C.faint },
      { str: c.balance < 0
        ? `${money(-c.balance)} to top up`
        : `covers ${Math.max(0, c.games_left ?? 0)} more game${c.games_left === 1 ? '' : 's'}`,
      x: x + w - 22, size: 21, align: 'right',
      color: c.balance < 0 ? C.warn : C.faint },
    ], 34);
    if (c.cash_owed > 0) {
      pen.text(`${money(c.cash_owed)} cash still to hand over`, x + 22,
        { size: 21, color: C.warn, lead: 30 });
    }
    pen.y = top + h;
    pen.gap(14);
  }

  pen.gap(6);
  pen.rect(x, w, 3, C.line);
  pen.gap(20);

  if (d.recent.length) {
    pen.text(`Your last ${d.weeks} weeks`, x, { size: 24, weight: 600, color: C.muted, lead: 36 });
    for (const e of d.recent.slice(0, 18)) {
      pen.row([
        { str: shortDate(e.date), x: x + 8, size: 22, color: C.text },
        { str: e.contract, x: x + 130, size: 22, color: C.faint },
        { str: e.label.slice(0, 34), x: x + 330, size: 22, color: C.muted },
        { str: signed(e.amount), x: x + w - 8, size: 22, weight: 600, align: 'right',
          color: e.amount < 0 ? C.bad : C.good },
      ], 34);
    }
  } else {
    pen.text(`Nothing in the last ${d.weeks} weeks.`, x, { size: 22, color: C.faint, lead: 34 });
  }

  pen.gap(18);
  pen.hr(x, w);
  pen.gap(16);
  if (d.total_balance < 0) {
    pen.text(`Across both contracts you are ${money(-d.total_balance)} short.`, x,
      { size: 22, color: C.bad, lead: 30 });
  } else {
    pen.text(`Across both contracts you are holding ${money(d.total_balance)}.`, x,
      { size: 22, color: C.good, lead: 30 });
  }
  pen.text('Sent from the FMSS contract manager', x, { size: 19, color: C.faint, lead: 26 });
  pen.gap(PAD);
}

// ---------------------------------------------------------------------------

/**
 * Paint once with the pen lifted to find the height, then again for real.
 *
 * The measuring pass is given a throwaway context purely so that wrapped text
 * can be measured for real. Without it the first pass has to guess how many
 * lines a list of names will take, and a guess that comes up short does not
 * produce a slightly wrong picture — it produces one with the bottom of the
 * list cut off, which is exactly the failure this whole feature exists to fix.
 */
function render(paint, data) {
  C = palette();
  const ruler = document.createElement('canvas').getContext('2d');

  const measure = new Pen(null);
  paint(measure, data, ruler);
  const height = Math.ceil(measure.y);

  const canvas = document.createElement('canvas');
  canvas.width = W * DPR;
  canvas.height = height * DPR;
  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, height);

  const drawn = new Pen(ctx);
  paint(drawn, data, ctx);
  return { canvas, height, drawnTo: Math.ceil(drawn.y) };
}

/**
 * Hand the picture to the person.
 *
 * Where the browser can share files — Windows and Android Chrome can — this
 * opens the system share sheet with WhatsApp in it, which is the whole point.
 * Everywhere else it downloads, and they attach it themselves.
 */
async function deliver(canvas, filename, title) {
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('The image could not be created');

  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (e) {
      // A cancelled share is a decision, not a failure — do not then force a
      // download they just declined.
      if (e?.name === 'AbortError') return 'cancelled';
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

const said = { shared: 'Sent', cancelled: 'Cancelled', downloaded: 'Saved to your downloads' };

/** One picture of the whole club, both contracts, ready for the group chat. */
export async function shareClubSnapshot({ weeks = 3 } = {}) {
  try {
    toast('Building the picture…');
    const data = await api.get(`/share/club?weeks=${weeks}`);
    const { canvas } = render(paintClub, data);
    const how = await deliver(canvas, `fmss-standing-${data.generated_at}.png`,
      'FMSS — where everyone stands');
    toast(said[how]);
  } catch (e) { toast(e.message, true); }
}

/** One picture for one player, covering every contract they are on. */
export async function sharePlayerSnapshot(playerId, { weeks = 3 } = {}) {
  try {
    toast('Building the picture…');
    const data = await api.get(`/share/player/${encodeURIComponent(playerId)}?weeks=${weeks}`);
    const { canvas } = render(paintPlayer, data);
    const how = await deliver(canvas,
      `fmss-${data.player.name.toLowerCase().replace(/\W+/g, '-')}-${data.generated_at}.png`,
      `FMSS — ${data.player.name}`);
    toast(said[how]);
  } catch (e) { toast(e.message, true); }
}
