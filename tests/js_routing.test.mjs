/*
 * Node harness for the browser-global CNSRouting planner (static/routing.js).
 *
 * routing.js attaches to window.CNSRouting and reads model factors through
 * window.CNSSettings. We load it in a vm context with a CNSSettings shim whose
 * usable / route / alternate-toggle we control per test, then drive planRoute
 * over a tiny synthetic geography on the equator (where 1 deg of longitude is a
 * fixed ~111.19 km, so leg distances are predictable).
 *
 * Run:  node tests/js_routing.test.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function loadRouting(flags) {
  const code = fs.readFileSync(path.join(REPO, 'static', 'routing.js'), 'utf8');
  const CNSSettings = {
    usableFraction: () => (flags.usable != null ? flags.usable : 1.0),
    routingFactor:  () => (flags.route  != null ? flags.route  : 1.0),
    alternateReserveEnabled: () => !!flags.requireAlt,
  };
  const sandbox = {
    window: { CNSSettings }, CNSSettings,
    console, JSON, Math, Object, Array, Set, Number, Infinity,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.CNSRouting;
}

// Equator airport at a given longitude; alt = its alternate_km.
const ap = (ident, lon, alt) => ({
  ident, name: ident, type: 'medium_airport',
  latitude_deg: 0, longitude_deg: lon, iata_code: '', alternate_km: alt,
});
const node = (ident, lon, alt) => ({ ident, lat: 0, lon, alternate_km: alt });
const PLANE = (range_km) => ({ range_km });

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

// planRoute builds its result inside the vm realm; assert.deepEqual is
// realm-sensitive, so copy the stop idents into THIS realm before comparing
// against plain array literals.
const idents = (res) => Array.from(res.stops, s => s.ident);

console.log('CNSRouting (static/routing.js) — node harness\n');

// Geography for all cases: equator airports, so 1 deg lon = ~111.19 km.
// O at lon 0; candidate stop at lon 1.5 (O->stop ~= 166.79 km); typical dest at
// lon 3.0 (O->D direct ~= 333.58 km, beyond a 200 km maxLeg -> needs a stop).

// 1. Toggle OFF: a feasible multi-stop route is produced (baseline).
test('alternate OFF: O-A-D via one stop when direct is out of range', () => {
  const R = loadRouting({ requireAlt: false });
  const O = node('O', 0.0, 0), D = node('D', 3.0, 0), A = ap('A', 1.5, 999);
  const res = R.planRoute({ origin: O, destination: D, plane: PLANE(200),
    allowedTypes: ['medium_airport'], allAirports: [O, A, D], options: {} });
  assert.equal(res.error, undefined, res.error);
  assert.equal(res.legCount, 2);
  assert.deepEqual(idents(res), ['A']);
});

// 2. Toggle ON, all alternate_km = 0: identical route to OFF (reserve term is 0).
test('alternate ON with zero alternate_km reproduces the OFF route', () => {
  const O = node('O', 0.0, 0), D = node('D', 3.0, 0), A = ap('A', 1.5, 0);
  const call = (requireAlt) => loadRouting({ requireAlt }).planRoute({
    origin: O, destination: D, plane: PLANE(200),
    allowedTypes: ['medium_airport'], allAirports: [O, A, D], options: {} });
  const off = call(false), on = call(true);
  assert.equal(on.error, undefined, on.error);
  assert.equal(on.legCount, off.legCount);
  assert.deepEqual(idents(on), idents(off));
});

// 3. A poorly-covered stop is rejected when its divert reserve won't fit.
//    O->A = 166.79 km, maxLeg = 200. altA = 50 -> 166.79 + 50 = 216.79 > 200.
//    No other candidate -> no route.
test('alternate ON: stop with a far alternate is rejected (no route)', () => {
  const O = node('O', 0.0, 0), D = node('D', 3.0, 5), A = ap('A', 1.5, 50);
  const res = loadRouting({ requireAlt: true }).planRoute({
    origin: O, destination: D, plane: PLANE(200),
    allowedTypes: ['medium_airport'], allAirports: [O, A, D], options: {} });
  assert.ok(res.error, 'expected a no-route error');
  assert.equal(res.legCount, 0);
});

// 4. With a better-covered alternative stop B, ON routes through B not A.
//    A at lon 1.5 altA = 50 (rejected); B at lon 1.5 altB = 5 (accepted).
test('alternate ON: planner picks the well-covered stop B over A', () => {
  const O = node('O', 0.0, 0), D = node('D', 3.0, 5);
  const A = ap('A', 1.5, 50), B = ap('B', 1.5, 5);
  const res = loadRouting({ requireAlt: true }).planRoute({
    origin: O, destination: D, plane: PLANE(200),
    allowedTypes: ['medium_airport'], allAirports: [O, A, B, D], options: {} });
  assert.equal(res.error, undefined, res.error);
  assert.deepEqual(idents(res), ['B']);
});

// 5. Direct-flight short-circuit deducts the DESTINATION's alternate.
//    O->D = 111.19 km, maxLeg = 130. altD = 30 -> 111.19 + 30 = 141.19 > 130,
//    so the direct hop is no longer allowed and (no stops available) it errors.
test('alternate ON: direct flight blocked when destination alternate too far', () => {
  const O = node('O', 0.0, 0), D = node('D', 1.0, 30);
  const res = loadRouting({ requireAlt: true }).planRoute({
    origin: O, destination: D, plane: PLANE(130),
    allowedTypes: ['medium_airport'], allAirports: [O, D], options: {} });
  assert.ok(res.error, 'expected the padded direct hop to be rejected');
});
test('alternate ON: direct flight allowed when destination alternate is near', () => {
  const O = node('O', 0.0, 0), D = node('D', 1.0, 10);
  const res = loadRouting({ requireAlt: true }).planRoute({
    origin: O, destination: D, plane: PLANE(130),
    allowedTypes: ['medium_airport'], allAirports: [O, D], options: {} });
  assert.equal(res.error, undefined, res.error);
  assert.equal(res.legCount, 1);
  assert.equal(res.stops.length, 0);
});

// 6. The divert reserve is NOT padded: it is alternate_km / route. Hold
//    maxLeg = 200 in both runs (range = 200*route, so maxLeg = range/route = 200).
//    O->stop = 166.79 km, altA = 35:
//      route 1.25: reserve 35/1.25 = 28.0 -> 166.79 + 28.0 = 194.79 <= 200 -> A accepted
//      route 1.0 : reserve 35/1.0  = 35.0 -> 166.79 + 35.0 = 201.79  > 200 -> A rejected (no route)
test('alternate reserve scales with 1/route (divert is unpadded)', () => {
  const mk = (route) => {
    const O = node('O', 0.0, 0), D = node('D', 3.0, 5), A = ap('A', 1.5, 35);
    return loadRouting({ requireAlt: true, route }).planRoute({
      origin: O, destination: D, plane: PLANE(200 * route),
      allowedTypes: ['medium_airport'], allAirports: [O, A, D], options: {} });
  };
  const padded = mk(1.25);   // reserve divided by 1.25 -> fits
  assert.equal(padded.error, undefined, padded.error);
  assert.deepEqual(idents(padded), ['A']);
  const unscaled = mk(1.0);  // reserve full -> A rejected -> no route
  assert.ok(unscaled.error, 'expected A to be rejected at route=1.0');
});

// 7. A node with no ident / no alternate_km imposes no reserve (fallback).
test('alternate ON: non-airport destination (no alternate_km) imposes no reserve', () => {
  const O = node('O', 0.0, 0);
  const D = { lat: 0, lon: 1.0 };  // custom point: no ident, no alternate_km
  const res = loadRouting({ requireAlt: true }).planRoute({
    origin: O, destination: D, plane: PLANE(130),
    allowedTypes: ['medium_airport'], allAirports: [O], options: {} });
  assert.equal(res.error, undefined, res.error);
  assert.equal(res.legCount, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
