# Player Relationships & Club Accounting System

**Status:** Backend complete, Ready for frontend dashboard development  
**Last Updated:** 2026-08-15  
**Version:** 1.0

---

## Overview

A comprehensive system for managing:
- **Outside Players:** Players introduced by regulars, charged 35-40 AED (introduced player deducted, introducer credited)
- **Shared Balances:** Multiple players linked to one balance (e.g., Aws & Ali as brothers = 1 shared balance)
- **Bank Transfers:** Move credits between players to settle outside player earnings
- **Clear Accounting:** Every transaction visible with full context for settlement

---

## Architecture

### Database Schema

#### 1. `players` (Enhanced)
Added fields:
- `introduced_by` — Player ID of who brought this player in (FK to players.id)
- `player_type` — 'regular' | 'outside'
- `outside_cost` — Cost when outside player is charged (35 or 40 AED)
- `balance_group_id` — Links to `player_balance_groups` for shared balances

#### 2. `player_balance_groups` (NEW)
Manages shared balance groups:
```
id, group_name ("Aws & Ali"), contract_id, description, created_at
```

#### 3. `transactions` (Enhanced)
Now tracks:
- Outside player charges & introducer credits
- Bank transfers between players
- Related_player_id for transfers (from → to)

### Key Repositories

#### `playerRelationshipsRepo`
```javascript
markOutside(db, playerId, introducedById, cost = 35)
markRegular(db, playerId)
createBalanceGroup(db, contractId, groupName, playerIds, description)
getBalanceGroup(db, groupId) → { id, groupName, players: [...] }
shareBalance(db, playerId1, playerId2) → boolean
```

#### `outsidePlayersRepo`
```javascript
recordOutsidePlayerCharge(db, gameweekId, contractId, outsideId, introducerId, cost)
  → { debitId, creditId }  // Auto-debit outside, auto-credit introducer

getIntroducerSummary(db, introducerId, contractId)
  → { outside_players_brought, games_participated, total_credits_earned }

getPlayersIntroduced(db, introducerId, contractId)
  → [{ id, name, outside_cost, games_played }, ...]

recordBankTransfer(db, fromId, toId, contractId, amount, description)
  → { debitId, creditId }
```

#### `ledgersRepo` (Enhanced)
```javascript
getGroupBalance(contractId, balanceGroupId)
  → { members: [...], combined_opening_balance, combined_charged, combined_present_balance }

getAllGroupBalances(contractId)
  → [{ balance_group_id, members: [...], combined_present_balance }, ...]
```

---

## API Endpoints

All endpoints require `Authorization: Bearer $TOKEN` (admin only).

### Player Relationship Management

#### Mark player as outside
```
POST /admin/players/:playerId/mark-outside
Body: { introduced_by: "vijay", cost: 35 }
Response: { ok: true }
```

#### Mark player as regular
```
POST /admin/players/:playerId/mark-regular
Response: { ok: true }
```

#### Get outside players for contract
```
GET /admin/contracts/:contractId/outside-players
Response: [{ id, name, player_type: "outside", introduced_by, outside_cost }, ...]
```

### Shared Balance Groups

#### Create balance group (Aws & Ali)
```
POST /admin/contracts/:contractId/balance-groups
Body: {
  group_name: "Aws & Ali",
  player_ids: ["aws-id", "ali-id"],
  description: "Brothers - shared balance"
}
Response: { id: "bg_...", groupName, playerIds, contractId }
```

#### Get group details
```
GET /admin/balance-groups/:groupId
Response: {
  id, group_name, contract_id,
  players: [{ id, name }, ...]
}
```

#### Get group combined balance
```
GET /admin/contracts/:contractId/balance-groups/:groupId/balance
Response: {
  balance_group_id, contract_id,
  members: [
    { player_id, player_name, opening_balance, contributed, charged, individual_balance },
    { player_id, player_name, opening_balance, contributed, charged, individual_balance }
  ],
  combined_opening_balance: 100,
  combined_contributed: 50,
  combined_charged: 30,
  combined_present_balance: 120
}
```

