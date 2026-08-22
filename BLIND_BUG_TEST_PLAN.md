# FMSS — Blind Bug Test Plan

**Method:** black-box. Every case is written as *what you do* and *what you should
see*, with concrete expected numbers. No case says "check the code does X" — if a
result has to be interpreted, the case is written wrong.

**Bias:** this is a money tracker, so the plan front-loads **arithmetic invariants**
over appearance. A ledger that is 30 AED wrong and looks fine is worse than a
misaligned card. Suites A–C are the ones that matter; F is cosmetic.

**Surface:** 87 API endpoints, 13 view modules, 2 roles (admin / player),
2 contracts (`sat`, `monthu`), 2 themes.

---

## 0. Setup — do this first

### 0.1 Snapshot the database

Every destructive case below assumes you can get back. **Do not skip this.**

```bash
cp data/fmss.db data/fmss.db.pretest
```

Restore at any point with:

```bash
cp data/fmss.db.pretest data/fmss.db
```

Restart the server after restoring.

### 0.2 Run against the branch, not production

```bash
git status -sb
```

Confirm you are on `fix/ui-theme-tokens-and-responsive`. Testing `main` tests the
old code.

### 0.3 Record the baseline

Before touching anything, write these down. Several cases compare against them.

| Figure | Where | Value |
|---|---|---|
| Net club credit | Dashboard KPI | |
| Kitty balance | Dashboard KPI | |
| Sat — total credit held | Dashboard | |
| Sat — total owed | Dashboard | |
| Mon/Thu — total credit held | Dashboard | |
| Mon/Thu — total owed | Dashboard | |
| Player count | Dashboard KPI | |

### 0.4 Severity

| | Meaning |
|---|---|
| **S1** | Money is wrong, or data is lost. Blocks release. |
| **S2** | A feature does not work; no data loss. |
| **S3** | Works, but wrong/confusing output. |
| **S4** | Cosmetic. |

---

## Suite A — Money invariants `S1`

The core question: **does every action move exactly the amount it claims to?**

Each case is arithmetic, so it cannot be argued into a pass.

### A1 — Ledger identity holds for every player
1. Open **Players**, pick the `sat` contract.
2. For **five** players, including at least one with a negative balance, check:
   `opening + contributed − charged = balance`
- **Expected:** exact for all five, to the decimal shown.
- **Fails if:** any row is off by any amount.

### A2 — Contract totals equal the sum of their rows
1. Sum the Balance column for all `sat` players.
2. Compare to Dashboard → Saturday → *Net standing*.
- **Expected:** identical.
- **Watch:** whether the dashboard silently excludes test players / cashiers when
  the ledger does not, or vice versa.

### A3 — A contribution moves the balance by exactly its amount
1. Note player P's balance.
2. **Contributions** → add **100** to P on `sat`.
3. Re-read P's balance.
- **Expected:** exactly `old + 100`. Dashboard net credit also `+100`.
- **Undo:** delete the contribution; balance must return to the original value.

### A4 — Deleting a contribution fully reverses it
Continue from A3's undo.
- **Expected:** P's balance and the dashboard total both return to their A3
  starting values, exactly.
- **Fails if:** anything is left behind, or the delete is refused.

### A5 — Charging a game debits every player by the shown amount
1. **Game Day** → `sat` → paste:
   ```
   🔴 Vijay (C) Toby Rojy
   🔵 Jithin Kartik Rakesh
   ```
2. Note each player's balance **before** confirming, and the preview's per-player
   amounts and total.
3. Confirm.
- **Expected:** each player debited by exactly their preview amount; the sum of
  the debits equals the preview total.
- **Fails if:** any player moves by a different amount, or someone not in the
  message moves at all.

### A6 — Deleting a gameweek reverses every charge
1. **Game History** → delete the gameweek from A5.
- **Expected:** all six balances return to their pre-A5 values, exactly.
- **S1 if:** balances do not restore — that is unrecoverable drift.

### A7 — The captain rate is actually different
In A5, Vijay is marked `(C)`.
- **Expected:** Vijay's amount differs from the non-captain rate, and matches the
  captain rate in **Settings**.
- **Fails if:** identical to others while Settings says otherwise.

### A8 — Money cannot be conjured or destroyed
Across A3–A6, after each undo:
- **Expected:** *net club credit* returns to the 0.3 baseline every time.
- **Fails if:** it drifts, even by 0.1.

### A9 — Negative and zero contributions
Try adding a contribution of `0`, `-50`, and `abc`.
- **Expected:** each is rejected with a clear message, **or** handled with a
  documented rule. Silent acceptance of `-50` is **S1**.

