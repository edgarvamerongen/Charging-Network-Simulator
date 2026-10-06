/*
 * Smart charging (dynamic load balancing under an airport's grid limit): CNSSettings.acceptKw (the CC-CV curve by
 * state of charge) and CNSScheduler's dispatch, which flies the planned day forward with the charges at a limited
 * airport sharing its limit. The limit is never exceeded, every charge still delivers its energy, a slowed charge
 * delays its aircraft, and a limit that never binds (or the switch off) leaves the plan exactly as it was.
 *
 * The scheduler half needs /api/simulate geometry (run_all.sh starts a fixture server; skips without one).
 * Run:  CNS_BASE_URL=http://127.0.0.1:5098 node --test tests/js_smartcharging.test.mjs
 */
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadStack, AP } from './golden_capture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANES = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'planes.fixture.json'), 'utf8')).map(p => [p.id, p]));
const BASE = process.env.CNS_BASE_URL || 'http://127.0.0.1:5055';

test('acceptKw is the taper chargeTimeMin integrates, by state of charge', () => {
  const S = loadStack(); S.CNSSettings.reset();
  const batt = 225, p = 320, s0 = 0.2, e = 180, n = 20000;
  let h = 0; for (let i = 0; i < n; i++) { const soc = s0 + (i + 0.5) * (e / batt) / n; h += (e / n) / S.CNSSettings.acceptKw(soc, p, batt); }
  const want = S.CNSSettings.chargeTimeMin(e, p, batt, s0);
  assert.ok(Math.abs(h * 60 - want) / want < 1e-3, `${(h * 60).toFixed(3)} min vs chargeTimeMin ${want.toFixed(3)}`);
  assert.equal(S.CNSSettings.acceptKw(0.5, p, batt), p);                       // below the knee: full power
  assert.ok(Math.abs(S.CNSSettings.acceptKw(1, p, batt) - p * 0.3) < 1e-9);    // taperPower floor at 100 %
  S.CNSSettings.save({ chargeTaper: { enabled: false } });
  assert.equal(S.CNSSettings.acceptKw(0.95, p, batt), p);
});

