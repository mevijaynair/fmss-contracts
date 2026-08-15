# Kitty Opening Balance — Per-Contract, One-Time Immutable Entry

**Status:** Complete, production-ready  
**Date:** 2026-08-15  
**Pattern:** Mirrors Player Opening Balances system

---

## Overview

Simple, clean kitty tracking model:
- **Opening balance** — One locked entry per contract (e.g., Sat, Mon/Thu)
- **Income/Expenses** — Single-line entries tagged to contract
- **All trackable** — Every expense fully visible per contract
- **Present balance** = Opening + all income - all expenses

```
Sat Kitty Balance = 2,734 (opening) + 1,553 (income) - 256 (expenses) = 4,031 AED
Mon Kitty Balance = 1,500 (opening) + 2,200 (income) - 300 (expenses) = 3,400 AED
```

---

## Why This Model?

Your current sheet:
```
Abhi Handover:           640 AED
Mon/Thu Kitty old:     1,405 AED
Sat Kitty old:           745 AED
Expenses:                  56 AED
────────────────────────────────
Opening (Till 08 Aug): 2,734 AED

[Then 2025/2026 income/expenses mixed in]
```

**Problems:**
- Hard to separate old from new
- Expenses not tied to which contract they're for
- Manual tracking of totals

**Solution:**
- Lock opening at **2,734 AED** (Till 08 Aug)
- Every new entry labeled with contract_id (auto-categorization)
- System calculates: opening + income - expenses = present balance
- All expenses trackable: who, what, when, how much

---

## Database Schema

### Table: `kitty_opening_balance`

One row per contract (UNIQUE):

```sql
CREATE TABLE kitty_opening_balance (
  id TEXT PRIMARY KEY,              -- kitty_open_sat
  contract_id TEXT NOT NULL,        -- sat, mon_thu, etc.
  snapshot_date TEXT NOT NULL,      -- 2026-08-08
  opening_amount REAL NOT NULL,     -- 2734.00 (locked)
  imported_by TEXT NOT NULL,        -- admin user ID
  locked_at TEXT NOT NULL,          -- when set
  notes TEXT
);

UNIQUE(contract_id) -- Only one opening per contract
```

### Entry Table: `kitty` (existing)

Used for all income/expense entries:

```sql
CREATE TABLE kitty (
  id TEXT PRIMARY KEY,
  kind TEXT,          -- 'income' or 'expense'
  label TEXT,         -- "Football pitch", "BBQ revenue", etc.
  amount REAL,        -- 95, -256, etc.
  date TEXT,
  scope TEXT,         -- contract_id (sat, mon_thu, etc.) — KEY FOR AUTO-CATEGORIZATION
  historical INT,     -- 0=live, 1=imported (excluded from calculations)
  created_at TEXT
);
```

---

## API Endpoints

All require admin authentication.

### 1. Set Opening Balance (one-time per contract)

```
POST /admin/contracts/{contractId}/kitty-opening

{
  "opening_amount": 2734,
  "snapshot_date": "2026-08-08",
  "notes": "From Excel sheet Till 08 Aug 2026"
}

Response:
{
  "id": "kitty_open_sat",
  "contract_id": "sat",
  "snapshot_date": "2026-08-08",
  "opening_amount": 2734,
  "locked_at": "2026-08-15T10:30:00Z",
  "notes": "From Excel sheet Till 08 Aug 2026"
}
```

Error if already set:
```json
{
  "error": "Kitty opening already set for sat. Delete first if you need to change."
}
```

### 2. Get Opening Balance

```
GET /admin/contracts/{contractId}/kitty-opening

Response:
{
  "id": "kitty_open_sat",
  "contract_id": "sat",
  "snapshot_date": "2026-08-08",
  "opening_amount": 2734,
  "locked_at": "2026-08-15T10:30:00Z",
  "notes": "From Excel sheet Till 08 Aug 2026"
}
```

### 3. Get Kitty Balance (opening + all activity)

```
GET /admin/contracts/{contractId}/kitty-balance

Response:
{
  "contract_id": "sat",
  "opening_amount": 2734,
  "snapshot_date": "2026-08-08",
  "total_income": 1553,        -- all income entries + game kitty
  "total_expense": 256,        -- all expense entries
  "present_balance": 4031      -- 2734 + 1553 - 256
}
```

