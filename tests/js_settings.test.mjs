/*
 * Node harness for the browser-global CNSSettings module (static/settings.js).
 *
 * settings.js attaches to `window` and depends on CNSState for persistence.
 * We load it in a vm context with a minimal window + an in-memory CNSState
 * shim, then drive the public accessors directly. No DOM is required because
 * the calc functions (usableFraction / gridDemandFactor / routingFactor /
 * chargeTimeMin) are pure given the stored settings.
 *
 * Run:  node tests/js_settings.test.mjs
 * Exit code 0 = all pass, 1 = at least one failure (so a CI/unittest wrapper
 * can gate on it).
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function loadSettings() {
  const code = fs.readFileSync(path.join(REPO, 'static', 'settings.js'), 'utf8');
  const store = {};
  const sandbox = {
    window: {},
    CNSState: {
      getJSON: (k, d) => (k in store ? JSON.parse(JSON.stringify(store[k])) : d),
      setJSON: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
    },
    console, JSON, Math, Object,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { S: sandbox.window.CNSSettings, store };
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log('CNSSettings (static/settings.js) — node harness\n');

// ---- defaults (all toggles off -> identity) --------------------------------
test('defaults: usableFraction == 1.0 when reserve off', () => {
  const { S } = loadSettings();
  assert.equal(S.usableFraction({}), 1.0);
});
test('defaults: gridDemandFactor == 1.0 when efficiency off', () => {
  const { S } = loadSettings();
  assert.equal(S.gridDemandFactor(), 1.0);
});
test('defaults: routingFactor == 1.0 when padding off', () => {
  const { S } = loadSettings();
  assert.equal(S.routingFactor(), 1.0);
});
test('defaults: chargeTimeMin linear when taper off (100kWh/100kW -> 60min)', () => {
  const { S } = loadSettings();
  assert.ok(approx(S.chargeTimeMin(100, 100, 225), 60));
});

// ---- landingReserve / usableFraction ---------------------------------------
test('usableFraction derates to (1 - minLandingSoc) when on', () => {
  const { S } = loadSettings();
  S.save({ landingReserve: { enabled: true, minLandingSoc: 0.30 } });
  assert.ok(approx(S.usableFraction({}), 0.70), `got ${S.usableFraction({})}`);
});
test('usableFraction clamps to >= 0.05 for absurd reserve', () => {
  const { S } = loadSettings();
  S.save({ landingReserve: { enabled: true, minLandingSoc: 0.99 } });
  assert.ok(approx(S.usableFraction({}), 0.05), `got ${S.usableFraction({})}`);
});

// ---- chargerEfficiency / gridDemandFactor ----------------------------------
test('gridDemandFactor == 1/0.88 (~1.1364) at default efficiency', () => {
  const { S } = loadSettings();
  S.save({ chargerEfficiency: { enabled: true, value: 0.88 } });
  const f = S.gridDemandFactor();
  assert.ok(approx(f, 1 / 0.88, 1e-9), `got ${f}`);
  // 100 kWh aircraft-side -> ~113.6 kWh grid-side
  assert.ok(approx(100 * f, 113.6363636, 1e-4));
});
test('gridDemandFactor clamps efficiency to <= 1.0 (no factor < 1)', () => {
  const { S } = loadSettings();
  S.save({ chargerEfficiency: { enabled: true, value: 1.5 } });
  assert.ok(S.gridDemandFactor() >= 1.0);
});

// ---- routingPadding --------------------------------------------------------
test('routingFactor == 1.05 default when on', () => {
  const { S } = loadSettings();
  S.save({ routingPadding: { enabled: true, factor: 1.05 } });
  assert.ok(approx(S.routingFactor(), 1.05));
});

// ---- chargeTaper -----------------------------------------------------------
test('taper SLOWS charging above threshold vs linear', () => {
  const { S } = loadSettings();
  const linear = S.chargeTimeMin(20, 100, 100);          // taper off: 12 min
  S.save({ chargeTaper: { enabled: true, threshold: 0.80, taperPower: 0.40 } });
  const tapered = S.chargeTimeMin(20, 100, 100);
  assert.ok(tapered > linear, `tapered ${tapered} should exceed linear ${linear}`);
});
test('taper math: 20kWh into the top slice of a 100kWh batt @100kW', () => {
  // batt 100, thr 0.80 -> topSliceCap = 20 kWh. Deliver exactly 20 kWh -> all
  // of it is in the tapered slice. avgTaperPower = 100*(1+0.4)/2 = 70 kW.
  // time = 60 * (0/100 + 20/70) = 17.142857 min.
  const { S } = loadSettings();
  S.save({ chargeTaper: { enabled: true, threshold: 0.80, taperPower: 0.40 } });
  const t = S.chargeTimeMin(20, 100, 100);
  assert.ok(approx(t, 60 * (20 / 70), 1e-4), `got ${t}`);
});
test('taper math: energy split across fast + tapered slices', () => {
  // batt 100, thr 0.80 -> topSliceCap 20. Deliver 50 kWh: 30 fast @100kW,
  // 20 tapered @70kW. time = 60*(30/100 + 20/70) = 18 + 17.142857 = 35.142857.
  const { S } = loadSettings();
  S.save({ chargeTaper: { enabled: true, threshold: 0.80, taperPower: 0.40 } });
  const t = S.chargeTimeMin(50, 100, 100);
  assert.ok(approx(t, 60 * (30 / 100 + 20 / 70), 1e-4), `got ${t}`);
});
test('taper without battery falls back to linear', () => {
  const { S } = loadSettings();
  S.save({ chargeTaper: { enabled: true } });
  assert.ok(approx(S.chargeTimeMin(20, 100, 0), 60 * 20 / 100));
});
test('chargeTimeMin(0,...) == 0', () => {
  const { S } = loadSettings();
  assert.equal(S.chargeTimeMin(0, 100, 100), 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
