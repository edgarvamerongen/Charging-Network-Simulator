/*
 * Waypoints (custom routes): turning points between two landings ride on that leg as legVias, and
 * CNSFlight.simulateTrip flies the leg through them. Pins the leg length, that a saved custom loop
 * with no airport stop (dest === origin) profiles as ONE closed leg, and that plain trips are unchanged.
 * Run:  node --test tests/js_waypoints.test.mjs
 */
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadStack } from './golden_capture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'planes.fixture.json'), 'utf8')).find(p => p.id === 'beta_plane');
const S = loadStack(); S.CNSSettings.reset();
const hav = (a, b) => S.CNSRouting.haversineKm(a, b);
const wp = (ident, lat, lon) => ({ ident, name: ident, lat, lon });

test('a leg flies through its turning points', () => {
  const A = wp('A', 0, 0), B = wp('B', 0, 2), V = { lat: 1, lon: 1 };
  const plain = S.CNSFlight.simulateTrip(P, [A, B], { tripType: 'one-way' }).legs[0];
  const via = S.CNSFlight.simulateTrip(P, [A, B], { tripType: 'one-way', legVias: [[V]] }).legs[0];
  assert.ok(Math.abs(via.rawKm - (hav(A, V) + hav(V, B))) < 1e-9, `${via.rawKm}`);
  assert.ok(via.rawKm > plain.rawKm && via.flightMin > plain.flightMin && via.energyKwh > plain.energyKwh);
});

test('a saved loop with no airport stop is one closed leg through its points', () => {
  const pts = [{ lat: 0.5, lon: 0 }, { lat: 0.5, lon: 0.5 }, { lat: 0, lon: 0.5 }];
  const trip = { custom: true, tripType: 'circular', planeId: 'beta_plane', battery: P.battery_kwh, range_km: P.range_km, speed_kmh: P.speed_kmh,
    originIdent: 'O', originName: 'O', originLat: 0, originLon: 0, destIdent: 'O', destName: 'O', destLat: 0, destLon: 0, stops: [], legVias: [pts] };
  const prof = S.CNSFlight.profileForTrip(trip, { getChargerKw: () => 250 });
  assert.equal(prof.legs.length, 1);
  const loop = hav({ lat: 0, lon: 0 }, pts[0]) + hav(pts[0], pts[1]) + hav(pts[1], pts[2]) + hav(pts[2], { lat: 0, lon: 0 });
  assert.ok(Math.abs(prof.legs[0].rawKm - loop) < 1e-9, `${prof.legs[0].rawKm} vs ${loop}`);
  assert.ok(prof.charges.some(c => c.ident === 'O' && c.energyKwh > 0), 'recharges at home');
});
