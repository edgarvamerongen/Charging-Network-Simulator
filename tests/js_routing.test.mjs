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
// rwy_paved_m: candidates need runway data or the planner refuses to stop there.
const ap = (ident, lon, alt) => ({
  ident, name: ident, type: 'medium_airport',
  latitude_deg: 0, longitude_deg: lon, iata_code: '', alternate_km: alt,
  rwy_paved_m: 2000,
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

// ============================================================================
//  Edge cases · different planes · multiple routes — alternate-reserve planning.
//  These lean on a direct INVARIANT: with the reserve ON, every arrival node
//  (each stop + the destination) must satisfy  leg(prev->node) + alt/route <= maxLeg.
//  Asserting it on the produced chain catches a reserve dropped at ANY hop.
// ============================================================================
const HAV = loadRouting({}).haversineKm;
const xy = (p) => ({ lat: p.lat ?? p.latitude_deg, lon: p.lon ?? p.longitude_deg });
function assertReserveRespected(chain, maxLeg, route = 1.0) {
  for (let i = 1; i < chain.length; i++) {
    const leg = HAV(xy(chain[i - 1]), xy(chain[i]));
    const reserve = (chain[i].alternate_km || 0) / route;
    assert.ok(leg + reserve <= maxLeg + 1e-6,
      `arrival ${chain[i].ident}: leg ${leg.toFixed(1)} + reserve ${reserve.toFixed(1)} = ${(leg + reserve).toFixed(1)} > maxLeg ${maxLeg}`);
  }
}

// 8. Different planes, same geography: a short-range aircraft needs alternate-respecting
//    stops where a long-range one flies direct — both respecting every node's reserve.
test('different planes: short-range needs stops where long-range flies direct (both respect reserve)', () => {
  const O = node('O', 0, 0), D = node('D', 4.0, 8);                 // D ~444.8 km from O, alt 8
  const all = [O, ap('S1', 1.0, 8), ap('S2', 2.0, 8), ap('S3', 3.0, 8), D];
  const plan = (range) => loadRouting({ requireAlt: true }).planRoute({
    origin: O, destination: D, plane: PLANE(range),
    allowedTypes: ['medium_airport'], allAirports: all, options: {} });
  const small = plan(135), big = plan(460);
  assert.equal(small.error, undefined, small.error);
  assert.equal(big.error, undefined, big.error);
  assert.ok(small.stops.length >= 1, 'short-range needs at least one stop');
  assert.equal(big.stops.length, 0, 'long-range flies direct (444.8 + 8 = 452.8 <= 460)');
  assert.ok(small.stops.length > big.stops.length, 'short-range needs more stops than long-range');
  assertReserveRespected([O, ...small.stops, D], 135);
  assertReserveRespected([O, ...big.stops, D], 460);
});

// 9. Long multi-stop route: a 3+ stop chain where EVERY arrival node carries its own
//    divert reserve. Confirms the reserve is enforced at each hop, not just first/last.
test('multi-stop route: every one of several arrival nodes respects its reserve', () => {
  const O = node('O', 0, 0), D = node('D', 5.0, 12);               // ~555.95 km
  const cands = [ap('A', 1.2, 10), ap('B', 2.4, 15), ap('C', 3.6, 6), ap('E', 4.6, 20)];
  const res = loadRouting({ requireAlt: true }).planRoute({
    origin: O, destination: D, plane: PLANE(160),
    allowedTypes: ['medium_airport'], allAirports: [O, ...cands, D], options: {} });
  assert.equal(res.error, undefined, res.error);
  assert.ok(res.stops.length >= 3, `expected a multi-stop chain, got ${res.stops.length}`);
  assertReserveRespected([O, ...res.stops, D], 160);
});

// 10. Mixed coverage: at the same waypoint the planner must skip a closer-but-remote field
//     for a well-covered one (divert fits) — the route-substitution case, mid-chain verified.
test('mixed alternates: planner skips a remote field for a well-covered co-located one', () => {
  const O = node('O', 0, 0), D = node('D', 3.0, 5);               // ~333.6 km; leg O->stop 166.79
  const REMOTE = ap('REMOTE', 1.5, 60), NEAR = ap('NEAR', 1.5, 8);
  const res = loadRouting({ requireAlt: true }).planRoute({
    origin: O, destination: D, plane: PLANE(200),                  // 166.79 + 60 > 200; + 8 <= 200
    allowedTypes: ['medium_airport'], allAirports: [O, REMOTE, NEAR, D], options: {} });
  assert.equal(res.error, undefined, res.error);
  assert.deepEqual(idents(res), ['NEAR']);
  assertReserveRespected([O, ...res.stops, D], 200);
});

// 11. A second, independent geography (longer route) — the reserve logic isn't tuned
//     to one layout. Uneven alternate distances per node.
test('second geography: a longer route still respects every node reserve', () => {
  const O = node('O', 0, 0), D = node('D', 6.0, 18);              // ~667 km
  const cands = [ap('P', 1.3, 12), ap('Q', 2.7, 9), ap('R2', 4.0, 14), ap('T2', 5.3, 7)];
  const res = loadRouting({ requireAlt: true }).planRoute({
    origin: O, destination: D, plane: PLANE(175),
    allowedTypes: ['medium_airport'], allAirports: [O, ...cands, D], options: {} });
  assert.equal(res.error, undefined, res.error);
  assert.ok(res.stops.length >= 3, `expected multiple stops, got ${res.stops.length}`);
  assertReserveRespected([O, ...res.stops, D], 175);
});

// 12. An explicit per-flight maxLegKm override still has the divert reserve deducted from it.
test('maxLegKm override: reserve is deducted from the override too', () => {
  const O = node('O', 0, 0), D = node('D', 1.0, 40);             // O->D 111.19 km, dest alt 40
  const call = (maxLegKm) => loadRouting({ requireAlt: true }).planRoute({
    origin: O, destination: D, plane: PLANE(999),
    allowedTypes: ['medium_airport'], allAirports: [O, D], options: { maxLegKm } });
  assert.ok(call(130).error, 'direct 111.19 + 40 = 151.19 > 130 override -> blocked');
  const ok = call(160);
  assert.equal(ok.error, undefined, ok.error);                   // 151.19 <= 160
  assert.equal(ok.legCount, 1);
});

// 13. Range too short to fit even the first leg once the reserve is added -> no route.
test('range too short for any reserved leg yields no route', () => {
  const O = node('O', 0, 0), D = node('D', 2.0, 30), A = ap('A', 1.0, 30);
  const res = loadRouting({ requireAlt: true }).planRoute({
    origin: O, destination: D, plane: PLANE(120),                 // O->A 111.19 + 30 = 141.19 > 120
    allowedTypes: ['medium_airport'], allAirports: [O, A, D], options: {} });
  assert.ok(res.error, 'no candidate fits within maxLeg once the reserve is added');
  assert.equal(res.legCount, 0);
});

// 14. Toggle OFF ignores alternate_km entirely — even absurd values (pure parity guard).
test('toggle OFF ignores alternate_km entirely (even huge values)', () => {
  const O = node('O', 0, 0), D = node('D', 2.0, 9999), A = ap('A', 1.0, 9999);
  const res = loadRouting({ requireAlt: false }).planRoute({
    origin: O, destination: D, plane: PLANE(150),
    allowedTypes: ['medium_airport'], allAirports: [O, A, D], options: {} });
  assert.equal(res.error, undefined, res.error);
  assert.deepEqual(idents(res), ['A']);
});

// 15. The reported field case: Beta Alia, available 420 km, routing ×1.07, the leg's arrival
//     airport has a 22 km alternate. Displayed 401 + 22 > 420 → the divert reserve tips it over.
//     Great-circle: leg 374.8 + 22/1.07 (20.56) = 395.4 > 420/1.07 (392.5) → rejected.
test('reported case: a 401 km leg with a 22 km destination alternate is rejected (420 km, ×1.07)', () => {
  const O = node('O', 0, 0), D = node('D', 374.77 / 111.19, 22);
  const res = loadRouting({ requireAlt: true, route: 1.07 }).planRoute({
    origin: O, destination: D, plane: PLANE(420),
    allowedTypes: ['medium_airport'], allAirports: [O, D], options: {} });
  assert.ok(res.error, 'leg 374.8 + 20.56 = 395.4 > 392.5 maxLeg → must be rejected');
});
// ...and the SAME leg is fine with the reserve OFF — the 22 km alternate is exactly what tips it.
test('reported case: the same 401 km leg is fine with the reserve OFF', () => {
  const O = node('O', 0, 0), D = node('D', 374.77 / 111.19, 22);
  const res = loadRouting({ requireAlt: false, route: 1.07 }).planRoute({
    origin: O, destination: D, plane: PLANE(420),
    allowedTypes: ['medium_airport'], allAirports: [O, D], options: {} });
  assert.equal(res.error, undefined, res.error);
  assert.equal(res.legCount, 1);
});

// 17. Reserve must apply to a destination EXCLUDED from allAirports (the app filters chain
//     airports out of the candidate pool) as long as the dest object carries alternate_km.
//     This is the 0-reserve bug: planRoute's alt lookup is built only from allAirports, so an
//     excluded endpoint fell back to its own object — which the UI built WITHOUT alternate_km.
test('reserve applies to a destination excluded from allAirports but carrying alternate_km', () => {
  const O = node('O', 0, 0), A = ap('A', 1.5, 5);
  const D = { ident: 'D', lat: 0, lon: 1.0, alternate_km: 40 };   // NOT in allAirports; carries alt
  const res = loadRouting({ requireAlt: true }).planRoute({
    origin: O, destination: D, plane: PLANE(130),
    allowedTypes: ['medium_airport'], allAirports: [O, A], options: {} });   // D absent from the pool
  // O->D 111.19 + 40 reserve = 151.19 > 130 → direct blocked; A (166.79 from O) is out of range →
  // no route. If the excluded dest's reserve were dropped (the bug), 111.19 <= 130 → it'd route.
  assert.ok(res.error, 'excluded-dest reserve must still block the hop (111.19 + 40 > 130)');
});
// ...and with NO reserve, the same excluded dest routes directly (proves the 40 is what blocks it).
test('the same excluded destination routes directly with the reserve OFF', () => {
  const O = node('O', 0, 0), A = ap('A', 1.5, 5);
  const D = { ident: 'D', lat: 0, lon: 1.0, alternate_km: 40 };
  const res = loadRouting({ requireAlt: false }).planRoute({
    origin: O, destination: D, plane: PLANE(130),
    allowedTypes: ['medium_airport'], allAirports: [O, A], options: {} });
  assert.equal(res.error, undefined, res.error);
  assert.equal(res.legCount, 1);
});

// Type preference is a SOFT bias: a "prefer medium" search that would overrun maxStops must
// fall back to a less-preferred (small-field) route that fits, rather than hard-failing.
// Geography (equator, 1deg=111.19km): O@0 -> D@3 (333km, needs a stop at reach 200).
//   small  S@1.5  bridges in ONE stop (166.8km legs)
//   medium M1@1, M2@2 bridge in TWO stops (111km legs)
const apT = (ident, lon, type) => ({ ident, name: ident, type, latitude_deg: 0, longitude_deg: lon, iata_code: '', alternate_km: 0, rwy_paved_m: 2000 });
const PREF_MED = { small_airport: 150, medium_airport: 0 };
const SCENE = ['small_airport', 'medium_airport'];
const POOL = [apT('S', 1.5, 'small_airport'), apT('M1', 1, 'medium_airport'), apT('M2', 2, 'medium_airport')];

test('type preference is soft: falls back past maxStops to a route that fits', () => {
  const res = loadRouting({ usable: 1.0, route: 1.0 }).planRoute({
    origin: node('O', 0), destination: node('D', 3), plane: PLANE(200),
    allowedTypes: SCENE, allAirports: POOL,
    options: { maxLegKm: 200, maxStops: 1, typePenalty: PREF_MED },
  });
  // prefer-medium wants M1+M2 (2 stops) > maxStops 1 → must fall back to the 1-stop small bridge.
  assert.ok(!res.error, 'should fall back, not hard-fail: ' + res.error);
  assert.equal(res.stops.map(s => s.ident).join(','), 'S');   // join: routing.js arrays live in a vm realm
});

test('type preference still wins when it fits within maxStops', () => {
  const res = loadRouting({ usable: 1.0, route: 1.0 }).planRoute({
    origin: node('O', 0), destination: node('D', 3), plane: PLANE(200),
    allowedTypes: SCENE, allAirports: POOL,
    options: { maxLegKm: 200, maxStops: 3, typePenalty: PREF_MED },
  });
  assert.ok(!res.error, res.error);
  assert.equal(res.stops.map(s => s.ident).join(','), 'M1,M2', 'prefer medium honoured (no fallback)');
});

// WYSIWYG pool: allowedIdents admits a candidate whose TYPE is filtered off —
// the live planner passes the NRG2fly charger idents here, so a network site is
// routable whenever it is shown, regardless of its size class.
test('allowedIdents admits an ident whose type is not in allowedTypes', () => {
  const O = node('O', 0), D = node('D', 3);                       // 333.6 km, reach 200 → needs a stop
  const S = apT('S', 1.5, 'small_airport');                       // the only bridge, small type
  const res = loadRouting({ usable: 1.0, route: 1.0 }).planRoute({
    origin: O, destination: D, plane: PLANE(200),
    allowedTypes: ['medium_airport'],                              // small NOT allowed by type…
    allowedIdents: new Set(['S']),                                 // …but shown as a network site
    allAirports: [S], options: { maxLegKm: 200 },
  });
  assert.ok(!res.error, 'network ident must be routable: ' + res.error);
  assert.equal(res.stops.map(s => s.ident).join(','), 'S');
});

test('without allowedIdents the same small-type bridge is rejected (regression)', () => {
  const res = loadRouting({ usable: 1.0, route: 1.0 }).planRoute({
    origin: node('O', 0), destination: node('D', 3), plane: PLANE(200),
    allowedTypes: ['medium_airport'], allAirports: [apT('S', 1.5, 'small_airport')],
    options: { maxLegKm: 200 },
  });
  assert.ok(res.error, 'expected no-route without the ident pool');
});

test('planChain forwards allowedIdents to each gap planRoute', () => {
  const R = loadRouting({ usable: 1.0, route: 1.0 });
  const res = R.planChain({
    origin: node('O', 0), dest: node('D', 3), manualStops: [], plane: PLANE(200),
    allowedTypes: ['medium_airport'], allowedIdents: new Set(['S']),
    allAirports: [apT('S', 1.5, 'small_airport')], maxLegKm: 200, options: {},
  });
  assert.ok(!res.error, 'planChain must forward the ident pool: ' + res.error);
  assert.equal(res.stops.map(s => s.ident).join(','), 'S');
});

// Runway-data gate: airports whose runways are unverifiable are never planned
// as stops — on either pool arm. Explicit waypoints are unaffected (they are
// chain endpoints, not candidates).
const bare = (ident, lon, type = 'medium_airport') => ({
  ident, name: ident, type, latitude_deg: 0, longitude_deg: lon, iata_code: '',
  alternate_km: 0, rwy_paved_m: '', rwy_grass_m: '',   // CSV blanks: no runway data
});

test('runway gate: the only geometric candidate has no runway data -> no route', () => {
  const R = loadRouting({});
  const res = R.planRoute({ origin: node('O', 0), destination: node('D', 3), plane: PLANE(200),
    allowedTypes: ['medium_airport'], allAirports: [bare('A', 1.5)], options: {} });
  assert.ok(res.error, 'expected no-route: A has no runway data');
});

test('runway gate: allowedIdents does not bypass it', () => {
  const R = loadRouting({});
  const res = R.planRoute({ origin: node('O', 0), destination: node('D', 3), plane: PLANE(200),
    allowedTypes: [], allowedIdents: new Set(['A']), allAirports: [bare('A', 1.5)], options: {} });
  assert.ok(res.error, 'expected no-route: NRG ident admission must not skip the runway gate');
});

test('runway gate: a with-data sibling is picked over the no-data airport', () => {
  const R = loadRouting({});
  const res = R.planRoute({ origin: node('O', 0), destination: node('D', 3), plane: PLANE(200),
    allowedTypes: ['medium_airport'], allAirports: [bare('A', 1.5), ap('B', 1.6, 0)], options: {} });
  assert.ok(!res.error, 'expected a route via B: ' + res.error);
  assert.equal(idents(res).join(','), 'B');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
