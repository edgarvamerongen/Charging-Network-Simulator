/*
 * Circular trip type — node harness over the client stack (flight-model,
 * demand, scheduler, recompute). A circular trip closes the ring
 * O → stops → D → back to O; the terminal charge is at HOME.
 * Run:  node tests/js_circular.test.mjs
 */
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { loadStack, AP } from './golden_capture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANES = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(REPO, 'planes.json'), 'utf8')).map(p => [p.id, p]));
const wp = (k) => ({ ident: k, name: AP[k].name, lat: AP[k].lat, lon: AP[k].lon });
const ap = (k, type = 'medium_airport') => ({ ident: k, name: AP[k].name, type, latitude_deg: AP[k].lat, longitude_deg: AP[k].lon, iata_code: '', alternate_km: 0 });

let pass = 0, fail = 0;
const test = (n, fn) => { try { fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };
const approx = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;

const S = loadStack();
const beta = PLANES.beta_plane;

console.log('Circular trip type (flight-model / demand / scheduler / recompute) — node harness\n');

// ---- engine: chain + roles --------------------------------------------------
test('_expandChain: circular closes the ring back to the origin', () => {
  const chain = S.CNSFlight._expandChain([wp('EHAM'), wp('EHRD'), wp('LFPG')], 'circular');
  const idents = chain.map(w => w.ident);
  if (idents.join(',') !== 'EHAM,EHRD,LFPG,EHAM') throw new Error('chain ' + idents.join(','));
});

function circularProfile() {
  S.CNSSettings.reset();
  S.CNSSettings.save({ landingReserve: { enabled: false }, routingPadding: { enabled: false }, chargeTarget: { enabled: false }, chargeTaper: { enabled: false }, chargerEfficiency: { enabled: false } });
  return S.CNSFlight.simulateTrip(beta, [wp('EHAM'), wp('EHRD'), wp('LFPG')],
    { tripType: 'circular', getTargetSoc: () => null, getChargerKw: () => 250 });
}

test('simulateTrip: circular has stops+2 legs; the last returns home', () => {
  const prof = circularProfile();
  if (prof.legs.length !== 3) throw new Error(`expected 3 legs, got ${prof.legs.length}`);
  const last = prof.legs[prof.legs.length - 1];
  if (last.fromIdent !== 'LFPG' || last.toIdent !== 'EHAM') throw new Error(`closing leg ${last.fromIdent}→${last.toIdent}`);
  if (!prof.multiLeg) throw new Error('circular must be multiLeg');
});

test('simulateTrip: terminal charge is HOME at the origin; only it is direction back', () => {
  const prof = circularProfile();
  const term = prof.charges[prof.charges.length - 1];
  if (term.role !== 'home' || term.ident !== 'EHAM') throw new Error(`terminal ${term.role}@${term.ident}`);
  const backs = prof.charges.filter(c => c.direction === 'back');
  if (backs.length !== 1 || backs[0] !== term) throw new Error('only the closing charge is direction back');
  const roles = prof.charges.map(c => c.role).join(',');
  if (roles !== 'stop,dest,home') throw new Error('roles ' + roles);
});

test('simulateTrip: loop conserves energy (departs full, tops to full at home)', () => {
  const prof = circularProfile();
  const burned = prof.legs.reduce((s, l) => s + l.energyKwh, 0);
  const charged = prof.charges.reduce((s, c) => s + c.energyKwh, 0);
  if (!approx(charged, burned)) throw new Error(`charged ${charged} vs burned ${burned}`);
});

// ---- demand: roles + contributions ------------------------------------------
function savedCircularTrip() {
  const prof = circularProfile();
  return {
    id: 'c1', tripType: 'circular', multiLeg: true,
    originIdent: 'EHAM', originName: AP.EHAM.name, originLat: AP.EHAM.lat, originLon: AP.EHAM.lon,
    destIdent: 'LFPG', destName: AP.LFPG.name, destLat: AP.LFPG.lat, destLon: AP.LFPG.lon,
    planeId: 'beta_plane', planeName: beta.name, battery: beta.battery_kwh,
    range_km: beta.range_km, speed_kmh: beta.speed_kmh,
    chargerId: 'dc_250', chargerName: '250 kW DC', chargerPower: 250,
    freqN: 1, freqUnit: 'day',
    stops: [{ ident: 'EHRD', name: AP.EHRD.name, lat: AP.EHRD.lat, lon: AP.EHRD.lon }],
    charges: prof.charges.map(c => ({ ident: c.ident, name: c.name, lat: c.lat, lon: c.lon, role: c.role, at_index: c.atIndex, energy_kwh: c.energyKwh })),
    legs: prof.legs.map(l => ({ from: { name: l.fromName, ident: l.fromIdent }, to: { name: l.toName, ident: l.toIdent }, distance_km: l.distKm, flight_time_h: (l.flightMin || 0) / 60, energy_kwh: l.energyKwh })),
  };
}

test('demand.roleAt: circular origin is HOME, dest is dest, stop is stop', () => {
  const t = savedCircularTrip();
  if (S.CNSDemand.roleAt(t, 'EHAM') !== 'home') throw new Error('origin should be home, got ' + S.CNSDemand.roleAt(t, 'EHAM'));
  if (S.CNSDemand.roleAt(t, 'LFPG') !== 'dest') throw new Error('dest role');
  if (S.CNSDemand.roleAt(t, 'EHRD') !== 'stop') throw new Error('stop role');
});

test('demand.computeAirports: origin gets exactly ONE contribution (home, back) — no zero-origin duplicate', () => {
  const t = savedCircularTrip();
  S.CNSState.setJSON('cns_folder', [t]);
  const airports = S.CNSDemand.computeAirports();
  const home = airports['EHAM'];
  if (!home) throw new Error('home airport missing');
  if (home.contribs.length !== 1) throw new Error(`expected 1 contribution at home, got ${home.contribs.length}: ` + home.contribs.map(c => c.role).join(','));
  if (home.contribs[0].role !== 'home') throw new Error('home contribution role ' + home.contribs[0].role);
  if (home.contribs[0].direction !== 'back') throw new Error('home charge should be the return visit');
  if (!(home.contribs[0].base > 0)) throw new Error('home charge energy should be > 0');
});

test('demand.energyAt: home energy == the closing charge', () => {
  const t = savedCircularTrip();
  const term = t.charges[t.charges.length - 1];
  const got = S.CNSDemand.energyAt(t, 'EHAM');
  if (!approx(got, term.energy_kwh)) throw new Error(`energyAt home ${got} vs terminal ${term.energy_kwh}`);
});

// ---- scheduler: roles + fleet default ----------------------------------------
test('scheduler.roleAt: circular origin is HOME (the closing recharge is scheduled)', () => {
  const t = savedCircularTrip();
  if (S.CNSScheduler.roleAt(t, 'EHAM') !== 'home') throw new Error('scheduler origin role ' + S.CNSScheduler.roleAt(t, 'EHAM'));
});

test('scheduler fleet default: circular matches retour — unset = separate (parallel starts), shared = sequential', () => {
  // fleetSeparate isn't exported; observe it through instanceStarts:
  // separate fleets all depart at DAY_START, a shared aircraft staggers.
  const base = { ...savedCircularTrip(), freqN: 2, flightTimeH: 4 };
  S.CNSState.setJSON('cns_sched', {});
  const unset = S.CNSScheduler.instanceStarts({ ...base, id: 'cu', fleetMode: undefined });
  if (!(unset.length === 2 && unset[0] === unset[1])) throw new Error('unset circular should default separate (parallel starts): ' + unset.join(','));
  const shared = S.CNSScheduler.instanceStarts({ ...base, id: 'cs', fleetMode: 'shared' });
  if (!(shared.length === 2 && shared[1] > shared[0])) throw new Error('shared circular should fly sequential rotations: ' + shared.join(','));
});

// ---- recompute: ring is preserved --------------------------------------------
test('recomputeFlight: circular stays multiLeg + feasible; ring intact', () => {
  S.CNSSettings.reset();
  const t = { ...savedCircularTrip(), stops: [{ ident: 'EHRD', name: AP.EHRD.name, lat: AP.EHRD.lat, lon: AP.EHRD.lon, _manual: true }] };
  const ctx = {
    allAirports: ['EHAM', 'EHRD', 'LFPG', 'EHGG', 'EGLL'].map(k => ap(k)),
    allowedTypes: ['medium_airport', 'large_airport'],
    planeFor: () => beta,
    availableRangeKm: (plane) => plane.range_km * S.CNSSettings.usableFraction(plane) / S.CNSSettings.routingFactor(),
  };
  const out = S.CNSRecompute.recomputeFlight(t, ctx);
  if (out.feasible !== true) throw new Error('circular should stay feasible: ' + out.infeasibleReason);
  if (out.multiLeg !== true) throw new Error('circular must stay multiLeg after recompute');
  const term = out.charges[out.charges.length - 1];
  if (!term || term.ident !== 'EHAM' || term.role !== 'home') throw new Error('recomputed terminal must be home@EHAM');
  if (out.legs.length !== out.stops.length + 2) throw new Error(`legs ${out.legs.length} vs stops+2 ${out.stops.length + 2}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
