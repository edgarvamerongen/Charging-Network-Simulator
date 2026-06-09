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
const ctx = (rangeKm) => ({
  allAirports: CATALOG,
  allowedTypes: ['medium_airport', 'large_airport'],
  planeFor: (t) => ({ id: t.planeId, name: t.planeName, battery_kwh: t.battery, range_km: t.range_km, speed_kmh: t.speed_kmh, c_rate: t.c_rate }),
  availableRangeKm: (plane) => {
    const route = S.CNSSettings.routingFactor();
    const sid = S.CNSSettings.sidStarPaddingKm ? S.CNSSettings.sidStarPaddingKm() : 0;
    const base = (rangeKm != null ? rangeKm : plane.range_km) * S.CNSSettings.usableFraction(plane) / route;
    return Math.max(0, base - sid / route);
  },
});

test('recomputeFlight: a short retour is feasible', () => {
  S.CNSSettings.reset();
  const out = S.CNSRecompute.recomputeFlight(tripFor('EHAM', 'EHGG'), ctx());
  if (out.feasible !== true) throw new Error('short retour should be feasible: ' + out.infeasibleReason);
});

test('recomputeFlight: cutting available range below the leg flips to infeasible', () => {
  S.CNSSettings.reset();
  const out = S.CNSRecompute.recomputeFlight(tripFor('EHAM', 'EGLL'), { ...ctx(), allAirports: [ap('EHAM'), ap('EGLL')], availableRangeKm: () => 100 });
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
  const big = ['EHAM', 'EHRD', 'EGLL'].map(k => ap(k, 'medium_airport', k === 'EGLL' ? 120 : 0));
  const t = tripFor('EHAM', 'EGLL');
  S.CNSSettings.save({ alternateReserve: { enabled: false } });
  const off = S.CNSRecompute.recomputeFlight(t, { ...ctx(), allAirports: big });
  S.CNSSettings.save({ alternateReserve: { enabled: true } });
  const on = S.CNSRecompute.recomputeFlight(t, { ...ctx(), allAirports: big });
  if (off.feasible !== true) throw new Error('should fit with the reserve off');
  if (on.feasible === off.feasible && JSON.stringify(on.stops) === JSON.stringify(off.stops))
    throw new Error('alternate reserve had no effect on routing/feasibility');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
