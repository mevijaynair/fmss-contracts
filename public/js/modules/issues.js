// issues.js — "that is not what happened".
//
// The results are typed in by one person from a WhatsApp message, and the
// twelve who were on the pitch are the only people who would spot a mistake.
// Until now they had nowhere in the app to say so, so a wrong score either
// reached the cashier as a message he had to act on from memory, or it stood.
//
// The form asks WHICH STAT, from a short list, before it asks anything else.
// "The score on 12 September is wrong, it was 8-6" can be checked in ten
// seconds; "something's up with last Thursday" is a conversation. It also
// shows what the app currently believes, so the person reporting can see
// whether they are disagreeing with the record or with their own memory.
//
// Nothing here changes a result. A report is a message with a subject line.
import { api } from '../api.js';
import { toast } from '../store.js';
import { $, esc, fmtDate, openModal, closeModal } from '../util.js';

/**
 * The club's WhatsApp number, fetched only when somebody is about to use it.
 *
 * It is a real person's phone number. It used to arrive with every dashboard
 * load; now it is asked for at the one moment it is needed, from an endpoint
 * that answers `no-store`. Held in a module variable for the life of the
 * page and never written to storage, so closing the tab takes it with it.
 */
let contact;                 // undefined = not asked yet, '' = none set

async function clubContact() {
  if (contact !== undefined) return contact;
  try { contact = (await api.get('/club-contact'))?.whatsapp || ''; }
  catch { contact = ''; }
  return contact;
}

/** The message a person would send, built so they do not have to write it. */
function whatsappText(game, fieldLabel, shouldBe) {
  return `FMSS — ${fieldLabel} looks wrong for the game on ${fmtDate(game.date)}`
    + `${game.contract_name ? ` (${game.contract_name})` : ''}.`
    + `${game.score ? ` The app says: ${game.score}.` : ''}`
    + ` It should be: ${shouldBe}`;
}

/**
 * Report a problem with one game.
 *
 * `game` is a row from /my/games, so the modal can show what the record says
 * beside the box asking what it should say.
 */
export async function reportIssue(game) {
  let fields;
  try { ({ fields } = await api.get('/my/issues')); }
  catch (e) { toast(e.message, true); return; }

  openModal(`What's wrong with ${fmtDate(game.date)}?`, `
    <p class="hint">${esc(game.contract_name || '')}${game.score
    ? ` · the app has it as <strong>${esc(game.score)}</strong>` : ' · no result recorded'}</p>
    <div class="form-group mt"><label for="ri_field">Which bit is wrong</label>
      <select id="ri_field">${Object.entries(fields)
    .map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')}</select></div>
    <div class="form-group mt"><label for="ri_should">What it should be</label>
      <input type="text" id="ri_should" maxlength="500"
        placeholder="e.g. Red won 8-6, not 7-5">
      <p class="hint" style="margin:0.35rem 0 0">Be specific — the exact number or name.
        That is what makes it a five-second fix rather than a conversation.</p></div>
    <button class="btn full-w mt" id="ri_send">Send it</button>
    <div id="ri_after" hidden></div>`);

  $('ri_send').addEventListener('click', async () => {
    const field = $('ri_field').value;
    const shouldBe = $('ri_should').value.trim();
    if (!shouldBe) { toast('Say what it should be', true); return; }
    try {
      await api.post('/my/issues', {
        gameweek_id: game.gameweek_id, field, should_be: shouldBe,
      });
    } catch (e) { toast(e.message, true); return; }

    // Filed. Now offer the faster route as well, because the club runs on
    // WhatsApp and a message read tonight beats a row read on Sunday. Offered,
    // never done for them: sending a message on somebody's behalf is theirs.
    const label = fields[field];
    const text = whatsappText(game, label, shouldBe);
    const number = await clubContact();
    const link = number
      ? `https://wa.me/${encodeURIComponent(String(number).replace(/\D/g, ''))}`
        + `?text=${encodeURIComponent(text)}`
      : null;
    $('ri_send').hidden = true;
    const after = $('ri_after');
    after.hidden = false;
    after.innerHTML = `
      <div class="panel">
        <div class="panel-title">Logged — thank you</div>
        <div class="panel-body">It is on the admin's list. If the result itself is wrong,
          a WhatsApp gets it fixed before the next game.</div>
        <div class="quick-row">
          ${link ? `<a class="btn btn-sm" id="ri_wa" href="${esc(link)}"
            target="_blank" rel="noopener">Send on WhatsApp</a>` : ''}
          <button class="btn btn-secondary btn-sm" id="ri_copy">Copy the message</button>
          <button class="btn btn-secondary btn-sm" id="ri_done">Done</button>
        </div>
      </div>`;
    $('ri_copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); toast('Copied — paste it to the group'); }
      catch { toast('Could not copy — select the text below', true); }
    });
    $('ri_done').addEventListener('click', closeModal);
    toast('Reported ✓');
  });
}

/** A player's own open reports, so they can see it was received. */
export function renderMyIssues(reports) {
  const open = (reports || []).filter(r => r.status === 'open');
  if (!open.length) return '';
  return `<div class="panel">
    <div class="panel-title">You have reported ${open.length} thing${open.length === 1 ? '' : 's'}</div>
    <div class="panel-body">${open.map(r =>
    `${esc(r.field_label)} on ${fmtDate(r.game_date)} — you said: ${esc(r.should_be)}`)
    .join('<br>')}</div>
  </div>`;
}