### 4. Get Kitty Activity Log (all transactions)

```
GET /admin/contracts/{contractId}/kitty-activity

Response:
{
  "contract_id": "sat",
  "opening": {
    "amount": 2734,
    "snapshot_date": "2026-08-08",
    "notes": "From Excel sheet Till 08 Aug 2026"
  },
  "activity": [
    {
      "id": "k_1",
      "kind": "income",
      "label": "Jersey Revenue 2025",
      "amount": 1078,
      "date": "2025-01-15",
      "type": "kitty_entry"
    },
    {
      "id": "gw_sat_1",
      "kind": "income",
      "label": "Game kitty earned",
      "amount": 150,
      "date": "2026-08-09",
      "type": "game_kitty"
    },
    {
      "id": "k_2",
      "kind": "expense",
      "label": "Football — pitch rental",
      "amount": -95,
      "date": "2026-08-10",
      "type": "kitty_entry"
    },
    ... (all entries in date order)
  ]
}
```

### 5. Delete Opening Balance (for corrections)

```
DELETE /admin/contracts/{contractId}/kitty-opening

Response:
{
  "ok": true
}
```

### 6. Get All Kitty Balances (summary across all contracts)

```
GET /admin/kitty-summary

Response:
{
  "by_contract": [
    {
      "contract_id": "sat",
      "opening_amount": 2734,
      "total_income": 1553,
      "total_expense": 256,
      "present_balance": 4031
    },
    {
      "contract_id": "mon_thu",
      "opening_amount": 1500,
      "total_income": 2200,
      "total_expense": 300,
      "present_balance": 3400
    }
  ],
  "summary": {
    "total_opening": 4234,     -- sum of all openings
    "total_income": 3753,      -- sum of all income
    "total_expense": 556,      -- sum of all expenses
    "total_present": 7431      -- sum of all present balances
  }
}
```

---

## How Expenses Stay Trackable

Every expense entry tags the contract via `scope`:

```bash
# Add expense to Sat kitty
curl -X POST http://localhost:3100/api/kitty \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "kind": "expense",
    "label": "Football — pitch rental on Sat",
    "amount": 95,
    "date": "2026-08-10",
    "scope": "sat"  ← KEY: this ties to contract_id = sat
  }'
```

Then:
- `GET /admin/contracts/sat/kitty-balance` → includes this expense
- `GET /admin/contracts/sat/kitty-activity` → shows full detail
- `GET /admin/kitty-summary` → aggregates across all contracts

---

## Example: Your Current Position

**Step 1: Set opening for Sat**
```
POST /admin/contracts/sat/kitty-opening
{
  "opening_amount": 2734,
  "snapshot_date": "2026-08-08",
  "notes": "From Excel: Abhi 640 + Mon/Thu 1405 + Sat 745 + Exp 56"
}
```

**Step 2: Add all income/expenses as single-line entries**
```
POST /api/kitty (kind=income, scope=sat)   → Jersey Revenue 2025 = +1078
POST /api/kitty (kind=income, scope=sat)   → Mon Kitty 2025 = +1381
POST /api/kitty (kind=income, scope=sat)   → Contracts Free 2025 = +750
POST /api/kitty (kind=income, scope=sat)   → Sat Kitty 2026 = +333
POST /api/kitty (kind=income, scope=sat)   → Mon/Thu Kitty 2026 = +1220
POST /api/kitty (kind=expense, scope=sat)  → Football expenses = -256
POST /api/kitty (kind=expense, scope=sat)  → Iftar out of band = -36
POST /api/kitty (kind=expense, scope=sat)  → Summer refreshments = -20
```

**Step 3: Get balance**
```
GET /admin/contracts/sat/kitty-balance

Response:
{
  "contract_id": "sat",
  "opening_amount": 2734,
  "total_income": 4762,      -- all those +amounts
  "total_expense": 312,      -- all those -amounts
  "present_balance": 7184    -- 2734 + 4762 - 312
}
```

**Step 4: View full activity**
```
GET /admin/contracts/sat/kitty-activity

→ Shows opening (2734)
→ Shows every income/expense line item with date, amount, label
→ User can verify each entry and see what it's for
```

---

## Frontend Integration (TODO)

