// devices.js — "have I signed in from here before?"
//
// This blocks nothing and gates nothing. Its whole job is to let the app say,
// once, at the moment somebody signs in: this is the first time from this
// network. Club PINs are handed out over WhatsApp and are therefore known to
// whoever passed them on, so a person noticing an unfamiliar sign-in is most
// of the defence that is actually available — and noticing is impossible if
// nothing ever says anything.
//
// THE ADDRESS IS NEVER STORED IN THE CLEAR. The club has no need to know where
// its players live to answer "have I seen this before", and a plain log of who
// connected from where is a thing that can leak. A salted hash answers the
// question and nothing else. The salt is the app's signing secret, so the
// hashes are worthless on their own and cannot be matched against a list of
// candidate addresses without it.
import { createHmac, randomBytes } from 'node:crypto';

const round = () => new Date().toISOString();

/**
 * The hashing key, kept in the database rather than taken from the signing
 * secret.
 *
 * Reusing the signing secret would have tied these hashes to a value that is
 * meant to be rotated: change it and every stored fingerprint stops matching,
 * so the next time all sixty players sign in they are each told their own
 * phone is a device they have never used. A warning that fires for everybody
 * at once is a warning nobody reads again. Generated once, on first use.
 */
let cachedKey = null;
function key(db) {
  if (cachedKey) return cachedKey;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'device_salt'").get();
  if (row?.value) { cachedKey = row.value; return cachedKey; }
  cachedKey = randomBytes(24).toString('hex');
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('device_salt', ?)").run(cachedKey);
  return cachedKey;
}

function fingerprint(db, ip) {
  return createHmac('sha256', key(db)).update(String(ip || 'unknown')).digest('hex').slice(0, 32);
}

/**
 * Record a successful sign-in and say whether the address is a new one.
 *
 * Returns { isNew, seen } — `seen` being how many distinct places this account
 * has ever signed in from, which is what makes "first time from here" mean
 * something on an account that has signed in ten times before and nothing at
 * all on one that has never signed in.
 *
 * Deliberately swallows its own errors. A sign-in must not fail because a
 * nice-to-have piece of bookkeeping did.
 */
export function noteLogin(db, userId, ip) {
  if (!userId) return { isNew: false, seen: 0 };
  try {
    const hash = fingerprint(db, ip);
    const now = round();
    const seen = db.prepare('SELECT COUNT(*) n FROM login_devices WHERE user_id = ?')
      .get(userId).n;
    const existing = db.prepare(
      'SELECT id FROM login_devices WHERE user_id = ? AND ip_hash = ?').get(userId, hash);

    if (existing) {
      db.prepare('UPDATE login_devices SET last_seen = ?, logins = logins + 1 WHERE id = ?')
        .run(now, existing.id);
      return { isNew: false, seen };
    }
    db.prepare(`INSERT INTO login_devices (id, user_id, ip_hash, first_seen, last_seen, logins)
                VALUES (?,?,?,?,?,1)`)
      .run(`d_${Date.now()}_${hash.slice(0, 6)}`, userId, hash, now, now);
    // The very first sign-in an account ever makes is not a warning — there is
    // nothing to compare it to, and crying wolf on day one teaches people to
    // ignore the notice on the day it matters.
    return { isNew: seen > 0, seen };
  } catch {
    return { isNew: false, seen: 0 };
  }
}

/** Every place an account has signed in from, for the person's own audit page. */
export function devicesFor(db, userId) {
  try {
    return db.prepare(
      `SELECT first_seen, last_seen, logins FROM login_devices
       WHERE user_id = ? ORDER BY last_seen DESC`).all(userId);
  } catch {
    return [];
  }
}
