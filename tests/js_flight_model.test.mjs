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

// No intended deltas: the golden is now ENGINE-derived (the engine-capture harness), so every case
// reproduces it exactly. The former 'retour-beta:target50' delta — the engine correcting the old
// deliveredEnergy over-recharge that broke energy conservation (R9 / audit T1.4) — is now absorbed
// into the regenerated golden (it carries the conserved value, so no diff remains to flag).
const KNOWN_DELTA = new Set([]);

let pass = 0, fail = 0, deltas = 0;

// ---- sidStarPadding integration: a fixed km adds to EACH leg's routed distance,
//      additive on top of routing padding (energy + time follow). The reach the
//      planner enforces (availRangeKm) RESERVES the pad, so a padded leg still
//      respects the plane's max range; the DISPLAYED available range stays whole
//      (reach + pad == full range). (Default-OFF is covered by the goldens.)
(function sidStarIntegration() {
  const S = loadStack();
  // Regime cutover: SID/STAR + routing padding are IFR-only, so use an IFR-capable plane
  // (Beta). The reach the planner enforces is now the regime usableRange (gross×(1−min_soc)
  // − reserve − divert), NOT the raw range — the pad is carved out of THAT.
  const plane = PLANES['beta_plane'];
  const ePerKm = plane.battery_kwh / plane.range_km;
  const waypoints = [wp('EHAM'), wp('LFPG')];
  const run = () => S.CNSFlight.simulateTrip(plane, waypoints, { tripType: 'one-way', ruleMode: 'ifr', getChargerKw: () => 250 });
  // the IFR planning reach before any SID/STAR pad (what avail0 must equal)
  const usable = S.CNSPlaneSchema.usableRange(plane, 'ifr', null, { alternateKm: +plane.divert_km || 0 });
  // baseline: SID/STAR + routing padding OFF -> leg == rawKm, reach == the usable planning range
  S.CNSSettings.save({ routingPadding: { enabled: false }, sidStarPadding: { enabled: false } });
  const base = run();
  const rawKm = base.legs[0].rawKm, d0 = base.legs[0].distKm, e0 = base.legs[0].energyKwh, avail0 = base.availRangeKm;
  // SID/STAR on at 30 km (IFR only)
  S.CNSSettings.save({ sidStarPadding: { enabled: true, km: 30 } });
  const padded = run();
  const d1 = padded.legs[0].distKm, e1 = padded.legs[0].energyKwh, avail1 = padded.availRangeKm;
  const eq = (a, b) => Math.abs(a - b) < 1e-6;
  const checks = [
    [eq(d0, rawKm), `routing off -> distKm == rawKm (${d0} vs ${rawKm})`],
    [eq(d1, rawKm + 30), `SID/STAR 30km -> distKm == rawKm + 30 (${d1} vs ${rawKm + 30})`],
    [eq(e1, ePerKm * d1), `energy tracks padded distKm (${e1} vs ${ePerKm * d1})`],
    [e1 > e0 + 1e-6, `padded energy exceeds baseline (${e1} > ${e0})`],
    [eq(avail0, usable), `reach (no pad) == regime usable range (${avail0} vs ${usable})`],
    [eq(avail1, usable - 30), `reach RESERVES the pad — == usable − 30 (${avail1} vs ${usable - 30})`],
    [eq(avail1 + 30, usable), `reach + pad == full usable range — a padded leg still respects the max (${avail1 + 30} vs ${usable})`],
    // display↔engine parity: the planning-aid distance shown in the trajectory pill +
    // route list is _dispKm = CNSRouting.routedKm + sidStarPaddingKm. It must equal the
    // engine's per-leg distKm, so the SHOWN distance moves with the pad exactly like the
    // result panel (which reads distKm). Guards the _dispKm vs _legEst (geographic) split.
    [eq(S.CNSRouting.routedKm(waypoints[0], waypoints[1]) + S.CNSSettings.sidStarPaddingKm(), d1),
      `_dispKm (routedKm + pad) == engine distKm (${S.CNSRouting.routedKm(waypoints[0], waypoints[1]) + S.CNSSettings.sidStarPaddingKm()} vs ${d1})`],
  ];
  for (const [okc, msg] of checks) {
    if (okc) { pass++; console.log(`  ok    sidStar — ${msg}`); }
    else { fail++; console.log(`  FAIL  sidStar — ${msg}`); }
  }
})();

