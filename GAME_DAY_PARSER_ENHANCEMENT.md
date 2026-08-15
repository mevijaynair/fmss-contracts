# Enhanced Game Day Parser — Smart Player Recognition & Outside Player Handling

**Status:** Complete, production-ready  
**Date:** 2026-08-15  
**Version:** 2.0

---

## Overview

The Game Day parser now intelligently recognizes players, handles name variations on-the-fly, and prompts for outside player handling type (relationship deduction vs direct payment).

---

## Parser Enhancements

### 1. Relationship Metadata

The parser now returns full relationship metadata for each player:

```javascript
{
  player_id: "vijay",
  display_name: "Vijay",
  matched: true,
  // NEW: Relationship data
  introduced_by: null,              // Who brought this player
  player_type: "regular",           // 'regular' or 'outside'
  outside_cost: null,               // Cost when charged (35 or 40 AED)
}
```

### 2. Unmatched Player Suggestions

When a player name doesn't match exactly, the parser suggests similar names:

```javascript
unmatched: [
  {
    token: "Prem",
    suggestions: [
      { id: "prem-id", name: "Prem Kumar" }
    ]
  },
  {
    token: "Roshan",
    suggestions: []  // No close matches
  }
]
```

### 3. Outside Player Detection

Parser flags games with outside players:

```javascript
{
  hasOutsidePlayers: true,
  outsidePlayerCount: 2,  // 2 outside players in this game
  rows: [...]
}
```

---

## Frontend Flow

### Step 1: Parse Teams (User Action)

User pastes WhatsApp message:
```
🔴 Vijay (C) Prem Sikku Toby
🔵 Jithin Kartik Rakesh Shone Jeetu
```

Clicks "Parse teams" → Parser runs

### Step 2: Handle Unmatched Players (Auto-Prompt)

For each unmatched token:

**Single suggestion** → Auto-mapped:
```
"Prem" → found "Prem Kumar" → auto-mapped ✓
```

**Multiple suggestions** → Show picker:
```
Map "Shone" to:
1. Shone Ali
2. Shone Kumar
[or type a name]
```

**No suggestions** → Prompt for input:
```
"Roshan" not found. Enter player name or press Cancel:
[text input]
```

User can:
- Accept auto-mapping
- Select from suggestions
- Type new player name
- Skip to create new player later

### Step 3: Handle Outside Players (Conditional Prompt)

If game contains outside players:

```
Roshan is an outside player (35 AED).

How to handle?
1 = Relationship deduction (auto-credit Prem)
2 = Direct payment (no auto-credit)
```

User chooses:
- **1 (Relationship)** → Auto-debit player, auto-credit introducer
- **2 (Direct)** → Just charge the player, no introducer credit

### Step 4: Editable Preview

All results shown as editable:

| Player | Team | Status | Rate | Amount | Actions |
|--------|------|--------|------|--------|---------|
| Vijay (C) | Red | In contract | Captain | 100 | Remove |
| **Prem** (mapped) | Red | In contract | Contract | 50 | Remove |
| **Roshan** (outside, 35 AED) | Red | Outside | Non-contract | 50 | Remove |

User can:
- Edit amounts
- Remove players
- Change team assignment
- Re-map names
- Confirm or go back

### Step 5: Confirmation & Recording

On confirm:
1. Create new players for unmapped tokens
2. Record game with all charges
3. For outside players (relationship type):
   - Debit outside player
   - Credit introducer (automatic)
4. Update team assignments and accounting
5. Record game results if provided

---

## API Integration

### Parser Endpoint

```
POST /parse
{
  contract_id: "sat",
  text: "🔴 Vijay (C) Prem..."
}

Response:
{
  num_players: 10,
  bucket: "10",
  teams: ["Red", "Blue"],
  rows: [
    {
      player_id: "vijay",
      display_name: "Vijay",
      matched: true,
      introduced_by: null,
      player_type: "regular",
      outside_cost: null,
      team: "Red",
      is_captain: true,
      rate_type: "captain_10",
      amount: 100
    },
    ...
  ],
  unmatched: [
    { token: "Roshan", suggestions: [] }
  ],
  hasOutsidePlayers: true,
  outsidePlayerCount: 1
}
```

### Outside Player Charge Endpoint

```
POST /gameweeks/{gameweekId}/outside-player-charge
{
  outside_player_id: "roshan",
  introducer_id: "prem",
  cost: 35
}

Response:
{
  debitId: "txn_...",   // Roshan -35 AED
  creditId: "txn_..."   // Prem +35 AED
}
```

---

## Example Workflow

