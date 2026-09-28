/*
 * CNSScheduler.whatIfChargers — the read-only "what if this airport had N chargers" run behind the
 * v2 sizing prototype. It must answer (more chargers → shorter queue), agree with the real run for
 * the real fleet, and leave storage and the scheduler's caches exactly as it found them.
 *
 * Server up on :5055 for /api/simulate geometry (like js_interim_charging). Skips when it is down.
 * Run:  CNS_BASE_URL=http://127.0.0.1:5055 node --test tests/js_whatif.test.mjs
 */
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadStack, AP } from './golden_capture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANES = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'planes.fixture.json'), 'utf8')).map(p => [p.id, p]));
const BASE = process.env.CNS_BASE_URL || 'http://127.0.0.1:5055';
const CHARGERS = { dc_250: { id: 'dc_250', name: '250 kW DC', power_kw: 250 } };
const co = k => ({ ident: k, name: AP[k].name, lat: AP[k].lat, lon: AP[k].lon });

let data = null, skip = null;
try {
  const r = await fetch(BASE + '/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin: co('EHAM'), destination: co('EHGG'), plane_id: 'beta_plane', charger_id: 'dc_250', trip_type: 'retour' }) });
  data = await r.json(); if (data.error) skip = 'sim error: ' + data.error;
} catch (e) { skip = `server at ${BASE} not reachable`; }

if (skip) test('whatIfChargers', { skip }, () => {});
else {
  const P = PLANES.beta_plane;
  // Six separate aircraft all leave EHAM at 07:00 and turn at EHGG: one charger there makes them queue.
  const trip = { id: 't-q', planeId: 'beta_plane', planeName: P.name, tripType: 'retour',
    originIdent: 'EHAM', originName: AP.EHAM.name, originLat: AP.EHAM.lat, originLon: AP.EHAM.lon,
    destIdent: 'EHGG', destName: AP.EHGG.name, destLat: AP.EHGG.lat, destLon: AP.EHGG.lon,
    battery: P.battery_kwh, range_km: P.range_km, speed_kmh: P.speed_kmh, chargerId: 'dc_250', chargerName: 'dc_250', chargerPower: 250,
    legEnergy: data.leg_energy_kwh, flightTimeH: data.flight_time_h, freqN: 6, freqUnit: 'day', fleetMode: 'separate' };
  const S = loadStack(); S.CNSSettings.reset();
  S.localStorage.setItem('cns_folder', JSON.stringify([trip]));
  S.localStorage.setItem('cns_airport_cfg', JSON.stringify({ EHGG: { chargers: ['dc_250'] } }));
  S.CNSScheduler.init({ chargers: CHARGERS });
  const queueAt = ident => { let q = 0; S.CNSScheduler.runGlobal().lanes.forEach(L => L.rotations.forEach(r => r.phases.forEach(ph => { if (ph.kind === 'charge' && ph.ident === ident) q += ph.wait || 0; }))); return q; };

  S.CNSScheduler.runGlobal(); S.CNSScheduler.runGlobal();   // the first run writes the default take-off schedule, the second settles on it
  const g0 = S.CNSScheduler.runGlobal(), q1 = queueAt('EHGG');
  const store0 = ['cns_folder', 'cns_airport_cfg', 'cns_schedule'].map(k => S.localStorage.getItem(k));
  const qSame = S.CNSScheduler.whatIfChargers('EHGG', ['dc_250'], () => queueAt('EHGG'));
  const q3 = S.CNSScheduler.whatIfChargers('EHGG', ['dc_250', 'dc_250', 'dc_250'], () => queueAt('EHGG'));
  const peak3 = S.CNSScheduler.whatIfChargers('EHGG', ['dc_250', 'dc_250', 'dc_250'], () => S.CNSScheduler.summary('EHGG').peakKw);

  test('one charger for six simultaneous turnarounds makes a queue', () => assert.ok(q1 > 0, `queue ${q1}`));
  test('the real fleet, asked as a what-if, gives the real answer', () => assert.equal(qSame, q1));
  test('three chargers shorten the queue and raise the peak', () => {
    assert.ok(q3 < q1, `queue with 3 chargers ${q3} not below ${q1}`);
    assert.ok(peak3 > S.CNSScheduler.summary('EHGG').peakKw, 'peak did not rise with more chargers');
  });
  test('nothing is saved and the caches come back', () => {
    assert.deepEqual(['cns_folder', 'cns_airport_cfg', 'cns_schedule'].map(k => S.localStorage.getItem(k)), store0);
    assert.equal(S.CNSScheduler.runGlobal(), g0, 'runGlobal cache not restored');
    assert.equal(queueAt('EHGG'), q1);
  });
}