// ---- result-panel reconciliation: index.html renderResult now reads each leg's engine
//      distKm + energyKwh (both paddings baked in) for the route rows, and totals.distKm
//      for "Total travel". Those rows must SUM to the totals the headline shows — otherwise
//      a leg row and its own headline disagree (the bug this fixes). Guards that invariant
//      at the engine level with BOTH distance factors on, multi-leg.
(function legsReconcileTotals() {
  const S = loadStack();
  S.CNSSettings.reset();
  S.CNSSettings.save({ routingPadding: { enabled: true, factor: 1.05 }, sidStarPadding: { enabled: true, km: 20 } });
  const plane = PLANES['beta_plane'];
  const route = S.CNSSettings.routingFactor(), sid = S.CNSSettings.sidStarPaddingKm();
  const prof = S.CNSFlight.simulateTrip(plane, [wp('EHAM'), wp('EHRD'), wp('EGLL')], { tripType: 'one-way', getChargerKw: () => 250 });
  const legs = prof.legs || [];
  const eq = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;
  const sumDist = legs.reduce((s, l) => s + l.distKm, 0);
  const sumEnergy = legs.reduce((s, l) => s + l.energyKwh, 0);
  const rChecks = [
    [legs.length === 2, `multi-leg trip yields 2 legs (got ${legs.length})`],
    [legs.every(l => eq(l.distKm, l.rawKm * route + sid)), `each leg distKm == rawKm × ${route} + ${sid} (both paddings)`],
    [eq(sumDist, prof.totals.distKm), `Σ leg distKm == totals.distKm — rows sum to "Total travel" (${sumDist.toFixed(3)} vs ${prof.totals.distKm.toFixed(3)})`],
    [eq(sumEnergy, prof.totals.energyUsedKwh), `Σ leg energyKwh == totals.energyUsedKwh — rows reconcile with headline (${sumEnergy.toFixed(3)} vs ${prof.totals.energyUsedKwh.toFixed(3)})`],
  ];
  for (const [okc, msg] of rChecks) {
    if (okc) { pass++; console.log(`  ok    reconcile — ${msg}`); }
    else { fail++; console.log(`  FAIL  reconcile — ${msg}`); }
  }
})();