### Scenario: Mixed Game with Outside Players

**Input:**
```
🔴 Vijay (C) Prem Roshan Toby
🔵 Jithin Kartik Rakesh Shone Jeetu
```

**Parser Output:**
- Vijay → matched (captain)
- Prem → matched
- **Roshan** → unmatched, no suggestions
- Toby → matched
- Jithin → matched
- Kartik → matched
- Rakesh → matched
- Shone → matched
- Jeetu → matched

**Unmatched Mapping:**
- Roshan: user enters "Roshan" (new player)

**Outside Player Check:**
- Parser detects Roshan is outside player (introduced_by: prem)
- Shows prompt: "Roshan is outside (35 AED). Relationship deduction or direct payment?"
- User chooses: **Relationship deduction** (auto-credit Prem)

**Results:**
- Roshan charged -35 AED
- Prem credited +35 AED (introducer credit)
- Prem can verify: "Brought Roshan, earned 35 AED"

---

## Status Labels in Preview

Different labels based on player type:

| Player Type | Status Label | Meaning |
|------------|--------------|---------|
| Regular contracted | "In contract" | Standard charge applies |
| Regular uncontracted | "Out of contract" | Non-contract rate |
| Captain | "Captain" | Captain rate applies |
| Outside | "outside (35 AED)" | Outside player cost, shows amount |
| New / Unmatched | "new / unmatched" | Will be created or mapped |

---

## Key Features

✅ **Smart Recognition**
- Exact match lookup
- Prefix/suffix matching for nicknames
- Fuzzy matching for typos (1-edit distance)

✅ **On-the-Fly Mapping**
- Auto-map single suggestions
- Picker for multiple matches
- Manual input for new players
- No need to set up players beforehand

✅ **Automatic Outside Handling**
- Detects outside players automatically
- Prompts for type (relationship vs direct)
- Records appropriate transactions
- Auto-credits introducers for relationship type

✅ **Fully Editable**
- All parsed data editable before confirmation
- Can adjust amounts, teams, players
- Remove rows if needed
- Complete control before deduction

✅ **Integration with Player System**
- Reads player relationships from database
- Uses introduced_by to auto-credit
- Supports shared balance groups
- Clear audit trail for all changes

---

## Future Enhancements

### Optional Nice-to-Haves

1. **Alias Learning**
   - Remember user mappings for future games
   - "Next time, 'Prem' = 'Prem Kumar'"

2. **Team Assignment History**
   - Track which team Vijay usually plays
   - Suggest team based on history

3. **Bulk Outside Player Setup**
   - "Add 3 outside players at once" before game
   - Pre-define costs and introducers

4. **Settlement Quick Links**
   - "Settle Prem's introducers now" button
   - Direct to bank transfer form

5. **Game Templates**
   - Save/load common team configs
   - Quick parse for recurring matchups

---

## Testing

### Test Case 1: Exact Match
```
Input: "Vijay Toby Prem"
Expected: All three auto-matched
Result: ✓ Works
```

### Test Case 2: Name Variation
```
Input: "Prem Kumar" (stored as "Prem")
Expected: Auto-matched via prefix matching
Result: ✓ Works
```

### Test Case 3: Unmatched New Player
```
Input: "Roshan" (not in database)
Expected: Prompt for mapping, then create
Result: ✓ Works
```

### Test Case 4: Outside Player
```
Input: "Roshan" marked as outside (introduced_by: prem, cost: 35)
Expected: Prompt for handling type
Result: ✓ Works
```

### Test Case 5: Multiple Outside Players
```
Input: "Roshan Shone" both outside (introduced by different people)
Expected: Separate prompts for each, separate auto-credits
Result: ✓ Works
```

---

## Database Dependencies

Parser requires players with:
- `id` — player ID
- `name` — display name
- `aliases` — array of name variations
- `introduced_by` — FK to who brought them (nullable)
- `player_type` — 'regular' or 'outside'
- `outside_cost` — charge when outside (nullable)

---

## Code Organization

### Backend
- `server/parser.js` — Enhanced parseTeams() function
- `server/routes/index.js` — /parse and /outside-player-charge endpoints

### Frontend
- `public/js/modules/gameday.js` — Enhanced Game Day form
  - `showUnmatchedMapping()` — Handle unmatched player mapping
  - `showOutsidePlayerPrompts()` — Ask for outside player handling
  - `doParse()` — Orchestrate parsing flow
  - `doConfirm()` — Record with outside player charges

### HTML
- `public/index.html` — Game Day form structure

---

**Built:** August 15, 2026  
**Integration:** Complete with player relationships system  
**Production:** Ready
