# Game Accounting System — Complete Implementation Guide

**Status:** Backend complete, Frontend UI integrated  
**Last Updated:** 2026-08-15

## Overview

A comprehensive game accounting system that tracks:
- **Game Results:** Team scores, win/loss/draw
- **Financial Tracking:** Water costs (15 AED), kitty earned, provisional payments
- **Player History:** Win/loss/draw records per player
- **Club Accounting:** Revenue vs. expenses, profit tracking

## Architecture

### Database Schema

#### 1. `gameweeks` (Enhanced)
Added fields for game accounting:
- `scoreline` — Game score (e.g., "5-3")
- `teams_json` — Player team assignments
- `whatsapp_message` — Elaborate game context
- `game_cost` — Water/facility cost (default 15 AED)
- `game_cost_paid_by` — Who paid (player_id or 'self')
- `kitty_earned` — Money collected from players (±, provisional)

#### 2. `game_results` (NEW)
Stores team-level results (not individual):
```
id, gameweek_id, team_a_name, team_b_name, 
goals_team_a, goals_team_b, result (draw|a_wins|b_wins)
```

#### 3. `game_financing` (NEW)
Tracks money flows:
```
id, gameweek_id, contract_id, category (water_cost|kitty_collection),
payer_id, amount, status (provisional|settled), settled_at
```

### Backend Repositories

#### `gameResultsRepo` (game_results.js)
```javascript
create(db, gameweekId, teamAName, teamBName, goalsA, goalsB)
update(db, gameweekId, teamAName, teamBName, goalsA, goalsB)
getByGameweekId(db, gameweekId)
delete(db, gameweekId)
```

#### `gameFinancingRepo` (game_financing.js)
```javascript
create(db, gameweekId, contractId, category, payerId, amount)
settle(db, financingId)  // Mark provisional as received
getWaterCost(db, gameweekId)
getKittyCollected(db, gameweekId)
getPlayerProvisional(db, playerId, contractId)  // Money owed/due
```

### API Endpoints

All endpoints require admin authentication.

#### Record Game Accounting
```
POST /gameweeks/:id/accounting
Body: {
  scoreline: "5-3",
  teams_json: "[{player_id, team}, ...]",
  whatsapp_message: "...",
  team_a_name: "Red",
  team_b_name: "Blue",
  goals_team_a: 5,
  goals_team_b: 3,
  game_cost: 15,
  game_cost_paid_by: "self" | "<player_id>",
  kitty_earned: 50
}
Response: Full game object with results + financing
```

#### Record Water Cost
```
POST /gameweeks/:id/water-cost
Body: { payer_id, amount, notes }
Response: Financing record
```

#### Record Kitty
```
POST /gameweeks/:id/kitty
Body: { payer_id, amount, notes }
Response: Financing record
```

#### Settle Payment
```
POST /gameweeks/:id/financing/:financing_id/settle
Response: Updated game with financing
```

#### Get Full Game Data
```
GET /gameweeks/:id/full
Response: {
  ...gameweek,
  result: { team_a_name, goals_team_a, ... },
  financing: [{ category, payer_id, amount, status }, ...]
}
```

## Frontend

### Game Day Form (Updated)

#### New Fields (Below existing score/comments):

**Team Scores:**
- Team A Name (e.g., "Red", "Team 1")
- Team A Goals (number)
- Team B Name (e.g., "Blue", "Team 2")
- Team B Goals (number)

**Costs & Kitty:**
- Water Cost (AED, default 15)
- Who Paid Water Cost (dropdown: "Me (Vijay)" or player names)
- Kitty Earned (AED, can be +/-; provisional)

**Game Message:**
- Elaborate WhatsApp message (optional textarea)

### Form Workflow

1. **Parse teams** from WhatsApp
2. **Review charges** in preview
3. **Fill in game accounting:**
   - Set team names and final scores
   - Specify water cost and who paid
   - Record kitty earned
   - Add elaborate game message if needed
4. **Confirm & Deduct** — saves everything:
   - Creates gameweek with accounting fields
   - Records game result (Team A vs B, score)
   - Sends to `/gameweeks/:id/accounting` endpoint

## Testing Workflow

### Manual Test Case 1: Record a Game with Full Accounting

