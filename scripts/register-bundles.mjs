// register-bundles.mjs — the bookings the club actually signed, entered once.
//
// Idempotent: run it twice and the second run says everything is already
// there. It writes no kitty row and moves no balance — a block payment is
// cash leaving the cashier against a cost the books have already taken, and
// booking it as an expense as well would charge the club twice for one pitch.
//
//   node scripts/register-bundles.mjs
//   - correct the O365 bundle to 4,999
//   - register the Koora bundle: 6,300 for 20 nights from 17 Oct
//   - the Saturday card that came into force with it
//   - the Mon/Thu pitch, at what the bundle actually costs a night
import { initSchema } from '../server/db.js';
import { financeRepo } from '../server/repos/finance.js';
import { contractsRepo } from '../server/repos/contracts.js';
initSchema();

const r2 = (n) => Math.round(n * 100) / 100;
const say = (s) => console.log(s);

// ---- 1. O365: the bundle is 4,999, not 5,000.
const o365 = financeRepo.venueContracts('mon_thu')
  .find(v => v.vendor.toLowerCase().includes('365'));
if (!o365) throw new Error('No O365 booking to correct');
if (r2(o365.amount_total) !== 4999) {
  financeRepo.updateVenueContract(o365.id, {
    amount_total: 4999,
    notes: `${o365.notes || ''} — 20 sessions with 3 free, paid up front`.trim(),
  });
  say(`O365 bundle ${o365.amount_total} -> 4999`);
} else say('O365 bundle already 4,999');
const o365b = financeRepo.venueContract(o365.id);
say(`   ${o365b.sessions_total}+${o365b.free_sessions} free = ${o365b.sessions_covered} nights`
  + ` at ${o365b.cost_per_session} each; ${o365b.hours_played} played, ${o365b.sessions_left} left`);

// ---- 1b. The payment is 4,999 too: the 5,000 on file was the round figure.
const pays = financeRepo.venueContract(o365.id).payments;
if (pays.length === 1 && r2(pays[0].amount) === 5000) {
  const { date, paid_by, method, note } = pays[0];
  financeRepo.removePayment(pays[0].id);
  financeRepo.addPayment(o365.id, { amount: 4999, date, paid_by, method, note });
  say('O365 payment 5000 -> 4999');
} else say(`O365 payments: ${pays.map(x => `${x.date} ${x.amount}`).join(', ')}`);

// ---- 2. Koora: 6,300 for 20 nights from 17 October.
const KOORA = 'Wasl Koora Dome';
let koora = financeRepo.venueContracts('sat').find(v => v.start_date === '2026-10-17');
if (!koora) {
  koora = financeRepo.createVenueContract({
    contract_id: 'sat', vendor: KOORA, start_date: '2026-10-17', end_date: null,
    sessions_total: 20, free_sessions: 0, amount_total: 6300,
    notes: '6,300 for 20 nights, from 17 Oct 2026',
  });
  say(`Koora booking registered: ${koora.id}`);
} else say('Koora booking already registered');
say(`   20 nights at ${koora.cost_per_session} each;`
  + ` ${koora.hours_played} played, ${koora.sessions_left} left; paid ${koora.paid}`
  + `, outstanding ${koora.outstanding}`);

// ---- 3. The Saturday card that came in with it.
contractsRepo.saveCard('sat', {
  effective_from: '2026-10-17',
  rates: { contracted_10: 36, captain_10: 31, contracted_12: 30, captain_12: 25, noncontract: 40 },
  pitch_per_game: 315, water_per_game: 15,
  notes: 'Koora 6,300 / 20 nights — 315 pitch, 15 water, ~15 to the kitty',
});
say('Saturday card from 2026-10-17: 36/31 ten, 30/25 twelve, guest 40, pitch 315');

// ---- 4. Mon/Thu: the pitch, at what the bundle actually costs a night.
//         The player rates are untouched; this is the club's own arithmetic.
const mtCard = contractsRepo.cardOn('mon_thu', '2026-08-31');
contractsRepo.saveCard('mon_thu', {
  effective_from: '2026-08-31',
  rates: mtCard.rates,
  pitch_per_game: r2(4999 / 23), water_per_game: 15,
  notes: 'O365 4,999 for 20+3 free = 217.35 a night',
});
say(`Mon/Thu card from 2026-08-31: pitch ${r2(4999 / 23)}, player rates unchanged`);

say('');
for (const c of contractsRepo.all()) {
  say(`${c.name}: cost_per_gw now ${c.cost_per_gw}, rates ${JSON.stringify(c.rates)}`);
  for (const k of contractsRepo.cards(c.id)) {
    say(`   ${k.effective_from} -> ${k.effective_to || 'in force'}  pitch ${k.pitch_per_game}`
      + `  ${JSON.stringify(k.rates)}`);
  }
}
