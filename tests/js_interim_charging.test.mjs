/*
 * Interim-deficit charging ("last-flight-full") — focused scheduler harness.
 *
 * A SHARED aircraft flying a retour >1x/day charges interim rotations only to the
 * away-stop target and tops the base to 100% on the day's FINAL rotation. We verify
 * against the all-rotations-to-full reference — the SAME trip as a SEPARATE fleet,
 * where each aircraft is one rotation that charges to full:
 *   - conservation : total charge ENERGY(shared) == ENERGY(separate)  (start full, end full)
 *   - the win      : total charge MINUTES(shared) <  MINUTES(separate) (interim charges dodge the CV taper)
 *   - distinction  : the shared rotations are NOT all identical (first/interim/last differ)
 *   - parity       : freqN:1 shared == 1 rotation, unchanged
 *
 * Server up on :5055 for /api/simulate geometry.
 * Run:  CNS_BASE_URL=http://127.0.0.1:5055 node tests/js_interim_charging.test.mjs
 */
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadStack, AP } from './golden_capture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANES = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(REPO, 'planes.json'), 'utf8')).map(p => [p.id, p]));
const BASE = process.env.CNS_BASE_URL || 'http://127.0.0.1:5055';
const CHARGERS = { dc_250: { id: 'dc_250', name: '250 kW DC', power_kw: 250 }, dc_60: { id: 'dc_60', name: '60 kW DC', power_kw: 60 } };
const co = (k) => ({ ident: k, name: AP[k].name, lat: AP[k].lat, lon: AP[k].lon });
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

let pass = 0, fail = 0;
const test = (n, fn) => { try { fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };

async function sim(o, d, plane, charger) {
  const r = await fetch(BASE + '/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin: co(o), destination: co(d), plane_id: plane, charger_id: charger, trip_type: 'retour' }) });
  return r.json();
}

function savedTrip(o, d, plane, data, freqN, fleetMode, charger) {
  const P = PLANES[plane];
  return {
    id: `t-${fleetMode}-${freqN}`, planeId: plane, planeName: P.name, tripType: 'retour',
    originIdent: o, originName: AP[o].name, originLat: AP[o].lat, originLon: AP[o].lon,
    destIdent: d, destName: AP[d].name, destLat: AP[d].lat, destLon: AP[d].lon,
    battery: P.battery_kwh, range_km: P.range_km, speed_kmh: P.speed_kmh, c_rate: P.c_rate,
    chargerId: charger, chargerName: charger, chargerPower: CHARGERS[charger].power_kw,
    legEnergy: data.leg_energy_kwh, flightTimeH: data.flight_time_h,
    freqN, freqUnit: 'day', fleetMode,
  };
}

// Sum charge energy + minutes across all lanes/rotations of runGlobal, and the per-rotation split.
function totals(S, trip) {
  S.localStorage.setItem('cns_folder', JSON.stringify([trip]));
  S.localStorage.setItem('cns_airport_cfg', JSON.stringify({}));
  S.CNSScheduler.init({ chargers: CHARGERS });
  const g = S.CNSScheduler.runGlobal();
  let energy = 0, minutes = 0; const byRot = [];
  g.lanes.forEach(L => L.rotations.forEach(rot => {
    let e = 0, m = 0;
    rot.phases.forEach(ph => { if (ph.kind === 'charge') { e += ph.energy || 0; m += ph.dur || 0; } });
    byRot.push(+e.toFixed(2)); energy += e; minutes += m;
  }));
  const dcm = (S.CNSScheduler.dailyChargeMinutesAt) ? +S.CNSScheduler.dailyChargeMinutesAt(trip, 'EHAM').toFixed(2) : null;   // base daily charge minutes = the reporting figure
  return { energy: +energy.toFixed(2), minutes: +minutes.toFixed(2), byRot, dcm };
}

console.log('Interim-deficit charging (last-flight-full) — node harness\n');

let data;
try { data = await sim('EHAM', 'EHGG', 'beta_plane', 'dc_250'); }   // short retour: round-trip drains << battery
catch { console.log(`SKIP: server at ${BASE} not reachable.`); process.exit(0); }
if (data.error) { console.log('SKIP (sim error):', data.error); process.exit(0); }

const S = loadStack(); S.CNSSettings.reset();
const shared3   = totals(S, savedTrip('EHAM', 'EHGG', 'beta_plane', data, 3, 'shared', 'dc_250'));
const separate3 = totals(S, savedTrip('EHAM', 'EHGG', 'beta_plane', data, 3, 'separate', 'dc_250'));
const shared1   = totals(S, savedTrip('EHAM', 'EHGG', 'beta_plane', data, 1, 'shared', 'dc_250'));

console.log(`  shared  3x/day: energy=${shared3.energy} kWh  minutes=${shared3.minutes}  per-rotation=[${shared3.byRot}]`);
console.log(`  separate 3 a/c: energy=${separate3.energy} kWh  minutes=${separate3.minutes}  per-rotation=[${separate3.byRot}]`);
console.log(`  shared  1x/day: energy=${shared1.energy} kWh  minutes=${shared1.minutes}\n`);

test('conservation: shared total charge energy == all-to-full reference', () => {
  assert.ok(near(shared3.energy, separate3.energy, 1.0), `shared ${shared3.energy} vs reference ${separate3.energy}`);
});
test('the win: shared total charge MINUTES < all-to-full reference (taper avoidance)', () => {
  assert.ok(shared3.minutes < separate3.minutes - 0.5, `shared ${shared3.minutes} not < reference ${separate3.minutes}`);
});
test('distinction: the 3 shared rotations are NOT all identical (first/interim/last differ)', () => {
  const [a, b, c] = shared3.byRot;
  assert.equal(shared3.byRot.length, 3, `expected 3 rotations, got ${shared3.byRot.length}`);
  assert.ok(!(a === b && b === c), `rotations identical: [${shared3.byRot}] — feature did not engage`);
});
test('final rotation tops up the most (its base charge reaches 100%)', () => {
  const last = shared3.byRot[2], interim = shared3.byRot[1];
  assert.ok(last > interim, `last ${last} should exceed interim ${interim}`);
});
test('parity: a 1x/day shared retour is a single unchanged rotation', () => {
  assert.equal(shared1.byRot.length, 1, `expected 1 rotation, got ${shared1.byRot.length}`);
});
test('reporting: dailyChargeMinutesAt @ base is LOWER for shared than the all-to-full reference', () => {
  assert.ok(shared3.dcm != null && separate3.dcm != null, 'dailyChargeMinutesAt unavailable');
  assert.ok(shared3.dcm < separate3.dcm - 0.5, `base daily charge min: shared ${shared3.dcm} not < reference ${separate3.dcm}`);
});

console.log(`  reporting dailyChargeMinutesAt @ base: shared=${shared3.dcm}  separate=${separate3.dcm}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
