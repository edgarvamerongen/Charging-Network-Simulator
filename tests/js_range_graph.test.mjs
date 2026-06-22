/*
 * CNSRangeGraph — node harness for the reachability core (static/range-graph.js).
 *
 * Only the pure `airportsInRange` is exercised here (the geometry that decides
 * which airports get a spoke); the Leaflet rendering is verified in the browser.
 * The set must match the planner's leg check — great-circle ≤ reach — and reject
 * self, out-of-range, and malformed coordinates.
 *
 * Run:  node tests/js_range_graph.test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function loadRG() {
  const code = fs.readFileSync(path.join(REPO, 'static', 'range-graph.js'), 'utf8');
  // range-graph.js touches L / document / CNSRouting only inside init()/show(),
  // so a bare window is all the sandbox needs to define CNSRangeGraph. With no
  // CNSRouting present, airportsInRange uses its built-in haversine fallback.
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.CNSRangeGraph;
}

const HUB = { ident: 'HUB', latitude_deg: 52.0, longitude_deg: 5.0 };
const AIRPORTS = [
  HUB,
  { ident: 'NEAR', latitude_deg: 52.3, longitude_deg: 5.4 },   // ~43 km
  { ident: 'MID',  latitude_deg: 53.0, longitude_deg: 6.0 },   // ~130 km
  { ident: 'FAR',  latitude_deg: 58.0, longitude_deg: 12.0 },  // ~800 km
  { ident: 'BAD',  latitude_deg: NaN,  longitude_deg: 5.0 },   // malformed
];

test('airportsInRange returns airports within reach, sorted set excludes self/far/bad', () => {
  const RG = loadRG();
  const idents = RG.airportsInRange(HUB, 150, AIRPORTS).map((r) => r.ap.ident).sort().join(',');
  assert.equal(idents, 'MID,NEAR');
});

test('tighter reach drops the mid airport', () => {
  const RG = loadRG();
  const idents = RG.airportsInRange(HUB, 80, AIRPORTS).map((r) => r.ap.ident).join(',');
  assert.equal(idents, 'NEAR');
});

test('each result carries the great-circle km', () => {
  const RG = loadRG();
  const near = RG.airportsInRange(HUB, 150, AIRPORTS).find((r) => r.ap.ident === 'NEAR');
  assert.ok(near && near.km > 30 && near.km < 60, 'NEAR km ~43, got ' + (near && near.km));
});

test('guards: zero reach / null inputs → empty', () => {
  const RG = loadRG();
  // .length (not deepEqual to []) — a sandbox-realm [] fails deepStrictEqual's prototype check.
  assert.equal(RG.airportsInRange(HUB, 0, AIRPORTS).length, 0);
  assert.equal(RG.airportsInRange(null, 150, AIRPORTS).length, 0);
  assert.equal(RG.airportsInRange(HUB, 150, null).length, 0);
});