### A10 — Very large value
Add a contribution of `99999999`.
- **Expected:** either rejected, or stored and displayed accurately.
- **Fails if:** it displays rounded/truncated, or overflows the layout.

---

## Suite B — Game Day parsing `S2`

The most complex input path in the app, and the one most exposed to messy
real-world WhatsApp text.

### B1 — Both team emoji styles
Test each separately: `🔴`/`🔵`, `❤️`/`💙`, and the text words `Red`/`Blue`.
- **Expected:** two teams detected each time.

### B2 — Captain marker
`Vijay (C)`, `Vijay(C)`, `Vijay (c)`.
- **Expected:** captain detected in all three, or the unsupported forms clearly
  flagged rather than silently treated as a normal player.

### B3 — Nicknames
Paste `VJ`, `AJ` and a player's full name in the same message.
- **Expected:** each resolves to a real player, or is clearly shown as unmatched.
- **S1 if:** a nickname silently resolves to the **wrong** player — that charges
  the wrong person.

### B4 — Unknown name
Include `Zzzqq` in the message.
- **Expected:** flagged as unmatched; you are asked before any player is created.
- **Fails if:** a player is created silently.

### B5 — Duplicate name in both teams
Put the same player on both teams.
- **Expected:** rejected or de-duplicated. Being charged twice for one game is
  **S1**.

### B6 — Empty and junk input
Parse an empty box, then a paragraph of unrelated prose.
- **Expected:** clear "no players detected"; no crash, no empty gameweek created.

### B7 — Odd team sizes
7 players vs 3.
- **Expected:** parses; rates apply per the Settings rate card.

### B8 — Preview matches what is committed
Screenshot the preview table, confirm, then open the gameweek in Game History.
- **Expected:** identical players, teams, captains and amounts.
- **S1 if:** they differ — the preview would be lying.

### B9 — Charge reassignment
Reassign one player's charge to another via the *Charged to* dropdown.
- **Expected:** the debit lands on the person selected, not the player listed.

### B10 — Outside player
Mark one player *outside contract*.
- **Expected:** excluded from the contracted P/L, and visible as owing separately.

---

## Suite C — Settlement, kitty, results `S1`/`S2`

### C1 — Recording a payment updates both places
Game History → edit a gameweek → mark a player paid by cash.
- **Expected:** collection % rises; the player's ledger balance improves by the
  same amount.
- **Fails if:** one updates without the other.

### C2 — Payment method is retained
Record three payments: cash, transfer, UPI.
- **Expected:** each shows the method it was recorded under.

### C3 — Kitty pending collections match the ledger
Compare **Kitty → Pending Collections** against the negative balances in Players.
- **Expected:** same people, same amounts.

### C4 — Quick withdraw
Withdraw 50.
- **Expected:** kitty falls by exactly 50; an entry appears with the reason.
- **Undo:** delete the entry; kitty returns exactly.

### C5 — Mon/Thu tab returns data
**Results** → *Monday/Thu*.
- **Expected:** shows that contract's games. **This was broken on `main`** (it
  queried `mon_thu`; the real id is `monthu`), so this is the regression check.
- **Fails if:** empty while Game History shows Mon/Thu games exist.

### C6 — Empty state, not fake zeros
Switch Results to a contract with no games.
- **Expected:** "No games recorded for this contract yet" + an Import button.
- **Fails if:** it shows leaderboards of `0W (0%)` — the old behaviour.

### C7 — Results arithmetic
Compare the Results leaderboard against Game History.
- **Expected:** games played per player matches; wins ≤ games; win % consistent.

### C8 — Games with no recorded result
Ensure at least one gameweek has a blank score.
- **Expected:** counted in *games*, excluded from *wins*; no crash, no `NaN`,
  no `undefined`.

### C9 — Flexible scorelines
Enter results as `13-9`, `won by 4`, `Reds win 7-5`, and gibberish.
- **Expected:** the first three classify correctly; gibberish is treated as
  unknown rather than a win.

### C10 — Import does what it claims
Use **Results → Import** with two rows.
- **Expected:** the toast states what happened *truthfully*. Note that today it
  reports parsed rows but does **not persist** them — if the wording implies data
  was saved when it was not, that is **S2**.

---

## Suite D — Roles and access `S1`

A player seeing another player's finances is the worst non-money bug here.

### D1 — Player login
Log in as a player with their PIN.
- **Expected:** only their own ledger, contributions and stats.

### D2 — No admin surfaces
As that player, look for Settings, Kitty, Logins, Game Day, Sandbox.
- **Expected:** absent from the nav.

### D3 — Direct URL / API access
While logged in as a player, request an admin endpoint:
```bash
curl -i -H "Authorization: Bearer <player-token>" localhost:3100/api/ledgers
```
- **Expected:** `401` or `403`.
- **S1 if:** it returns every player's balances.

