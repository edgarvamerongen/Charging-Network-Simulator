/*
 * Node harness for the browser-global CNSPlaneSchema (static/plane-schema.js).
 * Loaded in a vm context with a minimal window (same pattern as
 * js_settings.test.mjs). Pure module — no DOM/storage needed.
 *
 * Run:  node tests/js_plane_schema.test.mjs   (exit 0 = pass, 1 = fail)
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function load() {
  const code = fs.readFileSync(path.join(REPO, 'static', 'plane-schema.js'), 'utf8');
  const sandbox = { window: {}, console, JSON, Math, Object, Array };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.CNSPlaneSchema;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

console.log('CNSPlaneSchema (static/plane-schema.js) — node harness\n');
const S = load();

test('value: bare scalar + default', () => {
  assert.equal(S.value({ battery_kwh: 22 }, 'battery_kwh'), 22);
  assert.equal(S.value({}, 'x', 7), 7);
});

test('value: provenance object unwraps to .value', () => {
  assert.equal(S.value({ mtow_kg: { value: 80000, confidence: 'estimated' } }, 'mtow_kg'), 80000);
});

test('value: arrays are not mistaken for provenance', () => {
  assert.deepEqual(S.value({ surfaces_ok: ['paved', 'grass'] }, 'surfaces_ok'), ['paved', 'grass']);
});

test('provenance: bare scalar reads as assumed', () => {
  assert.equal(S.provenance({ range_km: 400 }, 'range_km').confidence, 'assumed');
  assert.equal(S.provenance({}, 'range_km'), null);
});

test('provenance: object preserves source + confidence', () => {
  const pr = S.provenance({ ifr_capable: { value: false, source: 'EASA', confidence: 'certified' } }, 'ifr_capable');
  assert.equal(pr.value, false);
  assert.equal(pr.confidence, 'certified');
  assert.equal(pr.source, 'EASA');
});

test('ifrCapable: explicit value wins', () => {
  assert.equal(S.ifrCapable({ class: 'regional', ifr_capable: false }), false);
  assert.equal(S.ifrCapable({ ifr_capable: { value: true } }), true);
});

test('ifrCapable: infer from class', () => {
  assert.equal(S.ifrCapable({ class: 'trainer' }), false);
  assert.equal(S.ifrCapable({ class: 'regional' }), true);
  assert.equal(S.ifrCapable({ class: 'evtol' }), true);
});

test('ifrCapable: infer from shape when class absent', () => {
  assert.equal(S.ifrCapable({ seats: 2, range_km: 87.5 }), false);
  assert.equal(S.ifrCapable({ seats: 9, range_km: 500 }), true);
});

test('normalize collapses provenance to scalars', () => {
  const n = S.normalize({ a: 1, b: { value: 2, confidence: 'estimated' } });
  assert.equal(n.a, 1);
  assert.equal(n.b, 2);
});

test('catalog: planes.json loads, Velis is VFR-only with 0.5 takeoff floor', () => {
  const planes = JSON.parse(fs.readFileSync(path.join(REPO, 'planes.json'), 'utf8'));
  assert.equal(planes.length, 5);
  const velis = planes.find(p => S.value(p, 'id') === 'pipistrel_velis');
  assert.equal(S.ifrCapable(velis), false);
  assert.equal(S.value(velis, 'min_takeoff_soc'), 0.5);
  // a non-trainer infers IFR-capable
  const elysian = planes.find(p => S.value(p, 'id') === 'elysian_e9x');
  assert.equal(S.ifrCapable(elysian), true);
});

const MEAS_PLANE = {
  id: 't', name: 'T', battery_kwh: 600, range_km: 500, speed_kmh: 400,
  measurements: [
    { quantity: 'range_km', value: 400, conditions: { regime: 'ifr', load: 'mtow' }, confidence: 'manufacturer-stated' },
    { quantity: 'takeoff_distance_m', value: 800, conditions: { surface: 'paved' } },
    { quantity: 'takeoff_distance_m', value: 1000, conditions: { surface: 'grass' } },
  ],
};

test('select: match by context', () => {
  assert.equal(S.select(MEAS_PLANE, 'range_km', { regime: 'ifr' }), 400);
  assert.equal(S.select(MEAS_PLANE, 'takeoff_distance_m', { surface: 'grass' }), 1000);
});

test('select: conflict + no-context fall to scalar default', () => {
  assert.equal(S.select(MEAS_PLANE, 'range_km', { regime: 'vfr' }), 500);
  assert.equal(S.select(MEAS_PLANE, 'range_km'), 500);
});

test('select: case-insensitive conditions', () => {
  assert.equal(S.select(MEAS_PLANE, 'range_km', { regime: 'IFR' }), 400);
});

test('usableRange: VFR/IFR build-down from gross (×0.8 min-SoC, then reserve)', () => {
  const beta = { id: 'b', name: 'B', battery_kwh: 225, range_km: 630, speed_kmh: 250 };
  assert.ok(Math.abs(S.usableRange(beta, 'vfr') - 379) < 1e-6);     // 630×0.8 − 125
  assert.ok(Math.abs(S.usableRange(beta, 'ifr') - 316.5) < 1e-6);   // 504 − 187.5
});

test('usableRange: explicit usable_incl_reserve measurement wins', () => {
  const v = { id: 'v', name: 'V', battery_kwh: 600, range_km: 500, speed_kmh: 400,
              measurements: [{ quantity: 'range_km', value: 400,
                               conditions: { regime: 'ifr', load: 'mtow' }, basis: 'usable_incl_reserve' }] };
  assert.equal(S.usableRange(v, 'ifr', { load: 'mtow' }), 400);
});

test('catalog: Vaeridion IFR@MTOW range is 400, TODR grass 1000', () => {
  const planes = JSON.parse(fs.readFileSync(path.join(REPO, 'planes.json'), 'utf8'));
  const v = planes.find(p => S.value(p, 'id') === 'vaeridion');
  assert.equal(S.select(v, 'range_km', { regime: 'ifr', load: 'mtow' }), 400);
  assert.equal(S.select(v, 'range_km'), 500);   // scalar default unchanged (additive)
  assert.equal(S.select(v, 'takeoff_distance_m', { surface: 'grass' }), 1000);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
