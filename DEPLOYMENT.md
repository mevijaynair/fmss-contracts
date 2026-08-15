# FMSS Deployment to DigitalOcean

**Date:** 2026-08-15  
**Version:** With Game Day Parser Enhancements + Kitty Opening Balance System

---

## Quick Deploy

### 1. SSH into DigitalOcean Droplet

```bash
ssh root@your-droplet-ip
cd /path/to/fmss-contracts  # wherever your app is deployed
```

### 2. Pull Latest Code

```bash
git pull origin main
```

This brings in:
- Enhanced Game Day parser (smart player recognition)
- Outside player handling (relationship deduction)
- Kitty opening balance system (per-contract tracking)

### 3. Install Dependencies (if needed)

```bash
npm install
```

### 4. Run Migrations

```bash
# The app auto-runs migrations on startup, but verify:
node server/db.js
```

Migrations that run automatically:
- `kitty_opening_balance` table (one-time entry per contract)
- Existing tables already in place

### 5. Restart App

```bash
# If using systemd
systemctl restart fmss

# If using PM2
pm2 restart fmss

# If running manually
npm start
```

### 6. Verify Deployment

```bash
# Check server is running
curl http://localhost:3100/api/me -H "Authorization: Bearer your-token"

# Test new kitty endpoint
curl http://localhost:3100/api/admin/kitty-summary -H "Authorization: Bearer your-token"
```

---

## What Was Deployed

### 1. Enhanced Game Day Parser
**Files:**
- `server/parser.js` — Smart player recognition with aliasing
- `public/js/modules/gameday.js` — On-the-fly mapping + outside player prompts

**Features:**
- Auto-map single-match player suggestions
- Prompt for multiple matches
- Detect outside players automatically
- Choose handling type (relationship deduction vs direct payment)
- All results editable before confirmation

### 2. Kitty Opening Balance System
**Files:**
- `server/db.js` — New `kitty_opening_balance` table
- `server/repos/kitty_opening_balance.js` — Complete repository
- `server/routes/index.js` — 6 new API endpoints

**Features:**
- One-time opening balance per contract (locked, immutable)
- Single-line income/expense entries (auto-categorized by contract_id)
- Clean balance calculation: opening + income - expense
- Per-contract view + summary across all contracts
- Full activity log with dates and labels

---

## Testing on DigitalOcean

### Test 1: Kitty Opening Balance

```bash
# Set opening for Sat contract
curl -X POST http://your-server/api/admin/contracts/sat/kitty-opening \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "opening_amount": 2734,
    "snapshot_date": "2026-08-08",
    "notes": "From Excel sheet"
  }'

# Get opening
curl http://your-server/api/admin/contracts/sat/kitty-opening \
  -H "Authorization: Bearer $TOKEN"

# Get balance
curl http://your-server/api/admin/contracts/sat/kitty-balance \
  -H "Authorization: Bearer $TOKEN"

# Expected response:
{
  "contract_id": "sat",
  "opening_amount": 2734,
  "snapshot_date": "2026-08-08",
  "total_income": 0,
  "total_expense": 0,
  "present_balance": 2734
}
```

### Test 2: Add Kitty Entry

```bash
# Add income entry
curl -X POST http://your-server/api/kitty \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "income",
    "label": "Jersey Revenue 2025",
    "amount": 1078,
    "date": "2025-01-15",
    "scope": "sat"
  }'

# Check updated balance
curl http://your-server/api/admin/contracts/sat/kitty-balance \
  -H "Authorization: Bearer $TOKEN"

# Expected: total_income now 1078, present_balance = 3812
```

### Test 3: Game Day Parser

In the web UI:
1. Go to **Game Day** tab
2. Paste a WhatsApp team message (e.g., "🔴 Vijay Prem Toby 🔵 Jithin Kartik")
3. Click "Parse teams"
4. Verify:
   - Known players auto-matched ✓
   - Unknown players prompt for mapping ✓
   - Outside players flagged ✓
   - All results editable ✓

### Test 4: Kitty Summary

```bash
curl http://your-server/api/admin/kitty-summary \
  -H "Authorization: Bearer $TOKEN"

# Expected: summary across all contracts
{
  "by_contract": [
    {
      "contract_id": "sat",
      "opening_amount": 2734,
      "total_income": 1078,
      "total_expense": 0,
      "present_balance": 3812
    }
  ],
  "summary": {
    "total_opening": 2734,
    "total_income": 1078,
    "total_expense": 0,
    "total_present": 3812
  }
}
```

---

## Rollback (if needed)

```bash
# Go back to previous commit
git revert HEAD~2  # revert last 2 commits
git push origin main

# Or reset to previous state
git reset --hard HEAD~2
git push origin main --force  # CAREFUL: only if necessary
```

---

## New Database Tables

Auto-created on first run:

### `kitty_opening_balance`
- One row per contract
- Locked at snapshot date
- Immutable opening_amount

```sql
CREATE TABLE kitty_opening_balance (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL UNIQUE,
  snapshot_date TEXT NOT NULL,
  opening_amount REAL NOT NULL,
  imported_by TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  notes TEXT
);
```

---

## Debugging

### Check Migrations Ran

```bash
# SSH into server
sqlite3 /path/to/fmss.db ".tables" | grep kitty_opening_balance

# Should see: kitty_opening_balance
```

### Check Server Logs

```bash
# If using systemd
journalctl -u fmss -f

# If using PM2
pm2 logs fmss

# If running in terminal
# (you'll see logs directly)
```

### Test Database Connection

```bash
curl http://your-server/api/admin/kitty-summary \
  -H "Authorization: Bearer $TOKEN"

# Should return kitty summary without error
```

---

## Performance Notes

- Game Day parser uses optimized fuzzy matching (1-edit distance max)
- Kitty balance queries are indexed on contract_id
- All calculations are in-memory (fast)
- No impact on existing systems

---

## Support

If anything breaks:

1. **Check git log:**
   ```bash
   git log --oneline -5
   ```

2. **Check database:**
   ```bash
   sqlite3 data/fmss.db ".schema" | grep kitty_opening_balance
   ```

3. **Check API:**
   ```bash
   curl http://localhost:3100/api/admin/kitty-summary -H "Authorization: Bearer $TOKEN"
   ```

4. **Rollback if needed:**
   ```bash
   git reset --hard HEAD~2
   npm start
   ```

---

**Deployment Date:** 2026-08-15  
**Commits:** 13 (main: enhanced parser + kitty system)  
**Status:** Ready to deploy