// ---- SID/STAR gates feasibility: the pad is in the COMPLETE forward model, so a leg that
//      fits the plane's max range bare must flip to OVER-RANGE once the pad pushes its routed
//      distance past that max. (Synthetic plane + self-calibrated boundary so it's robust to
//      catalog retunes; routing off to isolate the additive pad.)
(function padGatesMaxRange() {
  const S = loadStack();
  S.CNSSettings.reset();
  // Pin the reserve (don't inherit the default) + size the plane so fullAvail
  // (range × 0.8 = 416 km) brackets the EHAM→LFPG leg (~399 km): bare fits, +30 tips.
  S.CNSSettings.save({ routingPadding: { enabled: false }, landingReserve: { enabled: true, minLandingSoc: 0.20 } });   // route = 1 → distKm = rawKm + sid
  const plane = { id: 'test_mid', name: 'Test Mid', battery_kwh: 200, range_km: 520, speed_kmh: 300, c_rate: 2 };
  const run = () => S.CNSFlight.simulateTrip(plane, [wp('EHAM'), wp('LFPG')], { tripType: 'one-way', getChargerKw: () => 250 });
  S.CNSSettings.save({ sidStarPadding: { enabled: false } });
  const noPad = run();
  S.CNSSettings.save({ sidStarPadding: { enabled: true, km: 30 } });
  const padded = run();
  const rawKm = noPad.legs[0].rawKm;
  const fullAvail = noPad.usable_kwh * plane.range_km / plane.battery_kwh;   // routed max distance on usable energy (= displayed available range)
  const gChecks = [
    [rawKm < fullAvail && rawKm + 30 > fullAvail, `boundary setup: bare ${rawKm.toFixed(0)}km fits ${fullAvail.toFixed(0)}km, +30 tips over`],
    [noPad.legs[0].overRange === false, `bare leg fits the max range (not over-range)`],
    [padded.legs[0].overRange === true, `+30km SID/STAR pad tips the SAME leg OVER the max range — pad gates feasibility`],
  ];
  for (const [okc, msg] of gChecks) {
    if (okc) { pass++; console.log(`  ok    gate — ${msg}`); }
    else { fail++; console.log(`  FAIL  gate — ${msg}`); }
  }
})();

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
// ---- the single reach seam: every consumer (planner UI, router, displays) reads these ----
(function reachSeam() {
  const S = loadStack();
  const beta = PLANES['beta_plane'];          // 630 gross, 225 kWh, 250 km/h, divert_km 50, IFR-capable
  const velis = PLANES['pipistrel_velis'];    // ifr_capable false (certified)
  S.CNSSettings.reset();                      // defaults: ruleMode ifr, sidStar 10 ON, routingPadding OFF
  const eq = (a, b, t) => Math.abs(a - b) < (t || 1e-6);
  const checks = [
    [S.CNSFlight.effectiveRegime(beta) === 'ifr', `effectiveRegime(beta) defaults to global ifr`],
    [S.CNSFlight.effectiveRegime(beta, 'vfr') === 'vfr', `explicit ruleMode wins`],
    [S.CNSFlight.effectiveRegime(velis, 'ifr') === 'vfr', `VFR-only plane is forced vfr`],
    [eq(S.CNSFlight.planningRangeKm(beta), 203.5), `beta IFR planning = 441 − 187.5 − 50 (got ${S.CNSFlight.planningRangeKm(beta)})`],
    [eq(S.CNSFlight.planningRangeKm(beta, { ruleMode: 'vfr' }), 316), `beta VFR planning = 441 − 125, no divert (got ${S.CNSFlight.planningRangeKm(beta, { ruleMode: 'vfr' })})`],
    [eq(S.CNSFlight.availableRangeKm(beta), 193.5), `beta IFR reach carves the 10 km sidStar (got ${S.CNSFlight.availableRangeKm(beta)})`],
    [eq(S.CNSFlight.availableRangeKm(beta, { ruleMode: 'vfr' }), 316), `beta VFR reach: no sidStar, no routing (got ${S.CNSFlight.availableRangeKm(beta, { ruleMode: 'vfr' })})`],
    [eq(S.CNSFlight.planningRangeKm(velis), 0), `velis planning range 0 — reserve exceeds endurance`],
    // engine parity: simulateTrip's enforced reach IS the seam value
    [eq(S.CNSFlight.simulateTrip(beta, [wp('EHAM'), wp('LFPG')], { tripType: 'one-way', getChargerKw: () => 250 }).availRangeKm,
        S.CNSFlight.availableRangeKm(beta)), `simulateTrip.availRangeKm === availableRangeKm(plane)`],
  ];
  for (const [okc, msg] of checks) {
    if (okc) { pass++; console.log(`  ok    seam — ${msg}`); }
    else { fail++; console.log(`  FAIL  seam — ${msg}`); }
  }
})();

// ---- tripPlane: catalog planes ignore stale per-trip physics snapshots (auto-migration) ----
// No `customPlane` flag exists anywhere in the codebase (grepped); the real detection mechanism
// mirrors profileForTrip's own lookup (:246) and report.js's _usedPlanes (:211): a plane is
// "catalog" iff its planeId resolves in window.PLANES_BY_ID. Anything else (a CNSPlanes-registered
// custom plane, or a truly unknown/deleted planeId) keeps the trip's own carried physics.
(function tripPlaneHeal() {
  const S = loadStack();
  const staleTrip = { planeId: 'beta_plane', range_km: 500, speed_kmh: 250, battery_kwh: 225 };
  const p1 = S.CNSFlight.tripPlane(staleTrip);
  const customTrip = { planeId: 'my_custom', range_km: 333, speed_kmh: 200, battery_kwh: 100, name: 'X' };
  const p2 = S.CNSFlight.tripPlane(customTrip);
  const checks = [
    [p1 && p1.range_km === 630, `catalog plane heals to catalog range (got ${p1 && p1.range_km})`],
    [p1 && p1.divert_km === 50, `catalog divert_km rides along`],
    [p2 && p2.range_km === 333, `custom plane keeps its own physics (got ${p2 && p2.range_km})`],
  ];
  for (const [okc, msg] of checks) {
    if (okc) { pass++; console.log(`  ok    heal — ${msg}`); }
    else { fail++; console.log(`  FAIL  heal — ${msg}`); }
  }
})();

