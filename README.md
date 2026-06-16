# FMSS — Football Club Contract Fee Management

A local web app for managing FMSS's two prepaid 5-a-side pitch contracts
(**Saturday Morning Madness** and **Monday/Thursday O365**). Paste the WhatsApp
team message, review the auto-computed per-player charges, and confirm to deduct
from each player's running balance. Tracks contributions (incoming funds), game
results/captains, and the club kitty.

Design and architecture mirror the SAMS dashboard (Express + Node's built-in
`node:sqlite`, modular ES-module frontend).

## Requirements
- **Node ≥ 22.5** (uses the built-in `node:sqlite` — no native build step).
- **Python 3 + openpyxl** (only for re-importing the Excel workbook).

## Setup

```bash
npm install
python scripts/extract_excel.py    # workbook → data/seed.json
npm run seed                        # load seed.json into data/fmss.db (first run only)
npm start                           # → http://localhost:3000
```

- `npm run reseed` — wipe the DB and reload from `seed.json` (e.g. after re-running the importer).
- The DB lives at `data/fmss.db`. Delete it to start over.

## How it works

- **Opening balance is authoritative.** The importer seeds each player's *Present
  Balance* from the workbook as their opening figure. Going forward:
  `present balance = opening + contributions − game charges`.
- Imported gameweeks and contributions are kept for the record (shown as
  "imported") but are **excluded from the live balance math** so nothing is
  double-counted — the opening balance already nets them.

## Views
- **Dashboard** — net standing per contract, kitty balance, refill watchlist.
- **Game Day** ⭐ — paste WhatsApp teams → parse → editable charge preview → confirm.
- **Players** — per-contract ledger; set status; add a contribution.
- **Contributions** — log/browse incoming payments.
- **Game History** — past games with teams, captains, score, charges.
- **Kitty** — club income/expense pot.
- **Settings** — edit venue, cost per game, and the rate card per contract.

## Rate card (editable in Settings)
Per-player cost is chosen by headcount and contract status:
`contracted_10/12`, `captain_10/12`, `noncontract` (default 35). Captains take the
captain rate; players flagged *Out of contract* take the non-contract rate.
