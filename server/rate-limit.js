// rate-limit.js — make guessing expensive.
//
// Two keys, both needed, because they stop different attacks:
//
//   the ACCOUNT   one person's login, guessed at from anywhere. Already held
//                 per player in auth_users; admin had nothing at all, and the
//                 admin password is the master key to the whole club.
//   the SOURCE IP one machine working through every name on the list. The
//                 login page publishes the roster — it has to, you pick your
//                 name from it — so an attacker never has to guess who exists.
//                 A per-account limit does nothing against that: five tries
//                 each across sixty names is three hundred free guesses.
//
// Held in memory. This is one small Node process behind one proxy, so a shared
// store would be a second thing to run and keep alive for no gain; the cost is
// that a restart forgets, which is worth stating rather than hiding. Attempts
// are also recorded in auth_users for the per-account half, so that part does
// survive.
//
// Counts FAILURES, not requests. Somebody signing in correctly forty times is
// not an attack, and locking out a whole household behind one router because
// the phones all logged in would be the limiter causing the outage.

const WINDOW_MS = 15 * 60 * 1000;   // how far back a failure counts
const IP_MAX = 12;                  // failures from one address in that window
const ACCOUNT_MAX = 5;              // failures against one account, any source

// key -> array of failure timestamps
const fails = new Map();

/** Drop anything older than the window, and the key itself once it is empty. */
function recent(key, now) {
  const kept = (fails.get(key) || []).filter(t => now - t < WINDOW_MS);
  if (kept.length) fails.set(key, kept); else fails.delete(key);
  return kept;
}

/**
 * The address a request came from.
 *
 * Express only fills req.ip from X-Forwarded-For when it has been told to
 * trust the proxy — see `trust proxy` in index.js. Without that every request
 * arrives as 127.0.0.1 and an IP limit becomes a limit on the whole club at
 * once, which is worse than having none: the first attacker locks everybody
 * out. Falls back to the socket address rather than to a constant, so a
 * misconfiguration degrades to per-process rather than to global.
 */
export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * May this attempt proceed? Returns null to allow, or { retryAfter } in
 * seconds. Checked BEFORE the password is looked at, so a locked-out caller
 * learns nothing about whether the account or the secret was right.
 */
export function checkLoginAllowed(req, accountKey) {
  const now = Date.now();
  const ip = recent(`ip:${clientIp(req)}`, now);
  const acct = accountKey ? recent(`acct:${accountKey}`, now) : [];

  const over = [
    ip.length >= IP_MAX ? ip : null,
    acct.length >= ACCOUNT_MAX ? acct : null,
  ].filter(Boolean);
  if (!over.length) return null;

  // Wait out the oldest failure still inside the window of whichever limit is
  // tripped, so the caller is told a time that is actually true.
  const oldest = Math.min(...over.map(list => Math.min(...list)));
  return { retryAfter: Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000)) };
}

/** Record a failed attempt against both keys. */
export function recordLoginFailure(req, accountKey) {
  const now = Date.now();
  for (const key of [`ip:${clientIp(req)}`, accountKey && `acct:${accountKey}`].filter(Boolean)) {
    const list = recent(key, now);
    list.push(now);
    fails.set(key, list);
  }
}

/**
 * Forget this account's failures after a correct sign-in.
 *
 * The IP's are deliberately NOT cleared: one correct password among a run of
 * guesses is exactly what an attacker working through a list produces, and
 * clearing on success would hand them a reset button.
 */
export function clearLoginFailures(req, accountKey) {
  if (accountKey) fails.delete(`acct:${accountKey}`);
}

/** For tests, and for anything that needs to reason about current state. */
export function _state() {
  return { keys: [...fails.keys()], WINDOW_MS, IP_MAX, ACCOUNT_MAX };
}
export function _reset() { fails.clear(); }
