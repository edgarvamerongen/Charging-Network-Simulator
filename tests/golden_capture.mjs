/*
 * Golden capture for the unified flight engine (decisions-doc blocker #2 / G2).
 * --------------------------------------------------------------------------
 * Loads the REAL calc stack (static/settings|routing|flight-model|demand|scheduler.js)
 * into one Node `vm` context with browser-global shims (window === global, in-memory
 * CNSState + localStorage), drives a representative trip matrix through sim.py
 * (/api/simulate) + the CNSFlight engine (the SAME path the result panel uses), and
 * snapshots the numbers static/flight-model.js must reproduce EXACTLY (gate G4).
 *
 * The captured `input.sim` (sim.py legs/charges) is saved alongside the expected
 * outputs, so the comparison test (js_flight_model.test.mjs) needs NO server.
 *
 * Run (server up on :5055):  node tests/golden_capture.mjs
 * Output: tests/goldens/flight-current.golden.json
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const BASE = process.env.CNS_BASE_URL || 'http://127.0.0.1:5055';
const PLANES = Object.fromEntries(
  JSON.parse(fs.readFileSync(path.join(REPO, 'planes.json'), 'utf8')).map(p => [p.id, p]));

// ---- load the real stack into one vm context (window === global, like the browser)
export function loadStack() {
  const stateStore = {};
  const lsStore = new Map();
  const CNSState = {
    KEYS: { folder: 'cns_folder', cfg: 'cns_airport_cfg' },
    getJSON: (k, d) => (k in stateStore ? JSON.parse(JSON.stringify(stateStore[k])) : d),
    setJSON: (k, v) => { stateStore[k] = JSON.parse(JSON.stringify(v)); },
  };
  const localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => lsStore.set(k, String(v)),
    removeItem: (k) => lsStore.delete(k),
  };
  const sandbox = {
    console, JSON, Math, Object, Array, Number, isFinite, isNaN, String, Boolean,
    parseInt, parseFloat, Date, Error, TypeError, RangeError, Map, Set, Symbol, RegExp,
    CNSState, localStorage, PLANES_BY_ID: PLANES,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['plane-schema.js', 'settings.js', 'routing.js', 'flight-model.js', 'demand.js', 'recompute.js', 'scheduler.js']) {
    vm.runInContext(fs.readFileSync(path.join(REPO, 'static', f), 'utf8'), sandbox);
  }
  return sandbox;
}

// settings variants exercised per case (shipped DEFAULTS + extremes)
export const SETTINGS = {
  off:       (S) => S.save({ landingReserve: { enabled: false }, routingPadding: { enabled: false }, chargeTarget: { enabled: false }, chargeTaper: { enabled: false }, chargerEfficiency: { enabled: false } }),
  default:   (S) => S.reset(),  // landingReserve 0.30, routing 1.05, chargeTarget 0.80, taper on
  target100: (S) => { S.reset(); S.save({ chargeTarget: { enabled: true, value: 1.0 } }); },
  target50:  (S) => { S.reset(); S.save({ chargeTarget: { enabled: true, value: 0.5 } }); },
  vfr:       (S) => { S.reset(); S.save({ ruleMode: { value: 'vfr' } }); },
};

// deterministic airports (coords lifted from tests/_helpers.py)
export const AP = {
  EHAM: { name: 'Amsterdam', lat: 52.308601, lon: 4.76389 },
  LFPG: { name: 'Paris',     lat: 49.00896,  lon: 2.554117 },
  EGLL: { name: 'London',    lat: 51.470748, lon: -0.459909 },
  EHGG: { name: 'Groningen', lat: 53.119107, lon: 6.577652 },
  EHRD: { name: 'Rotterdam', lat: 51.956902, lon: 4.43722 },
};
const co = (k) => ({ ident: k, name: AP[k].name, lat: AP[k].lat, lon: AP[k].lon });

export const MATRIX = [
  { name: 'oneway-velis-short', plane: 'pipistrel_velis', o: 'EHRD', d: 'EHAM', trip: 'one-way' },
  { name: 'oneway-beta',        plane: 'beta_plane',      o: 'EHAM', d: 'LFPG', trip: 'one-way' },
  { name: 'retour-beta',        plane: 'beta_plane',      o: 'EHAM', d: 'EHGG', trip: 'retour' },
  { name: 'oneway-multi-beta',  plane: 'beta_plane',      o: 'EHAM', d: 'EGLL', trip: 'one-way', stops: ['EHRD'] },
  { name: 'retour-multi-beta',  plane: 'beta_plane',      o: 'EHAM', d: 'EGLL', trip: 'retour',  stops: ['EHRD'] },
  { name: 'training-velis',     plane: 'pipistrel_velis', o: 'EHAM', d: 'EHAM', trip: 'training' },
];

const round = (x, n = 4) => (x == null || !Number.isFinite(+x)) ? (x ?? null) : +(+x).toFixed(n);

async function sim(c) {
  const dest = c.trip === 'training' ? c.o : c.d;
  const payload = { origin: co(c.o), destination: co(dest), plane_id: c.plane, charger_id: 'dc_250', trip_type: c.trip };
  if (c.stops) payload.stops = c.stops.map(co);
  const r = await fetch(BASE + '/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return r.json();
}

// Build the engine FlightProfile for a case — the SAME path the result panel takes
// (index.html _engineProfile -> CNSFlight.simulateTrip), so the golden tracks the live
// engine, not the deleted CNSScheduler.tripBreakdown. Geometry from the deterministic AP
// coords; preview target = the global default (no per-airport override, so
// chargeTargetDefault() == the result panel's CNSDemand.resolveTargetSoc({})); the matrix
// always simulates charger_id 'dc_250' -> 250 kW.
export function engineProfile(S, c) {
  const plane = PLANES[c.plane];
  const dest = c.trip === 'training' ? c.o : c.d;
  const stops = (c.stops || []).map(co);
  const waypoints = c.trip === 'training' ? [co(c.o)] : [co(c.o), ...stops, co(dest)];
  return S.CNSFlight.simulateTrip(plane, waypoints, {
    tripType: c.trip,
    getTargetSoc: () => S.CNSSettings.chargeTargetDefault(),
    getChargerKw: () => 250,
    trainingRangeKm: plane.training_range_km,
  });
}

// Map a CNSFlight FlightProfile to the tripBreakdown-shaped object breakdownSnapshot()
// reads — a faithful copy of index.html's _breakdownFromProfile (the result-panel rows):
// fly.leg is 'out'/'back' single-leg or the leg index multi-leg; a charge carries its role.
export function breakdownFromProfile(prof) {
  if (!prof) return {};
  const T = prof.totals || {}, term = prof.terminal || {};
  let flyN = 0;
  const phases = (prof.phases || []).map(ph => {
    if (ph.kind === 'fly') {
      const leg = prof.multiLeg ? ph.legIndex : (flyN++ === 0 ? 'out' : 'back');
      return { kind: 'fly', leg, dur: ph.dur };
    }
    const ch = (prof.charges || [])[ph.chargeIndex] || {};
    return { kind: 'charge', at: ch.role, name: ch.name, dur: ph.dur, energy: ch.energyKwh };
  });
  const lastLeg = (prof.legs || [])[(prof.legs || []).length - 1] || {};
  return {
    energyUsedKwh: T.energyUsedKwh, flightMin: T.flightMin, chargeMin: T.chargeMin,
    enRouteMin: T.enRouteMin, terminalMin: T.terminalMin, terminalKwh: term.energyKwh,
    terminalName: term.name || lastLeg.toName || '', arrivalSoc: term.arrivalSocFrac, phases,
  };
}

export function breakdownSnapshot(bd) {
  return {
    energyUsedKwh: round(bd.energyUsedKwh), flightMin: round(bd.flightMin), chargeMin: round(bd.chargeMin),
    enRouteMin: round(bd.enRouteMin), terminalMin: round(bd.terminalMin), terminalKwh: round(bd.terminalKwh),
    terminalName: bd.terminalName, arrivalSoc: round(bd.arrivalSoc),
    phases: (bd.phases || []).map(p => ({ kind: p.kind, leg: p.leg ?? null, at: p.at ?? null, dur: round(p.dur), energy: round(p.energy) })),
  };
}

export async function captureCase(c) {
  const data = await sim(c);
  if (data.error) return { name: c.name, error: data.error };
  const variants = {};
  for (const [vname, apply] of Object.entries(SETTINGS)) {
    const S = loadStack();
    apply(S.CNSSettings);
    const bd = breakdownFromProfile(engineProfile(S, c));
    variants[vname] = breakdownSnapshot(bd);
  }
  return {
    name: c.name,
    input: {
      plane: c.plane, trip: c.trip, o: c.o, d: c.d, stops: c.stops || null,
      sim: {
        legs: Array.isArray(data.legs) ? data.legs.map(l => ({ from: l.from && l.from.name, to: l.to && l.to.name, distance_km: round(l.distance_km, 3), energy_kwh: round(l.energy_kwh, 3), flight_time_h: round(l.flight_time_h, 4) })) : null,
        charges: Array.isArray(data.charges) ? data.charges.map(ch => ({ ident: ch.ident, role: ch.role, energy_kwh: round(ch.energy_kwh, 3) })) : null,
        leg_distance_km: round(data.leg_distance_km, 3), leg_energy_kwh: round(data.leg_energy_kwh, 3), flight_time_h: round(data.flight_time_h, 4),
        total_distance_km: round(data.total_distance_km, 3), multi_leg: !!data.multi_leg,
      },
    },
    variants,
  };
}

const GOLDEN_PATH = path.join(REPO, 'tests', 'goldens', 'flight-current.golden.json');

async function serverUp() {
  try { const r = await fetch(BASE + '/', { method: 'GET' }); return r.ok; } catch { return false; }
}

async function main() {
  const check = process.argv.includes('--check');
  if (!(await serverUp())) {
    console.log(`SKIP golden ${check ? 'check' : 'capture'}: server at ${BASE} not reachable.`);
    process.exit(0);   // skip (don't fail CI) when the server is down, like the API tests
  }
  const captured = [];
  for (const c of MATRIX) {
    const r = await captureCase(c);
    if (r.error) { console.log(`SKIP ${c.name}: ${r.error}`); continue; }
    captured.push(r);
  }

  if (check) {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
    const byName = Object.fromEntries(golden.cases.map(c => [c.name, c]));
    let fails = 0;
    for (const cs of captured) {
      const g = byName[cs.name];
      if (!g) { console.log(`  NEW   ${cs.name} (not in golden — run without --check to add)`); fails++; continue; }
      if (JSON.stringify(cs.variants) === JSON.stringify(g.variants)) { console.log(`  ok    ${cs.name}`); }
      else { console.log(`  FAIL  ${cs.name} — engine breakdown drifted from the golden`); fails++; }
    }
    console.log(fails
      ? `\nGOLDEN DRIFT: ${fails}/${captured.length} case(s) differ. If intended, re-run without --check to update.`
      : `\nall ${captured.length} cases reproduce the golden.`);
    process.exit(fails ? 1 : 0);
  }

  const golden = { _meta: { base: BASE, cases: captured.length, settings: Object.keys(SETTINGS), note: 'CNSFlight-engine breakdown baseline for static/flight-model.js parity (G2/G4). Regenerate: node tests/golden_capture.mjs. Verify: node tests/golden_capture.mjs --check.' }, cases: captured };
  fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
  fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + '\n');
  console.log(`captured ${captured.length} cases x ${Object.keys(SETTINGS).length} settings -> tests/goldens/flight-current.golden.json\n`);
  for (const cs of captured) {
    for (const [v, o] of Object.entries(cs.variants)) {
      const sumCharge = (o.phases || []).filter(p => p.kind === 'charge').reduce((s, p) => s + (p.energy || 0), 0);
      console.log(`  ${cs.name.padEnd(20)} [${v.padEnd(9)}] used=${String(o.energyUsedKwh).padStart(7)}  arrival=${String(o.arrivalSoc).padStart(6)}  chargeMin=${String(o.chargeMin).padStart(6)}  Σcharge=${round(sumCharge)}`);
    }
  }
}

// Run only when invoked directly (so a future engine-parity test can import the helpers).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
