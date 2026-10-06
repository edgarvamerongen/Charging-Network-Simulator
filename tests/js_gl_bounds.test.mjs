/*
 * The pure geometry of the v2 map's drawing layer (static/ui/gl.js): bounds that never take the long way round the
 * antimeridian, pad/contains on them, continuous longitudes for a line across 180°, and the geodesic circle ring.
 * Run:  node --test tests/js_gl_bounds.test.mjs
 */
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm'; import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { window: {}, console, Math, requestAnimationFrame: f => f() };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(REPO, 'static', 'ui', 'gl.js'), 'utf8'), sandbox);
const G = sandbox.window.CNSGL;

test('bounds across the antimeridian take the short side', () => {
  const b = G.latLngBounds([[-17.7, 178.5], [-16.8, -179.9], [-18.1, 179.3]]);   // Fiji
  assert.ok(b.getEast() - b.getWest() < 5, `span ${b.getEast() - b.getWest()}`);
  assert.equal(b.getWest(), 178.5);
  assert.ok(Math.abs(b.getEast() - 180.1) < 1e-9);
  assert.ok(b.contains([-17.5, -179.95]) && b.contains([-17.5, 179]));
  assert.ok(!b.contains([-17.5, 170]) && !b.contains([-17.5, -170]));
});

test('ordinary bounds, pad and contains', () => {
  const b = G.latLngBounds([[52.45, 5.51], [50.03, 8.56]]);   // Lelystad, Frankfurt
  assert.equal(JSON.stringify([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]), JSON.stringify([50.03, 5.51, 52.45, 8.56]));
  const p = b.pad(0.5);
  assert.ok(p.contains([53.5, 4.2]) && !b.contains([53.5, 4.2]));
  assert.ok(!p.contains([60, 5]));
});

test('a line across 180° keeps continuous longitudes', () => {
  const l = G.unwrapLine([{ lat: -17, lng: 179.5 }, { lat: -17, lng: -179.5 }, { lat: -17, lng: -178 }]);
  assert.equal(JSON.stringify(l.map(p => p[0])), JSON.stringify([179.5, 180.5, 182]));
});

test('the geodesic circle ring sits at its radius', () => {
  const R = 6371.0088, ring = G.circleRing({ lat: 60, lng: 10 }, 100000, 36), rad = Math.PI / 180;
  ring.forEach(p => {
    const d = 2 * R * Math.asin(Math.sqrt(Math.sin((p.lat - 60) * rad / 2) ** 2 + Math.cos(60 * rad) * Math.cos(p.lat * rad) * Math.sin((p.lng - 10) * rad / 2) ** 2));
    assert.ok(Math.abs(d - 100) < 0.01, `${d} km`);
  });
});

test('course is the initial great-circle bearing', () => {
  assert.ok(Math.abs(G.course({ lat: 0, lng: 0 }, { lat: 0, lng: 10 }) - 90) < 1e-9);
  assert.ok(Math.abs(G.course({ lat: 0, lng: 0 }, { lat: 10, lng: 0 }) - 0) < 1e-9);
});