const co = k => ({ ident: k, name: AP[k].name, lat: AP[k].lat, lon: AP[k].lon });
let data = null, skip = null;
try {
  const r = await fetch(BASE + '/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin: co('EHAM'), destination: co('EHGG'), plane_id: 'beta_plane', charger_id: 'dc_250', trip_type: 'retour' }) });
  data = await r.json(); if (data.error) skip = 'sim error: ' + data.error;
} catch (e) { skip = `server at ${BASE} not reachable`; }

if (skip) test('smart charging dispatch', { skip }, () => {});
else {
  const P = PLANES.beta_plane;
  // Six aircraft turn at EHGG (two chargers) and recharge at home on six: the home recharges overlap.
  const trip = { id: 't-sc', planeId: 'beta_plane', planeName: P.name, tripType: 'retour',
    originIdent: 'EHAM', originName: AP.EHAM.name, originLat: AP.EHAM.lat, originLon: AP.EHAM.lon,
    destIdent: 'EHGG', destName: AP.EHGG.name, destLat: AP.EHGG.lat, destLon: AP.EHGG.lon,
    battery: P.battery_kwh, range_km: P.range_km, speed_kmh: P.speed_kmh, chargerId: 'dc_250', chargerName: 'dc_250', chargerPower: 250,
    legEnergy: data.leg_energy_kwh, flightTimeH: data.flight_time_h, freqN: 6, freqUnit: 'day', fleetMode: 'separate' };
  const setup = (limit, enabled = true) => {
    const S = loadStack(); S.CNSSettings.reset(); if (!enabled) S.CNSSettings.save({ smartCharging: { enabled: false } });
    S.localStorage.setItem('cns_folder', JSON.stringify([trip]));
    const home = { chargers: new Array(6).fill('dc_250') }; if (limit) home.gridLimitKw = limit;
    S.localStorage.setItem('cns_airport_cfg', JSON.stringify({ EHGG: { chargers: ['dc_250', 'dc_250'] }, EHAM: home }));
    S.CNSScheduler.init({ chargers: { dc_250: { id: 'dc_250', name: '250 kW DC', power_kw: 250 } } });
    S.CNSScheduler.runGlobal(); S.CNSScheduler.runGlobal();   // write the default take-offs, then settle on them
    return S;
  };
  const phases = S => S.CNSScheduler.runGlobal().lanes.flatMap(L => L.rotations.flatMap(r => r.phases));
  const free = setup(0), freePeak = free.CNSScheduler.loadCurve('EHAM').peakKw;

  test('the fixture overlaps its home recharges (else nothing here would bind)', () => {
    assert.ok(freePeak >= 500, `free peak at EHAM ${freePeak} kW`);
  });

  test('the draw never exceeds the limit, and the limit is used (peak = limit)', () => {
    const lim = Math.round(freePeak / 2), S = setup(lim), c = S.CNSScheduler.loadCurve('EHAM');
    assert.ok(c.pts.every(p => p.kw <= lim + 1e-6), `max ${Math.max(...c.pts.map(p => p.kw))} kW over the ${lim} kW limit`);
    assert.ok(Math.abs(c.peakKw - lim) < 1e-6, `peak ${c.peakKw} vs limit ${lim}`);
    assert.equal(S.CNSScheduler.smartAt('EHAM').freePeakKw, freePeak);
  });

  test('every shared charge still delivers exactly its energy', () => {
    const S = setup(Math.round(freePeak / 2));
    const shared = phases(S).filter(ph => ph.series);
    assert.ok(shared.length >= 6);
    shared.forEach(ph => {
      const end = ph.start + ph.dur; let kwh = 0;
      ph.series.forEach((q, i) => { const t1 = Math.min(end, i + 1 < ph.series.length ? ph.series[i + 1].t : end); kwh += q.kw * Math.max(0, t1 - q.t) / 60; });
      assert.ok(Math.abs(kwh - ph.energy) / ph.energy < 1e-6, `${kwh} kWh vs ${ph.energy}`);
    });
  });

  test('a slowed charge takes longer and delays its aircraft; the minutes are reported', () => {
    const S = setup(Math.round(freePeak / 2)), sm = S.CNSScheduler.smartAt('EHAM');
    assert.ok(sm.addedMin > 1 && sm.slowed > 0, JSON.stringify(sm));
    const endOf = X => Math.max(...X.CNSScheduler.runGlobal().lanes.map(L => L.rotations[L.rotations.length - 1].end));
    assert.ok(endOf(S) > endOf(free) + 1, `day ends ${endOf(S)} vs ${endOf(free)} without the limit`);
    const slowed = phases(S).filter(ph => ph.slow > 0);
    assert.ok(slowed.every(ph => ph.ident === 'EHAM'), 'only the limited airport slows charges');
  });

  test('a limit that never binds flies the plan; the switch off ignores the limit', () => {
    const plan = phases(free);
    [setup(1e6), setup(Math.round(freePeak / 2), false)].forEach((S, n) => {
      const got = phases(S);
      assert.equal(got.length, plan.length);
      got.forEach((ph, i) => assert.ok(Math.abs(ph.start - plan[i].start) < 0.3 && Math.abs(ph.dur - plan[i].dur) < 0.3, `${n ? 'off' : 'non-binding'}: phase ${i} ${ph.start}+${ph.dur} vs ${plan[i].start}+${plan[i].dur}`));
      const pk = S.CNSScheduler.loadCurve('EHAM').peakKw; assert.ok(pk <= freePeak + 1e-6, `${n ? 'off' : 'non-binding'}: peak ${pk} vs ${freePeak}`);
    });
  });
}
