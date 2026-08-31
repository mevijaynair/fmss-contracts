// gameweeks.js — match records + their per-player charges (+ edit with audit trail).
import { db } from '../db.js';
import { ledgersRepo } from './ledgers.js';
import { auditRepo } from './audit.js';

export const gameweeksRepo = {
  all(contractId) {
    const sql = contractId
      ? 'SELECT * FROM gameweeks WHERE contract_id = ? ORDER BY date DESC, gw_number DESC'
      : 'SELECT * FROM gameweeks ORDER BY date DESC';
    const rows = contractId ? db.prepare(sql).all(contractId) : db.prepare(sql).all();
    // charges_count alongside the charged total: the stored num_players counts
    // everyone named in the message, including people who were never matched to
    // an account, so it runs 1–3 ahead of the players actually charged. Lists
    // should show what was billed.
    return rows.map(g => ({
      ...g,
      charged: this.chargeTotal(g.id),
      charges_count: this.chargeCount(g.id),
      // The list previously carried no payment-status data at all, so the frontend
      // had nothing to show for Settlement/Collected except "—" on every row — it
      // required a per-charge `paid` array that only the single-gameweek detail
      // endpoint returns. These two aggregates let the list render real status
      // without an N+1 fetch of every game's charges.
      paid_count: this.paidCount(g.id),
      pending_amount: this.pendingAmount(g.id),
    }));
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
    const gw = db.prepare('SELECT contract_id, date FROM gameweeks WHERE id = ?').get(gameweekId);
    db.prepare('UPDATE charges SET paid = ?, paid_at = ?, paid_method = ? WHERE id = ?')
      .run(paid ? 1 : 0, paid ? new Date().toISOString() : null, paid ? method : null, chargeId);

    // An out-of-contract player pays cash on the day rather than from a prepaid
    // balance, so that money lands in the kitty. A contract player's charge was
    // already funded by their balance, so settling it moves nothing.
    // Keyed to the charge so unticking removes exactly the entry it added.
    const kittyId = `k_charge_${chargeId}`;
    const payerId = row.charged_to || row.player_id;
    const payer = db.prepare('SELECT name, player_type FROM players WHERE id = ?').get(payerId);
    const isOutside = payer?.player_type === 'outside';
    const amount = Number(row.amount) || 0;

    db.prepare('DELETE FROM kitty WHERE id = ?').run(kittyId);
    if (paid && isOutside && amount > 0) {
      db.prepare(`INSERT INTO kitty (id,kind,label,amount,date,historical,created_at)
                  VALUES (?,?,?,?,?,0,?)`)
        .run(kittyId, 'income', `${payer.name} paid for ${gw?.date || 'a game'}`,
          amount, gw?.date || new Date().toISOString().slice(0, 10), new Date().toISOString());
    }
    return this.get(gameweekId);
  },

  removeCharge(gameweekId, chargeId) {
    const row = db.prepare('SELECT * FROM charges WHERE id = ? AND gameweek_id = ?')
      .get(chargeId, gameweekId);
    if (!row) throw new Error('Charge not found');
    db.prepare('DELETE FROM charges WHERE id = ?').run(chargeId);
    db.prepare('UPDATE gameweeks SET num_players = ? WHERE id = ?')
      .run(this.chargeCount(gameweekId), gameweekId);
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
    g.charges = db.prepare(`SELECT ch.*, p.name AS player_name FROM charges ch
      JOIN players p ON p.id = ch.player_id WHERE ch.gameweek_id = ?
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
      insCharge.run(`c_live_${Date.now()}_${i}`, id, ch.player_id, ch.team || '',
        ch.is_captain ? 1 : 0, ch.rate_type || '', Number(ch.amount),
        ch.charged_to || ch.player_id, ch.paid ? 1 : 0);
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
    return this.get(gameweekId);
  },

  // Update game accounting: scoreline, team assignments, result, costs
  updateGameAccounting(id, { scoreline, teams_json, whatsapp_message, game_cost, game_cost_paid_by, kitty_earned }) {
    db.prepare(`UPDATE gameweeks
      SET scoreline=?, teams_json=?, whatsapp_message=?, game_cost=?, game_cost_paid_by=?, kitty_earned=?
      WHERE id=?`).run(
      scoreline || '', teams_json || null, whatsapp_message || '',
      game_cost || 0, game_cost_paid_by || 'self', kitty_earned || 0, id);
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
