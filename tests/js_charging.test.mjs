/*
 * Node harness for CNSCharging (static/charging.js) — the per-airport charger
 * assignment heuristic that drives charge times + peak power.
 *
 * charging.js is a pure module (no DOM, no CNSState), so it loads in a vm
 * context with just a window stub.
 *
 * Contract under test (from the file's own docstring):
 *   1. biggest aircraft -> most powerful charger (size-ranked pairing).
 *   2. charge time = energy / power * 60 (linear).
 *   3. more aircraft than chargers -> they wrap (queue); `queued` counts them.
 *   4. peakPower = sum of the DISTINCT in-use chargers (never double-counts a
 *      charger even if two aircraft share it) — this is the invariant the
 *      scheduler comment flags as historically broken. A charger serving only a
 *      0-energy pass-through aircraft is NOT in use (draws nothing) and must not
 *      contribute to peak.
 *
 * Run:  node tests/js_charging.test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function loadCharging() {
  const code = fs.readFileSync(path.join(REPO, 'static', 'charging.js'), 'utf8');
  const sandbox = { window: {}, console, JSON, Math, Object, Array, Number, isFinite };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.CNSCharging;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log('CNSCharging (static/charging.js) — node harness\n');
const C = loadCharging();

test('module loads', () => assert.equal(typeof C, 'object'));

test('biggest aircraft pairs with most powerful charger', () => {
  const plan = C.planCharging(
    [{ id: 'a', power_kw: 172 }, { id: 'b', power_kw: 400 }],
    [{ name: 'big', energy: 200, size: 500 }, { name: 'small', energy: 20, size: 22 }]);
  assert.equal(plan.assignments[0].power, 400, 'big -> 400 kW');
  assert.equal(plan.assignments[1].power, 172, 'small -> 172 kW');
});

test('charge time == energy / power * 60', () => {
  const plan = C.planCharging(
    [{ id: 'b', power_kw: 400 }],
    [{ name: 'big', energy: 200, size: 500 }]);
  assert.ok(approx(plan.assignments[0].chargeTimeMin, 200 / 400 * 60));
});

test('peakPower == sum of DISTINCT in-use chargers', () => {
  const plan = C.planCharging(
    [{ id: 'a', power_kw: 172 }, { id: 'b', power_kw: 400 }],
    [{ name: 'big', energy: 200, size: 500 }, { name: 'small', energy: 20, size: 22 }]);
  assert.equal(plan.peakPower, 572);            // 400 + 172, both used
});

test('two aircraft sharing ONE charger do not double-count peak', () => {
  // INVARIANT the scheduler docstring flags: a single 400 kW charger serving
  // two aircraft must contribute 400 kW to peak, not 800.
  const plan = C.planCharging(
    [{ id: 'b', power_kw: 400 }],
    [{ name: 'x', energy: 100, size: 500 }, { name: 'y', energy: 50, size: 200 }]);
  assert.equal(plan.numChargers, 1);
  assert.equal(plan.queued, 1, 'one aircraft is queued behind the other');
  assert.equal(plan.peakPower, 400, 'shared charger counted once');
});

test('zero-energy pass-through aircraft draws no peak power', () => {
  // A flight that overflies an airport WITHOUT charging (arrives with enough) is
  // still assigned a charger for ordering, but delivers 0 kWh, so it must NOT add
  // to peak. Regression: the demand card showed a phantom 60 kW peak at such an
  // airport (0 kWh / 0 min, yet "60 kW") because the 0-energy slot counted as in-use.
  const plan = C.planCharging(
    [{ id: 'dc60', power_kw: 60 }],
    [{ name: 'beta', energy: 0, size: 225 }]);
  assert.equal(plan.peakPower, 0, '0 kWh delivered -> 0 kW peak');
  assert.equal(plan.assignments[0].chargeTimeMin, 0, '0-energy charge takes 0 min');
});

test('mixed energies: only actually-charging aircraft count toward peak', () => {
  const plan = C.planCharging(
    [{ id: 'big', power_kw: 400 }, { id: 'small', power_kw: 60 }],
    [{ name: 'charges', energy: 100, size: 500 },   // ranked 1st -> 400 kW, draws
     { name: 'passes',  energy: 0,   size: 225 }]); // ranked 2nd -> 60 kW, draws nothing
  assert.equal(plan.peakPower, 400, 'only the charging aircraft contributes to peak');
  assert.equal(plan.queued, 0, 'two chargers, two aircraft -> none queued');
});

test('more aircraft than chargers -> wrap-around assignment', () => {
  const plan = C.planCharging(
    [{ id: 'a', power_kw: 400 }, { id: 'b', power_kw: 100 }],
    [{ name: 'p1', energy: 10, size: 500 },
     { name: 'p2', energy: 10, size: 300 },
     { name: 'p3', energy: 10, size: 100 }]);
  assert.equal(plan.queued, 1);                 // 3 aircraft, 2 chargers
  // ranked: p1(500)->400, p2(300)->100, p3(100)-> wraps to 400
  assert.equal(plan.assignments[0].power, 400);
  assert.equal(plan.assignments[2].power, 400);
});

test('no chargers -> zero power, Infinity time, all queued', () => {
  const plan = C.planCharging([], [{ name: 'p', energy: 10, size: 100 }]);
  assert.equal(plan.assignments[0].power, 0);
  assert.equal(plan.assignments[0].chargeTimeMin, Infinity);
  assert.equal(plan.queued, 1);
  assert.equal(plan.peakPower, 0);
});

test('assignments preserve input order', () => {
  const plan = C.planCharging(
    [{ id: 'a', power_kw: 400 }, { id: 'b', power_kw: 100 }],
    [{ name: 'small', energy: 5, size: 50 }, { name: 'big', energy: 90, size: 900 }]);
  // input order is [small, big]; big should still get the 400 kW
  assert.equal(plan.assignments[1].power, 400);
  assert.equal(plan.assignments[0].power, 100);
});

// ---- manual-first override (forcedChargerId) --------------------------------

test('forcedChargerId pins a flight to its chosen charger (overrides priority)', () => {
  // Without a pin, the big aircraft (size 500) would take the 400 kW charger.
  // Pinning it to the 100 kW charger must win, and the small one then takes 400.
  const plan = C.planCharging(
    [{ id: 'big', power_kw: 400 }, { id: 'small', power_kw: 100 }],
    [{ name: 'pinned', energy: 50, size: 500, forcedChargerId: 'small' },
     { name: 'auto',   energy: 20, size: 22 }]);
  assert.equal(plan.assignments[0].power, 100, 'pinned flight forced onto 100 kW');
  assert.equal(plan.assignments[0].forced, true, 'marked as a manual pin');
  assert.equal(plan.assignments[1].power, 400, 'the auto flight takes the leftover 400 kW');
});

test('forced charge time uses the pinned charger power', () => {
  const plan = C.planCharging(
    [{ id: 'big', power_kw: 400 }, { id: 'small', power_kw: 100 }],
    [{ name: 'pinned', energy: 50, size: 500, forcedChargerId: 'small' }]);
  assert.ok(approx(plan.assignments[0].chargeTimeMin, 50 / 100 * 60));
});

test('a pin naming a charger not in the fleet falls back to automatic', () => {
  // 'ghost' isn't in the fleet → the flight rejoins the auto pool and lands on
  // the most powerful charger by the normal rule (no deadlock, no fighting).
  const plan = C.planCharging(
    [{ id: 'big', power_kw: 400 }, { id: 'small', power_kw: 100 }],
    [{ name: 'pinned', energy: 50, size: 500, forcedChargerId: 'ghost' }]);
  assert.equal(plan.assignments[0].power, 400);
  assert.ok(!plan.assignments[0].forced, 'not treated as a manual pin');
});

test('peak counts a pinned charger once, even when also auto-assigned', () => {
  // Two flights, both end up on the single 400 kW charger (one pinned, one auto).
  const plan = C.planCharging(
    [{ id: 'only', power_kw: 400 }],
    [{ name: 'pinned', energy: 50, size: 80, forcedChargerId: 'only' },
     { name: 'auto',   energy: 50, size: 900 }]);
  assert.equal(plan.peakPower, 400, 'shared charger counted once');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
