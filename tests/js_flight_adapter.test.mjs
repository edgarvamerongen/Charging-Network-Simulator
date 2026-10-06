/*
 * CNSFlight saved-trip adapter parity — profileForTrip + chargeEnergyAt.
 *
 * These two functions are the SHARED adapter the demand drawer (index.html) and the
 * PDF report (report.js) both build per-airport contribution energy from. This test
 * rebuilds each golden saved-trip from its coords and locks the adapter's own contract:
 * chargeEnergyAt resolves every charge and energyAt(ident) sums them. Charge VALUES are
 * golden-verified in js_flight_model. Server-free (reads the golden).
 *
 * Run:  node tests/js_flight_adapter.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadStack, AP } from './golden_capture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANES = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'planes.fixture.json'), 'utf8')).map(p => [p.id, p]));
const GP = path.join(REPO, 'tests', 'goldens', 'flight-current.golden.json');
if (!fs.existsSync(GP)) { console.log('SKIP: no golden (run node tests/golden_capture.mjs).'); process.exit(0); }
const golden = JSON.parse(fs.readFileSync(GP, 'utf8'));
const co = (k) => ({ ident: k, name: AP[k].name, lat: AP[k].lat, lon: AP[k].lon });

// Reconstruct a saved folder trip from a golden case (coords + sim legs/charges).
function savedTrip(c) {
  const P = PLANES[c.input.plane], o = c.input.o, dest = c.input.trip === 'training' ? o : c.input.d;
  const t = {
    id: c.name, planeId: c.input.plane, tripType: c.input.trip,
    originIdent: o, originName: AP[o].name, originLat: AP[o].lat, originLon: AP[o].lon,
    destIdent: dest, destName: AP[dest].name, destLat: AP[dest].lat, destLon: AP[dest].lon,
    battery: P.battery_kwh, range_km: P.range_km, speed_kmh: P.speed_kmh,
    legEnergy: c.input.sim.leg_energy_kwh,
  };
  if (c.input.sim.multi_leg) { t.multiLeg = true; t.stops = (c.input.stops || []).map(co); t.legs = c.input.sim.legs; t.charges = c.input.sim.charges; }
  else if (c.input.trip === 'training') t.trainingRangeKm = P.training_range_km;
  return t;
}

const near = (a, b) => Math.abs((+a || 0) - (+b || 0)) <= Math.max(0.05, Math.abs(+b || 0) * 0.01);

console.log('CNSFlight saved-trip adapter (profileForTrip + chargeEnergyAt) — node harness\n');

const S = loadStack();
S.CNSSettings.reset();
const getT = () => S.CNSSettings.chargeTargetDefault();   // global target (golden has no per-airport overrides)

test('chargeEnergyAt: multi-leg maps by chargeIdx, single-leg by role; null-safe', () => {
  const prof = { charges: [{ role: 'stop', energyKwh: 10 }, { role: 'dest', energyKwh: 20 }] };
  assert.equal(S.CNSFlight.chargeEnergyAt(prof, { t: { multiLeg: true }, chargeIdx: 1 }), 20);
  assert.equal(S.CNSFlight.chargeEnergyAt(prof, { t: { multiLeg: true }, chargeIdx: 0 }), 10);
  assert.equal(S.CNSFlight.chargeEnergyAt(prof, { t: {}, role: 'dest' }), 20);
  assert.equal(S.CNSFlight.chargeEnergyAt(null, { t: {}, role: 'dest' }), null);
});

test('chargeEnergyAt: the stored charges skip 0 kWh landings; match by leg index + airport, not position', () => {
  // A circuit O -> EHRD -> EHWO -> O lands twice with battery to spare: the profile lists three charges,
  // the stored trip only the home recharge (recompute keeps energy > 0). chargeIdx 0 must read the 469 kWh.
  const prof = { charges: [{ ident: 'EHRD', atIndex: 1, energyKwh: 0 }, { ident: 'EHWO', atIndex: 2, energyKwh: 0 }, { ident: 'EHLE', atIndex: 3, energyKwh: 469 }] };
  const t = { multiLeg: true, charges: [{ ident: 'EHLE', at_index: 3, energy_kwh: 469 }] };
  assert.equal(S.CNSFlight.chargeEnergyAt(prof, { t, chargeIdx: 0 }), 469);
  // a stored charge with no matching leg index still finds its airport
  assert.equal(S.CNSFlight.chargeEnergyAt(prof, { t: { multiLeg: true, charges: [{ ident: 'EHLE' }] }, chargeIdx: 0 }), 469);
  // a zero-energy landing contribution (no chargeIdx) reads nothing
  assert.equal(S.CNSFlight.chargeEnergyAt(prof, { t, role: 'stop', noCharge: true }), null);
});

test('profileForTrip returns null for an old save without coords (caller handles null)', () => {
  assert.equal(S.CNSFlight.profileForTrip({ planeId: 'beta_plane', battery: 225, range_km: 600 }, { getTargetSoc: getT }), null);
});

// The adapter rebuilds a FlightProfile from a saved trip's coords/stops and maps each
// per-airport contribution back to its charge. Legacy demand-math parity is retired (the
// engine is the only path now); the charge VALUES are golden-verified in js_flight_model.
// Here we lock the adapter's own contract: chargeEnergyAt resolves every charge (multi-leg
// by position, single-leg by role), and energyAt(ident) == the sum of that airport's charges.
for (const c of golden.cases) {
  test(`adapter rebuilds + maps charges self-consistently: ${c.name}`, () => {
    const t = savedTrip(c);
    const prof = S.CNSFlight.profileForTrip(t, { getTargetSoc: getT });
    assert.ok(prof, 'profileForTrip should resolve from coords + catalog');
    const byIdent = {};
    prof.charges.forEach((ch, i) => {
      const e = t.multiLeg ? S.CNSFlight.chargeEnergyAt(prof, { t, chargeIdx: i })
                           : S.CNSFlight.chargeEnergyAt(prof, { t, role: ch.role });
      assert.ok(near(e, ch.energyKwh), `charge ${i} (${ch.role}) maps to ${(+e).toFixed(2)} vs ${(+ch.energyKwh).toFixed(2)}`);
      byIdent[ch.ident] = (byIdent[ch.ident] || 0) + ch.energyKwh;
    });
    for (const ident in byIdent) {
      assert.ok(near(prof.energyAt(ident), byIdent[ident]), `energyAt(${ident}) ${(+prof.energyAt(ident)).toFixed(2)} == sum ${(+byIdent[ident]).toFixed(2)}`);
    }
  });
}
