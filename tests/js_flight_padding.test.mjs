/*
 * Padding-model test for the unified engine (static/flight-model.js).
 *
 * Decision ("pad the route length"): routing padding lands on the LENGTH (distKm),
 * and energy + time DERIVE from the routed length, so per leg the three reconcile:
 *     distKm   == rawKm * routingFactor          (great-circle -> routed)
 *     energyKwh == ePerKm * distKm               (ePerKm = battery/range)
 *     flightMin == distKm / speed * 60
 * rawKm stays great-circle (geographic) for the map arc. Reachability still keys
 * off energy vs usable, so it is UNCHANGED by where the padding is shown.
 *
 * Training legs are intentionally excluded — their padding is a separate, deferred
 * (G4a) decision and they keep distKm == rawKm for now.
 *
 * Run:  node tests/js_flight_padding.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadStack, AP } from './golden_capture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANES = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(REPO, 'planes.json'), 'utf8')).map(p => [p.id, p]));
const wp = (k) => ({ ident: k, name: AP[k].name, lat: AP[k].lat, lon: AP[k].lon });

let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); pass++; console.log(`  ok   ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); } };
const approx = (a, b, tol) => Math.abs(a - b) <= (tol == null ? Math.max(1e-6, Math.abs(b) * 1e-4) : tol);

console.log('CNSFlight padding model (static/flight-model.js) — node harness\n');

// Multi-leg one-way Beta with a stop, padding ON (shipped default 1.05).
function run(padding = true) {
  const S = loadStack();
  S.CNSSettings.reset();
  if (!padding) S.CNSSettings.save({ routingPadding: { enabled: false } });
  const prof = S.CNSFlight.simulateTrip(PLANES.beta_plane, [wp('EHAM'), wp('EHRD'), wp('EGLL')],
    { tripType: 'one-way', getTargetSoc: () => S.CNSSettings.chargeTargetDefault(), getChargerKw: () => 250 });
  return { prof, route: S.CNSSettings.routingFactor() };
}
const P = PLANES.beta_plane;
const ePerKm = P.battery_kwh / P.range_km;

test('routing padding is ON by default (1.05)', () => {
  const { route } = run();
  assert.ok(approx(route, 1.05), `routingFactor ${route}`);
});

test('distKm == rawKm * routingFactor — padding lands on the LENGTH', () => {
  const { prof, route } = run();
  for (const l of prof.legs) assert.ok(approx(l.distKm, l.rawKm * route), `${l.toName}: distKm ${l.distKm} vs rawKm*route ${l.rawKm * route}`);
});

test('energy reconciles with the routed distance (energyKwh == ePerKm * distKm)', () => {
  const { prof } = run();
  for (const l of prof.legs) assert.ok(approx(l.energyKwh, ePerKm * l.distKm), `${l.toName}: energy ${l.energyKwh} vs ePerKm*distKm ${ePerKm * l.distKm}`);
});

test('time reconciles with the routed distance (flightMin == distKm / speed)', () => {
  const { prof } = run();
  for (const l of prof.legs) assert.ok(approx(l.flightMin, l.distKm / P.speed_kmh * 60), `${l.toName}: time ${l.flightMin} vs distKm/speed ${l.distKm / P.speed_kmh * 60}`);
});

test('rawKm stays great-circle (geographic), strictly shorter than routed distKm', () => {
  const { prof, route } = run();
  const l = prof.legs[0];
  assert.ok(l.rawKm > 0 && l.rawKm < l.distKm, `rawKm ${l.rawKm} should be < distKm ${l.distKm}`);
  assert.ok(approx(l.distKm / l.rawKm, route), `distKm/rawKm ${l.distKm / l.rawKm} should equal routingFactor ${route}`);
});

test('total distKm == sum of routed legs', () => {
  const { prof } = run();
  const sum = prof.legs.reduce((s, l) => s + l.distKm, 0);
  assert.ok(approx(prof.totals.distKm, sum), `total ${prof.totals.distKm} vs sum ${sum}`);
});

test('avgUsageKwhPer100km is unchanged by the move (== ePerKm * 100)', () => {
  const { prof } = run();
  assert.ok(approx(prof.totals.avgUsageKwhPer100km, ePerKm * 100, 0.05), `avg ${prof.totals.avgUsageKwhPer100km} vs ePerKm*100 ${ePerKm * 100}`);
});

test('padding OFF -> distKm == rawKm (no routed inflation)', () => {
  const { prof } = run(false);
  for (const l of prof.legs) assert.ok(approx(l.distKm, l.rawKm), `padding off: distKm ${l.distKm} should == rawKm ${l.rawKm}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
