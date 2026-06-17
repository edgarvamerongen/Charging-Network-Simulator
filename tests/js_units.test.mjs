/*
 * CNSUnits — node harness for the display-unit system (static/units.js).
 *
 * Two layers of protection:
 *  1. The formatters convert + label correctly when metric ↔ nautical flips,
 *     and onChange notifies subscribers (that's the whole re-render mechanism).
 *  2. A drift guard on templates/index.html: the CNSUnits.onChange subscriber
 *     must re-render EVERY component that prints a distance — the live bug was
 *     exactly a missing entry there (suggested route + alternate markers kept
 *     showing km after switching to nautical). The node harness has no DOM, so
 *     we assert the subscriber body references each render hook by name.
 *
 * Run:  node tests/js_units.test.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function loadUnits() {
  const code = fs.readFileSync(path.join(REPO, 'static', 'units.js'), 'utf8');
  const store = {};
  const CNSState = {
    KEYS: { units: 'cns_units' },
    getRaw: (k) => store[k],
    setRaw: (k, v) => { store[k] = v; },
  };
  const sandbox = { window: { CNSState }, CNSState, console, Math, String, isFinite, JSON };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.CNSUnits;
}

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

test('metric formatting (defaults)', () => {
  const U = loadUnits();
  assert.equal(U.fmtDist(54), '54 km');
  assert.equal(U.fmtSpeed(150), '150 km/h');
  assert.equal(U.fmtUsage(39.4), '40 kWh/100km');
});

test('nautical: distances convert km → NM with the NM label', () => {
  const U = loadUnits(); U.set('nautical');
  assert.equal(U.fmtDist(54), '30 NM');        // 54 / 1.852 = 29.2 → ceil 30
  assert.equal(U.fmtDist(46), '25 NM');        // the alternate-label case from the bug report
  assert.equal(U.fmtSpeed(150), '81 kts');      // 150 / 1.852 = 81.0 → 81
  assert.equal(U.fmtUsage(37.04), '69 kWh/100NM'); // 37.04 × 1.852 = 68.6 → ceil 69
});

test('energy/power/duration are unit-system independent', () => {
  const U = loadUnits(); U.set('nautical');
  assert.equal(U.fmtEnergy(43), '43 kWh');
  assert.equal(U.fmtPower(250), '250 kW');
  assert.equal(U.fmtDuration(26), '26 min');
});

test('onChange notifies on a real flip, not on a no-op, and unsubscribes', () => {
  const U = loadUnits();
  const seen = [];
  const off = U.onChange(v => seen.push(v));
  U.set('nautical');
  U.set('nautical');           // same value → no event
  U.set('bogus');              // invalid → no event
  assert.deepEqual(seen, ['nautical']);
  off();
  U.set('metric');
  assert.deepEqual(seen, ['nautical'], 'unsubscribed listener must not fire');
});

test('index.html: the units subscriber re-renders every distance-bearing component', () => {
  const html = fs.readFileSync(path.join(REPO, 'templates', 'index.html'), 'utf8');
  const m = html.match(/CNSUnits\.onChange\(\(\) => \{([\s\S]*?)\n {8}\}\);/);
  assert.ok(m, 'CNSUnits.onChange subscriber not found in index.html');
  const body = m[1];
  // Every UI component that prints fmtDist/fmtSpeed output must be re-rendered here.
  // If you add a new distance display, add its render hook to the subscriber AND this list.
  for (const hook of ['updateTrajectory', 'renderResult', 'renderPlaneSpecCard',
                      'renderFolder', 'renderStops', 'refreshAlternates']) {
    assert.ok(body.includes(hook), `units onChange subscriber is missing ${hook}() — that component will keep stale units`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
