/*
 * Climb-energy model test (static/flight-model.js + static/settings.js).
 * CLIMB_ENERGY_MODEL.md — ruled 2026-07-27:
 *     E(leg) = cruisePerKm·d + eMax·min(1, d/dSat)
 *     eMax = 10% × battery (NET of descent give-back), dSat = 15% × range_km.
 * Anchor: E(range_km) == battery exactly. Gates: powered-lift (type ~ VTOL)
 * and training flights stay linear; pct = 0 reduces EVERYTHING to linear.
 *
 * Run:  node tests/js_climb.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadStack, AP } from './golden_capture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANES = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'planes.fixture.json'), 'utf8')).map(p => [p.id, p]));
const wp = (k) => ({ ident: k, name: AP[k].name, lat: AP[k].lat, lon: AP[k].lon });

let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); pass++; console.log(`  ok   ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); } };
const approx = (a, b, tol) => Math.abs(a - b) <= (tol == null ? Math.max(1e-9, Math.abs(b) * 1e-9) : tol);

console.log('CNSFlight climb-energy model — node harness\n');

const BETA = PLANES.beta_plane;                       // 225 kWh / 500 km -> eMax 22.5, dSat 75, cruise 0.405
const stack = () => { const S = loadStack(); S.CNSSettings.reset(); return S; };

test('defaults: climb model ships ON at 10% / 15% of range', () => {
  const S = stack();
  assert.equal(S.CNSSettings.climbOverheadPct(), 0.10);
  assert.equal(S.CNSSettings.climbSatFrac(), 0.15);
  assert.equal(S.CNSSettings.activeFlags().climbModel, true);
});

test('anchor: a full-catalog-range leg consumes exactly one battery', () => {
  const S = stack();
  assert.ok(approx(S.CNSFlight.legEnergyKwh(BETA, BETA.range_km), BETA.battery_kwh),
    `E(range) ${S.CNSFlight.legEnergyKwh(BETA, BETA.range_km)} vs battery ${BETA.battery_kwh}`);
});

test('ramp below dSat: half the saturation distance pays half a climb', () => {
  const S = stack();
  const cp = S.CNSFlight.climbParams(BETA);
  assert.ok(approx(cp.eMaxKwh, 22.5) && approx(cp.dSatKm, 75) && approx(cp.cruisePerKm, 0.405), JSON.stringify(cp));
  const d = cp.dSatKm / 2;
  assert.ok(approx(S.CNSFlight.legEnergyKwh(BETA, d), cp.cruisePerKm * d + cp.eMaxKwh / 2));
});

test('saturation: past dSat every leg pays exactly one full climb', () => {
  const S = stack();
  const cp = S.CNSFlight.climbParams(BETA);
  for (const d of [100, 250, 400]) {
    assert.ok(approx(S.CNSFlight.legEnergyKwh(BETA, d), cp.cruisePerKm * d + cp.eMaxKwh), `d=${d}`);
  }
});

test('memo §4 pins: Beta 50 km = 35.25 kWh (+57%), 150 km = 83.25 kWh', () => {
  const S = stack();
  assert.ok(approx(S.CNSFlight.legEnergyKwh(BETA, 50), 35.25, 1e-6));
  assert.ok(approx(S.CNSFlight.legEnergyKwh(BETA, 150), 83.25, 1e-6));
});

test('pct = 0 (disabled) reduces to the linear model exactly', () => {
  const S = stack();
  S.CNSSettings.save({ climbModel: { enabled: false } });
  const lin = BETA.battery_kwh / BETA.range_km;
  for (const d of [10, 50, 500]) assert.ok(approx(S.CNSFlight.legEnergyKwh(BETA, d), lin * d), `d=${d}`);
  assert.ok(approx(S.CNSFlight.maxFlownLegKm(BETA), BETA.range_km * S.CNSSettings.usableFraction(BETA)));
});

test('powered-lift gate: type eVTOL stays linear even with the model on', () => {
  const S = stack();
  const evtol = { ...BETA, type: 'eVTOL' };
  const lin = BETA.battery_kwh / BETA.range_km;
  assert.equal(S.CNSFlight.climbParams(evtol).applies, false);
  assert.ok(approx(S.CNSFlight.legEnergyKwh(evtol, 50), lin * 50));
});

test('battery-less hybrid: zero energy, gate self-neutralises', () => {
  const S = stack();
  const hybrid = { range_km: 800, speed_kmh: 300, type: 'STOL' };
  assert.equal(S.CNSFlight.climbParams(hybrid).applies, false);
  assert.equal(S.CNSFlight.legEnergyKwh(hybrid, 200), 0);
  assert.ok(approx(S.CNSFlight.maxFlownLegKm(hybrid), 800 * S.CNSSettings.usableFraction(hybrid)));
});

test('maxFlownLegKm: closed-form inverse (Beta, landing reserve 20%)', () => {
  const S = stack();
  const usable = BETA.battery_kwh * S.CNSSettings.usableFraction(BETA);   // 225 × 0.8 = 180
  const cp = S.CNSFlight.climbParams(BETA);
  const expected = (usable - cp.eMaxKwh) / cp.cruisePerKm;                // affine branch: (180 − 22.5)/0.405
  const got = S.CNSFlight.maxFlownLegKm(BETA);
  assert.ok(approx(got, expected, 1e-6), `${got} vs ${expected}`);
  assert.ok(approx(S.CNSFlight.legEnergyKwh(BETA, got), usable, 1e-6), 'E(maxLeg) == usable');
});

test('simulateTrip legs use the ramped energy (matches legEnergyKwh on distKm)', () => {
  const S = stack();
  const prof = S.CNSFlight.simulateTrip(BETA, [wp('EHAM'), wp('EHRD'), wp('EGLL')],
    { tripType: 'one-way', getTargetSoc: () => S.CNSSettings.chargeTargetDefault(), getChargerKw: () => 250 });
  for (const l of prof.legs) {
    assert.ok(approx(l.energyKwh, S.CNSFlight.legEnergyKwh(BETA, l.distKm), 1e-9), `${l.toName}`);
  }
});

test('training is excluded (ruled): consumed stays linear ePerKm × trainKm', () => {
  const S = stack();
  const velis = PLANES.pipistrel_velis;
  const prof = S.CNSFlight.simulateTrip(velis, [wp('EHAM')],
    { tripType: 'training', trainingRangeKm: 40, getChargerKw: () => 50 });
  const lin = velis.battery_kwh / velis.range_km;
  const usable = velis.battery_kwh * S.CNSSettings.usableFraction(velis);
  assert.ok(approx(prof.legs[0].energyKwh, Math.min(lin * 40, usable), 1e-9),
    `training consumed ${prof.legs[0].energyKwh} vs linear ${Math.min(lin * 40, usable)}`);
});

test('availRangeKm: profile reach equals the closed-form inverse (pads carved out)', () => {
  const S = stack();
  S.CNSSettings.save({ sidStarPadding: { enabled: false }, routingPadding: { enabled: false } });
  const prof = S.CNSFlight.simulateTrip(BETA, [wp('EHAM'), wp('EGLL')], { tripType: 'one-way', getChargerKw: () => 250 });
  assert.ok(approx(prof.availRangeKm, S.CNSFlight.maxFlownLegKm(BETA), 1e-9),
    `${prof.availRangeKm} vs ${S.CNSFlight.maxFlownLegKm(BETA)}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
