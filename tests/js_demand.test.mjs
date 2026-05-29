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

function loadDemand() {
  const code = fs.readFileSync(path.join(REPO, 'static', 'demand.js'), 'utf8');
  const store = {};
  const sandbox = {
    window: {},
    CNSState: {
      KEYS: { folder: 'cns_folder', cfg: 'cns_airport_cfg' },
      getJSON: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d),
      setJSON: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
    },
    console, JSON, Math, Object, Array, Number, isFinite,
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

test('one-way arrival: lower target reduces delivered energy', () => {
  // target 0.8 -> 0.8*225 - 135 = 45.
  const e = D.deliveredEnergy({ tripType: 'one-way' }, 'dest', 90, 225, 225, 0.8, null);
  assert.ok(approx(e, 0.8 * 225 - 135), `got ${e}`);
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
