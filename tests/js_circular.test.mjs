/*
 * Circular trip type — node harness over the client stack (flight-model,
 * demand, scheduler, recompute). A circular trip closes the ring
 * O → stops → D → back to O; the terminal charge is at HOME.
 * Run:  node tests/js_circular.test.mjs
 */
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadStack, AP } from './golden_capture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANES = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'planes.fixture.json'), 'utf8')).map(p => [p.id, p]));
const wp = (k) => ({ ident: k, name: AP[k].name, lat: AP[k].lat, lon: AP[k].lon });
const ap = (k, type = 'medium_airport') => ({ ident: k, name: AP[k].name, type, latitude_deg: AP[k].lat, longitude_deg: AP[k].lon, iata_code: '', alternate_km: 0 });

const approx = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;

const S = loadStack();
const beta = PLANES.beta_plane;

console.log('Circular trip type (flight-model / demand / scheduler / recompute) — node harness\n');

// ---- engine: chain + roles --------------------------------------------------
test('_expandChain: circular closes the ring back to the origin', () => {
  const chain = S.CNSFlight._expandChain([wp('EHAM'), wp('EHRD'), wp('LFPG')], 'circular');
  const idents = chain.map(w => w.ident);
  assert.equal(idents.join(','), 'EHAM,EHRD,LFPG,EHAM');
});

function circularProfile() {
  S.CNSSettings.reset();
  S.CNSSettings.save({ landingReserve: { enabled: false }, routingPadding: { enabled: false }, chargeTarget: { enabled: false }, chargeTaper: { enabled: false }, chargerEfficiency: { enabled: false } });
  return S.CNSFlight.simulateTrip(beta, [wp('EHAM'), wp('EHRD'), wp('LFPG')],
    { tripType: 'circular', getTargetSoc: () => null, getChargerKw: () => 250 });
}

test('simulateTrip: circular has stops+2 legs; the last returns home', () => {
  const prof = circularProfile();
  assert.equal(prof.legs.length, 3, `expected 3 legs, got ${prof.legs.length}`);
  const last = prof.legs[prof.legs.length - 1];
  assert.ok(last.fromIdent === 'LFPG' && last.toIdent === 'EHAM', `closing leg ${last.fromIdent}→${last.toIdent}`);
  assert.ok(prof.multiLeg, 'circular must be multiLeg');
});

test('simulateTrip: terminal charge is HOME at the origin; only it is direction back', () => {
  const prof = circularProfile();
  const term = prof.charges[prof.charges.length - 1];
  assert.ok(term.role === 'home' && term.ident === 'EHAM', `terminal ${term.role}@${term.ident}`);
  const backs = prof.charges.filter(c => c.direction === 'back');
  assert.ok(backs.length === 1 && backs[0] === term, 'only the closing charge is direction back');
  const roles = prof.charges.map(c => c.role).join(',');
  assert.equal(roles, 'stop,dest,home');
});

test('simulateTrip: loop conserves energy (departs full, tops to full at home)', () => {
  const prof = circularProfile();
  const burned = prof.legs.reduce((s, l) => s + l.energyKwh, 0);
  const charged = prof.charges.reduce((s, c) => s + c.energyKwh, 0);
  assert.ok(approx(charged, burned), `charged ${charged} vs burned ${burned}`);
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
  assert.equal(S.CNSDemand.roleAt(t, 'EHAM'), 'home');
  assert.equal(S.CNSDemand.roleAt(t, 'LFPG'), 'dest');
  assert.equal(S.CNSDemand.roleAt(t, 'EHRD'), 'stop');
});

test('demand.computeAirports: origin gets exactly ONE contribution (home, back) — no zero-origin duplicate', () => {
  const t = savedCircularTrip();
  S.CNSState.setJSON('cns_folder', [t]);
  const airports = S.CNSDemand.computeAirports();
  const home = airports['EHAM'];
  assert.ok(home, 'home airport missing');
  assert.equal(home.contribs.length, 1, `expected 1 contribution at home, got ${home.contribs.length}: ` + home.contribs.map(c => c.role).join(','));
  assert.equal(home.contribs[0].role, 'home');
  assert.equal(home.contribs[0].direction, 'back', 'home charge should be the return visit');
  assert.ok(home.contribs[0].base > 0, 'home charge energy should be > 0');
});

// ---- scheduler: roles + fleet default ----------------------------------------
test('scheduler.roleAt: circular origin is HOME (the closing recharge is scheduled)', () => {
  const t = savedCircularTrip();
  assert.equal(S.CNSScheduler.roleAt(t, 'EHAM'), 'home');
});

test('scheduler fleet default: circular matches retour — unset = separate (parallel starts), shared = sequential', () => {
  // fleetSeparate isn't exported; observe it through instanceStarts:
  // separate fleets all depart at DAY_START, a shared aircraft staggers.
  const base = { ...savedCircularTrip(), freqN: 2, flightTimeH: 4 };
  S.CNSState.setJSON('cns_sched', {});
  const unset = S.CNSScheduler.instanceStarts({ ...base, id: 'cu', fleetMode: undefined });
  assert.ok(unset.length === 2 && unset[0] === unset[1], 'unset circular should default separate (parallel starts): ' + unset.join(','));
  const shared = S.CNSScheduler.instanceStarts({ ...base, id: 'cs', fleetMode: 'shared' });
  assert.ok(shared.length === 2 && shared[1] > shared[0], 'shared circular should fly sequential rotations: ' + shared.join(','));
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
  assert.equal(out.feasible, true, 'circular should stay feasible: ' + out.infeasibleReason);
  assert.equal(out.multiLeg, true, 'circular must stay multiLeg after recompute');
  const term = out.charges[out.charges.length - 1];
  assert.ok(term && term.ident === 'EHAM' && term.role === 'home', 'recomputed terminal must be home@EHAM');
  assert.equal(out.legs.length, out.stops.length + 2, `legs ${out.legs.length} vs stops+2 ${out.stops.length + 2}`);
});