### D4 — Another player's data
```bash
curl -i -H "Authorization: Bearer <player-token>" localhost:3100/api/players/<other-id>/ledgers
```
- **Expected:** refused.

### D5 — No token at all
Repeat D3 with the header removed.
- **Expected:** `401`.

### D6 — Wrong PIN
Attempt a player login with a wrong PIN three times.
- **Expected:** rejected each time, no lockout bypass, no hint about the correct PIN.

---

## Suite E — Destructive operations and integrity `S1`

### E1 — Reset player
Reset a player who has both contributions and charges.
- **Expected:** matches exactly what the confirmation promised — contributions
  cleared, balance 0, **game history retained**.
- **Fails if:** it does more or less than stated.

### E2 — Confirmation is honest and readable
Open the reset and delete dialogs in **both themes**.
- **Expected:** text legible in both; the checkbox genuinely gates the button.
- (Both dialogs hardcoded light backgrounds on `main` — this is the regression check.)

### E3 — Delete player
Delete a **sandbox** player only.
- **Expected:** gone; contract totals drop by exactly that player's balance;
  no orphan rows in Contributions or Game History.

### E4 — Apostrophe / unicode names
Create players named `O'Brien`, `José`, and `<b>Bold</b>`.
- **Expected:** stored and displayed literally.
- **S1 if:** `<b>Bold</b>` renders as bold text — that is HTML injection.

### E5 — Very long name
150 characters.
- **Expected:** accepted or rejected cleanly; no layout break.

### E6 — Duplicate player name
Add a second player with an existing name.
- **Expected:** rejected, or clearly distinguishable afterwards.

### E7 — Concurrent edit
Open the app in two tabs. Add a contribution in tab 1, then act in tab 2 without
refreshing.
- **Expected:** no stale overwrite; no negative-money outcome.

### E8 — Refresh mid-flow
Parse a Game Day message, then refresh before confirming.
- **Expected:** nothing charged.

---

## Suite F — Appearance and responsive `S3`/`S4`

Lowest priority. Run last.

### F1 — Both themes, every view
Toggle the theme and visit all 8 nav items.
- **Expected:** no light-on-light or dark-on-dark text anywhere.

### F2 — Phone width
375px, every view.
- **Expected:** no horizontal page scroll; the nav scrolls sideways by itself.
- (`main` forced the sidebar to 990px — regression check.)

### F3 — Tablet
768px and 900px, Players and Results.
- **Expected:** filter bar and leaderboards reflow without clipping.

### F4 — Long content
A player with 50+ transactions; a gameweek with 20 players.
- **Expected:** tables scroll inside their own container.

### F5 — Numbers stay aligned
Check a negative, a zero, and a 5-figure balance in one table.
- **Expected:** right-aligned and consistently formatted.

---

## Suite G — Deploy and operations `S1`

Written from the failure that actually occurred on `fmss-web-prod`.

### G1 — Health endpoint
```bash
curl -fsS localhost:3002/api/health && echo
```
- **Expected:** succeeds.

### G2 — Service survives restart
```bash
systemctl restart fmss-contracts && sleep 3 && systemctl status fmss-contracts --no-pager
```
- **Expected:** active (running).

### G3 — Data survives restart
Note the kitty balance, restart, re-check.
- **Expected:** unchanged.
- **S1 if:** it resets — the DB is not on the persistent path.

### G4 — A failed install is detectable
This already bit you: `npm ci` empties `node_modules` before installing, so a
build failure leaves the app with **no dependencies**, and a restart takes the
site down silently.
- **Expected:** G1 and G2 catch it. Confirm they do before trusting a deploy.

---

## Running order

| Pass | Suites | Time | When |
|---|---|---|---|
| **Smoke** | A1–A6, C5, C6, D1, D3, F1 | ~20 min | Before every merge |
| **Full** | A–G | ~2 hrs | Before a production deploy |
| **Post-deploy** | G1–G3, A1, A2, C5 | ~5 min | Immediately after deploying |

---

## Results — smoke pass, 2026-08-22

Run against `fix/ui-theme-tokens-and-responsive` on `localhost:3100`, DB snapshotted
first. Baseline: 34 players, kitty 2894.25, sat net 1256.6, monthu net 3826.5,
net club credit 5083.10.

