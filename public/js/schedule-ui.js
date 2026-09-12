// schedule-ui.js — the season's shared vocabulary.
//
// Game Day and Season both ask the same questions of the fixture list: what is
// the next date nothing has been said about, what does this date look like
// written down, and how do I record that a game did or did not happen. They had
// grown two answers to each — two day-name arrays, two date formats (one showing
// "Saturday 8 Aug" and the other "2026-08-08" for the same day), and two copies
// of the mark-as-no-game prompt. Presentation stays with each view, since a
// compact bar and a full board want different layouts; everything below it is
// shared so the two cannot drift again.
import { api } from './api.js';
import { toast } from './store.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const utc = (iso) => new Date(`${iso}T00:00:00Z`);

export const dayName = (iso) => DAYS[utc(iso).getUTCDay()];

/** One way of writing a fixture date, everywhere it appears. */
export const fixtureDate = (iso) =>
  `${dayName(iso)} ${utc(iso).getUTCDate()} ${MONTHS[utc(iso).getUTCMonth()]}`;

/** "Monday and Thursday" — the days this contract plays on. */
export const describeDays = (gameDays = []) =>
  gameDays.map(d => DAYS[d]).join(' and ');

/**
 * The season, or null when it cannot be shown — no fixture days configured, or
 * the request failed. Both callers treat those the same way: render nothing
 * rather than an empty scaffold.
 */
export async function loadSchedule(contractId) {
  try {
    const s = await api.schedule(contractId);
    return s?.game_days?.length ? s : null;
  } catch { return null; }
}

/**
 * Record that a fixture was not played. Returns true when something changed, so
 * callers know whether to re-render. Cancelling the prompt is not a failure —
 * it leaves the date exactly as it was.
 */
export async function markNoGame(contractId, date) {
  const reason = prompt(`No game on ${fixtureDate(date)}?\n\nWhy not? (optional)`);
  if (reason === null) return false;
  try {
    await api.markNoGame(contractId, date, reason.trim() || null);
    toast(`${fixtureDate(date)} marked as no game`);
    return true;
  } catch (e) { toast(e.message, true); return false; }
}

/** Put a no-game date back to unaccounted for. */
export async function reopenDate(contractId, date) {
  try {
    await api.clearNoGame(contractId, date);
    toast(`${fixtureDate(date)} is back to unaccounted for`);
    return true;
  } catch (e) { toast(e.message, true); return false; }
}
