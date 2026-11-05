#!/usr/bin/env node
/**
 * check-html-structure.js — the shell is still the shape the app assumes.
 *
 * A missing ">" on one div cost three screens. The parser read
 *
 *   <div class="sams-card" id="backupCard"      <- no ">"
 *     <div class="card-header">
 *
 * as a SINGLE tag, swallowing the inner div's opening. One open div was lost,
 * so the next </div> closed <div class="main"> instead — taking
 * <main class="content"> with it. Everything after that point was reparented
 * out of the content area and into the sidebar grid, where it has no column
 * and cannot be seen.
 *
 * Nothing complained. The HTML was served exactly as written, every module
 * loaded, every route answered, the view rendered its markup into a container
 * that really was in the DOM — and three screens were blank, with no error in
 * the browser, the server log, or any test. The only symptom was absence.
 *
 * So: the two things that were wrong are now things that fail the build.
 *   1. every tag closes the tag it looks like it closes
 *   2. every view sits inside <main id="content">
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'public', 'index.html');
const raw = fs.readFileSync(FILE, 'utf8');

// Comments, scripts and styles are blanked rather than removed, so a reported
// line number is the line you open in the editor.
const blank = (m) => m.replace(/[^\n]/g, ' ');
const src = raw
  .replace(/<!--[\s\S]*?-->/g, blank)
  .replace(/<script\b[\s\S]*?<\/script>/g, blank)
  .replace(/<style\b[\s\S]*?<\/style>/g, blank);

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'source', 'track', 'wbr']);

const lineStarts = [0];
for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
const lineOf = (off) => {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1; }
  return lo + 1;
};

const problems = [];
const stack = [];
const views = [];          // [{ name, line, insideContent }]

for (const m of src.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
  const [, closing, rawTag, attrs, selfClose] = m;
  const tag = rawTag.toLowerCase();
  const line = lineOf(m.index);
  if (VOID.has(tag) || selfClose) continue;

  if (!closing) {
    // A view's home is decided by what is open when it opens.
    // The class token exactly, not a substring: "login-view" is a different
    // thing and lives outside the shell on purpose.
    const classes = ((attrs.match(/class="([^"]*)"/) || [])[1] || '').trim().split(/\s+/);
    const named = (attrs.match(/data-view="([^"]+)"/) || [])[1];
    if (tag === 'section' && classes.includes('view') && named) {
      const name = named;
      views.push({ name, line, insideContent: stack.some(f => f.tag === 'main' && /id="content"/.test(f.attrs)) });
    }
    stack.push({ tag, line, attrs });
    continue;
  }

  if (stack.length && stack[stack.length - 1].tag === tag) { stack.pop(); continue; }

  let idx = -1;
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === tag) { idx = i; break; }
  if (idx === -1) {
    problems.push(`line ${line}: </${tag}> closes nothing — look for a tag above it that never opened`);
  } else {
    const forced = stack.slice(idx + 1).map(f => `<${f.tag}> from line ${f.line}`).join(', ');
    problems.push(`line ${line}: </${tag}> reaches back to line ${stack[idx].line} and force-closes ${forced}`
      + `\n    Almost always a missing ">" on an opening tag above, which swallows the next one.`);
    stack.length = idx;
  }
}
for (const f of stack) problems.push(`line ${f.line}: <${f.tag}> is never closed`);

// Where a view ends up is the thing that actually broke, so it is checked
// directly rather than inferred from the balance above.
const stranded = views.filter(v => !v.insideContent);
for (const v of stranded) {
  problems.push(`line ${v.line}: the "${v.name}" view is not inside <main id="content">`
    + `\n    It will render its markup and still be invisible — the shell grid gives it no column.`);
}

if (problems.length) {
  console.error(`\n✗ check-html-structure: ${problems.length} problem(s) in public/index.html\n`);
  for (const p of problems) console.error('  ' + p);
  console.error('');
  process.exit(1);
}
console.log(`✓ check-html-structure: tags balanced, all ${views.length} views inside <main id="content">`);
