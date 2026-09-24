// contributions.js — incoming funds log (the "Contri" sheet).
import { db } from '../db.js';
import { ledgersRepo } from './ledgers.js';
import { contractsRepo } from './contracts.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * What a game actually costs this player on this contract.
 *
 * Not the card rate. The rate on the card depends on how many turn out — ten
 * players is 30 a head on Mon/Thu, twelve is 27 — so quoting the card would
 * tell somebody their 300 covers ten games when it covers eleven. What they
 * have actually been charged lately is the honest answer, and the card is
 * only the fallback for someone who has not played yet.
 */
function typicalCost(playerId, contractId, contract, playerType) {
  const recent = db.prepare(`
    SELECT ch.amount FROM charges ch
    JOIN gameweeks g ON g.id = ch.gameweek_id
    WHERE ch.player_id = ? AND g.contract_id = ? AND g.historical = 0 AND ch.amount > 0
    ORDER BY g.date DESC LIMIT 3`).all(playerId, contractId).map(r => Number(r.amount));
  if (recent.length) return round2(recent.reduce((a, b) => a + b, 0) / recent.length);

  const rates = typeof contract.rates === 'string'
    ? (() => { try { return JSON.parse(contract.rates || '{}'); } catch { return {}; } })()
    : (contract.rates || {});
  const member = Number(rates.contracted_12) || Number(rates.contracted_10) || 0;
  const guest = Number(rates.noncontract) || 0;
  return playerType === 'outside' ? (guest || member) : (member || guest);
}

/** Games played on a contract since a date. */
function gamesSince(playerId, contractId, from) {
  return db.prepare(`
    SELECT COUNT(DISTINCT ch.gameweek_id) n FROM charges ch
    JOIN gameweeks g ON g.id = ch.gameweek_id
    WHERE ch.player_id = ? AND g.contract_id = ? AND g.historical = 0 AND g.date >= ?`)
    .get(playerId, contractId, from).n;
}

/**
 * Top up the emptiest tank first, until both run dry at the same time.
 *
 * Splitting the rest by how often somebody plays each night sounds right and
 * is not: Toby holds 487 on Mon/Thu and nothing on Saturdays, so a share of
 * his 200 went to the night already covered for twenty-two games while the
 * one he cannot play next week got the smaller half. What a top-up is FOR is
 * staying covered, so the money should go where the cover runs out first.
 *
 * `burn` is what a night consumes — games lately times what a game costs
 * them, so a 40 Saturday counts for more than a 30 Monday. This finds the
 * level T that the payment can fill every tank up to, and gives each one what
 * it needs to reach it. A contract they have stopped playing has a burn of
 * zero: it never runs out, so it never gets funded, which is the same rule as
 * before by a different route.
 */
function fillToLevel(balances, burns, amount) {
  const active = burns.map((b, i) => (b > 0 ? i : -1)).filter(i => i >= 0);
  if (!active.length || amount <= 0) return balances.map(() => 0);

  const need = (t) => active.reduce((s, i) => s + Math.max(0, t * burns[i] - balances[i]), 0);
  let lo = 0;
  let hi = Math.max(...active.map(i => (balances[i] + amount) / burns[i])) + 1;
  // Sixty halvings is far more precision than dirhams need, and costs nothing.
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (need(mid) < amount) lo = mid; else hi = mid;
  }
  const shares = balances.map((b, i) =>
    (burns[i] > 0 ? Math.max(0, lo * burns[i] - b) : 0));

  // The search lands just short; hand the crumbs to the hungriest tank so the
  // parts still add to the payment before they are rounded.
  const short = amount - shares.reduce((a, b) => a + b, 0);
  if (short > 0) {
    const biggest = active.reduce((best, i) => (burns[i] > burns[best] ? i : best), active[0]);
    shares[biggest] += short;
  }
  return shares;
}

