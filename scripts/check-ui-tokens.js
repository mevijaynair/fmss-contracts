#!/usr/bin/env node
/**
 * check-ui-tokens.js — UI regression guard for the FMSS front-end.
 *
 * Enforces four rules:
 *   0. Every JS file must PARSE. A file that does not is a blank page, and no
 *      other rule here would notice — see Rule 0 below for the outage.
 *   1. No raw colour literals in view modules — they bypass the theme tokens
 *      and render light-on-light (or dark-on-dark) when the theme flips.
 *   2. No CSS variables that do not exist in styles.css (typos resolve to
 *      nothing and silently drop the declaration).
 *   3. No "phantom" classes — a class used in JS/HTML with styling intent but
 *      no rule in styles.css.
 *
 * Run:  node scripts/check-ui-tokens.js
 * Exit: 0 clean, 1 violations found.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.join(__dirname, '..');
const CSS = path.join(ROOT, 'public/css/styles.css');
const JS_DIR = path.join(ROOT, 'public/js');
const HTML = path.join(ROOT, 'public/index.html');

// Classes used purely as querySelector hooks — no styling intent, so a missing
// CSS rule is correct, not a bug.
const HOOK_CLASSES = new Set([
  // The participant-* classes belonged to the old split-the-bill events panel,
  // which the programmes rewrite replaced; att-* are its successors.
  'att-tier', 'att-amt', 'att-method', 'att-paid',
  'player-type-select', 'charged-to-select', 'charge-delta',
  'ch-team', 'ch-capt', 'ch-paid', 'ch-mode', 'ch-payer', 'ch-fund', 'gw-pick',
]);

// A line carrying this marker is allowed a raw colour (domain data, e.g. kit colours).
const ALLOW_MARKER = 'ui-tokens-allow';

// Numeric HTML entities (&#9662;) look like hex colours to the pattern below,
// so strip them before testing.
const ENTITY = /&#\d+;?/g;
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d|:\s*white\b|:\s*black\b/;

const cache = new Map();
const read = f => { if (!cache.has(f)) cache.set(f, fs.readFileSync(f, 'utf8')); return cache.get(f); };
// Blank out comment bodies (keeping newlines) so prose examples like
// "use var(--bg-*)" are not mistaken for real references.
const blank = m => m.replace(/[^\n]/g, ' ');
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, blank)          // /* block */ (JS + CSS)
  .replace(/<!--[\s\S]*?-->/g, blank)           // <!-- html -->
  .replace(/(^|[^:'"\\])\/\/.*$/gm, (m, p) => p + blank(m.slice(p.length)));

const css = read(CSS);
const violations = [];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const jsFiles = walk(JS_DIR);
const sources = [...jsFiles, HTML];

/* ---- Rule 0: every JS file must PARSE ----
   This rule did not exist here, and on 2026-09-13 that took the whole site
   down. render() in gameweeks.js already declared `const all`; a second one was
   added at the top of the same function. A duplicate declaration is a PARSE
   error, so the module never loaded — and because main.js imports it at boot,
   NOTHING loaded: no nav, no dashboard, no data, just a header over an empty
   card. Every other rule in this file passed, because none of them ask whether
   the file is valid JavaScript.

   The annual day app grew this same check after shipping a broken panel twice.
   It was never ported back. It is first now because a file that does not parse
   makes every other question about it meaningless.

   The server and scripts are checked too: an admin screen that cannot load is
   bad, an API that cannot boot is worse. */
for (const file of [...jsFiles, ...walk(path.join(ROOT, 'server')),
  ...walk(path.join(ROOT, 'scripts'))]) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    const detail = (e.stderr?.toString() || e.message).split('\n')
      .find(l => /SyntaxError|Invalid|Unexpected|already been declared/.test(l))
      ?? 'does not parse';
    violations.push(`[syntax] ${path.relative(ROOT, file)}  ${detail.trim()}`);
  }
}

/* ---- Rule 1: no raw colour literals outside styles.css ---- */
for (const file of jsFiles) {
  const rel = path.relative(ROOT, file);
  const lines = read(file).split('\n');
  lines.forEach((line, i) => {
    if (!COLOUR.test(line.replace(ENTITY, ''))) return;
    // The marker may sit on the line itself or on any of the 3 lines above, so a
    // single comment can cover a small block of related domain constants.
    if (lines.slice(Math.max(0, i - 3), i + 1).some(l => l.includes(ALLOW_MARKER))) return;
    violations.push(`[colour] ${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
  });
}

/* ---- Rule 2: every var(--x) referenced must be declared somewhere ---- */
// Declared = set in styles.css, or set inline by a source file (e.g.
// style="--col-min: 260px" feeding an auto-grid rule).
const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
for (const file of sources) {
  for (const m of read(file).matchAll(/(--[a-z0-9-]+)\s*:/g)) declared.add(m[1]);
}
for (const file of [...sources, CSS]) {
  const rel = path.relative(ROOT, file);
  stripComments(read(file)).split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
      if (declared.has(m[1])) continue;
      violations.push(`[token] ${rel}:${i + 1}  undefined ${m[1]}`);
    }
  });
}

/* ---- Rule 3: no phantom classes ---- */
const cssClasses = new Set([...css.matchAll(/\.([a-z][a-z0-9_-]*)/gi)].map(m => m[1]));
const seen = new Map();
for (const file of sources) {
  const rel = path.relative(ROOT, file);
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/class="([^"$`]*)"/g)) {
      for (const c of m[1].split(/\s+/).filter(Boolean)) {
        if (cssClasses.has(c) || HOOK_CLASSES.has(c)) continue;
        if (!seen.has(c)) seen.set(c, `${rel}:${i + 1}`);
      }
    }
  });
}
for (const [c, where] of seen) violations.push(`[phantom] ${where}  .${c} has no CSS rule`);

/* ---- Report ---- */
if (violations.length) {
  console.error(`\n✗ check-ui-tokens: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error('  ' + v);
  console.error(`
  Fixes:
    [colour]  use a theme token — var(--danger|--warning|--success|--sport-on-soft|
              --text-main|--text-muted|--bg-card|--bg-inset). If the colour is real
              domain data (e.g. team kit colours), add a "${ALLOW_MARKER}" comment.
    [token]   the variable is not declared in styles.css — check for a typo.
    [phantom] add a rule to styles.css, or list it in HOOK_CLASSES if it is only a
              querySelector hook.
`);
  process.exit(1);
}
console.log('✓ check-ui-tokens: no violations');
