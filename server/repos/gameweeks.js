// gameweeks.js — match records + their per-player charges (+ edit with audit trail).
import { db } from '../db.js';
import { ledgersRepo } from './ledgers.js';
import { auditRepo } from './audit.js';
import { gameResultsRepo } from './game_results.js';


const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Write one derived kitty row, or remove it if it nets to nothing.
 *
 * The kitty stores sign in `kind` and magnitude in `amount`, so a net loss is
 * an expense rather than a negative income. Every game-derived row carries the
 * gameweek id in `scope`, which is what lets deleting a game take its kitty
 * entries with it — kitty has no foreign key to cascade on.
 *
 * Deletes first, always: that makes every caller idempotent, so recomputing
 * twice, or toggling a collection on and off, can never leave a duplicate or a
 * stale row behind.
 */
function writeKittyRow(id, net, label, date, scope) {
  db.prepare('DELETE FROM kitty WHERE id = ?').run(id);
  const amount = round2(Math.abs(net));
  if (amount < 0.01) return;
  db.prepare(`INSERT INTO kitty (id,kind,label,amount,date,scope,historical,created_at)
              VALUES (?,?,?,?,?,?,0,?)`)
    .run(id, net > 0 ? 'income' : 'expense', label, amount,
      date || new Date().toISOString().slice(0, 10), scope || '',
      new Date().toISOString());
}

/**
 * One guest's cash, in or out of the kitty, keyed to the charge that owes it.
 *
 * An out-of-contract player hands over cash rather than drawing on a prepaid
 * balance, so the money genuinely arrives in the club's hands only when it is
 * collected. A contract player's charge was already funded by their balance,
 * so settling it moves nothing and belongs in the game's own entry instead.
 *
 * Safe to call for a charge that no longer exists — it clears the row and stops,
 * which is what removing a player from a game needs.
 */
function syncGuestCashToKitty(chargeId) {
  const row = db.prepare(`SELECT ch.*, g.date AS game_date, g.historical,
      COALESCE(p.player_type,'regular') AS payer_type, p.name AS payer_name
    FROM charges ch
    JOIN gameweeks g ON g.id = ch.gameweek_id
    LEFT JOIN players p ON p.id = COALESCE(ch.charged_to, ch.player_id)
    WHERE ch.id = ?`).get(chargeId);
  const kittyId = `k_charge_${chargeId}`;
  if (!row) { db.prepare('DELETE FROM kitty WHERE id = ?').run(kittyId); return; }

  const amount = row.historical || !row.paid || row.payer_type !== 'outside'
    ? 0 : Number(row.amount) || 0;
  writeKittyRow(kittyId, amount,
    `${row.payer_name || 'Guest'} paid for the game on ${row.game_date}`,
    row.game_date, row.gameweek_id);
}

/**
 * Rebuild every kitty entry this game owes, from the charges as they stand now.
 *
 * The kitty used to be committed by a confirm() dialog in the browser *after*
 * the game had already been saved, so declining it — or closing the tab, or any
 * error in between — left a committed game whose money never reached the pot.
 * Deriving the entries here instead means there is no window in which the two
 * can disagree: whatever the charges say, the kitty says.
 *
 * Two kinds of row, because the money arrives at two different times. Contract
 * charges are funded from balances the club already holds, so they land with
 * the game, net of the pitch and the water. Guest cash lands when the guest
 * actually hands it over, which is usually later. Their sum is the game's true
 * profit once everyone has settled.
 *
 * Historical games are left alone: they are already inside the opening snapshot,
 * and crediting them again would count that money twice.
 */