/**
 * Hand out whole dirhams so the parts add up to the total, exactly.
 *
 * Rounding each share on its own loses or invents money — three ways of 100
 * becomes 99. Largest-remainder instead: everyone gets their whole part, and
 * the odd dirhams left over go to whoever was cut by the most. The parts then
 * sum to the payment by construction, which matters because the form refuses
 * to submit unless they do.
 */
function wholeDirhams(shares, total) {
  const floors = shares.map(s => Math.floor(s));
  let left = Math.round(total - floors.reduce((a, b) => a + b, 0));
  const order = shares
    .map((s, i) => ({ i, frac: s - Math.floor(s) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; left > 0 && order.length; k++, left--) floors[order[k % order.length].i] += 1;
  return floors;
}

export const contributionsRepo = {
  all({ playerId, contractId } = {}) {
    const where = [];
    const args = [];
    if (playerId) { where.push('q.player_id = ?'); args.push(playerId); }
    if (contractId) { where.push('q.contract_id = ?'); args.push(contractId); }
    // Rows that came from one payment carry its whole size and how many ways it
    // went, so a 1000 can be read back as "1000 of a 1500 split two ways"
    // without the reader having to find its siblings.
    const sql = `SELECT q.*, p.name AS player_name,
        CASE WHEN q.split_group IS NULL THEN NULL ELSE (
          SELECT ROUND(SUM(s.amount), 2) FROM contributions s WHERE s.split_group = q.split_group
        ) END AS split_total,
        CASE WHEN q.split_group IS NULL THEN NULL ELSE (
          SELECT COUNT(*) FROM contributions s WHERE s.split_group = q.split_group
        ) END AS split_parts
      FROM contributions q
      LEFT JOIN players p ON p.id = q.player_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY q.date DESC, q.created_at DESC`;
    return db.prepare(sql).all(...args);
  },

  /**
   * How a payment should be divided between the contracts this player is on.
   *
   * A cashier taking 300 off somebody in the car park should not have to open
   * two ledgers and work out where it is needed. The split is proposed, never
   * applied: every figure stays editable, because the person handing the money
   * over sometimes says what it is for and that beats any rule here.
   *
   * Two rules, in order, and both are things a person would say out loud:
   *
   *   1. CLEAR WHAT IS OWED FIRST. A negative balance means the next game is
   *      not paid for. If the payment cannot clear both, it comes off them in
   *      proportion, so neither night is left behind.
   *   2. SPLIT THE REST BY HOW THEY PLAY. Weighted by games in the last eight
   *      weeks, falling back to their whole record if they have been away. A
   *      contract they never play gets nothing — which is the difference
   *      between this and an even split, and the reason an even split is
   *      wrong: it strands half the money on a night they do not turn up to.
   *
   * Returns the split, what each contract looks like afterwards, and the
   * reason for each line, so the suggestion can be argued with rather than
   * just accepted.
   */
  suggestSplit(playerId, amount) {
    const amt = Math.round(Number(amount) || 0);
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
    if (!player) throw new Error('No such player');
    if (player.special_role === 'cashier') {
      return { player: { id: player.id, name: player.name }, amount: amt, lines: [],
        refused: 'The cashier funds the club and never contributes to it.' };
    }

    const byId = Object.fromEntries(contractsRepo.all().map(c => [c.id, c]));
    const since = new Date();
    since.setDate(since.getDate() - 56);          // eight weeks
    const from = since.toISOString().slice(0, 10);

    const lines = ledgersRepo.forPlayer(playerId)
      .filter(l => byId[l.contract_id])
      .map((l) => {
        const c = byId[l.contract_id];
        return {
          contract_id: l.contract_id,
          contract_name: c.name,
          balance: round2(l.present_balance),
          owed: Math.max(0, round2(-l.present_balance)),
          cost_per_game: typicalCost(playerId, l.contract_id, c, player.player_type),
          recent_games: gamesSince(playerId, l.contract_id, from),
          games: l.games,
        };
      });

    if (!lines.length) {
      return { player: { id: player.id, name: player.name }, amount: amt, lines: [],
        refused: `${player.name} is not on any contract yet.` };
    }

    // A guest keeps no balance at all — they pay cash for the night they play.
    // Money put on a balance for them sits there unspent while the app still
    // reports them as owing cash, so it is worth saying rather than splitting.
    const guest = (player.player_type || 'regular') === 'outside';

    // ---- rule 1: what is owed, first
    const owedTotal = round2(lines.reduce((s, l) => s + l.owed, 0));
    const toDebt = owedTotal > 0 ? Math.min(amt, owedTotal) : 0;
    const debtShare = lines.map(l => (owedTotal > 0 ? (l.owed / owedTotal) * toDebt : 0));

    // ---- rule 2: the rest, to whichever night runs out first
    const rest = amt - toDebt;
    let weights = lines.map(l => l.recent_games);
    let basis = 'how soon each night runs out, at the rate they have been playing';
    if (!weights.some(w => w > 0)) {
      weights = lines.map(l => l.games);
      basis = 'how soon each night runs out, over their whole record';
    }
    if (!weights.some(w => w > 0)) {
      weights = lines.map(() => 1);
      basis = 'no games on record, so evenly';
    }
    // Where they stand once what they owe has been paid — the level the rest
    // is filling up from.
    const after = lines.map((l, i) => l.balance + debtShare[i]);
    const burns = lines.map((l, i) => weights[i] * (l.cost_per_game || 1));
    const restShare = fillToLevel(after, burns, rest);

    const exact = lines.map((_, i) => debtShare[i] + restShare[i]);
    const whole = wholeDirhams(exact, amt);

    lines.forEach((l, i) => {
      l.suggested = whole[i];
      l.balance_after = round2(l.balance + whole[i]);
      l.games_after = l.cost_per_game > 0
        ? Math.floor(l.balance_after / l.cost_per_game) : null;
      const bits = [];
      if (l.owed > 0) {
        bits.push(whole[i] >= l.owed ? `clears the ${Math.round(l.owed)} owed`
          : `${whole[i]} off the ${Math.round(l.owed)} owed`);
      }
      if (l.games_after !== null && l.balance_after > 0) {
        bits.push(`covers ${l.games_after} more game${l.games_after === 1 ? '' : 's'}`);
      }
      if (!l.recent_games) bits.push('not played here in eight weeks');
      l.why = bits.join(' · ') || 'nothing needed here';
    });

    const used = lines.filter(l => l.suggested > 0);
    const headline = guest
      ? `${player.name} is a guest — they pay cash per game and keep no balance. `
        + 'A contribution here will sit unspent.'
      : lines.length === 1
        ? `${player.name} only plays ${lines[0].contract_name}, so it all goes there.`
        : owedTotal >= amt && owedTotal > 0
          ? `${Math.round(owedTotal)} is owed across the two, and ${amt} does not cover it — `
            + 'split in proportion so neither night is left behind.'
          : owedTotal > 0
            ? `${Math.round(owedTotal)} owed comes off first; the rest goes by ${basis}.`
            : `Nothing is owed, so it goes by ${basis}.`;

    return {
      player: { id: player.id, name: player.name, guest },
      amount: amt,
      lines,
      // The one invariant the form depends on.
      total: lines.reduce((s, l) => s + l.suggested, 0),
      owed_total: owedTotal,
      basis,
      single: used.length <= 1,
      headline,
      refused: null,
    };
  },

  /** The other legs of the same payment — what a bank line reconciles against. */
  splitSiblings(groupId) {
    if (!groupId) return [];
    return db.prepare(
      `SELECT q.id, q.contract_id, q.amount, q.date, c.name AS contract_name
       FROM contributions q LEFT JOIN contracts c ON c.id = q.contract_id
       WHERE q.split_group = ? ORDER BY q.amount DESC`
    ).all(groupId);
  },

  create({ player_id, contract_id, amount, date, comments, split_group = null }) {
    // Cashier exception: block Vijay from contributing
    if (player_id) {
      const player = db.prepare('SELECT special_role FROM players WHERE id = ?').get(player_id);
      if (player?.special_role === 'cashier') {
        throw new Error('Cashier cannot contribute; contributions excluded for audit integrity');
      }
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt)) {
      throw new Error(`Invalid contribution amount: ${amount} (must be a number)`);
    }
    // Balances are read from the ledger table, so money paid towards a contract
    // the player has no row on lands nowhere visible: the contribution is
    // logged, no balance moves, and nothing says why. Giving them the row is
    // the whole fix — it starts at zero and the payment then shows up on it.
    if (player_id && contract_id) ledgersRepo.ensure(player_id, contract_id);
    // A split writes several rows back to back; a timestamp alone collides when
    // two land in the same millisecond, and the second insert would fail on the
    // primary key.
    const id = `q_live_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const name = player_id
      ? (db.prepare('SELECT name FROM players WHERE id=?').get(player_id)?.name || '')
      : '';
    db.prepare(`INSERT INTO contributions
      (id,player_id,contract_id,name_raw,amount,date,comments,historical,created_at,split_group)
      VALUES (?,?,?,?,?,?,?,0,?,?)`).run(
      id, player_id || null, contract_id || null, name, Number(amount) || 0,
      date || new Date().toISOString().slice(0, 10), comments || '',
      new Date().toISOString(), split_group || null);
    return db.prepare('SELECT * FROM contributions WHERE id = ?').get(id);
  },
  /**
   * Correct what a payment SAYS, never what it is worth.
   *
   * Praveen's 96 was a May payment that the 1 August opening balance had
   * missed. Entered four months after its own date and with no note, it reads
   * to anyone checking — including whoever reads the Excel — as the same money
   * counted twice, and there was no way to say otherwise from inside the app.
   *
   * The note and the date are the two things that can be wrong without the
   * money being wrong, so they are the two things this changes. The amount,
   * the player and the contract are deliberately not editable: those ARE the
   * money, and quietly rewriting them would move a balance with nothing in the
   * log to say so. Getting one of those wrong is a delete and a re-entry,
   * which leaves the correction visible.
   *
   * An imported row is refused outright — it came in with the opening
   * balances, is already counted there, and is behind the closed baseline.
   */
  edit(id, { comments, date } = {}) {
    const row = db.prepare('SELECT * FROM contributions WHERE id = ?').get(id);
    if (!row) throw new Error('No such payment');
    if (row.historical) {
      throw new Error('That one came in with the opening balances and cannot be edited');
    }

    const nextComments = comments === undefined || comments === null
      ? row.comments : String(comments).slice(0, 500);
    const nextDate = date === undefined || date === null || date === ''
      ? row.date : String(date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) {
      throw new Error(`Not a date: ${nextDate}`);
    }

    // The promise this makes is that no balance moves. Checked rather than
    // asserted, inside the transaction, the same way every other write here
    // proves itself — a date is not money, but a rule nobody verifies is a
    // rule until the day somebody edits the wrong column.
    const before = row.player_id
      ? ledgersRepo.forPlayer(row.player_id).reduce((s, l) => s + l.present_balance, 0) : 0;

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE contributions SET comments = ?, date = ? WHERE id = ?')
        .run(nextComments, nextDate, id);
      const after = row.player_id
        ? ledgersRepo.forPlayer(row.player_id).reduce((s, l) => s + l.present_balance, 0) : 0;
      if (round2(after) !== round2(before)) {
        throw new Error(`Refusing: the balance would move from ${round2(before)} to ${round2(after)}`);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return db.prepare('SELECT * FROM contributions WHERE id = ?').get(id);
  },

  remove(id) {
    db.prepare('DELETE FROM contributions WHERE id = ?').run(id);
  },
};
