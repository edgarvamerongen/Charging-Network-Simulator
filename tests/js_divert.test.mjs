/*
 * Node harness for CNSDivertEdit's pure core (static/divert-edit.js):
 * the divert resolver (manual -> live nearest-suitable -> baked), the
 * override-aware reserve, and the inbound-leg feasibility predicate.
 * The Leaflet surface is browser-verified; this file pins the math.
 *
 * Run:  node tests/js_divert.test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function loadModule() {
  const code = fs.readFileSync(path.join(REPO, 'static', 'divert-edit.js'), 'utf8');
  const sandbox = { window: {}, console, JSON, Math, Object, Array, Number, isFinite };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.CNSDivertEdit;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const D = loadModule();

// Equator geography: 1° lon ≈ 111.19 km. Node N at lon 0; candidates east.
const ap = (ident, lon, extra = {}) => ({ ident, latitude_deg: 0, longitude_deg: lon, ...extra });
const AIRPORTS = [
  ap('NEAR_BAD', 0.2),                      // closest, but unsuitable
  ap('NEAR_OK', 0.5),                       // closest suitable
  ap('FAR_OK', 1.5),
  ap('SELF', 0.0),
];
const suitable = (a) => a.ident !== 'NEAR_BAD';
const byIdent = Object.fromEntries(AIRPORTS.map(a => [a.ident, a]));
const ctx = { byIdent, airports: AIRPORTS, isSuitable: suitable };

console.log('CNSDivertEdit pure core — node harness\n');

test('nearestSuitable: closest SUITABLE airport wins; unsuitable + self excluded', () => {
  const got = D.nearestSuitable({ lat: 0, lon: 0 }, AIRPORTS, suitable, 'SELF');
  assert.equal(got.ident, 'NEAR_OK');
});

test('nearestSuitable: malformed coords and empty pools resolve to null', () => {
  assert.equal(D.nearestSuitable({ lat: 0, lon: 0 }, [ap('X', NaN)], suitable), null);
  assert.equal(D.nearestSuitable(null, AIRPORTS, suitable), null);
  assert.equal(D.nearestSuitable({ lat: 0, lon: 0 }, [], suitable), null);
});

test('divertFor tier 1: a manual override ident beats everything', () => {
  const node = { ident: 'SELF', lat: 0, lon: 0, divertOverride: 'FAR_OK' };
  assert.equal(D.divertFor(node, ctx).ident, 'FAR_OK');
});

test('divertFor tier 2: no override -> live nearest-suitable', () => {
  const node = { ident: 'SELF', lat: 0, lon: 0 };
  assert.equal(D.divertFor(node, ctx).ident, 'NEAR_OK');
});

test('divertFor tier 3: empty client pool falls back to the baked DB alternate', () => {
  const withBaked = { ...byIdent, SELF: { ...byIdent.SELF, alternate_ident: 'FAR_OK' } };
  const node = { ident: 'SELF', lat: 0, lon: 0 };
  const got = D.divertFor(node, { byIdent: withBaked, airports: [], isSuitable: suitable });
  assert.equal(got.ident, 'FAR_OK');
});

test('divertFor: a stale override ident (not in the catalog) falls through to tier 2', () => {
  const node = { ident: 'SELF', lat: 0, lon: 0, divertOverride: 'GONE' };
  assert.equal(D.divertFor(node, ctx).ident, 'NEAR_OK');
});

test('divertReserveKm is override-aware (distance to the CHOSEN divert)', () => {
  const auto = D.divertReserveKm({ ident: 'SELF', lat: 0, lon: 0 }, ctx);
  const manual = D.divertReserveKm({ ident: 'SELF', lat: 0, lon: 0, divertOverride: 'FAR_OK' }, ctx);
  assert.ok(Math.abs(auto - 0.5 * 111.19) < 0.5, `auto ~55.6 km (got ${auto})`);
  assert.ok(Math.abs(manual - 1.5 * 111.19) < 0.5, `manual ~166.8 km (got ${manual})`);
  assert.ok(manual > auto, 'a farther manual divert costs more reserve');
});

test('legInfeasible: leg + reserve vs available range, 0-safe', () => {
  assert.equal(D.legInfeasible(300, 60, 350), true, '360 > 350');
  assert.equal(D.legInfeasible(300, 50, 350), false, '350 == 350 fits');
  assert.equal(D.legInfeasible(0, 0, 0), false, 'empty case is not flagged');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
