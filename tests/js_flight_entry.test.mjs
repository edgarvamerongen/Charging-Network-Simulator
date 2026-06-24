/*
 * CNSFlightEntry — node harness for the sim-response → demand-folder mapper.
 * Run:  node tests/js_flight_entry.test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function load() {
  const code = fs.readFileSync(path.join(REPO, 'static', 'flight-entry.js'), 'utf8');
  const sandbox = { window: {}, console, JSON };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.CNSFlightEntry;
}

const ORIGIN = { ident: 'EHLE', name: 'Lelystad', lat: 52.46, lon: 5.52 };
const DEST = { ident: 'EDDF', name: 'Frankfurt', lat: 50.03, lon: 8.56 };

test('fromSim maps a single-leg response and preserves the explicit id', () => {
  const E = load();
  const d = {
    plane: { id: 'beta_plane', name: 'Beta Alia', svg: 'beta.svg', battery_kwh: 225, c_rate: 1, range_km: 500, speed_kmh: 250 },
    charger: { name: 'Cube 320', power_kw: 320 },
    trip_type: 'oneway', leg_energy_kwh: 154.3, recharge_energy_kwh: 154.3, flight_time_h: 1.4,
  };
  const e = E.fromSim(d, { origin: ORIGIN, dest: DEST, chargerId: 'dc_320', freqN: 2, freqUnit: 'day', id: 'f1' });
  assert.equal(e.id, 'f1');
  assert.equal(e.originIdent, 'EHLE');
  assert.equal(e.originLat, 52.46);
  assert.equal(e.destIdent, 'EDDF');
  assert.equal(e.planeId, 'beta_plane');
  assert.equal(e.chargerId, 'dc_320');
  assert.equal(e.legEnergy, 154.3);
  assert.equal(e.freqN, 2);
  assert.equal(e.multiLeg, undefined);
  // The demand-calc recompute rebuilds the routing plane from these — without
  // them every restored flight is "Aircraft has no range" → infeasible.
  assert.equal(e.range_km, 500);
  assert.equal(e.speed_kmh, 250);
});

test('fromSim carries multi-leg fields through', () => {
  const E = load();
  const d = {
    plane: { id: 'vaeridion', name: 'Vaeridion', svg: 'v.svg', battery_kwh: 600, c_rate: 2, range_km: 1000, speed_kmh: 320 },
    charger: { name: '1 MW', power_kw: 1000 },
    trip_type: 'oneway', leg_energy_kwh: 100, multi_leg: true,
    total_flight_time_h: 3.2, total_recharge_energy_kwh: 280,
    stops: [{ ident: 'EDLV', name: 'Niederrhein', lat: 51.6, lon: 6.1 }],
    charges: [{ ident: 'EDLV', energy_kwh: 120, role: 'stop', at_index: 1 }],
    legs: 2, total_distance_km: 700, total_charge_time_min: 60,
  };
  const e = E.fromSim(d, { origin: ORIGIN, dest: DEST, chargerId: 'dc_1000', freqN: 1, freqUnit: 'day', id: 'x' });
  assert.equal(e.multiLeg, true);
  assert.deepEqual(e.stops, d.stops);
  assert.deepEqual(e.charges, d.charges);
  assert.equal(e.totalDistanceKm, 700);
  assert.equal(e.range_km, 1000);
  assert.equal(e.speed_kmh, 320);
});