function recomputeGameKitty(gameweekId) {
  const gw = db.prepare('SELECT * FROM gameweeks WHERE id = ?').get(gameweekId);
  if (!gw) return;

  const charges = db.prepare(`SELECT ch.id, ch.amount,
      COALESCE(p.player_type,'regular') AS payer_type
    FROM charges ch LEFT JOIN players p ON p.id = COALESCE(ch.charged_to, ch.player_id)
    WHERE ch.gameweek_id = ?`).all(gameweekId);

  let contracted = 0;
  for (const ch of charges) {
    if (ch.payer_type === 'outside') syncGuestCashToKitty(ch.id);
    else contracted += Number(ch.amount) || 0;
  }
  // A game that becomes historical — pulled behind a closed baseline — must give
  // its entry back rather than keep it. Writing zero is how that row is removed,
  // so the check lands here and not as an early return that leaves it standing.
  const pitch = Number(gw.cost_per_gw) || 0;
  // Water comes off the pot only when the pot bought it. When a player buys it
  // they are credited a contribution for the same amount — the club owes them
  // instead — so taking it off the kitty as well would charge the club twice for
  // one bottle run: once in cash that never left, and again as a debt to the
  // player. Who paid changes where the cost lands, not how much it was.
  const payer = gw.game_cost_paid_by || 'self';
  const water = payer === 'self' ? Number(gw.game_cost) || 0 : 0;
  writeKittyRow(`k_gw_${gameweekId}`,
    gw.historical ? 0 : round2(contracted - pitch - water),
    `Game on ${gw.date}: charged ${round2(contracted)} less pitch ${pitch}`
    + (water ? ` and water ${water}` : ''),
    gw.date, gameweekId);
}

