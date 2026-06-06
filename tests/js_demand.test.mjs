/*
 * Node harness for CNSDemand (static/demand.js) — the per-airport demand model.
 *
 * demand.js attaches to window and uses CNSState for storage; we shim both.
 * We focus on the PURE energy helpers (deliveredEnergy / energyAt /
 * recomputeMultiLegCharges) that decide how much each airport must deliver —
 * the numbers that feed the demand drawer, scheduler peak, and PDF.
 *
 * Key invariant under test: for a retour trip, the energy delivered at the
 * destination plus the energy delivered at home equals the round-trip
 * consumption (2 x leg) — energy conservation across the cycle, which the
 * file's docstring explicitly promises ("DEST_kWh + HOME_kWh = 2xleg always").
 *
 * Run:  node tests/js_demand.test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

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

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log('CNSDemand (static/demand.js) — node harness\n');
const D = loadDemand();

test('module loads', () => assert.equal(typeof D, 'object'));

// ---- deliveredEnergy: one-way arrival -------------------------------------
test('one-way arrival: charge == leg when departing/ending full', () => {
  // batt 225, leg 90 -> arrival 135, target 100% -> 225 - 135 = 90 == leg.
  const e = D.deliveredEnergy({ tripType: 'one-way' }, 'dest', 90, 225, 225, null, null);
  assert.ok(approx(e, 90), `got ${e}`);
});

test('one-way arrival: charges to 100% even with a low target (ignores DCT)', () => {
  // A one-way flight departs base full and tops back up to 100% on arrival,
  // regardless of the charge target: batt 225, leg 90 -> arrival 135, fills to
  // 225 -> delivers 90 (the full leg) whether the target is 0.8 or unset.
  const low  = D.deliveredEnergy({ tripType: 'one-way' }, 'dest', 90, 225, 225, 0.8, null);
  const none = D.deliveredEnergy({ tripType: 'one-way' }, 'dest', 90, 225, 225, null, null);
  assert.ok(approx(low, 90) && approx(none, 90), `one-way arrival should ignore DCT: low ${low}, none ${none}`);
});

// ---- deliveredEnergy: retour energy conservation --------------------------
test('retour: DEST + HOME == 2*leg (no targets, deficit mode)', () => {
  const leg = 180, batt = 225;
  const dest = D.deliveredEnergy({ tripType: 'retour' }, 'dest', leg, batt, batt, null, null);
  const home = D.deliveredEnergy({ tripType: 'retour' }, 'home', leg, batt, batt, null, null);
  assert.ok(approx(dest + home, 2 * leg), `dest ${dest} + home ${home} != ${2 * leg}`);
});

test('retour: deficit at dest matches max(0, 2*leg - batt)', () => {
  const leg = 180, batt = 225;
  const dest = D.deliveredEnergy({ tripType: 'retour' }, 'dest', leg, batt, batt, null, null);
  assert.ok(approx(dest, Math.max(0, 2 * leg - batt)), `got ${dest}`);
});

test('retour: when both legs fit, dest supplies 0', () => {
  const leg = 90, batt = 225;   // 2*leg = 180 < 225
  const dest = D.deliveredEnergy({ tripType: 'retour' }, 'dest', leg, batt, batt, null, null);
  assert.ok(approx(dest, 0), `got ${dest}`);
});

test('retour: conservation holds with explicit targets too', () => {
  const leg = 120, batt = 225;
  // both ends target 100%
  const dest = D.deliveredEnergy({ tripType: 'retour' }, 'dest', leg, batt, batt, 1.0, 1.0);
  const home = D.deliveredEnergy({ tripType: 'retour' }, 'home', leg, batt, batt, 1.0, 1.0);
  assert.ok(approx(dest + home, 2 * leg), `dest ${dest} + home ${home} != ${2 * leg}`);
});

// ---- deliveredEnergy: BASE always departs at 100% (regardless of DCT) ------
// The plane is based at HOME, so it always takes off from base on a full
// charge no matter what departure charge target (DCT) is in effect — the
// target only governs the away-from-base (destination) end.
test('retour: HOME (base) departs full even with a low home target', () => {
  const leg = 120, batt = 225;
  // home target 0.6, dest target none. HOME must still depart at 100%, so the
  // home recharge equals what a 100% departure needs — identical to a 1.0
  // (or null) home target. Only the dest end would react to a target.
  const homeLow  = D.deliveredEnergy({ tripType: 'retour' }, 'home', leg, batt, batt, 0.6, null);
  const homeFull = D.deliveredEnergy({ tripType: 'retour' }, 'home', leg, batt, batt, 1.0, null);
  const homeNull = D.deliveredEnergy({ tripType: 'retour' }, 'home', leg, batt, batt, null, null);
  assert.ok(approx(homeLow, homeFull) && approx(homeLow, homeNull),
    `home base should ignore its DCT: low ${homeLow}, full ${homeFull}, null ${homeNull}`);
});

test('retour: conservation still holds when only DEST has a low target', () => {
  const leg = 120, batt = 225;
  // dest target 0.6 (this end reacts), home (base) stays full.
  const dest = D.deliveredEnergy({ tripType: 'retour' }, 'dest', leg, batt, batt, 0.6, null);
  const home = D.deliveredEnergy({ tripType: 'retour' }, 'home', leg, batt, batt, null, 0.6);
  assert.ok(approx(dest + home, 2 * leg), `dest ${dest} + home ${home} != ${2 * leg}`);
});

// ---- recomputeMultiLegCharges: BASE departs full regardless of DCT ---------
test('multi-leg: origin (base) departs full, so the first stop only tops up its leg', () => {
  // Origin → stop → dest, each leg 30 kWh, batt 100, no reserve. With the
  // origin departing at 100% it arrives at the stop with 70; a GLOBAL 0.8
  // target at the stop charges it to 80 → delivers 10. A non-base origin
  // departing at 0.8 (the old behaviour) would have arrived at 50, charged 30.
  const trip = {
    multiLeg: true, tripType: 'one-way', originIdent: 'BASE', battery: 100,
    legs: [{ energy_kwh: 30 }, { energy_kwh: 30 }],
    charges: [
      { ident: 'STOP', role: 'stop', at_index: 1, energy_kwh: 30 },
      { ident: 'DEST', role: 'dest', at_index: 2, energy_kwh: 30 },
    ],
  };
  // Global target 0.8 everywhere; the base must still depart at 100% and the
  // one-way destination must charge to 100% on arrival (ignoring the target).
  const out = D.recomputeMultiLegCharges(trip, () => 0.8, 100);
  assert.ok(approx(out[0].energy_kwh, 10), `stop after full-base departure should be 10, got ${out[0].energy_kwh}`);
  // arrive dest at 80 - 30 = 50, fill to 100 -> 50 delivered (not 0.8*100 - 50 = 30).
  assert.ok(approx(out[1].energy_kwh, 50), `one-way destination should charge to 100% on arrival, got ${out[1].energy_kwh}`);
});

// ---- deliveredEnergy: training cap ----------------------------------------
test('training: capped at usable battery', () => {
  // leg (pattern) 30 kWh, usable 20 -> capped at 20.
  const e = D.deliveredEnergy({ tripType: 'training' }, 'training', 30, 100, 20, null, null);
  assert.ok(approx(e, 20), `got ${e}`);
});

test('training: below cap returns the pattern energy', () => {
  const e = D.deliveredEnergy({ tripType: 'training' }, 'training', 15, 100, 100, null, null);
  assert.ok(approx(e, 15), `got ${e}`);
});

// ---- energyAt (legacy single-leg path) ------------------------------------
test('energyAt: one-way dest == legEnergy', () => {
  const trip = { tripType: 'one-way', destIdent: 'X', legEnergy: 90, battery: 225 };
  assert.ok(approx(D.energyAt(trip, 'X', false), 90));
});

test('energyAt: retour home == min(2*leg, batt)', () => {
  const trip = { tripType: 'retour', originIdent: 'H', destIdent: 'D', legEnergy: 180, battery: 225 };
  assert.ok(approx(D.energyAt(trip, 'H', false), Math.min(360, 225)));   // 225
});

// ---- computeAirports: a one-way ORIGIN does NOT charge ---------------------
// Model decision (B): a one-way departure leaves FULL — its charge is accounted
// for at the airport where it last landed (a 'dest' there), so charging it again
// at the origin would double-count. The origin contributes no charging demand;
// destinations and intermediate stops still do.
test('computeAirports: one-way single-leg charges the DEST, not the origin', () => {
  D.saveFolder([{
    tripType: 'one-way', legEnergy: 90, battery: 225,
    originIdent: 'EDDB', originName: 'Berlin', originLat: 52.36, originLon: 13.50,
    destIdent: 'EHAM', destName: 'Amsterdam', destLat: 52.31, destLon: 4.77,
  }]);
  const ap = D.computeAirports();
  assert.ok('EHAM' in ap, 'one-way destination is missing');
  assert.equal(ap.EHAM.contribs[0].role, 'dest');
  assert.ok(!('EDDB' in ap), 'one-way ORIGIN must not contribute charging (departs full)');
  D.saveFolder([]);
});

test('computeAirports: one-way MULTI-LEG charges stops + dest, not the origin', () => {
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
  assert.ok(!('EDDB' in ap), 'multi-leg one-way ORIGIN must not contribute charging (departs full)');
  assert.ok('EDDP' in ap, 'intermediate charging stop is missing');
  assert.ok('EHAM' in ap, 'destination is missing');
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
