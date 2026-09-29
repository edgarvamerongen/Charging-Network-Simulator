/*
 * The load curve behind the timeline's load row, the printed peaks and the PDF curve:
 * CNSSettings.chargePowerAt (the CC-CV taper in time) and CNSScheduler.loadCurve (the day's power).
 * A charge's power must integrate to its energy over exactly the duration chargeTimeMin gives, one
 * charger must never read as more than its own power (back-to-back charges used to double up in
 * 15-min bins), and with the taper off the curve's peak is the old flat event peak.
 *
 * The scheduler half needs /api/simulate geometry (run_all.sh starts a fixture server; skips without one).
 * Run:  CNS_BASE_URL=http://127.0.0.1:5098 node --test tests/js_loadcurve.test.mjs
 */
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadStack, AP } from './golden_capture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANES = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'planes.fixture.json'), 'utf8')).map(p => [p.id, p]));
const BASE = process.env.CNS_BASE_URL || 'http://127.0.0.1:5055';

// ∫ P dt over [0, dur] by the midpoint rule, in kWh.
const energyOf = (S, e, p, batt, soc) => {
  const dur = S.CNSSettings.chargeTimeMin(e, p, batt, soc), n = 20000; let kwh = 0;
  for (let i = 0; i < n; i++) kwh += S.CNSSettings.chargePowerAt((i + 0.5) * dur / n, e, p, batt, soc) * dur / n / 60;
  return { dur, kwh };
};

test('chargePowerAt: the taper in time integrates to the energy over chargeTimeMin', () => {
  const S = loadStack(); S.CNSSettings.reset();
  const { dur, kwh } = energyOf(S, 180, 320, 225, 0.2);            // 20 → 100 %, well into the taper
  assert.ok(Math.abs(kwh - 180) / 180 < 1e-3, `${kwh} kWh over ${dur} min`);
  assert.equal(S.CNSSettings.chargePowerAt(0, 180, 320, 225, 0.2), 320);
  const end = S.CNSSettings.chargePowerAt(dur - 1e-6, 180, 320, 225, 0.2);
  assert.ok(Math.abs(end - 96) < 0.5, `end power ${end}, want 320 × 0.30`);   // taperPower floor at 100 %
  const top = energyOf(S, 45, 320, 225, 0.8);                      // starts above the knee
  assert.ok(Math.abs(top.kwh - 45) / 45 < 1e-3, `${top.kwh}`);
  assert.equal(S.CNSSettings.chargePowerAt(5, 67.5, 320, 225, 0.2), 320);   // ends below the knee: flat
});

test('chargePowerAt is flat when the taper is off', () => {
  const S = loadStack(); S.CNSSettings.reset(); S.CNSSettings.save({ chargeTaper: { enabled: false } });
  assert.equal(S.CNSSettings.chargePowerAt(30, 180, 320, 225, 0.2), 320);
});

const co = k => ({ ident: k, name: AP[k].name, lat: AP[k].lat, lon: AP[k].lon });
let data = null, skip = null;
try {
  const r = await fetch(BASE + '/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin: co('EHAM'), destination: co('EHGG'), plane_id: 'beta_plane', charger_id: 'dc_250', trip_type: 'retour' }) });
  data = await r.json(); if (data.error) skip = 'sim error: ' + data.error;
} catch (e) { skip = `server at ${BASE} not reachable`; }

if (skip) test('loadCurve', { skip }, () => {});
else {
  const P = PLANES.beta_plane;
  // Six aircraft turn at EHGG on ONE 250 kW charger (back-to-back charges) and recharge at home on six.
  const trip = { id: 't-lc', planeId: 'beta_plane', planeName: P.name, tripType: 'retour',
    originIdent: 'EHAM', originName: AP.EHAM.name, originLat: AP.EHAM.lat, originLon: AP.EHAM.lon,
    destIdent: 'EHGG', destName: AP.EHGG.name, destLat: AP.EHGG.lat, destLon: AP.EHGG.lon,
    battery: P.battery_kwh, range_km: P.range_km, speed_kmh: P.speed_kmh, chargerId: 'dc_250', chargerName: 'dc_250', chargerPower: 250,
    legEnergy: data.leg_energy_kwh, flightTimeH: data.flight_time_h, freqN: 6, freqUnit: 'day', fleetMode: 'separate' };
  const setup = taper => {
    const S = loadStack(); S.CNSSettings.reset(); if (!taper) S.CNSSettings.save({ chargeTaper: { enabled: false } });
    S.localStorage.setItem('cns_folder', JSON.stringify([trip]));
    S.localStorage.setItem('cns_airport_cfg', JSON.stringify({ EHGG: { chargers: ['dc_250'] }, EHAM: { chargers: new Array(6).fill('dc_250') } }));
    S.CNSScheduler.init({ chargers: { dc_250: { id: 'dc_250', name: '250 kW DC', power_kw: 250 } } });
    S.CNSScheduler.runGlobal(); S.CNSScheduler.runGlobal();   // write the default take-offs, then settle on them
    return S;
  };
  const charges = (S, ident) => { const out = []; S.CNSScheduler.runGlobal().lanes.forEach(L => L.rotations.forEach(r => r.phases.forEach(ph => { if (ph.kind === 'charge' && ph.dur > 0 && ph.ident === ident) out.push(ph); }))); return out; };
  const area = pts => pts.reduce((s, p, i) => s + (i + 1 < pts.length ? p.kw * (pts[i + 1].t - p.t) / 60 : 0), 0);
  const flatPeak = (S, ident) => { const ev = []; charges(S, ident).forEach(ph => ev.push([ph.start, ph.power], [ph.start + ph.dur, -ph.power])); ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]); let c = 0, m = 0; ev.forEach(e => { c += e[1]; m = Math.max(m, c); }); return m; };

  test('one charger never reads as more than its own power, and its peak is that power', () => {
    const S = setup(true), c = S.CNSScheduler.loadCurve('EHGG');
    assert.ok(charges(S, 'EHGG').length >= 6);
    assert.ok(c.pts.every(p => p.kw <= 250 + 1e-9), `max ${Math.max(...c.pts.map(p => p.kw))}`);
    assert.equal(c.peakKw, 250);
    assert.equal(S.CNSScheduler.summary('EHGG').peakKw, c.peakKw);
  });

  test('the curve carries the energy the charges deliver (minute steps through the tapers)', () => {
    const S = setup(true);
    ['EHGG', 'EHAM'].forEach(ident => {
      const kwh = charges(S, ident).reduce((s, ph) => s + ph.energy, 0), got = area(S.CNSScheduler.loadCurve(ident).pts);
      assert.ok(Math.abs(got - kwh) / kwh < 0.03, `${ident}: curve ${got.toFixed(1)} kWh vs delivered ${kwh.toFixed(1)}`);
    });
  });

  test('the taper can only lower the coincident peak; off, it is the flat event peak', () => {
    const on = setup(true), off = setup(false);
    ['EHGG', 'EHAM', null].forEach(ident => {
      assert.ok(on.CNSScheduler.loadCurve(ident).peakKw <= (ident ? flatPeak(on, ident) : Infinity) + 1e-9);
      if (ident) assert.equal(off.CNSScheduler.loadCurve(ident).peakKw, flatPeak(off, ident));
    });
  });
}