// ---- tripPlane wired LIVE into profileForTrip: the heal above is only useful if the actual
// saved-trip path (scheduler.js:99 / report.js:68 / index.html:4239, all via profileForTrip)
// assembles its plane through tripPlane instead of its own inline literal. Coords are required —
// profileForTrip returns null without originLat/originLon/destLat/destLon (see :273).
// Field name note: a saved trip carries battery under `battery` (NOT `battery_kwh`) — every real
// writer persists `battery: d.plane.battery_kwh` (flight-entry.js:23, index.html:5435/5649,
// mobile.js:747); these fixtures mirror that on-the-wire shape rather than the FlightProfile's
// own `battery_kwh` naming.
(function tripPlaneLiveInProfileForTrip() {
  const S = loadStack();
  const o = AP.EHAM, d = AP.LFPG;
  // Stale catalog trip: carries an old (pre-cutover) physics snapshot for a plane that IS in
  // the catalog today. Un-wired profileForTrip would use trip.range_km (500) verbatim; wired
  // through tripPlane it must heal to the catalog's current range_km (630), matching
  // availableRangeKm(PLANES['beta_plane']) exactly (heal visible on the LIVE path).
  const staleTrip = {
    planeId: 'beta_plane', planeName: 'Beta Alia CX300', tripType: 'one-way',
    range_km: 500, speed_kmh: 250, battery: 225,
    originIdent: 'EHAM', originName: o.name, originLat: o.lat, originLon: o.lon,
    destIdent: 'LFPG', destName: d.name, destLat: d.lat, destLon: d.lon,
  };
  const p1 = S.CNSFlight.profileForTrip(staleTrip, {});
  const expect1 = S.CNSFlight.availableRangeKm(PLANES['beta_plane']);
  // Custom trip: planeId not in catalog, own physics carried on the trip — must NOT heal;
  // profileForTrip must simulate with exactly this trip's own numbers.
  const customTrip = {
    planeId: 'my_custom', planeName: 'X', tripType: 'one-way',
    range_km: 333, speed_kmh: 200, battery: 100,
    originIdent: 'EHAM', originName: o.name, originLat: o.lat, originLon: o.lon,
    destIdent: 'LFPG', destName: d.name, destLat: d.lat, destLon: d.lon,
  };
  const p2 = S.CNSFlight.profileForTrip(customTrip, {});
  const customPlane = { battery_kwh: 100, range_km: 333, speed_kmh: 200 };
  const expect2 = S.CNSFlight.availableRangeKm(customPlane);
  const checks = [
    // p1/p2 must both RESOLVE (non-null) — a null profile means profileForTrip bailed
    // (e.g. its plane literal never picked up the trip-carried battery), which is itself
    // a failure, not a vacuous pass.
    [p1 != null && p1.availRangeKm === expect1, `LIVE — stale catalog trip through profileForTrip heals to catalog reach (got ${p1 && p1.availRangeKm}, want ${expect1})`],
    [p2 != null && p2.availRangeKm === expect2, `LIVE — custom trip through profileForTrip keeps its own reach (got ${p2 && p2.availRangeKm}, want ${expect2})`],
  ];
  for (const [okc, msg] of checks) {
    if (okc) { pass++; console.log(`  ok    ${msg}`); }
    else { fail++; console.log(`  FAIL  ${msg}`); }
  }
})();

console.log(`\n${pass} pass, ${deltas} intended delta(s), ${fail} fail (of ${golden.cases.length * golden._meta.settings.length})`);
process.exit(fail ? 1 : 0);
