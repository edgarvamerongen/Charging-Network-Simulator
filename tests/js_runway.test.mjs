/*
 * Node harness for the browser-global CNSRunway module (static/runway.js).
 * Pure module — loaded in a vm context with a minimal window, same pattern as
 * js_range_graph.test.mjs. Covers the airport-card chip summary + the
 * per-selected-aircraft suitability check (display-only feature).
 *
 * Run:  node tests/js_runway.test.mjs   (exit 0 = pass, 1 = fail)
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function load() {
  const code = fs.readFileSync(path.join(REPO, 'static', 'runway.js'), 'utf8');
  const sandbox = { window: {}, console, Math, isFinite, Number };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.CNSRunway;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

console.log('CNSRunway (static/runway.js) — node harness\n');
const R = load();

// The airports API serves rwy_<cat>_m as numbers, or '' for blank CSV cells.
const AMS   = { ident: 'EHAM', rwy_paved_m: 3800, rwy_grass_m: '' };
const MIXED = { ident: 'X1', rwy_paved_m: 2013, rwy_grass_m: 800 };
const GRASSY = { ident: 'X2', rwy_grass_m: 600 };
const NODATA = { ident: 'X3', rwy_paved_m: '', rwy_grass_m: '' };

test('summary: chips in category order, thousands-separated meters', () => {
  assert.equal(R.summary(MIXED), 'paved 2,013 m · grass 800 m');
  assert.equal(R.summary(AMS), 'paved 3,800 m');
});

test('summary: unknown category labeled bare rwy; empty when no data', () => {
  assert.equal(R.summary({ rwy_unknown_m: 750 }), 'rwy 750 m');
  assert.equal(R.summary(NODATA), '');
  assert.equal(R.summary(null), '');
});

test('suitability: no requirement or no airport data -> unknown (render nothing)', () => {
  assert.equal(R.suitability(null, MIXED).state, 'unknown');
  assert.equal(R.suitability({}, MIXED).state, 'unknown');
  assert.equal(R.suitability({ runway_req: { paved: 550 } }, NODATA).state, 'unknown');
});

test('suitability: fits when any required category is long enough', () => {
  assert.equal(R.suitability({ runway_req: { paved: 550, grass: 550 } }, MIXED).state, 'ok');
  assert.equal(R.suitability({ runway_req: { grass: 1250, paved: 1000 } }, AMS).state, 'ok');   // paved 3800 covers it
});

test('suitability: null minimum = surface-only requirement', () => {
  assert.equal(R.suitability({ runway_req: { grass: null } }, GRASSY).state, 'ok');
  const r = R.suitability({ runway_req: { grass: null } }, AMS);          // AMS has no grass
  assert.equal(r.state, 'surface');
  assert.equal(r.label, 'no grass rwy');
});

test('suitability: right surface but too short -> short with the smallest need', () => {
  const r = R.suitability({ runway_req: { paved: 2000, grass: 1250 } }, GRASSY);
  assert.equal(r.state, 'short');
  assert.equal(r.label, 'rwy short — need 1,250 m');   // grass is present (600) but needs 1,250
});

test('suitability: required surface absent entirely -> surface state, first missing named', () => {
  const r = R.suitability({ runway_req: { paved: 46 } }, GRASSY);
  assert.equal(r.state, 'surface');
  assert.equal(r.label, 'no paved rwy');
});

test('suitability: any-style requirement (all categories) fits whatever exists', () => {
  const req = { paved: 46, grass: 46, gravel: 46, dirt: 46, water: 46, unknown: 46 };
  assert.equal(R.suitability({ runway_req: req }, GRASSY).state, 'ok');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