```bash
1. Navigate to Game Day
2. Paste sample teams (provided in form)
3. Click "Parse teams"
4. Fill in preview form:
   - Date: today
   - Score/Result: "5-3 win"
   - Team A: "Red" Goals: 5
   - Team B: "Blue" Goals: 3
   - Water Cost: 15 (default)
   - Who Paid: "Me"
   - Kitty: 50
   - Message: "Great game! Toby scored twice"
5. Click "Confirm & deduct balances"
6. Verify:
   - Game created with scoreline "5-3"
   - Teams recorded
   - Result shows Red won 5-3
   - Water cost: 15 AED (paid by self)
   - Kitty: 50 AED (provisional)
```

### Manual Test Case 2: Someone Else Paid Water Cost

```bash
1-3. Same as above
4. Fill form but set:
   - Who Paid: "Nihas" (from dropdown)
   - This records financing entry: Nihas paid 15 AED
   - Nihas can then settle this payment later
```

### Manual Test Case 3: View Game Accounting Later

```bash
1. Navigate to Game History
2. Click a game record
3. Verify:
   - Scoreline displays (5-3)
   - Team names show (Red vs Blue)
   - Result displays (Red wins)
   - Water cost shows who paid
   - Kitty amount visible
   - Game message visible if provided
```

## Business Logic: Money Tracking

### Example: Game with Kitty Shortfall

**Setup:**
- Water cost: 15 AED (you paid)
- Players collected: 40 AED (short 10)
- Kitty should be: -10 (provisional owed)

**Recording:**
```
Water Cost: 15, Paid by: self
Kitty Earned: -10 (you record what was actually collected minus cost)
```

**Later:**
- One player settles their share
- Mark payment as settled via `/gameweeks/:id/financing/:financing_id/settle`
- Status changes from "provisional" to "settled"

### Example: You Didn't Play (Collecting Money Only)

**Setup:**
- Water cost: 15 AED (someone else paying)
- Kitty collected: 150 AED from players
- Your net: 150 - 15 = 135 AED (club profit)

**Recording:**
```
Water Cost: 15, Paid by: "Nihas"
Kitty Earned: 150
Note: Club keeps 135, Nihas gets 15 back when settled
```

## Next Steps

### Phase 2: Player History & Reports

1. **Player Dashboard Tab:** Shows per-player:
   - W-L-D record per contract
   - Goals scored (team-level, not individual)
   - Date & opponent of each game
   - Team each player was on

2. **Club Accounting Dashboard:**
   - Total water costs paid by you
   - Total kitty collected
   - Club profit/loss per contract
   - Provisional payments due (pending settlement)

### Phase 3: Bulk Reporting

1. **Export:** Monthly summary of games, costs, kitty
2. **Analytics:** Trends in game participation, costs per venue
3. **Settlement Reports:** Who owes what from provisional games

## API Usage Example (cURL)

```bash
# After creating a game, record the full accounting
curl -X POST http://localhost:3100/api/gameweeks/{game_id}/accounting \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "scoreline": "5-3",
    "team_a_name": "Red",
    "team_b_name": "Blue",
    "goals_team_a": 5,
    "goals_team_b": 3,
    "game_cost": 15,
    "game_cost_paid_by": "self",
    "kitty_earned": 50,
    "whatsapp_message": "Great game today!"
  }'
```

## Known Limitations

1. **Goal attribution:** Goals tracked at team level only (not individual players)
   - Rationale: Avoids disputes, matches typical casual play recording

2. **Retroactive edits:** Can edit team scores/costs via API but no UI yet
   - Workaround: Use admin API or database directly

3. **Player history:** Not yet implemented in UI
   - Data is captured; need to build views in Phase 2

## Database Migrations

All migrations run automatically on server startup. To manually verify:

```bash
# Check if game_results table exists
sqlite3 data/fmss.db "SELECT name FROM sqlite_master WHERE type='table' AND name='game_results';"

# Check gameweeks columns
sqlite3 data/fmss.db "PRAGMA table_info(gameweeks);"
```

## Troubleshooting

### Forms don't capture team data

**Problem:** Team fields show but data not saved  
**Solution:** Ensure `/gameweeks/:id/accounting` endpoint receives data

### Water cost payer dropdown empty

**Problem:** Only showing "Me (Vijay)"  
**Solution:** Check that `store.players` is loaded before `initGameday()`

### Game result not created

**Problem:** Recorded game but no result in database  
**Solution:** Both `team_a_name` and `team_b_name` must be provided to create result

---

**Built:** August 15, 2026  
**Version:** 1.0 (MVP - Core accounting working)  
**Ready for:** Testing with real game data
