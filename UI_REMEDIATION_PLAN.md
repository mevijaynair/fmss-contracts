# FMSS UI/UX Remediation Plan — Site-wide

**Scope:** All 13 view modules, not just Results.
**Method:** Audited actual source + CSS. Every item below cites a real file:line.
**Principle:** Fix the *mechanism* (inline styles bypassing tokens), not just the symptoms.

---

## Ground truth: what actually exists

Verified in `public/css/styles.css`:

**Real tokens** (use these):
`--bg-main` `--bg-card` `--bg-inset` `--bg-subtle` `--border-color` `--border-strong`
`--text-main` `--text-muted` `--text-faint` `--danger` `--warning` `--success`
`--sport` `--sport-deep` `--sport-ring` `--sport-grad` `--sport-on-soft`
`--shadow-sm` `--shadow-md` `--shadow-lg` `--radius`

**Tokens that DO NOT exist** (never use — earlier draft invented these):
`--text-primary` ❌ `--border-subtle` ❌ `--bg-hover` ❌

**Layout already handled** — do not re-implement:
- `.view { display:flex; flex-direction:column; gap:1.5rem; }` — vertical rhythm between sections is automatic
- `.sams-card` — bg, border, radius, padding
- `.card-header` / `.card-title` — section headers (with `::before` accent bar)
- `.sams-grid` — 2-col, collapses at 900px
- `.kpi-strip` — `repeat(auto-fit, minmax(155px, 1fr))`
- `.seg` — segmented control pill (styles `.seg button`, **not** `.seg-btn`)
- `.hint` — empty-state text
- Theme switches on `[data-theme]` at `styles.css:40` and `:644`

**Shared helpers already exist** — do not hand-roll:
- `contractSeg(host, contracts, active, onPick)` — `util.js:34`
- `openModal(title, html)` / `closeModal()` — `util.js`
- `toast(msg, isError)` — `store.js`
- `esc()` `money()` `fmtDate()` `balCell()` — `util.js`

---

## Defect inventory (measured)

### D1 — Theme-breaking light-only surfaces `CRITICAL`

Hardcoded light backgrounds + dark text rendering on a `#121212` dark theme.

| File | Lines | Surface | Literals |
|---|---|---|---|
| `players.js` | 520–530 | **Reset Player confirm modal** | `#f5f5f5` `#fafafa` `#333` `#555` `#ddd` |
| `players.js` | 559–570 | **Delete Player confirm modal** | `#fff3f3` `#fafafa` `#333` `#dc3545` |
| `results.js` | 69 | Leaderboard player rows | `#f9f9f9` |
| `results.js` | 115–126 | Quarter cards Q1–Q4 | `white` `#f5f5f5` `#eee` `#999` `#ddd` |
| `kitty.js` | 186, 193 | Pending Collections panel | `#ffe0b2` `#ffe8c9` `rgba(255,255,255,0.5)` |
| `kitty.js` | 227 | Quick Withdraw panel | `#ffcccc` `#ffe0e0` |

**Risk note:** the two highest-severity items are destructive-action confirmations. Unreadable warning text on a delete dialog is a data-loss hazard, not a cosmetic issue.

### D2 — Semantic colors bypassing tokens

| Literal | Should be | Occurrences |
|---|---|---|
| `#d32f2f` | `var(--danger)` | players.js:23,141,146; kitty.js:195,227 |
| `#ff9800` | `var(--warning)` | players.js:28; kitty.js:186 |
| `#4caf50` | `var(--success)` | players.js:33; results.js (multiple) |
| `#dc3545` | `var(--danger)` | players.js:559,560 |

**Exception — keep as domain data:** `gameday.js:20-21` `#d32f2f`/`#1976d2` are *kit colors* (Red team / Blue team), not UI semantics. Move to a named `TEAM_COLORS` const; do not tokenize.

### D3 — Phantom CSS classes (styling intent, zero CSS)

| Class | Used in | Fix |
|---|---|---|
| `.seg-btn` | results.js:145 | Delete — `.seg button` already styles it |
| `.tab-btn` | players.js:369-373 | Define in styles.css |
| `.tab-content` | players.js | Define in styles.css |
| `.outside-badge` | gameday.js | Define in styles.css |

**NOT defects — leave alone.** These are legitimate `querySelector` hooks with no styling intent:
`.participant-row` `.participant-check` `.participant-amount` `.participant-contract`
`.player-type-select` `.charged-to-select` `.charge-delta`

### D4 — Inline style sprawl (the mechanism)

258 inline `style="` attributes. This is *how* D1 and D2 keep happening.

