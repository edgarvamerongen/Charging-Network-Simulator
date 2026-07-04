/*
 * CNSRouting.planChain + CNSRecompute — node harness (no server: routing is pure,
 * energy via the client engine which rebuilds from coords).
 * Run:  node tests/js_recompute.test.mjs
 */
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { loadStack, AP } from './golden_capture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANES = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(REPO, 'planes.json'), 'utf8')).map(p => [p.id, p]));
// Minimal airport catalog for the planner's candidate pool, with the fields planRoute reads.
const ap = (k, type = 'medium_airport', alt = 0) => ({ ident: k, name: AP[k].name, type, latitude_deg: AP[k].lat, longitude_deg: AP[k].lon, iata_code: '', alternate_km: alt });
const node = (k, alt = 0) => ({ ident: k, name: AP[k].name, lat: AP[k].lat, lon: AP[k].lon, alternate_km: alt });

let pass = 0, fail = 0;
const test = (n, fn) => { try { fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };

const S = loadStack(); S.CNSSettings.reset();
const beta = PLANES.beta_plane;

test('planChain: short hop needs no stop, returns origin→dest only', () => {
  const r = S.CNSRouting.planChain({
    origin: node('EHAM'), dest: node('EHGG'), manualStops: [], plane: beta,
    allowedTypes: ['medium_airport', 'large_airport'], allAirports: [ap('EHAM'), ap('EHGG')],
    maxLegKm: 400, options: {},
  });
  if (r.error) throw new Error('unexpected error: ' + r.error);
  if (r.stops.length !== 0) throw new Error(`expected 0 stops, got ${r.stops.length}`);
});

test('planChain: a manual stop is kept and tagged _manual', () => {
  const r = S.CNSRouting.planChain({
    origin: node('EHAM'), dest: node('EGLL'), manualStops: [node('EHRD')], plane: beta,
    allowedTypes: ['medium_airport', 'large_airport'],
    allAirports: [ap('EHAM'), ap('EHRD'), ap('EGLL')], maxLegKm: 400, options: {},
  });
  if (r.error) throw new Error('unexpected error: ' + r.error);
  const ehrd = r.stops.find(s => s.ident === 'EHRD');
  if (!ehrd) throw new Error('manual stop EHRD was dropped');
  if (ehrd._manual !== true) throw new Error('manual stop lost its _manual flag');
});

test('planChain: no route within range and no anchor → error', () => {
  const r = S.CNSRouting.planChain({
    origin: node('EHAM'), dest: node('EGLL'), manualStops: [], plane: beta,
    allowedTypes: ['medium_airport'], allAirports: [ap('EHAM'), ap('EGLL')],
    maxLegKm: 50, options: {},   // 50 km can't cross to London, no candidate airports
  });
  if (!r.error) throw new Error('expected an error for an unroutable too-short leg');
});

test('mergeManualFlags: copies _manual onto saved stops by ident', () => {
  const saved = [{ ident: 'EHRD', name: 'R' }, { ident: 'EDDL', name: 'D' }];
  const planned = [{ ident: 'EHRD', _manual: true }, { ident: 'EDDL', _auto: true }];
  const out = S.CNSRecompute.mergeManualFlags(saved, planned);
  if (out[0]._manual !== true) throw new Error('EHRD should be _manual');
  if (out[1]._manual === true) throw new Error('EDDL (auto) must not be _manual');
});

// Build a saved trip + a ctx the way index.html will.
function tripFor(o, d, planeId = 'beta_plane', stops = []) {
  const P = PLANES[planeId];
  return { id: 't', planeId, planeName: P.name, tripType: 'retour',
    originIdent: o, originName: AP[o].name, originLat: AP[o].lat, originLon: AP[o].lon,
    destIdent: d, destName: AP[d].name, destLat: AP[d].lat, destLon: AP[d].lon,
    battery: P.battery_kwh, range_km: P.range_km, speed_kmh: P.speed_kmh, c_rate: P.c_rate,
    chargerId: 'dc_250', chargerName: '250 kW DC', chargerPower: 250,
    freqN: 1, freqUnit: 'day', fleetMode: 'separate', stops };
}
const CATALOG = ['EHAM', 'EHGG', 'EHRD', 'EGLL', 'LFPG'].map(k => ap(k));
// Mirrors the app's _recomputeCtx after the seam fix: planeFor/availableRangeKm are
// FALLBACKS for a stack loaded without flight-model.js. loadStack always loads it, so
// recomputeFlight resolves the plane via CNSFlight.tripPlane (catalog heal) and the
// reach via CNSFlight.availableRangeKm(plane, {ruleMode: trip.rm}) — these ctx fields
// are never consulted here, but the contract is kept for synthetic/no-engine harnesses.
const ctx = () => ({
  allAirports: CATALOG,
  allowedTypes: ['medium_airport', 'large_airport'],
  planeFor: (t) => ({ id: t.planeId, name: t.planeName, battery_kwh: t.battery, range_km: t.range_km, speed_kmh: t.speed_kmh, c_rate: t.c_rate }),
  availableRangeKm: (plane) => S.CNSFlight.availableRangeKm(plane),
});
// Synthetic airport at exact coordinates (for legs sized against the 193.5 beta reach).
const apAt = (ident, lat, lon, type = 'medium_airport', alt = 0) => ({
  ident, name: ident, type, latitude_deg: lat, longitude_deg: lon, iata_code: '', alternate_km: alt });
// MID sits halfway along EHAM→EGLL (direct ≈ 370 km): legs ≈ 184/186 km, inside the beta reach.
const MID = (type = 'medium_airport') => apAt('MID', 51.88965, 2.152, type);

test('recomputeFlight: a short retour is feasible', () => {
  S.CNSSettings.reset();
  const out = S.CNSRecompute.recomputeFlight(tripFor('EHAM', 'EHGG'), ctx());
  if (out.feasible !== true) throw new Error('short retour should be feasible: ' + out.infeasibleReason);
});

test('recomputeFlight: a leg beyond the seam reach with no bridge flips to infeasible', () => {
  S.CNSSettings.reset();
  // Beta seam reach (IFR defaults) = 193.5 km; EHAM→EGLL direct ≈ 370 km, empty candidate pool.
  const out = S.CNSRecompute.recomputeFlight(tripFor('EHAM', 'EGLL'), { ...ctx(), allAirports: [ap('EHAM'), ap('EGLL')] });
  if (out.feasible !== false) throw new Error('expected infeasible when no route fits');
  if (!out.infeasibleReason) throw new Error('infeasible flight must carry a reason');
});

test('recomputeFlight: idempotent at unchanged settings', () => {
  S.CNSSettings.reset();
  const a = S.CNSRecompute.recomputeFlight(tripFor('EHAM', 'EHGG'), ctx());
  const b = S.CNSRecompute.recomputeFlight(a, ctx());
  if (JSON.stringify(a.stops) !== JSON.stringify(b.stops)) throw new Error('stops drift on re-recompute');
  if (Math.abs((a.legEnergy || 0) - (b.legEnergy || 0)) > 1e-6) throw new Error('legEnergy drift on re-recompute');
});

test('recomputeFlight: alternate reserve can flip feasibility', () => {
  S.CNSSettings.reset();
  // EHAM→EHGG ≈ 151.8 km; beta seam reach 193.5 with the flat divert_km 50 already inside
  // it, so EHGG's 120 km alternate counts only its EXCESS: 120 − 50 = 70. Reserve on →
  // 151.8 > 193.5 − 70 = 123.5 with no bridge → infeasible; off → feasible direct.
  const big = ['EHAM', 'EHGG'].map(k => ap(k, 'medium_airport', k === 'EHGG' ? 120 : 0));
  const t = tripFor('EHAM', 'EHGG');
  S.CNSSettings.save({ alternateReserve: { enabled: false } });
  const off = S.CNSRecompute.recomputeFlight(t, { ...ctx(), allAirports: big });
  S.CNSSettings.save({ alternateReserve: { enabled: true } });
  const on = S.CNSRecompute.recomputeFlight(t, { ...ctx(), allAirports: big });
  if (off.feasible !== true) throw new Error('should fit with the reserve off');
  if (on.feasible !== false) throw new Error('reserve on: 151.8 + excess 70 must overrun the 193.5 reach');
});

test('recomputeAll: recomputes every trip and sets feasible on each', () => {
  S.CNSSettings.reset();
  const trips = [tripFor('EHAM', 'EHGG'), tripFor('EHAM', 'LFPG')];
  const out = S.CNSRecompute.recomputeAll(trips, ctx());
  if (out.length !== 2) throw new Error('expected 2 trips back');
  if (!out.every(t => typeof t.feasible === 'boolean')) throw new Error('every trip must get a feasible flag');
});

test('runGlobal excludes feasible:false flights (no lane, no peak)', () => {
  S.CNSSettings.reset();
  const ok = { ...tripFor('EHAM', 'EHGG'), id: 'ok', feasible: true };
  const bad = { ...tripFor('EHAM', 'LFPG'), id: 'bad', feasible: false };
  S.localStorage.setItem('cns_folder', JSON.stringify([ok, bad]));
  S.localStorage.setItem('cns_airport_cfg', JSON.stringify({}));
  S.CNSScheduler.init({ chargers: { dc_250: { id: 'dc_250', name: '250 kW DC', power_kw: 250 } } });
  const laneTripIds = new Set(S.CNSScheduler.runGlobal().lanes.map(L => L.trip.id));
  if (laneTripIds.has('bad')) throw new Error('infeasible flight must be excluded from runGlobal');
  if (!laneTripIds.has('ok')) throw new Error('feasible flight should still have a lane');
  S.localStorage.setItem('cns_folder', JSON.stringify([]));
});

test('recomputeFlight re-plans auto/untagged stops, preserves only explicit manual', () => {
  S.CNSSettings.reset();
  // A short hop that needs no stop, stored with an UNNEEDED stop and NO _manual tag
  // (how a saved auto-planned route looks). Recompute must DROP it like a fresh plan —
  // not freeze it (the incoherence: DES kept the route while the planner re-planned).
  const auto = { ...tripFor('EHAM', 'EHGG'), multiLeg: true,
    stops: [{ ident: 'EHRD', name: AP.EHRD.name, lat: AP.EHRD.lat, lon: AP.EHRD.lon }] };
  if (S.CNSRecompute.recomputeFlight(auto, ctx()).stops.some(s => s.ident === 'EHRD'))
    throw new Error('untagged auto-stop must be re-planned away, not preserved');
  // An EXPLICIT manual stop is still preserved (MID keeps both EHAM→EGLL segments
  // inside the 193.5 beta reach, so the kept stop is routable).
  const man = { ...tripFor('EHAM', 'EGLL'), multiLeg: true,
    stops: [{ ident: 'MID', name: 'MID', lat: 51.88965, lon: 2.152, _manual: true }] };
  const out = S.CNSRecompute.recomputeFlight(man, { ...ctx(), allAirports: [ap('EHAM'), MID(), ap('EGLL')] });
  if (!out.stops.some(s => s.ident === 'MID'))
    throw new Error('explicit manual stop must be preserved: ' + out.infeasibleReason);
});

test('recomputeFlight forwards ctx.routingOptions to the planner (not hard-coded {})', () => {
  S.CNSSettings.reset();
  // EHAM→EGLL (≈370 km) exceeds the 193.5 beta reach; MID bridges it in one stop. With
  // routingOptions.maxStops:0 the planner must refuse the stop → infeasible. Proves the
  // recompute honours the planner's options (the "Prefer"/typePenalty the live planner
  // passes) instead of a hard-coded {} — the bug where the default small-airport penalty
  // flipped feasible routes to "no route" in the DC.
  const base = { ...ctx(), allAirports: [ap('EHAM'), MID(), ap('EGLL')] };
  if (S.CNSRecompute.recomputeFlight(tripFor('EHAM', 'EGLL'), base).feasible !== true)
    throw new Error('control: one stop should make it feasible');
  if (S.CNSRecompute.recomputeFlight(tripFor('EHAM', 'EGLL'), { ...base, routingOptions: { maxStops: 0 } }).feasible !== false)
    throw new Error('ctx.routingOptions.maxStops:0 must propagate → infeasible');
});

test('recomputeFlight forwards ctx.allowedIdents (network site routable despite type filter)', () => {
  S.CNSSettings.reset();
  // EHAM→EGLL needs the MID bridge. MID is presented as a small_airport with only
  // medium/large allowed by type — feasible ONLY when ctx.allowedIdents admits it
  // (the DC passes the full network here).
  const pool = [ap('EHAM'), MID('small_airport'), ap('EGLL')];
  const base = { ...ctx(), allAirports: pool, allowedTypes: ['medium_airport', 'large_airport'] };
  if (S.CNSRecompute.recomputeFlight(tripFor('EHAM', 'EGLL'), base).feasible !== false)
    throw new Error('control: small-type bridge must be rejected without the ident pool');
  const out = S.CNSRecompute.recomputeFlight(tripFor('EHAM', 'EGLL'),
    { ...base, allowedIdents: new Set(['MID']) });
  if (out.feasible !== true) throw new Error('ctx.allowedIdents must admit MID: ' + out.infeasibleReason);
});

test('index.html: _recomputeCtx is map-filter independent (full catalog, settings-only)', () => {
  const html = fs.readFileSync(path.join(REPO, 'templates', 'index.html'), 'utf8');
  const m = html.match(/function _recomputeCtx\(\) \{([\s\S]*?)\n        \}/);
  if (!m) throw new Error('_recomputeCtx not found');
  if (m[1].includes('_allowedTypes()'))
    throw new Error('_recomputeCtx must NOT read the map filters — saved flights react to model settings only');
  for (const must of ['small_airport', 'medium_airport', 'large_airport', 'allowedIdents'])
    if (!m[1].includes(must)) throw new Error(`_recomputeCtx missing ${must} (full-catalog pool)`);
});

// ---- C2: per-route ruleMode threads through recompute (profileForTrip/simulateTrip) ----
// Two-leg Beta retour (EHAM<->EHGG, no stops = out+back = 2 legs). t2 carries rm:'vfr';
// under IFR-global defaults VFR drops the 10-km sidStar pad on EACH leg, so t2 must burn
// less energy than t1 — and the saved rm must survive the recompute round-trip unchanged.
function energyOf(t) { return (t.legs || []).reduce((s, l) => s + (l.energy_kwh || 0), 0); }

test('recomputeFlight: per-trip rm=vfr burns less energy than the IFR-global default', () => {
  S.CNSSettings.reset();   // global ruleMode 'ifr', sidStarPadding 10 km ON
  const t1 = tripFor('EHAM', 'EHGG');
  const t2 = { ...tripFor('EHAM', 'EHGG'), rm: 'vfr' };
  const out1 = S.CNSRecompute.recomputeFlight(t1, ctx());
  const out2 = S.CNSRecompute.recomputeFlight(t2, ctx());
  if (!(energyOf(out2) < energyOf(out1)))
    throw new Error(`expected VFR energy < IFR-global energy, got vfr=${energyOf(out2)} ifr=${energyOf(out1)}`);
  const legs = (out1.legs || []).length;
  const expectedDeltaKwh = legs * 10 * 0.357143;
  const gotDeltaKwh = energyOf(out1) - energyOf(out2);
  if (Math.abs(gotDeltaKwh - expectedDeltaKwh) > 0.05)
    throw new Error(`expected delta ~${expectedDeltaKwh.toFixed(3)} kWh (legs=${legs} x 10km x 0.357143), got ${gotDeltaKwh.toFixed(3)}`);
});

test('recomputeFlight: rm survives the recompute round-trip (preserved like _manual)', () => {
  S.CNSSettings.reset();
  const t2 = { ...tripFor('EHAM', 'EHGG'), rm: 'vfr' };
  const out2 = S.CNSRecompute.recomputeFlight(t2, ctx());
  if (out2.rm !== 'vfr') throw new Error(`expected rm to survive recompute unchanged, got ${JSON.stringify(out2.rm)}`);
});

// ---- Final-review Fix 1: the recompute lane goes through the SAME seam as the planner ----
// Plane via CNSFlight.tripPlane (catalog heal — divert_km/measurements/ifr_capable ride
// along) and reach via CNSFlight.availableRangeKm(plane, { ruleMode: trip.rm }). The broken
// path fed a stripped literal ({id,name,battery,range,speed,c_rate}) into the live form's
// _availableRangeKm: Beta recomputed at 243.5 km instead of the planner's 193.5, Vaeridion
// at 153.7 instead of 390 (measurement lost), stale pre-cutover trips at 152.5 (un-healed).
// Equator geography below: 1° lon = 111.19 km, so leg lengths are exact by construction.
function tripAt(o, d, planeId, extra) {
  const P = PLANES[planeId] || {};
  return { id: 't', planeId, planeName: P.name, tripType: 'one-way',
    originIdent: o.ident, originName: o.ident, originLat: o.latitude_deg, originLon: o.longitude_deg,
    destIdent: d.ident, destName: d.ident, destLat: d.latitude_deg, destLon: d.longitude_deg,
    battery: P.battery_kwh, range_km: P.range_km, speed_kmh: P.speed_kmh, c_rate: P.c_rate,
    chargerId: 'dc_250', chargerName: '250 kW DC', chargerPower: 250,
    freqN: 1, freqUnit: 'day', fleetMode: 'separate', stops: [], ...(extra || {}) };
}
const O0 = apAt('O0', 0, 0);

test('recompute reach IS the catalog seam: Beta bridges 220 km, flies 190 km direct (193.5, not 243.5)', () => {
  S.CNSSettings.reset();
  // 220.16 km sits between the healed seam reach (193.5) and the stripped-literal reach
  // (243.5): only the seam inserts the midpoint stop. 190 km stays direct (≤ 193.5), which
  // also excludes the stale 152.5 — together they bracket the used reach to [190, 220).
  const D220 = apAt('D220', 0, 1.98), MID110 = apAt('MID110', 0, 0.99);
  const far = S.CNSRecompute.recomputeFlight(tripAt(O0, D220, 'beta_plane'),
    { ...ctx(), allAirports: [O0, MID110, D220] });
  if (far.feasible !== true) throw new Error('220 km with a midpoint bridge must be feasible: ' + far.infeasibleReason);
  if (!(far.stops || []).some(s => s.ident === 'MID110'))
    throw new Error(`beta at 220 km must route via the bridge (seam reach 193.5) — a stripped 243.5 reach flies direct; got stops [${(far.stops || []).map(s => s.ident)}]`);
  const D190 = apAt('D190', 0, 1.70878);
  const near = S.CNSRecompute.recomputeFlight(tripAt(O0, D190, 'beta_plane'),
    { ...ctx(), allAirports: [O0, D190] });
  if (near.feasible !== true || (near.stops || []).length !== 0)
    throw new Error('190 km must stay a feasible DIRECT leg (≤ 193.5): ' + near.infeasibleReason);
});

test('recompute heals a stale pre-cutover trip: baked range_km 500 recomputes at the catalog reach', () => {
  S.CNSSettings.reset();
  // Un-healed stale reach would be 152.5 (500×0.7 − 187.5 − 10); the healed catalog reach
  // is 193.5 (same as the fresh-trip test above) → a 190 km direct leg discriminates.
  const D190 = apAt('D190', 0, 1.70878);
  const stale = S.CNSRecompute.recomputeFlight(tripAt(O0, D190, 'beta_plane', { range_km: 500 }),
    { ...ctx(), allAirports: [O0, D190] });
  if (stale.feasible !== true || (stale.stops || []).length !== 0)
    throw new Error('stale trip must heal to the catalog 193.5 reach and fly 190 km direct: ' + stale.infeasibleReason);
});

test('recompute keeps Vaeridion\'s 400-incl-reserve measurement: 300 km direct IFR feasible (reach 390, alternate excess over flat 80)', () => {
  S.CNSSettings.reset();
  // Catalog reach (400 − 10 sidStar)/1 = 390; the stripped literal loses the measurement →
  // gross build-down 153.7 → wrongly infeasible. The destination's 100 km alternate counts
  // only its excess over the flat divert_km 80 (Fix 3): 300 ≤ 390 − 20 = 370 → DIRECT.
  // (Pre-Fix-3 full-count would block it: 300 > 390 − 100 = 290.)
  const D300 = apAt('D300', 0, 2.69809, 'medium_airport', 100);
  const out = S.CNSRecompute.recomputeFlight(tripAt(O0, D300, 'vaeridion'),
    { ...ctx(), allAirports: [O0, D300] });
  if (out.feasible !== true) throw new Error('vaeridion 300 km direct must be feasible at the 390 reach: ' + out.infeasibleReason);
  if ((out.stops || []).length !== 0) throw new Error('must fly DIRECT (no stops)');
});

test('recompute reach honours the trip\'s own rm: Beta flies 300 km direct under rm=vfr, not under global ifr', () => {
  S.CNSSettings.reset();   // global default ifr
  const D300v = apAt('D300v', 0, 2.69809);
  const pool = { ...ctx(), allAirports: [O0, D300v] };
  const ifr = S.CNSRecompute.recomputeFlight(tripAt(O0, D300v, 'beta_plane'), pool);
  const vfr = S.CNSRecompute.recomputeFlight(tripAt(O0, D300v, 'beta_plane', { rm: 'vfr' }), pool);
  if (ifr.feasible !== false) throw new Error('global IFR: 300 km > 193.5 reach with no bridge must be infeasible');
  if (vfr.feasible !== true) throw new Error('rm=vfr must lift the routing reach to 316 (630×0.7 − 125): ' + vfr.infeasibleReason);
  if ((vfr.stops || []).length !== 0) throw new Error('vfr trip must fly direct');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
