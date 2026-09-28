/*
 * Automatic take-offs (CNSScheduler.runGlobal). A take-off is automatic unless the user fixed it:
 * an automatic flight leaves as much later as it can without finishing later, so it lands when its
 * charger is free instead of queueing (departure first). Waiting is left where that can't absorb it
 * and for fixed take-offs, which fly exactly as set and are planned before the automatic ones.
 *
 * Server up on :5055 for /api/simulate geometry (like js_whatif). Skips when it is down.
 * Run:  CNS_BASE_URL=http://127.0.0.1:5055 node --test tests/js_autoplace.test.mjs
 */
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadStack, AP } from './golden_capture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANES = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'planes.fixture.json'), 'utf8')).map(p => [p.id, p]));
const BASE = process.env.CNS_BASE_URL || 'http://127.0.0.1:5055';
const CHARGERS = { dc_250: { id: 'dc_250', name: '250 kW DC', power_kw: 250 } };
const co = k => ({ ident: k, name: AP[k].name, lat: AP[k].lat, lon: AP[k].lon });

let data = null, skip = null;
try {
  const r = await fetch(BASE + '/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin: co('EHAM'), destination: co('EHGG'), plane_id: 'beta_plane', charger_id: 'dc_250', trip_type: 'retour' }) });
  data = await r.json(); if (data.error) skip = 'sim error: ' + data.error;
} catch (e) { skip = `server at ${BASE} not reachable`; }

if (skip) test('automatic take-offs', { skip }, () => {});
else {
  const P = PLANES.beta_plane, D0 = 420;
  // Six separate aircraft turn at EHGG, which has one charger (the what-if test's network).
  const trip = (id, extra) => ({ id, planeId: 'beta_plane', planeName: P.name, tripType: 'retour',
    originIdent: 'EHAM', originName: AP.EHAM.name, originLat: AP.EHAM.lat, originLon: AP.EHAM.lon,
    destIdent: 'EHGG', destName: AP.EHGG.name, destLat: AP.EHGG.lat, destLon: AP.EHGG.lon,
    battery: P.battery_kwh, range_km: P.range_km, speed_kmh: P.speed_kmh, chargerId: 'dc_250', chargerName: 'dc_250', chargerPower: 250,
    legEnergy: data.leg_energy_kwh, flightTimeH: data.flight_time_h, freqN: 6, freqUnit: 'day', fleetMode: 'separate', ...extra });
  const S = loadStack(); S.CNSSettings.reset();
  S.localStorage.setItem('cns_folder', JSON.stringify([trip('t-a')]));
  S.localStorage.setItem('cns_airport_cfg', JSON.stringify({ EHGG: { chargers: ['dc_250'] } }));
  S.CNSScheduler.init({ chargers: CHARGERS });
  const charges = r => r.phases.filter(p => p.kind === 'charge' && p.dur > 0);
  /** The day for a stored schedule (null = leave storage as it is), as plain data. */
  const day = sched => {
    if (sched !== null) S.localStorage.setItem('cns_schedule', JSON.stringify(sched));
    S.CNSScheduler.runGlobal();
    return JSON.parse(JSON.stringify(S.CNSScheduler.runGlobal().lanes.map(L => L.rotations.map(r => ({ takeoff: r.takeoff, end: r.end, fixed: r.fixed, charges: charges(r).map(c => ({ ident: c.ident, start: c.start, dur: c.dur, wait: c.wait, queue: c.queue })) })))));
  };
  const flat = d => d.flat();
  const auto = flat(day({ _v: 2 }));
  const old = flat(day({ _v: 2, 't-a': new Array(6).fill(D0) }));    // everyone fixed at 07:00: the old day

  test('automatic take-offs are staggered so nobody queues at the turnaround charger', () => {
    const offs = auto.map(r => r.takeoff);
    assert.equal(offs[0], D0);
    offs.slice(1).forEach((t, i) => assert.ok(t > offs[i], `take-offs not staggered: ${offs.join(', ')}`));
    auto.forEach(r => assert.equal(r.charges[0].wait, 0, `waits ${r.charges[0].wait} min at ${r.charges[0].ident}`));
    assert.ok(old.some(r => r.charges[0].wait > 0), 'the 07:00 day should queue');
  });
  test('departure first never makes a rotation finish later, and never waits more', () => {
    auto.forEach((r, i) => assert.ok(Math.abs(r.end - old[i].end) < 1e-6, `rotation ${i} ends ${r.end} vs ${old[i].end}`));
    const waited = d => d.reduce((s, r) => s + r.charges.reduce((a, c) => a + c.wait, 0), 0);
    assert.ok(waited(auto) < waited(old), `waited ${waited(auto)} vs ${waited(old)}`);
    auto.forEach((r, i) => assert.ok(r.takeoff >= old[i].takeoff));
  });
  test('the queue delay a charger causes is still reported (sizing)', () => {
    const q = d => d.reduce((s, r) => s + r.charges.filter(c => c.ident === 'EHGG').reduce((a, c) => a + c.queue, 0), 0);
    assert.ok(q(auto) > 0);
    assert.ok(Math.abs(q(auto) - q(old)) < 1e-6);
  });
  test('a fixed take-off flies exactly as set; automatic flights are planned around it', () => {
    const d = flat(day({ _v: 2, 't-a': [null, null, null, null, null, D0] }));
    assert.equal(d[5].takeoff, D0); assert.equal(d[5].fixed, true); assert.equal(d[5].charges[0].wait, 0);
    d.slice(0, 5).forEach(r => { assert.equal(r.fixed, false); assert.ok(r.takeoff > D0); assert.equal(r.charges[0].wait, 0); });
  });
  test('an automatic flight is planned past a fixed one rather than wait for its charger', () => {
    // Fixed at 08:00, #1 holds the turnaround and home chargers in the middle of the morning queue.
    const d = flat(day({ _v: 2, 't-a': [480, null, null, null, null, null] }));
    assert.equal(d[0].takeoff, 480);
    d.slice(1).forEach((r, i) => r.charges.forEach(c => assert.equal(c.wait, 0, `aircraft ${i + 2} waits ${c.wait} min at ${c.ident}`)));
  });
  test('two take-offs fixed at the same time: the second waits at the charger', () => {
    const d = flat(day({ _v: 2, 't-a': [D0, D0, null, null, null, null] }));
    assert.equal(d[0].takeoff, D0); assert.equal(d[1].takeoff, D0);
    assert.ok(d[1].charges[0].wait > 0, 'no wait for a clashing fixed take-off');
  });
  test('a schedule saved before automatic placement: the 07:00 default becomes automatic, a dragged time stays fixed', () => {
    const d = flat(day({ 't-a': [D0, D0, 500, D0, D0, D0] }));
    assert.equal(S.CNSScheduler.fixedCount(), 1);
    assert.equal(d[2].takeoff, 500); assert.equal(d[2].fixed, true);
    assert.equal(JSON.parse(S.localStorage.getItem('cns_schedule'))._v, 2);
  });
  test('fixing a shared aircraft\'s later rotation fixes the earlier ones where they fly, then releaseAll frees them', () => {
    S.localStorage.setItem('cns_folder', JSON.stringify([trip('t-s', { freqN: 3, fleetMode: 'shared' })]));
    const d0 = day({ _v: 2 })[0];
    S.CNSScheduler.setTakeoff('t-s', 2, 1100);
    const s = JSON.parse(S.localStorage.getItem('cns_schedule'))['t-s'];
    assert.deepEqual(s, [Math.round(d0[0].takeoff), Math.round(d0[1].takeoff), 1100]);
    assert.equal(day(null)[0][2].takeoff, 1100);
    S.CNSScheduler.releaseAll();
    assert.equal(S.CNSScheduler.fixedCount(), 0);
  });
}