### Outside Player Transactions

#### Record outside player charge
```
POST /gameweeks/:gameweekId/outside-player-charge
Body: {
  outside_player_id: "newbie-id",
  introducer_id: "vijay",
  cost: 35
}
Response: { debitId, creditId }

Creates TWO transactions automatically:
1. Debit: newbie-id -35 AED (charge)
2. Credit: vijay +35 AED (introducer credit)
```

#### Get outside player charges for a game
```
GET /gameweeks/:gameweekId/outside-player-charges
Response: [
  {
    id, player_id, player_name, amount,
    type: "charge", description: "Outside player charge (introduced by Vijay)",
    introducer_name: "Vijay", created_at
  },
  ...
]
```

#### Get introducer summary
```
GET /admin/players/:playerId/introducer-summary?contract_id=sat
Response: {
  introducer_id: "vijay",
  outside_players_brought: 3,
  games_participated: 5,
  total_credits_earned: 105  // 3 × 35 AED
}
```

### Bank Transfers

#### Transfer credits (settle outside player earnings)
```
POST /admin/contracts/:contractId/bank-transfer
Body: {
  from_player_id: "vijay",      // Who's paying
  to_player_id: "prem",          // Who's receiving
  amount: 105,
  description: "Settlement for outside players brought"
}
Response: { debitId, creditId }

Creates TWO transactions:
1. Debit: vijay -105 (transfer_out)
2. Credit: prem +105 (transfer_in, related_player_id: vijay)
```

### Club Accounting Summary

#### Get full accounting view
```
GET /admin/contracts/:contractId/accounting-summary
Response: {
  contract_id: "sat",
  introducers: [
    {
      introducer_id: "vijay", introducer_name: "Vijay",
      outside_players_brought: 3,
      games_participated: 5,
      total_credits_earned: 105
    },
    ...
  ],
  shared_balances: [
    {
      balance_group_id: "bg_aws_ali",
      members: [
        { player_id: "aws", player_name: "Aws", individual_balance: 50 },
        { player_id: "ali", player_name: "Ali", individual_balance: 70 }
      ],
      combined_present_balance: 120
    },
    ...
  ],
  total_water_costs: 180,        // Sum of all game_cost (water costs paid by you)
  total_kitty_earned: 200,       // Sum of all kitty_earned
  net_club_position: 20          // kitty - costs
}
```

---

## Business Logic Examples

### Example 1: Newbie Joins (Outside Player)

**Setup:**
- Prem brings his friend Roshan to play
- Roshan is charged 35 AED (not a regular)
- Prem gets credited 35 AED (for introducing)

**Recording:**
```bash
1. Mark Roshan as outside:
   POST /admin/players/roshan/mark-outside
   { introduced_by: "prem", cost: 35 }

2. On game day, when recording charges:
   POST /gameweeks/{gameId}/outside-player-charge
   { outside_player_id: "roshan", introducer_id: "prem", cost: 35 }

Result:
- Roshan balance: -35 (charged)
- Prem balance: +35 (introducer credit)
```

### Example 2: Aws & Ali (Shared Balance)

**Setup:**
- Aws and Ali are brothers with shared finances
- Want one balance that reflects both
- Both can be charged individually
- Balance shows combined total

**Recording:**
```bash
1. Create shared balance group:
   POST /admin/contracts/sat/balance-groups
   {
     group_name: "Aws & Ali",
     player_ids: ["aws-id", "ali-id"],
     description: "Brothers sharing finances"
   }

2. When Aws plays:
   - Regular game day parsing charges Aws 50 AED
   - Aws's contribution: -50

3. When Ali plays:
   - Ali is charged 50 AED
   - Ali's contribution: -50

4. Check combined balance:
   GET /admin/contracts/sat/balance-groups/bg_aws_ali/balance
   
   Returns:
   - Aws: -50
   - Ali: -50
   - Combined: -100
```

