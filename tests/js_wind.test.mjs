/*
 * Wind (Model settings › Wind): the aircraft holds its catalog cruise airspeed (TAS); the air moves over the
 * ground. Pins the wind triangle (CNSSettings.windLeg), the engine's leg time + energy (flight-model.js) and the
 * router's leg check (routing.js), and that still air changes nothing.
 * Run:  node --test tests/js_wind.test.mjs
 */
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadStack } from './golden_capture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANES = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'planes.fixture.json'), 'utf8')).map(p => [p.id, p]));
const P = PLANES.beta_plane;                                   // TAS 250 km/h
const KT = kmh => kmh / 1.852;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const stack = wind => { const S = loadStack(); S.CNSSettings.reset(); if (wind) S.CNSSettings.save({ wind: Object.assign({ enabled: true }, wind) }); return S; };

test('wind triangle: head, tail, cross; too strong a crosswind cannot be flown', () => {
  const S = stack({ fromDeg: 90, kt: KT(50) });
  const head = S.CNSSettings.windLeg(90, 250), tail = S.CNSSettings.windLeg(270, 250), cross = S.CNSSettings.windLeg(0, 250);
  near(head.gsKmh, 200, 1e-9, 'headwind GS'); near(head.factor, 1.25, 1e-9, 'headwind air/ground'); near(head.headKt, KT(50), 1e-9, 'headwind kt');
  near(tail.gsKmh, 300, 1e-9, 'tailwind GS'); near(tail.headKt, -KT(50), 1e-9, 'tailwind kt');
  near(cross.gsKmh, Math.sqrt(250 ** 2 - 50 ** 2), 1e-9, 'crosswind GS');   // heading into the wind costs ground speed too
  near(cross.wcaDeg, Math.asin(50 / 250) * 180 / Math.PI, 1e-9, 'heading correction');
  assert.equal(stack({ fromDeg: 0, kt: KT(260) }).CNSSettings.windLeg(90, 250).ok, false);
  const calm = stack(null).CNSSettings.windLeg(90, 250);
  assert.deepEqual([calm.factor, calm.gsKmh, calm.headKt], [1, 250, 0]);
});

const wp = (ident, lon) => ({ ident, name: ident, lat: 0, lon });
const leg = (S, trip) => S.CNSFlight.simulateTrip(P, [wp('A', 0), wp('B', 2)], { tripType: trip || 'one-way' });   // course 090°, 222 km

test('engine: a headwind leg takes longer and uses more energy; still air is unchanged', () => {
  const calm = leg(stack(null)).legs[0], head = leg(stack({ fromDeg: 90, kt: KT(50) })).legs[0];
  near(head.flightMin, calm.flightMin * 1.25, 1e-6, 'time × TAS/GS');
  near(head.airKm, calm.distKm * 1.25, 1e-6, 'air km');
  assert.ok(head.energyKwh > calm.energyKwh * 1.2, `${head.energyKwh} vs ${calm.energyKwh}`);
  near(head.distKm, calm.distKm, 1e-9, 'ground distance unchanged');
});

test('engine: a return trip in wind costs more than in still air (head out, tail back do not cancel)', () => {
  const calm = leg(stack(null), 'retour').totals, wind = leg(stack({ fromDeg: 90, kt: KT(50) }), 'retour').totals;
  near(wind.distKm, calm.distKm, 1e-9, 'same ground distance');
  assert.ok(wind.flightMin > calm.flightMin + 1, `${wind.flightMin} vs ${calm.flightMin}`);   // 1.25 + 0.833 > 2
  assert.ok(wind.energyUsedKwh > calm.energyUsedKwh, `${wind.energyUsedKwh} vs ${calm.energyUsedKwh}`);
});

test('router: a direct leg that fits in still air needs a stop into a headwind, not with a tailwind', () => {
  const O = { ident: 'O', lat: 0, lon: 0, alternate_km: 0 }, D = { ident: 'D', lat: 0, lon: 1.0, alternate_km: 0 };   // 111 km east
  const S1 = { ident: 'S', name: 'S', type: 'medium_airport', latitude_deg: 0, longitude_deg: 0.5, alternate_km: 0, rwy_paved_m: 2000 };
  const plan = wind => stack(wind).CNSRouting.planRoute({ origin: O, destination: D, plane: P, allowedTypes: ['medium_airport'], allAirports: [S1], options: { maxLegKm: 120 } });
  assert.deepEqual(Array.from(plan(null).stops, s => s.ident), []);
  assert.deepEqual(Array.from(plan({ fromDeg: 90, kt: KT(50) }).stops, s => s.ident), ['S']);   // 111 × 1.25 > 120
  assert.deepEqual(Array.from(plan({ fromDeg: 270, kt: KT(50) }).stops, s => s.ident), []);
});

// The divert reserve is flown from the arrival to ITS alternate, so the wind on that course is what it costs: a tailwind
// divert is cheap, a headwind one dear, one the aircraft can't make headway against rules the leg out. (It used to be
// the worst-case headwind for every divert, which ruled out short legs in a tailwind.)
test('router: the divert reserve pays the wind on the divert course, not a worst-case headwind', () => {
  const S = stack({ fromDeg: 270, kt: KT(50) });                      // westerly: eastbound is a tailwind (×0.83), westbound a headwind (×1.25)
  if (!S.CNSSettings.alternateReserveEnabled(P)) return;              // the fixture plane must carry divert reserves
  const O = { ident: 'O', lat: 0, lon: 0 };
  const plan = (altLon, s) => {
    const A = { ident: 'A', name: 'A', type: 'medium_airport', latitude_deg: 0, longitude_deg: altLon, alternate_km: 50, rwy_paved_m: 2000 };
    const D = { ident: 'D', name: 'D', type: 'medium_airport', latitude_deg: 0, longitude_deg: 1.0, alternate_km: 111.19, alternate_ident: 'A', rwy_paved_m: 2000 };
    return (s || S).CNSRouting.planRoute({ origin: O, destination: { ident: 'D', lat: 0, lon: 1.0, alternate_km: 111.19, alternate_ident: 'A' }, plane: P, allowedTypes: ['medium_airport'], allAirports: [A, D], options: { maxLegKm: 200 } });
  };
  // 111 km east in a tailwind (92.6 air km) + a 111 km divert further east, also downwind (92.6): 185 ≤ 200. Flies direct.
  // (At the worst-case headwind the divert alone was 139 km: 232 > 200, no route.)
  const east = plan(2.0);
  assert.equal(east.error, undefined, east.error); assert.equal(east.legCount, 1);
  // the same divert back west, into the wind: 92.6 + 139 = 232 > 200
  assert.match(plan(0.0).error || '', /No reachable route/);
  // a wind the aircraft can't make headway against on the divert rules the leg out, whatever the reserve
  assert.match(plan(0.0, stack({ fromDeg: 270, kt: KT(260) })).error || '', /No reachable route/);
});