| Module | Inline styles | True hardcoded colors |
|---|---|---|
| players.js | 102 | 24 |
| kitty.js | 26 | 8 |
| results.js | 25 | 11 |
| opening_balances.js | 23 | 0 |
| gameweeks.js | 17 | 0 |
| contributions.js | 17 | 0 |
| external_events.js | 14 | 0 |
| transfers.js | 13 | 0 |
| sandbox.js | 13 | 1 |
| gameday.js | 5 | 2 |
| settings.js | 2 | 0 |
| logins.js | 1 | 0 |
| dashboard.js | **0** | **0** |

`dashboard.js` is the reference implementation — zero inline styles, zero hardcoded colors. Match it.

### D5 — results.js convention breaks (isolated to one file)

| Issue | Evidence | Impact |
|---|---|---|
| Hand-rolled segment control | results.js:145 vs `contractSeg()` used by gameday/gameweeks/players | **Mon/Thu tab is dead** — sends `mon_thu`, real id is `monthu` (`util.js:36`) |
| Import button inside `.seg` | results.js:145 `margin-left:auto` | Inherits `.seg button` styling, looks glued into the pill |
| No empty state | every other module has a `.hint` fallback | Empty view shows bare headers and `0W (0%)` |
| `alert()` for player detail | results.js:91 | Native dialog in a themed app; `openModal` exists |

Note: `confirm()` in external_events.js, gameday.js, sandbox.js are legitimate destructive-action guards. Not defects.

---

## Remediation phases

### Phase 0 — CSS foundation `~30 min`
Add to `styles.css` (once; every later phase consumes these):
- `.tab-btn`, `.tab-btn.active`, `.tab-content` — real definitions
- `.outside-badge` — badge styling
- `.panel-warn`, `.panel-danger` — token-based replacements for kitty's pastel gradients and players' modal boxes
- `.res-board`, `.res-row`, `.res-quarter` — Results primitives
- All using real tokens + `[data-theme]`-aware (inherit from `--bg-*` / `--text-*`)

**Exit check:** new classes render correctly in both light and dark.

### Phase 1 — Kill theme-breaking surfaces `~45 min` `HIGHEST RISK`
Order by severity:
1. `players.js:520-570` — both destructive-action modals → `.panel-warn` / `.panel-danger`
2. `kitty.js:186,193,227` — Pending Collections + Quick Withdraw → `.panel-warn` / `.panel-danger`
3. `results.js:69,115-126` — leaderboard rows + quarter cards → `.res-row` / `.res-quarter`

**Exit check:** toggle theme on each screen; zero light-on-dark or dark-on-light text.

### Phase 2 — Tokenize semantic colors `~20 min`
- Replace `#d32f2f`/`#dc3545` → `var(--danger)`, `#ff9800` → `var(--warning)`, `#4caf50` → `var(--success)` across players.js, kitty.js, results.js
- Extract `gameday.js:20-21` kit colors into a `TEAM_COLORS` const (keep the literals — domain data)

**Exit check:** `grep -rn "#d32f2f\|#ff9800\|#4caf50\|#dc3545" public/js/modules/` returns only the gameday TEAM_COLORS const.

### Phase 3 — results.js convention repair `~25 min`
- Swap hand-rolled segment → `contractSeg($('resContractSeg'), store.contracts, contractId, cb)` — **fixes the dead Mon/Thu tab**
- Move Import button out of `.seg`, into `card-header`
- Add `.hint` empty state: "No games recorded for this contract yet" + inline Import CTA
- Replace `alert()` → `openModal()`
- Delete `.seg-btn`

**Exit check:** Mon/Thu returns data; empty contract shows a friendly message, not `0W (0%)`.

### Phase 4 — Inline style reduction `~60 min`
Target the two worst offenders only. Do not touch modules already at 0 hardcoded colors.
- `players.js` 102 → target < 20
- `kitty.js` 26 → target < 10
- Promote repeated patterns into styles.css classes

**Exit check:** no behavior change; visual diff only where Phase 1–2 already fixed things.

### Phase 5 — Verification + guardrail `~40 min`
- Walk all 13 views in **light theme**, **dark theme**, and **375px mobile**
- Add `scripts/check-ui-tokens.js` — fails if a module introduces a raw hex outside an allowlist (gameday TEAM_COLORS). Wire into the test run so this cannot regress.

**Exit check:** the guardrail script passes on a clean tree and fails on a deliberately introduced `#ffffff`.

---

## Total: ~3.5 hours across 6 phases

Phases 0–3 (~2 hours) remove every user-visible defect. Phases 4–5 prevent recurrence.

## Explicitly NOT doing
- Restyling `dashboard.js`, `settings.js`, `logins.js`, `transfers.js`, `opening_balances.js`, `contributions.js`, `external_events.js`, `gameweeks.js` — audited clean (0 hardcoded colors)
- Renaming `querySelector` hook classes — they work, renaming is churn
- Adding a CSS framework or build step — the token system already works
- Changing `confirm()` guards on destructive actions — those are correct