### Example 3: Settlement (Bank Transfer)

**Setup:**
- Vijay brought 3 outside players over the season
- Total earnings: 105 AED (3 × 35)
- Now settling with Prem (who co-manages)

**Recording:**
```bash
POST /admin/contracts/sat/bank-transfer
{
  from_player_id: "vijay",
  to_player_id: "prem",
  amount: 105,
  description: "Settlement for 3 outside players brought"
}

Result:
- Vijay balance: -105 (transfer_out)
- Prem balance: +105 (transfer_in)
- Clear audit trail shows settlement
```

### Example 4: Introducer Summary

**Check who brought outside players:**
```bash
GET /admin/players/vijay/introducer-summary?contract_id=sat

Returns:
{
  introducer_id: "vijay",
  outside_players_brought: 3,
  games_participated: 5,
  total_credits_earned: 105  // 3 × 35 AED earned
}

Meaning:
- Vijay brought 3 outside players
- They participated in 5 games total
- Vijay earned 105 AED from introductions
```

---

## Transaction Visibility

All transactions stored with full context:

```
Transaction Example:
{
  id: "txn_...",
  player_id: "prem",
  amount: +35,
  type: "contribution",
  description: "Outside player credit (Roshan charge)",
  game_id: "gw_...",
  created_at: "2026-08-15T...",
  status: "approved"
}

Readable as:
"Prem received +35 AED on 2026-08-15 (Outside player credit: Roshan was charged)"
```

---

## Frontend Dashboard (TODO)

The backend is complete. Frontend needs:

### 1. **Player Setup Panel**
- [ ] List all players with filters (regular / outside)
- [ ] Mark as outside (dropdown for introducer, cost 35/40)
- [ ] Create shared balance groups (Aws & Ali)
- [ ] Edit relationships

### 2. **Outside Players View**
- [ ] List outside players with introducer + cost
- [ ] Show introducer earnings summary
- [ ] Settlement history

### 3. **Shared Balances View**
- [ ] List balance groups
- [ ] Show combined balance + individual breakdowns
- [ ] Transaction history for each group

### 4. **Club Accounting Dashboard**
- [ ] Summary card: Total water costs, total kitty, net position
- [ ] Introducer earnings table (name, players brought, earnings, settlement status)
- [ ] Shared balance groups summary
- [ ] All transactions timeline with full context

### 5. **Settlement Workflow**
- [ ] Bank transfer UI (from → to, amount, description)
- [ ] Settlement history showing who paid whom
- [ ] Reconciliation checklist

---

## Testing Workflow

### Setup Test Data
```bash
1. Create contract "sat"

2. Create players:
   - vijay (regular)
   - prem (regular, brings outside players)
   - aws, ali (brothers for shared balance)
   - roshan, shone, sikku (outside players)

3. Mark outside players:
   POST /admin/players/roshan/mark-outside
   { introduced_by: "prem", cost: 35 }
   
   POST /admin/players/shone/mark-outside
   { introduced_by: "prem", cost: 35 }
   
   POST /admin/players/sikku/mark-outside
   { introduced_by: "vijay", cost: 40 }

4. Create shared balance group:
   POST /admin/contracts/sat/balance-groups
   {
     group_name: "Aws & Ali",
     player_ids: ["aws", "ali"],
     description: "Brothers"
   }
```

### Test Outside Player Flow
```bash
1. Record a game with outside players:
   POST /gameweeks/{gw_id}/outside-player-charge
   { outside_player_id: "roshan", introducer_id: "prem", cost: 35 }
   
   Verify:
   - Roshan: -35
   - Prem: +35 (credit for introduction)

2. Check introducer summary:
   GET /admin/players/prem/introducer-summary?contract_id=sat
   
   Should show: brought 1 player, earned 35 AED
```

