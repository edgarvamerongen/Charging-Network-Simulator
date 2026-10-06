/*
 * Node harness for CNSDemand (static/demand.js) — the per-airport demand model.
 *
 * demand.js attaches to window and uses CNSState for storage; we shim both.
 * The per-trip energy math (deliveredEnergy / recomputeMultiLegCharges) moved to the
 * unified engine (static/flight-model.js), tested in js_flight_model + js_flight_adapter.
 * What remains here is CNSDemand's own surface: the per-airport contribution grouping
 * and resolveTargetSoc (LOCAL-over-GLOBAL target).
 *
 * Run:  node tests/js_demand.test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function loadDemand(globalTarget) {
  const code = fs.readFileSync(path.join(REPO, 'static', 'demand.js'), 'utf8');
  const store = {};
  // Optional CNSSettings stub so resolveTargetSoc's GLOBAL fallback is
  // testable; `globalTarget` undefined => factor off (returns null). The file
  // reads it both as `window.CNSSettings` and the bare `CNSSettings` global
  // (same object in the browser), so expose it under both names here.
  const CNSSettings = { chargeTargetDefault: () => (globalTarget == null ? null : globalTarget), routingFactor: () => 1.0 };
  const sandbox = {
    CNSSettings,
    window: { CNSSettings },
    CNSState: {
      KEYS: { folder: 'cns_folder', cfg: 'cns_airport_cfg' },
      getJSON: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d),
      setJSON: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
    },
    console, JSON, Math, Object, Array, Number, isFinite, String,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.CNSDemand;
}

const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log('CNSDemand (static/demand.js) — node harness\n');
const D = loadDemand();

test('module loads', () => assert.equal(typeof D, 'object'));

// ---- computeAirports: a one-way ORIGIN is LISTED but charges ZERO ----------
// A one-way departure leaves FULL — its charge is accounted for where it last
// landed (a 'dest' there), so it adds NO charging demand at the origin. But the
// departure hub is still listed (a zero-energy 'origin' contribution) so it
// doesn't vanish from the DC; destinations and intermediate stops charge as before.
test('computeAirports: one-way single-leg — origin LISTED with 0 charging, dest charges', () => {
  D.saveFolder([{
    tripType: 'one-way', legEnergy: 90, battery: 225,
    originIdent: 'EDDB', originName: 'Berlin', originLat: 52.36, originLon: 13.50,
    destIdent: 'EHAM', destName: 'Amsterdam', destLat: 52.31, destLon: 4.77,
  }]);
  const ap = D.computeAirports();
  assert.ok('EHAM' in ap, 'one-way destination is missing');
  assert.equal(ap.EHAM.contribs[0].role, 'dest');
  assert.ok(approx(ap.EHAM.contribs[0].base, 90), 'dest still charges the full leg');
  assert.ok('EDDB' in ap, 'one-way ORIGIN should be LISTED (departure hub)');
  assert.equal(ap.EDDB.contribs[0].role, 'origin');
  assert.equal(ap.EDDB.contribs[0].base, 0, 'origin contributes ZERO charging (departs full)');
  D.saveFolder([]);
});

test('computeAirports: one-way MULTI-LEG — origin LISTED with 0 charging; stops + dest charge', () => {
  D.saveFolder([{
    multiLeg: true, tripType: 'one-way',
    originIdent: 'EDDB', originName: 'Berlin', originLat: 52.36, originLon: 13.50,
    destIdent: 'EHAM', destName: 'Amsterdam', destLat: 52.31, destLon: 4.77,
    legs: [{ energy_kwh: 15 }, { energy_kwh: 15 }],
    stops: [{ ident: 'EDDP' }],
    charges: [
      { ident: 'EDDP', name: 'Leipzig',   lat: 51.4, lon: 12.2, role: 'stop', at_index: 1, energy_kwh: 15 },
      { ident: 'EHAM', name: 'Amsterdam', lat: 52.31, lon: 4.77, role: 'dest', at_index: 2, energy_kwh: 15 },
    ],
  }]);
  const ap = D.computeAirports();
  assert.ok('EDDB' in ap, 'multi-leg one-way ORIGIN should be LISTED (departure hub)');
  assert.equal(ap.EDDB.contribs[0].role, 'origin');
  assert.equal(ap.EDDB.contribs[0].base, 0, 'origin contributes ZERO charging');
  assert.ok('EDDP' in ap, 'intermediate charging stop is missing');
  assert.ok('EHAM' in ap, 'destination is missing');
  D.saveFolder([]);
});

test('computeAirports: a RETOUR origin is still home (charges), not an origin tag', () => {
  D.saveFolder([{
    tripType: 'retour', legEnergy: 180, battery: 225,
    originIdent: 'EDDB', originName: 'Berlin', originLat: 52.36, originLon: 13.50,
    destIdent: 'EHAM', destName: 'Amsterdam', destLat: 52.31, destLon: 4.77,
  }]);
  const ap = D.computeAirports();
  assert.equal(ap.EDDB.contribs[0].role, 'home', 'retour origin must stay home (it recharges to fly back)');
  assert.ok(ap.EDDB.contribs[0].base > 0, 'retour home charges > 0');
  D.saveFolder([]);
});

test('computeAirports: every LANDING is listed, a stop reached with battery to spare as a 0 kWh contribution', () => {
  // Circuit EHLE -> EHRD -> EHWO -> EHLE: only the home recharge is stored (recompute keeps energy > 0),
  // yet the aircraft lands at EHRD and EHWO, so both belong in the network (the map draws them).
  D.saveFolder([{
    multiLeg: true, tripType: 'circular',
    originIdent: 'EHLE', originName: 'Lelystad', originLat: 52.45, originLon: 5.51,
    destIdent: 'EHWO', destName: 'Woensdrecht', destLat: 51.45, destLon: 4.34,
    stops: [{ ident: 'EHRD', name: 'Rotterdam', lat: 51.96, lon: 4.44 }],
    charges: [{ ident: 'EHLE', name: 'Lelystad', lat: 52.45, lon: 5.51, role: 'home', at_index: 3, energy_kwh: 469 }],
  }]);
  const ap = D.computeAirports();
  assert.deepEqual(Object.keys(ap).sort(), ['EHLE', 'EHRD', 'EHWO']);
  assert.equal(ap.EHLE.contribs.length, 1, 'home is listed once (its charge), no extra zero entry');
  assert.equal(ap.EHRD.contribs[0].role, 'stop'); assert.equal(ap.EHRD.contribs[0].base, 0); assert.equal(ap.EHRD.contribs[0].noCharge, true);
  assert.equal(ap.EHWO.contribs[0].role, 'dest'); assert.equal(ap.EHWO.contribs[0].base, 0);
  D.saveFolder([]);
});

// ---- computeAirports: a missing ident must NOT swallow other airports ------
// Airports are keyed by ident; if two arrive with a blank ident they used to
// collapse onto one empty key (first-write-wins) and the rest vanished. The
// key now falls back to name/coords so each keeps its own slot.
test('computeAirports: two ident-less airports both survive (no key collapse)', () => {
  D.saveFolder([
    { tripType: 'one-way', legEnergy: 50, battery: 225,
      originIdent: 'X1', originName: 'Origin 1', originLat: 1, originLon: 1,
      destIdent: '', destName: 'No-Ident A', destLat: 10, destLon: 10 },
    { tripType: 'one-way', legEnergy: 50, battery: 225,
      originIdent: 'X2', originName: 'Origin 2', originLat: 2, originLon: 2,
      destIdent: '', destName: 'No-Ident B', destLat: 20, destLon: 20 },
  ]);
  const names = Object.values(D.computeAirports()).map(a => a.name);
  assert.ok(names.includes('No-Ident A'), 'first ident-less airport was dropped');
  assert.ok(names.includes('No-Ident B'), 'second ident-less airport collapsed onto the first');
  D.saveFolder([]);
});

// ---- resolveTargetSoc: LOCAL (per-airport) overrides GLOBAL default --------
// The crux of the global charge-target feature: energy math reads the resolved
// target, where a per-airport value always wins over the model-settings default,
// and the default only applies when no per-airport value is set.
test('resolveTargetSoc: local per-airport target wins over global default', () => {
  const Dg = loadDemand(0.80);                       // global default 80%
  assert.ok(approx(Dg.resolveTargetSoc({ targetDepartureSoc: 0.6 }), 0.6), 'local 60% should win');
});
test('resolveTargetSoc: falls back to global default when no local target', () => {
  const Dg = loadDemand(0.80);
  assert.ok(approx(Dg.resolveTargetSoc({}), 0.80), 'empty cfg should inherit global 80%');
  assert.ok(approx(Dg.resolveTargetSoc(null), 0.80), 'null cfg should inherit global 80%');
});
test('resolveTargetSoc: null (deficit) when factor off and no local target', () => {
  const Doff = loadDemand(null);                     // chargeTarget factor off
  assert.equal(Doff.resolveTargetSoc({}), null, 'no global, no local => null/deficit');
  assert.ok(approx(Doff.resolveTargetSoc({ fullCharge: true }), 1.0), 'legacy fullCharge still resolves to 1.0');
});
