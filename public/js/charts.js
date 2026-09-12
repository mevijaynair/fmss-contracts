// charts.js — small inline-SVG charts, drawn with theme tokens so both themes
// work without a second palette.
//
// Colour choices here were validated rather than eyeballed. Two results shaped
// what follows:
//
//   - Green and red sit only ΔE 5.0 apart under deuteranopia. Win and loss can
//     therefore never be told apart by colour alone, so every segment carries a
//     direct label and the two poles are separated by a neutral midpoint.
//   - Win / draw / loss is polarity, not identity, so it takes a diverging scale
//     — two hues either side of a neutral grey — not three competing hues. Green
//     / neutral / red measures ΔE 13.5 under CVD and 20.1 normal, comfortably
//     clear, where green / amber / red failed the normal-vision floor outright.
//
// The gold accent is used only where a chart has a single series: at L 0.887 it
// is too light to sit in a categorical set on a dark surface, but as a lone line
// against the card it has ample contrast.

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => new Intl.NumberFormat('en-AE', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));

/**
 * Zero, plus the extremes — but only where they will not sit on top of each
 * other. A player whose balance never strays far from zero would otherwise get
 * three labels stacked in the same 10px.
 */
function axisLabels(ys, lo, hi, x) {
  const placed = [];
  // Zero first: it is the line that matters, so it wins any collision.
  for (const value of [0, hi, lo]) {
    const y = ys(value);
    if (placed.some(p => Math.abs(p.y - y) < 12)) continue;
    placed.push({ value, y });
  }
  return placed.map(p => `<text x="${x}" y="${p.y.toFixed(1)}" class="ch-axis"
      text-anchor="end" dominant-baseline="middle">${money(p.value)}</text>`).join('');
}

/**
 * A running balance over time. One series, so no legend — the heading names it.
 * Zero is drawn as a reference line because crossing it is the thing that
 * matters: above it they can cover the next game, below it they owe.
 */
export function balanceLine(points, { height = 150 } = {}) {
  if (!points || points.length < 2) {
    return '<p class="hint">Not enough movement yet to plot a trend.</p>';
  }
  const W = 600, H = height, PAD = { t: 12, r: 10, b: 20, l: 44 };
  const xs = (i) => PAD.l + (i / (points.length - 1)) * (W - PAD.l - PAD.r);
  const values = points.map(p => p.balance);
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  const span = (hi - lo) || 1;
  const ys = (v) => PAD.t + (1 - (v - lo) / span) * (H - PAD.t - PAD.b);

  const path = points.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(p.balance).toFixed(1)}`).join(' ');
  const area = `${path} L${xs(points.length - 1).toFixed(1)},${ys(lo)} L${xs(0).toFixed(1)},${ys(lo)} Z`;
  const zeroY = ys(0).toFixed(1);

  // Label only the ends and the extremes — never a number on every point.
  const marks = points.map((p, i) => {
    const last = i === points.length - 1;
    const extreme = p.balance === hi || p.balance === lo;
    if (!last && !extreme && i !== 0) return '';
    return `<circle cx="${xs(i).toFixed(1)}" cy="${ys(p.balance).toFixed(1)}" r="4"
      fill="var(--sport)" stroke="var(--bg-card)" stroke-width="2"/>`;
  }).join('');

  const hotspots = points.map((p, i) => `
    <rect x="${(xs(i) - 8).toFixed(1)}" y="0" width="16" height="${H}" fill="transparent"
      class="ch-hot" data-x="${xs(i).toFixed(1)}"
      data-label="${esc(p.label)} · ${money(p.balance)}"><title>${esc(p.label)} — ${money(p.balance)}</title></rect>`).join('');

  return `
    <div class="ch-wrap">
      <svg viewBox="0 0 ${W} ${H}" class="ch-svg" role="img"
           aria-label="Running balance from ${esc(points[0].label)} to ${esc(points[points.length - 1].label)}">
        <line x1="${PAD.l}" y1="${zeroY}" x2="${W - PAD.r}" y2="${zeroY}" class="ch-zero"/>
        ${axisLabels(ys, lo, hi, PAD.l - 6)}
        <path d="${area}" class="ch-area"/>
        <path d="${path}" class="ch-line"/>
        ${marks}
        <line class="ch-cross" x1="0" y1="${PAD.t}" x2="0" y2="${H - PAD.b}" style="opacity:0"/>
        ${hotspots}
      </svg>
      <div class="ch-tip" hidden></div>
    </div>`;
}

/**
 * One bar divided into parts of a whole, each labelled in place. Used for
 * win/draw/loss and for billed/unbilled games, where the split IS the message
 * and three separate tiles would make the reader do the arithmetic.
 */
export function dividedBar(segments, { height = 26 } = {}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (!total) return '<p class="hint">Nothing recorded yet.</p>';

  const bars = segments.filter(s => s.value > 0).map(s => {
    const pct = (s.value / total) * 100;
    // Wide enough to read a number inside; otherwise the label sits in the key.
    const inline = pct > 12 ? `<span class="ch-seg-label">${s.value}</span>` : '';
    return `<div class="ch-seg ${s.cls}" style="width:${pct}%" title="${esc(s.label)}: ${s.value}">${inline}</div>`;
  }).join('');

  // A legend is always present at two or more series, so identity never rests
  // on colour — which matters here, green and red being near-identical to a
  // deuteranope.
  const key = segments.map(s => `
    <span class="ch-key-item"><i class="ch-dot ${s.cls}"></i>${esc(s.label)} <strong>${s.value}</strong></span>`).join('');

  return `<div class="ch-bar" style="height:${height}px">${bars}</div><div class="ch-key">${key}</div>`;
}

/** Two magnitudes of the same unit, on one shared scale. */
export function pairedBars(items) {
  const max = Math.max(1, ...items.map(i => i.value));
  return `<div class="ch-rows">${items.map(i => `
    <div class="ch-row">
      <span class="ch-row-label">${esc(i.label)}</span>
      <span class="ch-row-track"><span class="ch-row-fill ${i.cls}" style="width:${(i.value / max) * 100}%"></span></span>
      <strong class="ch-row-value">${i.value}</strong>
    </div>`).join('')}</div>`;
}

/** Wire the crosshair and tooltip on any line charts inside `root`. */
export function wireCharts(root) {
  root.querySelectorAll('.ch-wrap').forEach(wrap => {
    const svg = wrap.querySelector('.ch-svg');
    const cross = wrap.querySelector('.ch-cross');
    const tip = wrap.querySelector('.ch-tip');
    if (!svg || !tip) return;
    wrap.querySelectorAll('.ch-hot').forEach(hot => {
      hot.addEventListener('mouseenter', () => {
        const x = hot.dataset.x;
        if (cross) { cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.style.opacity = '1'; }
        tip.textContent = hot.dataset.label;
        tip.hidden = false;
        // Position over the point, in the wrapper's own percentage space so it
        // survives the SVG being scaled to fit.
        tip.style.left = `${(Number(x) / 600) * 100}%`;
      });
    });
    wrap.addEventListener('mouseleave', () => {
      tip.hidden = true;
      if (cross) cross.style.opacity = '0';
    });
  });
}