### Test Settlement
```bash
1. After multiple games with outside players:
   GET /admin/players/prem/introducer-summary?contract_id=sat
   → Shows total earned (e.g., 105 AED)

2. Settle with bank transfer:
   POST /admin/contracts/sat/bank-transfer
   { from_player_id: "prem", to_player_id: "vijay", amount: 105, description: "Settlement" }

3. Check balances:
   - Prem: Should be -105 (transferred out)
   - Vijay: Should be +105 (transferred in)
```

### Test Shared Balances
```bash
1. Record Aws playing in game 1:
   - Aws charged 50 AED

2. Record Ali playing in game 2:
   - Ali charged 50 AED

3. Check combined balance:
   GET /admin/contracts/sat/balance-groups/bg_aws_ali/balance
   
   Should show:
   - Aws individual: -50
   - Ali individual: -50
   - Combined: -100
```

---

## Integration with Game Day Flow

When recording a game with outside players:

```
Game Day Flow:
1. Parse teams from WhatsApp
2. For each outside player in charges:
   POST /gameweeks/{gw_id}/outside-player-charge
   Auto-debit outside, auto-credit introducer
3. Regular players charged normally
4. Shared balance groups show combined totals

Results:
- Transactions are atomic
- Audit trail is complete
- Balances update automatically
```

---

## API Usage Examples (cURL)

### Mark player as outside
```bash
curl -X POST http://localhost:3100/api/admin/players/roshan/mark-outside \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"introduced_by": "prem", "cost": 35}'
```

### Create shared balance group
```bash
curl -X POST http://localhost:3100/api/admin/contracts/sat/balance-groups \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "group_name": "Aws & Ali",
    "player_ids": ["aws-id", "ali-id"],
    "description": "Brothers sharing balance"
  }'
```

### Record outside player charge
```bash
curl -X POST http://localhost:3100/api/gameweeks/gw_id/outside-player-charge \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "outside_player_id": "roshan",
    "introducer_id": "prem",
    "cost": 35
  }'
```

### Get club accounting summary
```bash
curl http://localhost:3100/api/admin/contracts/sat/accounting-summary \
  -H "Authorization: Bearer $TOKEN"
```

---

## Known Limitations

1. **Bulk outside player creation:** Currently mark one at a time; could add batch endpoint
2. **Group membership changes:** Once in a group, must be manually moved (no automatic rebalancing)
3. **Cost adjustments:** Outside costs don't change retroactively (would need manual adjustments)
4. **No UI yet:** All features are API-only; frontend dashboard needed

---

## Database Query Examples

### Get introducer's earnings breakdown
```sql
SELECT
  (SELECT name FROM players WHERE id = ?) as introducer,
  COUNT(DISTINCT p.id) as outside_players_brought,
  COUNT(DISTINCT t.game_id) as games_where_they_played,
  SUM(CASE WHEN t.type = 'contribution' THEN t.amount ELSE 0 END) as total_credits
FROM players p
LEFT JOIN transactions t ON t.player_id = ? AND t.description LIKE '%Outside player credit%'
WHERE p.introduced_by = ? AND p.player_type = 'outside';
```

### Get shared balance group status
```sql
SELECT
  pg.group_name,
  p.id, p.name,
  l.opening_balance,
  (SELECT SUM(amount) FROM transactions WHERE player_id = p.id AND type = 'contribution') as contributed,
  (SELECT SUM(amount) FROM transactions WHERE player_id = p.id AND type = 'charge') as charged,
  (l.opening_balance + COALESCE((SELECT SUM(amount) FROM transactions WHERE player_id = p.id), 0)) as balance
FROM player_balance_groups pg
JOIN players p ON p.balance_group_id = pg.id
JOIN ledgers l ON l.player_id = p.id
WHERE pg.group_name = 'Aws & Ali'
ORDER BY p.name;
```

---

**Built:** August 15, 2026  
**Version:** 1.0 (Core system complete)  
**Next:** Frontend dashboard with clear line-item accounting