export const gameweeksRepo = {
  // Exposed for the one-off reconcile script, which rebuilds the pot from games
  // that predate the derived entries.
  recomputeGameKitty,
  all(contractId) {
    const sql = contractId
      ? 'SELECT * FROM gameweeks WHERE contract_id = ? ORDER BY date DESC, gw_number DESC'
      : 'SELECT * FROM gameweeks ORDER BY date DESC';
    const rows = contractId ? db.prepare(sql).all(contractId) : db.prepare(sql).all();
    if (!rows.length) return rows;

    // One aggregate query for every gameweek in this result, instead of the
    // four per-row queries (chargeTotal/chargeCount/paidCount/pendingAmount)
    // this used to run for each row — that was 4N queries for N gameweeks,
    // paid even by callers (import-duplicate-detection, contract summaries)
    // that never read paid_count/pending_amount at all.
    const ids = rows.map(g => g.id);
    const placeholders = ids.map(() => '?').join(',');
    // What is still outstanding is only the cash a guest owes. A contract
    // player's charge came out of a balance the club already holds, so it is
    // settled the moment the game is recorded and its `paid` flag means nothing
    // — nothing ever sets it. Counting those as unpaid made a normal game read
    // "400 pending, 0% collected" when the only money actually outstanding was
    // the guest cash.
    const awaitingCash = `COALESCE(sp.player_type,'regular') = 'outside' AND ch.paid = 0`;
    const stats = db.prepare(`
      SELECT ch.gameweek_id,
             COUNT(*) AS charges_count,
             COALESCE(SUM(ch.amount), 0) AS charged,
             COALESCE(SUM(CASE WHEN ${awaitingCash} THEN 0 ELSE 1 END), 0) AS paid_count,
             COALESCE(SUM(CASE WHEN ${awaitingCash} THEN ch.amount ELSE 0 END), 0) AS pending_amount
      FROM charges ch
      LEFT JOIN players sp ON sp.id = COALESCE(ch.charged_to, ch.player_id)
      WHERE ch.gameweek_id IN (${placeholders})
      GROUP BY ch.gameweek_id
    `).all(...ids);
    const statsById = new Map(stats.map(s => [s.gameweek_id, s]));
    const empty = { charges_count: 0, charged: 0, paid_count: 0, pending_amount: 0 };

    // charges_count alongside the charged total: the stored num_players counts
    // everyone named in the message, including people who were never matched to
    // an account, so it runs 1–3 ahead of the players actually charged. Lists
    // should show what was billed.
    return rows.map(g => ({ ...g, ...(statsById.get(g.id) || empty) }));
  },
  chargeCount(id) {
    return db.prepare('SELECT COUNT(*) AS n FROM charges WHERE gameweek_id = ?').get(id).n;
  },
  paidCount(id) {
    return db.prepare('SELECT COUNT(*) AS n FROM charges WHERE gameweek_id = ? AND paid = 1').get(id).n;
  },
  pendingAmount(id) {
    return db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM charges WHERE gameweek_id = ? AND paid = 0')
      .get(id).t;
  },

  /**
   * Add one player to an existing game. Needed after an import, where a name the
   * sheet used could not be matched to anyone — the raw team text is kept on the
   * gameweek so the missing people can be filled in by hand afterwards.
   * `amount` defaults to 0, which records the appearance without touching money.
   */
  addCharge(gameweekId, { player_id, team = '', is_captain = false, rate_type = 'manual', amount = 0 }) {
    const gw = this.get(gameweekId);
    if (!gw) throw new Error('Gameweek not found');
    if (!player_id) throw new Error('player_id required');

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) throw new Error(`Invalid amount: ${amount}`);
    // Same rule as create(): one charge per player per game, or they are billed
    // twice and counted twice in the results.
    if (gw.charges.some(c => c.player_id === player_id)) {
      throw new Error('That player is already in this game');
    }

    ledgersRepo.ensure(player_id, gw.contract_id);
    db.prepare(`INSERT INTO charges (id,gameweek_id,player_id,team,is_captain,rate_type,amount)
                VALUES (?,?,?,?,?,?,?)`)
      .run(`c_add_${Date.now()}`, gameweekId, player_id, team,
        is_captain ? 1 : 0, rate_type, amt);
    db.prepare('UPDATE gameweeks SET num_players = ? WHERE id = ?')
      .run(this.chargeCount(gameweekId), gameweekId);
    recomputeGameKitty(gameweekId);
    return this.get(gameweekId);
  },

  /**
   * Mark a charge settled (or unsettle it). Payments routinely arrive after the
   * game is entered, so a charge starts unpaid and is closed off here.
   */
  setChargePaid(gameweekId, chargeId, { paid = true, method = null } = {}) {
    const row = db.prepare('SELECT * FROM charges WHERE id = ? AND gameweek_id = ?')
      .get(chargeId, gameweekId);
    if (!row) throw new Error('Charge not found');
    db.prepare('UPDATE charges SET paid = ?, paid_at = ?, paid_method = ? WHERE id = ?')
      .run(paid ? 1 : 0, paid ? new Date().toISOString() : null, paid ? method : null, chargeId);

    syncGuestCashToKitty(chargeId);
    return this.get(gameweekId);
  },

  removeCharge(gameweekId, chargeId) {
    const row = db.prepare('SELECT * FROM charges WHERE id = ? AND gameweek_id = ?')
      .get(chargeId, gameweekId);
    if (!row) throw new Error('Charge not found');
    db.prepare('DELETE FROM charges WHERE id = ?').run(chargeId);
    db.prepare('UPDATE gameweeks SET num_players = ? WHERE id = ?')
      .run(this.chargeCount(gameweekId), gameweekId);
    syncGuestCashToKitty(chargeId);   // clears the row the departed charge owned
    recomputeGameKitty(gameweekId);
    return this.get(gameweekId);
  },

  /** Change a player's team or captaincy without touching the amount. */
  updateCharge(gameweekId, chargeId, { team, is_captain }) {
    const row = db.prepare('SELECT * FROM charges WHERE id = ? AND gameweek_id = ?')
      .get(chargeId, gameweekId);
    if (!row) throw new Error('Charge not found');
    db.prepare('UPDATE charges SET team = ?, is_captain = ? WHERE id = ?')
      .run(team ?? row.team, is_captain === undefined ? row.is_captain : (is_captain ? 1 : 0), chargeId);
    return this.get(gameweekId);
  },
  get(id) {
    const g = db.prepare('SELECT * FROM gameweeks WHERE id = ?').get(id);
    if (!g) return null;
    // Who settles a charge is not always who played it, and it decides whether
    // the money is already in hand (a contract balance) or still to be collected
    // (a guest's cash). Callers were left to guess from player_id alone, so they
    // treated every unpaid charge as outstanding — including the ones already
    // paid for out of a balance.
    g.charges = db.prepare(`SELECT ch.*, p.name AS player_name,
        COALESCE(ch.charged_to, ch.player_id) AS settled_by,
        sp.name AS settler_name,
        COALESCE(sp.player_type, 'regular') AS settler_type
      FROM charges ch
      JOIN players p ON p.id = ch.player_id
      LEFT JOIN players sp ON sp.id = COALESCE(ch.charged_to, ch.player_id)
      WHERE ch.gameweek_id = ?
      ORDER BY ch.team, p.name`).all(id);
    return g;
  },
  chargeTotal(id) {
    return db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM charges WHERE gameweek_id = ?')
      .get(id).t;
  },
  nextGwNumber(contractId) {
    return (db.prepare('SELECT MAX(gw_number) AS m FROM gameweeks WHERE contract_id = ?')
      .get(contractId).m || 0) + 1;
  },
  // Create a live gameweek and its charges; ensures every charged player has a ledger.
  create(gw, charges) {
    // Validate everything BEFORE the first INSERT. There is no transaction here,
    // so throwing partway through the charge loop would leave a gameweek row with
    // only some of its charges written — worse than rejecting outright.
    const seen = new Set();
    for (const ch of charges) {
      const amt = Number(ch.amount);
      if (!Number.isFinite(amt) || amt < 0) {
        throw new Error(`Invalid charge amount for ${ch.player_id}: ${ch.amount} (must be ≥ 0)`);
      }
      // A player can only be charged once per gameweek. A name pasted under both
      // teams (an edited WhatsApp message, or someone who swapped sides) would
      // otherwise be silently debited twice for a single game.
      if (seen.has(ch.player_id)) {
        throw new Error(
          `${ch.player_id} appears more than once in this game — a player can only be charged once per gameweek.`);
      }
      seen.add(ch.player_id);
    }

    const id = `${gw.contract_id}_live_${Date.now()}`;
    const now = new Date().toISOString();

    // Wrapped in a transaction: the water-cost credit below can fail (e.g. the
    // payer was deleted between page load and submit, tripping the contributions
    // FK) after the gameweek and charges are already written. Without a
    // transaction that leaves a committed gameweek with no failure surfaced
    // beyond an error toast, and a retry from the same form double-charges
    // every player for the same match.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO gameweeks
        (id,contract_id,gw_number,contract_number,date,cost_per_gw,num_players,
         teams_raw,captains_raw,score,comments,historical,created_at,
         scoreline,teams_json,whatsapp_message,game_cost,game_cost_paid_by,kitty_earned)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)`).run(
        id, gw.contract_id, gw.gw_number ?? this.nextGwNumber(gw.contract_id),
        gw.contract_number ?? 0, gw.date || now.slice(0, 10), gw.cost_per_gw || 0,
        charges.length, gw.teams_raw || '', gw.captains_raw || '', gw.score || '',
        gw.comments || '', now,
        gw.scoreline || '', gw.teams_json || null, gw.whatsapp_message || '',
        gw.game_cost || 0, gw.game_cost_paid_by || 'self', gw.kitty_earned || 0);

      const insCharge = db.prepare(`INSERT INTO charges
        (id,gameweek_id,player_id,team,is_captain,rate_type,amount,charged_to,paid)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      charges.forEach((ch, i) => {
        ledgersRepo.ensure(ch.player_id, gw.contract_id);
        const settledBy = ch.charged_to || ch.player_id;
        insCharge.run(`c_live_${Date.now()}_${i}`, id, ch.player_id, ch.team || '',
          ch.is_captain ? 1 : 0, ch.rate_type || '', Number(ch.amount),
          settledBy, ch.paid ? 1 : 0);

        // Remember who covered a guest, so the next game can suggest them
        // rather than asking again — losing that link is losing who came from
        // whom. Only recorded when it is not already known, so a deliberate
        // correction on the players screen is never overwritten by one game.
        if (settledBy !== ch.player_id) {
          db.prepare(
            `UPDATE players SET introduced_by = ?
             WHERE id = ? AND introduced_by IS NULL AND id <> ?`
          ).run(settledBy, ch.player_id, settledBy);
        }
      });
      // Whoever bought the water is out of pocket for it. game_cost_paid_by was
      // recorded but nothing ever gave it back, so a player who bought the water
      // silently subsidised the game. Credit them for it as a contribution, which
      // is where the rest of their incoming money already lives.
      const payer = gw.game_cost_paid_by;
      const waterCost = Number(gw.game_cost) || 0;
      if (payer && payer !== 'self' && waterCost > 0) {
        ledgersRepo.ensure(payer, gw.contract_id);
        db.prepare(`INSERT INTO contributions (id,player_id,contract_id,amount,date,comments,created_at)
                    VALUES (?,?,?,?,?,?,?)`)
          .run(`c_water_${id}`, payer, gw.contract_id, waterCost,
            gw.date || now.slice(0, 10),
            `Bought the water for the game on ${gw.date || now.slice(0, 10)}`, now);
      }
      // Deciding later that a game did happen after all is a normal correction.
      // The date cannot be both played and not played, so recording the game
      // clears the marker rather than leaving the schedule contradicting itself.
      db.prepare('DELETE FROM no_game_days WHERE contract_id = ? AND date = ?')
        .run(gw.contract_id, gw.date || now.slice(0, 10));

      // The score belongs to the game, so it is written with it. It used to be a
      // second POST after the save had returned, which meant a game could be
      // recorded and its result quietly lost to a dropped connection.
      const res = gw.result;
      if (res?.team_a_name && res?.team_b_name
        && Number.isFinite(Number(res.goals_team_a)) && Number.isFinite(Number(res.goals_team_b))) {
        gameResultsRepo.create(db, id, res.team_a_name, res.team_b_name,
          Number(res.goals_team_a), Number(res.goals_team_b));
      }

      // The kitty is committed here, inside the same transaction as the game, so
      // the two can only ever succeed or fail together. It used to be a separate
      // confirm() in the browser after the save had already gone through, which
      // is how a game could be recorded with its money missing.
      recomputeGameKitty(id);

      // A figure typed over the calculated one is a deliberate correction — a
      // note in someone's pocket, a discount agreed on the night. Keep it as its
      // own one-off adjustment rather than overwriting the derived entry, so a
      // guest settling up later still tops the kitty up on top of it.
      if (gw.kitty_override) {
        const derived = db.prepare(
          `SELECT COALESCE(SUM(CASE WHEN kind='income' THEN amount ELSE -amount END),0) AS n
           FROM kitty WHERE scope = ?`).get(id).n;
        writeKittyRow(`k_gwadj_${id}`, round2((Number(gw.kitty_earned) || 0) - derived),
          `Manual adjustment to the game on ${gw.date || now.slice(0, 10)}`,
          gw.date || now.slice(0, 10), id);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    return this.get(id);
  },
  remove(id) {
    // Reverse any override (autoRecalculate=false) opening_balance compensations
    // before deleting, otherwise the shift is orphaned and silently inflates the
    // player's balance once the charge disappears. Only live games can carry these.
    const g = this.get(id);
    if (g && !g.historical) {
      for (const ch of g.charges) {
        const shift = db.prepare(
          `SELECT COALESCE(SUM(new_amount - original_amount), 0) AS s
           FROM charge_audit WHERE charge_id = ? AND auto_recalculate = 0`).get(ch.id).s;
        if (shift !== 0) {
          db.prepare(`UPDATE ledgers SET opening_balance = opening_balance - ?
                      WHERE player_id = ? AND contract_id = ?`)
            .run(shift, ch.player_id, g.contract_id);
        }
      }
    }
    // The water credit is a contribution keyed to this gameweek — remove it too,
    // otherwise deleting the game leaves the payer permanently in credit for it.
    db.prepare('DELETE FROM contributions WHERE id = ?').run(`c_water_${id}`);
    // Kitty rows have no foreign key to cascade on, so the game's own entries —
    // its profit, each guest's cash, any manual adjustment — are cleared by the
    // scope they all carry. Missing this would leave the pot crediting a game
    // that no longer exists.
    db.prepare('DELETE FROM kitty WHERE scope = ?').run(id);
    db.prepare('DELETE FROM gameweeks WHERE id = ?').run(id);   // charges cascade
  },

  // Update gameweek metadata (game_type, tournament_name, score, comments, etc.)
  updateMetadata(id, { game_type, tournament_name, score, comments, teams_raw, captains_raw }) {
    db.prepare(`UPDATE gameweeks SET game_type=?, tournament_name=?, score=?, comments=?, teams_raw=?, captains_raw=?
                WHERE id=?`).run(
      game_type ?? 'regular', tournament_name || null, score || '', comments || '',
      teams_raw || '', captains_raw || '', id);
    return this.get(id);
  },

  // Preview impact of charge edits (returns summary of what would change, no commit).
  // chargeEdits may be a SUBSET of the game's charges, so totalDelta is summed from
  // the per-charge deltas (not newTotal − fullGameTotal, which would be wrong for a
  // partial edit) and newTotal is derived as originalTotal + totalDelta.
  previewChargeEdits(gameweekId, chargeEdits) {
    const gameweek = this.get(gameweekId);
    const impact = {
      originalTotal: this.chargeTotal(gameweekId),
      newTotal: 0,
      totalDelta: 0,
      playerImpacts: [],
      changedCount: 0,
    };

    for (const edit of chargeEdits) {
      const charge = gameweek.charges.find(c => c.id === edit.chargeId);
      if (!charge) continue;
      const delta = edit.newAmount - charge.amount;
      if (delta !== 0) {
        impact.playerImpacts.push({
          playerId: charge.player_id,
          playerName: charge.player_name,
          oldAmount: charge.amount,
          newAmount: edit.newAmount,
          delta,
        });
        impact.totalDelta += delta;
        impact.changedCount++;
      }
    }
    impact.newTotal = impact.originalTotal + impact.totalDelta;
    return impact;
  },

  // Apply charge edits with audit trail + auto-recalculate option.
  //
  // Present balance is COMPUTED (opening + contributions − charges), so editing a
  // charge on a live game always flows into the balance by default — that is the
  // auto-recalculate (default) behaviour. When autoRecalculate is false the caller
  // wants an "override": correct only this game's recorded charge WITHOUT moving the
  // player's present balance. We achieve that by shifting opening_balance by the same
  // delta, which exactly neutralises the charge change. (Only meaningful for live
  // games; historical charges are excluded from the live balance, so there is nothing
  // to neutralise and we must NOT touch opening_balance for them.)
  applyChargeEdits(gameweekId, chargeEdits, { reason = '', changedBy = 'system', autoRecalculate = true } = {}) {
    const gameweek = this.get(gameweekId);
    for (const edit of chargeEdits) {
      const charge = gameweek.charges.find(c => c.id === edit.chargeId);
      if (!charge || edit.newAmount === charge.amount) continue;
      if (!Number.isFinite(edit.newAmount) || edit.newAmount < 0) {
        throw new Error(`Invalid charge amount: ${edit.newAmount} (must be a number ≥ 0)`);
      }
      const delta = edit.newAmount - charge.amount;

      db.prepare('UPDATE charges SET amount=? WHERE id=?').run(edit.newAmount, edit.chargeId);
      auditRepo.create(edit.chargeId, charge.amount, edit.newAmount, reason, changedBy, autoRecalculate);
      ledgersRepo.ensure(charge.player_id, gameweek.contract_id);

      if (!autoRecalculate && !gameweek.historical) {
        // Override: keep the player's present balance unchanged.
        db.prepare(`UPDATE ledgers SET opening_balance = opening_balance + ?
                    WHERE player_id = ? AND contract_id = ?`)
          .run(delta, charge.player_id, gameweek.contract_id);
      }
    }
    recomputeGameKitty(gameweekId);
    return this.get(gameweekId);
  },

  // Update game accounting: scoreline, team assignments, result, costs
  updateGameAccounting(id, { scoreline, teams_json, whatsapp_message, game_cost, game_cost_paid_by, kitty_earned }) {
    db.prepare(`UPDATE gameweeks
      SET scoreline=?, teams_json=?, whatsapp_message=?, game_cost=?, game_cost_paid_by=?, kitty_earned=?
      WHERE id=?`).run(
      scoreline || '', teams_json || null, whatsapp_message || '',
      game_cost || 0, game_cost_paid_by || 'self', kitty_earned || 0, id);
    recomputeGameKitty(id);   // the water cost comes straight off the kitty
    return this.get(id);
  },

  // Get full game data including results and financing
  getFullGame(id) {
    const g = this.get(id);
    if (!g) return null;

    // Add game result if exists
    const result = db.prepare('SELECT * FROM game_results WHERE gameweek_id = ?').get(id);
    if (result) {
      g.result = result;
    }

    // Add financing records (water cost, kitty)
    const financing = db.prepare('SELECT * FROM game_financing WHERE gameweek_id = ? ORDER BY created_at').all(id);
    g.financing = financing;

    return g;
  },
};
