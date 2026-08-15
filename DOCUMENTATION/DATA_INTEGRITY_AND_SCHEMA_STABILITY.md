# Data Integrity & Schema Stability

**Last Updated:** 2026-08-15  
**Status:** STABLE — Safe for production data

This document defines the architecture guardrails to ensure balance data remains safe during future updates.

---

## 🔒 Immutable Data: Opening Balances (1 Aug Baseline)

### Schema Stability (FROZEN)
The following tables and fields are **locked from breaking changes:**
- `ledgers.opening_balance` — initial balance imported on 1 Aug per contract
- `ledgers.is_opening_balanced` — flag marking balance as initialized
- `opening_balances_snapshot` — immutable snapshot table of every import batch

### Protection Mechanism
1. **Import Snapshot** — When you import balances via `/admin/opening-balances/import`:
   - Balance is stored in `ledgers.opening_balance` (local copy for speed)
   - Full snapshot recorded in `opening_balances_snapshot` (immutable audit trail)
   - `is_opening_balanced` flag set to `1` (marks as completed)

2. **Schema Migration Rule** — Any future change to balance storage:
   - Must NOT alter `opening_balance` field directly
   - Must NOT modify `opening_balances_snapshot` structure
   - Must create NEW fields (e.g., `opening_balance_v2`) if needed
   - Must write a migration script to preserve existing data

3. **API Contract** — These endpoints are FROZEN:
   - `POST /admin/opening-balances/import` — signature and behavior unchanged
   - `GET /admin/opening-balances/:contractId` — returns balances, summary, and snapshot

### Example: Safe Future Update
If you need to add a "currency" field to opening balances:

```sql
-- ❌ WRONG: Breaks existing data
ALTER TABLE ledgers MODIFY opening_balance REAL NOT NULL DEFAULT 0;

-- ✅ CORRECT: Non-breaking change
ALTER TABLE opening_balances_snapshot ADD COLUMN currency TEXT DEFAULT 'AED';
ALTER TABLE ledgers ADD COLUMN opening_balance_currency TEXT DEFAULT 'AED';
```

---

## 🧪 Sandbox Environment: Test Players

### Safe Testing
**Sandbox Players** are ephemeral test accounts created for:
- Testing balance import accuracy
- Verifying transaction flows
- Experimenting with features before production use

### Isolation Guarantee
When you delete a sandbox player:
- ✅ ALL transactions are cascade-deleted
- ✅ Ledger entries are wiped
- ✅ Opening balance snapshots are removed
- ✅ Auth records are purged
- ✅ Zero residual data remains

### Usage Pattern
```
1. Click "Create Test Player" (e.g., "Test Player A")
2. Import balances including the test player
3. Run transactions, verify calculations
4. Click "Delete & Reset" to wipe all test data
5. Production data is untouched
```

---

## 📋 Transaction Architecture: Forward-Safe

### Unified Ledger Pattern
All balance changes flow through `transactions` table with explicit types:
```
type ∈ {
  'contribution',      -- incoming money from player
  'charge',           -- game fee deducted
  'event_deduction',  -- external event (meal, venue) cost
  'transfer_out',     -- player sent money to another
  'transfer_in',      -- player received money from another
  'adjustment',       -- admin balance correction
}
```

### Why This Matters
- New transaction types can be added without breaking existing data
- Each type has a clear semantic meaning (no ambiguity)
- Audit trail is self-documenting
- Reports can filter by type without schema changes

### Safe: Adding a New Transaction Type
```sql
-- 1. Add new type to CHECK constraint
ALTER TABLE transactions DROP CONSTRAINT CHECK_type;
ALTER TABLE transactions ADD CONSTRAINT CHECK_type 
  CHECK (type IN ('contribution', 'charge', 'event_deduction', 'transfer_out', 'transfer_in', 'adjustment', 'refund'));

-- 2. Create handler function
function createRefundTransaction(playerId, contractId, amount, reason) {
  return db.insert('transactions', {
    type: 'refund',
    player_id: playerId,
    contract_id: contractId,
    amount: amount,
    description: reason,
    status: 'approved',
    created_at: now(),
  });
}
```

---

## 🛡️ Data Versioning: Multi-Version Modules

### Pattern: Dual Module Approach
For major changes, follow the V22/V23 pattern from Football AI:

```
existing code:  academy_stats_v22.js    (frozen, v22 only)
              academy_stats.js        (active, v23)

future:        academy_stats_v24.js    (if V24 needed)
              academy_stats.js        (upgraded to v24)
```

### Apply When
- Breaking schema changes needed
- API signature must change
- Core calculation logic incompatible with old data

### Example: If Balance Calculation Changes
```
Current:   ledgers.contributed, ledgers.charged, ledgers.present_balance
Future v2: ledgers_v2.total_movements, ledgers_v2.net_balance

Files:
  ledgers_repo.js         (v24: uses ledgers_v2 for new accounts)
  ledgers_repo_v23.js     (frozen: reads ledgers for old accounts)
```

---

## ✅ Checklist: Before Each Release

### Before Editing Shared Modules
- [ ] Check if Football AI v22 uses this module
- [ ] If yes: create `*_v23.js` frozen copy, don't edit the shared one
- [ ] If no: safe to edit (but still test sandbox first)

### Before Database Migrations
- [ ] Write migration as **additive only** (new columns, new tables)
- [ ] Never alter existing column types or constraints
- [ ] Never delete fields (mark deprecated instead)
- [ ] Test with sandbox players first

### Before API Changes
- [ ] New endpoint? Create new path (e.g., `/admin/opening-balances/v2/import`)
- [ ] Changing existing endpoint? Provide deprecation notice (3 release warning)
- [ ] Always bump version (e.g., `opening_balances.importBalances_v2`)

---

## 📊 Current Stable APIs

| API | Module | Status | Last Change |
|-----|--------|--------|-------------|
| POST /admin/opening-balances/import | opening_balances.js | ✅ STABLE | 2026-08-15 |
| GET /admin/opening-balances/:id | opening_balances.js | ✅ STABLE | 2026-08-15 |
| POST /admin/sandbox/players | sandbox_players.js | ✅ STABLE | 2026-08-15 |
| DELETE /admin/sandbox/players/:id | sandbox_players.js | ✅ STABLE | 2026-08-15 |

---

## 🚨 Red Flags: Risky Operations

**DO NOT:**
- Modify `opening_balances_snapshot` without migration
- Delete `opening_balance` field from `ledgers`
- Rename transaction types (add new ones instead)
- Cascade-delete from core tables without sandbox testing

**DO:**
- Test balance changes in sandbox first
- Write migration scripts for schema changes
- Document why you're changing data models
- Keep snapshot table indexed for fast audit trails