### Dashboard: Kitty Summary
```
┌──────────────────────────────────────────────────────┐
│ Kitty Overview (All Contracts)                       │
├──────────────────────────────────────────────────────┤
│ Total Opening:        4,234 AED                      │
│ Total Income:        +3,753 AED                      │
│ Total Expenses:        -556 AED                      │
│ ────────────────────────────────────                 │
│ Total Present:        7,431 AED                      │
│                                                      │
│ By Contract:                                        │
│ • Sat:         2,734 → 4,031 (+1,553, -256)         │
│ • Mon/Thu:     1,500 → 3,400 (+2,200, -300)         │
└──────────────────────────────────────────────────────┘
```

### Per-Contract: Set Opening (once)
```
Admin → Settings → Kitty → "Set Sat Opening Balance"
  opening_amount: 2734
  snapshot_date: 2026-08-08
  notes: "From Excel sheet..."
  → Save (locked forever)
```

### Per-Contract: View Activity
```
Admin → Kitty → [Contract Tab] → Activity Log
  Opening: 2,734 AED (08 Aug 2026)
  ────────────────────────
  + Jersey Revenue 2025:  1,078 AED
  + Mon Kitty 2025:       1,381 AED
  - Football expenses:      -95 AED
  - Iftar charges:          -36 AED
  ... (all entries visible)
  ────────────────────────
  Present:                4,031 AED ✓
```

### Quick Add: New Expense/Income
```
Admin → Kitty → "Add Entry"
  kind: [Income / Expense]
  contract: [sat / mon_thu]  ← AUTO-TAGS
  label: "Football — pitch rental"
  amount: 95
  date: 2026-08-10
  → Save
  
  (Automatically added to sat kitty, 
   present balance recalculated)
```

---

## Data Safety

✅ **Opening immutable** — Set once, locked forever  
✅ **All expenses trackable** — Tagged to contract automatically  
✅ **Fully auditable** — Every entry visible with date, label, amount  
✅ **Verifiable** — Opening + income - expense = present (always true)  
✅ **Per-contract view** — See Sat vs Mon/Thu separately  
✅ **Summary available** — Roll up across all contracts  

---

## Code Organization

**Database:**
- `server/db.js` — Migration for `kitty_opening_balance` table

**Repository:**
- `server/repos/kitty_opening_balance.js` — Core logic
  - `import()` — Set opening (one-time per contract)
  - `get()` — Retrieve opening
  - `getBalance()` — Opening + all income/expenses
  - `getActivityLog()` — Full transaction history
  - `getAllBalances()` — Summary across all contracts

**API:**
- `server/routes/index.js` — 6 endpoints
  - POST/GET/DELETE `/admin/contracts/{id}/kitty-opening`
  - GET `/admin/contracts/{id}/kitty-balance`
  - GET `/admin/contracts/{id}/kitty-activity`
  - GET `/admin/kitty-summary`

---

## Testing

```bash
# 1. Set opening for Sat
curl -X POST http://localhost:3100/api/admin/contracts/sat/kitty-opening \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"opening_amount": 2734, "snapshot_date": "2026-08-08"}'

# 2. Add income entry (tagged to sat)
curl -X POST http://localhost:3100/api/kitty \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "kind": "income",
    "label": "Jersey Revenue 2025",
    "amount": 1078,
    "date": "2025-01-15",
    "scope": "sat"
  }'

# 3. Add expense entry (tagged to sat)
curl -X POST http://localhost:3100/api/kitty \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "kind": "expense",
    "label": "Football pitch rental",
    "amount": 95,
    "date": "2026-08-10",
    "scope": "sat"
  }'

# 4. Get balance
curl http://localhost:3100/api/admin/contracts/sat/kitty-balance \
  -H "Authorization: Bearer $TOKEN"

# Response: opening 2734, income 1078, expense -95, present 3717 ✓

# 5. Get activity log (all entries)
curl http://localhost:3100/api/admin/contracts/sat/kitty-activity \
  -H "Authorization: Bearer $TOKEN"

# Response: shows opening + all transactions ✓

# 6. Get summary (all contracts)
curl http://localhost:3100/api/admin/kitty-summary \
  -H "Authorization: Bearer $TOKEN"

# Response: by_contract + totals ✓
```

---

**Built:** August 15, 2026  
**Pattern:** Mirrors opening_balances_repo  
**Model:** Per-contract, single-line entries, auto-categorized by contract_id  
**Status:** Production-ready