| ID | Result | Sev | Notes |
|---|---|---|---|
| A1 | **PASS** | | Identity held for **all 53** ledger rows, not just the 5 required |
| A2 | **PASS** | | Both contracts reconcile to the dashboard exactly; row counts match (23/30) |
| A3 | **PASS** | | +100 moved balance 147→247 and net credit by exactly +100 |
| A4 | **PASS** | | Delete restored 247→147 and net credit to 5083.10 exactly |
| A5 | **PASS\*** | | All *non-duplicate* players debited exactly right — see B5 |
| A6 | **PASS** | | Gameweek delete restored all 5 balances exactly, incl. the double charge |
| A7 | **PASS** | | Captain 25 vs non-captain 35 — rates genuinely differ |
| A8 | **PASS** | | Net credit returned to 5083.10 after every undo; no drift |
| A9 | not run | | |
| A10 | not run | | |
| B1 | **PASS** | | 🔴/🔵 → `["Red","Blue"]`, players assigned correctly |
| B2 | **PASS** | | `(C)` detected, captain rate applied |
| B3 | not run | | |
| B4 | **PASS** | | Unknown names returned `matched:false`, no silent player creation |
| B5 | **FAIL** | **S1** | **Player on both teams is charged twice for one game** — see findings |
| B6 | not run | | |
| B7 | not run | | |
| B8 | **PASS** | | Committed charges matched the preview amounts exactly |
| B9 | not run | | |
| B10 | not run | | |
| C1 | not run | | |
| C2 | not run | | |
| C3 | not run | | |
| C4 | not run | | |
| C5 | **PARTIAL** | **S2** | Contract id fix confirmed (`monthu`=20 gw, `mon_thu`=0), but Results UI still shows nothing — blocked by finding 2 |
| C6 | **FAIL** | **S2** | Empty state renders *when data exists* — 19/20 gameweeks present |
| C7 | blocked | | Blocked by finding 2 |
| C8 | blocked | | Blocked by finding 2 |
| C9 | not run | | |
| C10 | not run | | |
| D1 | blocked | | Needs a real player PIN |
| D2 | blocked | | Needs a real player PIN |
| D3 | **PARTIAL** | | Unauthenticated blocked; player-token escalation untested |
| D4 | blocked | | Needs a real player PIN |
| D5 | **PASS** | | No token / garbage token → 401 on `/ledgers`, `/dashboard`, `/players` |
| D6 | not run | | |
| E1–E8 | not run | | |
| F1 | **PASS** | | 0 contrast pairs below AA-large across all views, both themes |
| F2 | **PASS** | | No horizontal overflow at 375px |
| F3–F5 | not run | | |
| G1–G4 | blocked | | Needs SSH to the server |

---

## Findings

### Finding 1 — A player listed on both teams is charged twice `S1`

**Case:** B5. **Reproduced end-to-end.**

Parsing `🔴 Vijay (C) Toby Rojy` / `🔵 Jeetu Nihas Rojy` returns 6 rows with `rojy`
appearing twice at 35 each. Committing the gameweek debits Rojy **70 AED for one
game**:

| Player | Before | After | Δ | Expected |
|---|---|---|---|---|
| vijay (C) | 0 | −25 | −25 | −25 ✓ |
| toby | −181.9 | −216.9 | −35 | −35 ✓ |
| **rojy** | 147 | 77 | **−70** | −35 ✗ |
| jeetu | −27.3 | −62.3 | −35 | −35 ✓ |
| nihas | 108.6 | 73.6 | −35 | −35 ✓ |

Realistic trigger: a WhatsApp message edited mid-thread, or someone moved between
teams and got pasted into both. Nothing warns the admin — the preview lists the
name twice, which reads as two different people at a glance.

Deleting the gameweek reverses it cleanly (A6), so it is recoverable *if noticed*.

**Suggested fix:** reject or merge duplicate `player_id`s at parse time, and warn
in the preview.

### Finding 2 — Results and Game History read a field the list endpoint never returns `S2`

`GET /gameweeks` returns `num_players` and `charged` (a total). It does **not**
return a `charges` array — only `GET /gameweeks/:id` does.

Both `results.js` and `gameweeks.js` iterate `gw.charges || []` over the **list**
response, so both always see zero.

Consequences:
- **Results** always renders the empty state, even with 19/20 gameweeks present.
  The Mon/Thu fix is correct underneath but invisible.
- **Game History** shows `0 players`, `0` charged, `0%` collected — and labels
  every one of the 19 games **"✓ Collected"**, because `pendingAmount === 0`.

The false "✓ Collected" is the worst part: it asserts every game is settled when
it has no data at all, which could stop you chasing money that is genuinely owed.

**Suggested fix:** use `num_players` / `charged` from the list, or have the list
endpoint include charges.

**Note:** this predates the UI work in PR #1 — the aggregation read `gw.charges`
from the start. The UI fixes made the failure *visible* (a correct empty state
instead of a grid of `0W (0%)`), but did not cause it.

**Restore the database when finished:**

```bash
cp data/fmss.db.pretest data/fmss.db
```
