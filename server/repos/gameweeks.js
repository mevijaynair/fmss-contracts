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
    return rows.map(g => ({ ...g, charged: this.chargeTotal(g.id) }));
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
    const id = `${gw.contract_id}_live_${Date.now()}`;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO gameweeks
      (id,contract_id,gw_number,contract_number,date,cost_per_gw,num_players,
       teams_raw,captains_raw,score,comments,historical,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?)`).run(
      id, gw.contract_id, gw.gw_number ?? this.nextGwNumber(gw.contract_id),
      gw.contract_number ?? 0, gw.date || now.slice(0, 10), gw.cost_per_gw || 0,
      charges.length, gw.teams_raw || '', gw.captains_raw || '', gw.score || '',
      gw.comments || '', now);

    const insCharge = db.prepare(`INSERT INTO charges
      (id,gameweek_id,player_id,team,is_captain,rate_type,amount) VALUES (?,?,?,?,?,?,?)`);
    charges.forEach((ch, i) => {
      const amt = Number(ch.amount);
      if (!Number.isFinite(amt) || amt < 0) {
        throw new Error(`Invalid charge amount for ${ch.player_id}: ${ch.amount} (must be ≥ 0)`);
      }
      ledgersRepo.ensure(ch.player_id, gw.contract_id);
      insCharge.run(`c_live_${Date.now()}_${i}`, id, ch.player_id, ch.team || '',
        ch.is_captain ? 1 : 0, ch.rate_type || '', amt);
    });
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
};
