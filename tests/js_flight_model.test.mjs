/*
 * Engine-parity test: CNSFlight.simulateTrip (static/flight-model.js) vs the captured
 * current-stack golden (tests/goldens/flight-current.golden.json). No server needed —
 * the engine rebuilds geometry from coords; we diff its tripBreakdown-equivalent output
 * against the golden within tolerance (engine haversine vs sim.py's may differ by epsilon).
 *
 * Run:  node tests/js_flight_model.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStack, AP } from './golden_capture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const PLANES = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(REPO, 'planes.json'), 'utf8')).map(p => [p.id, p]));
const GP = path.join(REPO, 'tests', 'goldens', 'flight-current.golden.json');
if (!fs.existsSync(GP)) { console.log('SKIP: no golden yet (run node tests/golden_capture.mjs).'); process.exit(0); }
const golden = JSON.parse(fs.readFileSync(GP, 'utf8'));

const SET = {
  off:       S => S.save({ landingReserve: { enabled: false }, routingPadding: { enabled: false }, chargeTarget: { enabled: false }, chargeTaper: { enabled: false }, chargerEfficiency: { enabled: false } }),
  default:   S => S.reset(),
  target100: S => { S.reset(); S.save({ chargeTarget: { enabled: true, value: 1.0 } }); },
  target50:  S => { S.reset(); S.save({ chargeTarget: { enabled: true, value: 0.5 } }); },
};
const wp = (k) => ({ ident: k, name: AP[k].name, lat: AP[k].lat, lon: AP[k].lon });

function engineSnapshot(c, vname) {
  const S = loadStack();
  SET[vname](S.CNSSettings);
  const plane = PLANES[c.input.plane];
  const o = c.input.o, d = c.input.trip === 'training' ? c.input.o : c.input.d, stops = c.input.stops || [];
  const waypoints = c.input.trip === 'training' ? [wp(o)] : [wp(o), ...stops.map(wp), wp(d)];
  const prof = S.CNSFlight.simulateTrip(plane, waypoints, {
    tripType: c.input.trip,
    getTargetSoc: () => S.CNSSettings.chargeTargetDefault(),
    getChargerKw: () => 250,
    trainingRangeKm: plane.training_range_km,
  });
  const t = prof.totals, term = prof.terminal || {};
  // replicate _breakdownFromProfile's phase mapping (the result-panel route rows)
  let flyN = 0;
  const phases = (prof.phases || []).map(ph => {
    if (ph.kind === 'fly') return { kind: 'fly', leg: prof.multiLeg ? ph.legIndex : (flyN++ === 0 ? 'out' : 'back'), dur: ph.dur };
    const cc = (prof.charges || [])[ph.chargeIndex] || {};
    return { kind: 'charge', at: cc.role, dur: ph.dur, energy: cc.energyKwh };
  });
  return { energyUsedKwh: t.energyUsedKwh, flightMin: t.flightMin, chargeMin: t.chargeMin, enRouteMin: t.enRouteMin, terminalMin: t.terminalMin, terminalKwh: term.energyKwh, terminalName: term.name, arrivalSoc: term.arrivalSocFrac, phases };
}

const FIELDS = ['energyUsedKwh', 'flightMin', 'chargeMin', 'terminalKwh', 'arrivalSoc'];

// INTENDED deltas — the engine deliberately CORRECTS a current-stack artifact (per R9 + audit T1.4):
// in a retour at a LOW charge target, deliveredEnergy makes the plane 'discharge' to the target at
// the turnaround then over-recharges at home, so Σcharges > Σlegs (energy NOT conserved). The engine's
// forward walk conserves (Σcharges == Σlegs == 2·leg). The golden's inflated value here is the bug.
const KNOWN_DELTA = new Set(['retour-beta:target50']);

let pass = 0, fail = 0, deltas = 0;
for (const c of golden.cases) {
  for (const v of golden._meta.settings) {
    let got;
    try { got = engineSnapshot(c, v); }
    catch (e) { fail++; console.log(`  FAIL ${c.name} [${v}] — threw: ${e.message}`); continue; }
    const exp = c.variants[v];
    const diffs = [];
    for (const f of FIELDS) {
      const a = +got[f] || 0, b = +exp[f] || 0;
      const tol = (f === 'arrivalSoc') ? 0.005 : Math.max(0.05, Math.abs(b) * 0.01);
      if (Math.abs(a - b) > tol) diffs.push(`${f}: engine ${a.toFixed(3)} vs golden ${b.toFixed(3)} (Δ${(a - b).toFixed(3)})`);
    }
    // route-row phases parity (count, kind, fly leg, dur, charge energy + role).
    // Skipped for training: the result panel renders training via its own branch (not phases),
    // and the engine's 'training' charge role is correct vs tripBreakdown's 'dest' quirk.
    const ep = c.input.trip === 'training' ? [] : (got.phases || []), gp = c.input.trip === 'training' ? [] : (exp.phases || []);
    if (ep.length !== gp.length) diffs.push(`phase count: engine ${ep.length} vs golden ${gp.length}`);
    else for (let i = 0; i < gp.length; i++) {
      if (ep[i].kind !== gp[i].kind) { diffs.push(`phase ${i} kind: ${ep[i].kind} vs ${gp[i].kind}`); continue; }
      if (Math.abs((+ep[i].dur || 0) - (+gp[i].dur || 0)) > Math.max(0.05, Math.abs(+gp[i].dur || 0) * 0.01)) diffs.push(`phase ${i} dur: ${ep[i].dur} vs ${gp[i].dur}`);
      if (gp[i].kind === 'fly' && String(ep[i].leg) !== String(gp[i].leg)) diffs.push(`phase ${i} leg: ${ep[i].leg} vs ${gp[i].leg}`);
      if (gp[i].kind === 'charge') {
        if (Math.abs((+ep[i].energy || 0) - (+gp[i].energy || 0)) > Math.max(0.05, Math.abs(+gp[i].energy || 0) * 0.01)) diffs.push(`phase ${i} energy: ${ep[i].energy} vs ${gp[i].energy}`);
        if ((ep[i].at || null) !== (gp[i].at || null)) diffs.push(`phase ${i} at: ${ep[i].at} vs ${gp[i].at}`);
      }
    }
    const key = `${c.name}:${v}`;
    if (diffs.length) {
      if (KNOWN_DELTA.has(key)) { deltas++; console.log(`  DELTA ${c.name} [${v}] — engine corrects retour-low-target artifact (conserves energy):\n        ${diffs.join('\n        ')}`); }
      else { fail++; console.log(`  FAIL ${c.name} [${v}]\n        ${diffs.join('\n        ')}`); }
    } else { pass++; console.log(`  ok    ${c.name} [${v}]`); }
  }
}
console.log(`\n${pass} pass, ${deltas} intended delta(s), ${fail} fail (of ${golden.cases.length * golden._meta.settings.length})`);
process.exit(fail ? 1 : 0);
