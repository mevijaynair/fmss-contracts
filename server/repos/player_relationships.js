// player_relationships.js — manage player relationships, outside players, and shared balances
import { randomUUID } from 'node:crypto';

export const playerRelationshipsRepo = {
  // Mark a player as "outside" (introduced by someone, costs 35-40 AED)
  markOutside(db, playerId, introducedById, cost = 35) {
    db.prepare(`
      UPDATE players
      SET player_type = 'outside', introduced_by = ?, outside_cost = ?
      WHERE id = ?
    `).run(introducedById, cost, playerId);
  },

  // Mark a player as regular
  markRegular(db, playerId) {
    db.prepare(`
      UPDATE players
      SET player_type = 'regular', introduced_by = NULL, outside_cost = NULL
      WHERE id = ?
    `).run(playerId);
  },

  // Get introducer of a player
  getIntroducer(db, playerId) {
    return db.prepare(`
      SELECT p.* FROM players p
      WHERE p.id = (SELECT introduced_by FROM players WHERE id = ?)
    `).get(playerId);
  },

  // Get all outside players
  getOutsidePlayers(db) {
    return db.prepare(`
      SELECT * FROM players WHERE player_type = 'outside' ORDER BY name
    `).all();
  },

  // Get outside players for a contract
  getOutsidePlayersForContract(db, contractId) {
    return db.prepare(`
      SELECT p.* FROM players p
      WHERE p.player_type = 'outside'
      AND EXISTS (SELECT 1 FROM ledgers WHERE player_id = p.id AND contract_id = ?)
      ORDER BY p.name
    `).all(contractId);
  },

  // Create a balance group (for shared balances like Aws & Ali)
  createBalanceGroup(db, contractId, groupName, playerIds, description = '') {
    const id = `bg_${randomUUID()}`;
    db.prepare(`
      INSERT INTO player_balance_groups (id, group_name, contract_id, description, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, groupName, contractId, description, new Date().toISOString());

    // Link players to the group
    for (const playerId of playerIds) {
      db.prepare(`
        UPDATE players SET balance_group_id = ? WHERE id = ?
      `).run(id, playerId);
    }

    return { id, groupName, contractId, playerIds };
  },

  // Get balance group
  getBalanceGroup(db, groupId) {
    const group = db.prepare(`
      SELECT * FROM player_balance_groups WHERE id = ?
    `).get(groupId);

    if (!group) return null;

    const players = db.prepare(`
      SELECT id, name FROM players WHERE balance_group_id = ?
    `).all(groupId);

    return { ...group, players };
  },

  // Get all players in a balance group
  getGroupMembers(db, groupId) {
    return db.prepare(`
      SELECT id, name FROM players WHERE balance_group_id = ? ORDER BY name
    `).all(groupId);
  },

  // Check if players share a balance
  shareBalance(db, playerId1, playerId2) {
    const p1 = db.prepare('SELECT balance_group_id FROM players WHERE id = ?').get(playerId1);
    const p2 = db.prepare('SELECT balance_group_id FROM players WHERE id = ?').get(playerId2);

    return p1?.balance_group_id && p1.balance_group_id === p2?.balance_group_id;
  },

  // Get the effective payer for a shared balance group
  // (For display: "Aws & Ali" instead of listing both separately)
  getGroupDisplayName(db, groupId) {
    const group = db.prepare(`
      SELECT group_name FROM player_balance_groups WHERE id = ?
    `).get(groupId);
    return group?.group_name || groupId;
  },

  // Link an outside player to their introducer
  linkOutsidePlayer(db, outsidePlayerId, introducerId, cost = 35) {
    db.prepare(`
      UPDATE players
      SET player_type = 'outside', introduced_by = ?, outside_cost = ?
      WHERE id = ?
    `).run(introducerId, cost, outsidePlayerId);
  },

  // Get players introduced by someone (for tracking who brings outsiders)
  getIntroducedPlayers(db, introducerId) {
    return db.prepare(`
      SELECT * FROM players
      WHERE introduced_by = ?
      ORDER BY name
    `).all(introducerId);
  },
};
