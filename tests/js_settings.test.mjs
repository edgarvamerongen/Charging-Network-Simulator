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

// ---- v5 defaults: reserve + taper + SID/STAR + alternate ON; routing padding, efficiency OFF ----
test('v5 defaults: reserve/taper/SID-STAR/alternate ON, routing/efficiency OFF', () => {
  const { S } = loadSettings();
  assert.ok(approx(S.usableFraction({}), 0.70), 'reserve default 30% -> usable 0.70');
  assert.equal(S.routingFactor(), 1.0, 'routing padding OFF by default -> identity');
  assert.equal(S.gridDemandFactor(), 1.0, 'efficiency off by default -> identity');
  assert.ok(S.chargeTimeMin(100, 100, 225) > 60, 'taper on -> slower than the 60min linear');
  assert.equal(S.sidStarPaddingKm(), 10, 'SID/STAR padding ON by default -> 10 km per leg');
  assert.equal(S.alternateReserveEnabled(), true, 'alternate reserve ON by default');
});

// ---- identity when a toggle is explicitly OFF (accessor returns the no-op) ---
test('identity: usableFraction == 1.0 when reserve off', () => {
  const { S } = loadSettings();
  S.save({ landingReserve: { enabled: false } });
  assert.equal(S.usableFraction({}), 1.0);
});
test('identity: gridDemandFactor == 1.0 when efficiency off', () => {
  const { S } = loadSettings();
  assert.equal(S.gridDemandFactor(), 1.0);
});
test('identity: routingFactor == 1.0 when padding off', () => {
  const { S } = loadSettings();
  S.save({ routingPadding: { enabled: false } });
  assert.equal(S.routingFactor(), 1.0);
});
test('identity: chargeTimeMin linear when taper off (100kWh/100kW -> 60min)', () => {
  const { S } = loadSettings();
  S.save({ chargeTaper: { enabled: false } });
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

// ---- sidStarPadding (additive per-leg SID/STAR km) -------------------------
test('sidStarPaddingKm == 0 when switched off', () => {
  const { S } = loadSettings();
  S.save({ sidStarPadding: { enabled: false } });
  assert.equal(S.sidStarPaddingKm(), 0);
});
test('sidStarPaddingKm returns the set km when on', () => {
  const { S } = loadSettings();
  S.save({ sidStarPadding: { enabled: true, km: 25 } });
  assert.equal(S.sidStarPaddingKm(), 25);
});
test('sidStarPaddingKm clamps to the slider range [5,50] when on', () => {
  const { S } = loadSettings();
  S.save({ sidStarPadding: { enabled: true, km: 2 } });
  assert.equal(S.sidStarPaddingKm(), 5, 'below 5 clamps up to 5');
  S.save({ sidStarPadding: { enabled: true, km: 99 } });
  assert.equal(S.sidStarPaddingKm(), 50, 'above 50 clamps down to 50');
});
test('sidStarPaddingKm falls back to 10 for non-numeric km', () => {
  const { S } = loadSettings();
  S.save({ sidStarPadding: { enabled: true, km: 'oops' } });
  assert.equal(S.sidStarPaddingKm(), 10);
});
test('sidStarPaddingKm == 0 when explicitly off regardless of km', () => {
  const { S } = loadSettings();
  S.save({ sidStarPadding: { enabled: false, km: 25 } });
  assert.equal(S.sidStarPaddingKm(), 0);
});

// ---- chargeTaper (EXPONENTIAL CV-phase roll-off) ---------------------------
// Above the threshold SoC, accepted power decays P(soc) = peak · floor^((soc-thr)/(1-thr)),
// floor = taperPower. Time over the tapered top slice is the closed-form integral of dE/P.
// expTaper mirrors static/settings.js so these lock that exact model (thr 0.80, floor 0.40).
const expTaper = (e, p, batt, thr, floor) => {
  const topSlice = batt * (1 - thr), b = -Math.log(floor);
  if (e <= topSlice) {
    const u0 = (1 - e / batt - thr) / (1 - thr);
    return 60 * topSlice / (p * b) * (Math.exp(b) - Math.exp(u0 * b));
  }
  return 60 * ((e - topSlice) / p + topSlice / (p * b) * (Math.exp(b) - 1));
};
test('taper SLOWS charging above threshold vs linear', () => {
  const { S } = loadSettings();
  S.save({ chargeTaper: { enabled: false } });
  const linear = S.chargeTimeMin(20, 100, 100);          // 12 min (taper explicitly off)
  S.save({ chargeTaper: { enabled: true, threshold: 0.80, taperPower: 0.40 } });
  const tapered = S.chargeTimeMin(20, 100, 100);
  assert.ok(tapered > linear, `tapered ${tapered} should exceed linear ${linear}`);
});
test('taper math: 20kWh = the whole top slice of a 100kWh batt @100kW (exp curve)', () => {
  // batt 100, thr 0.80 -> topSlice 20 kWh; e == topSlice -> all in the taper band,
  // ending at 100%. Exponential closed-form ~= 19.64 min (vs 12 linear).
  const { S } = loadSettings();
  S.save({ chargeTaper: { enabled: true, threshold: 0.80, taperPower: 0.40 } });
  const t = S.chargeTimeMin(20, 100, 100);
  assert.ok(approx(t, expTaper(20, 100, 100, 0.80, 0.40), 1e-4), `got ${t}`);
});
test('taper math: energy split across fast + tapered slices (exp curve)', () => {
  // batt 100, thr 0.80 -> topSlice 20. Deliver 50: 30 fast @100kW + 20 in the
  // exponential taper band -> ~= 37.64 min.
  const { S } = loadSettings();
  S.save({ chargeTaper: { enabled: true, threshold: 0.80, taperPower: 0.40 } });
  const t = S.chargeTimeMin(50, 100, 100);
  assert.ok(approx(t, expTaper(50, 100, 100, 0.80, 0.40), 1e-4), `got ${t}`);
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

// ---- alternateReserve ------------------------------------------------------
test('alternateReserveEnabled() false when switched off', () => {
  const { S } = loadSettings();
  S.save({ alternateReserve: { enabled: false } });
  assert.equal(S.alternateReserveEnabled(), false);
});
test('alternateReserveEnabled() true once toggled on', () => {
  const { S } = loadSettings();
  S.save({ alternateReserve: { enabled: true } });
  assert.equal(S.alternateReserveEnabled(), true);
});
test('activeFlags reports alternateReserve + anyOn', () => {
  const { S } = loadSettings();
  S.save({ alternateReserve: { enabled: true } });
  const f = S.activeFlags();
  assert.equal(f.alternateReserve, true);
  assert.equal(f.anyOn, true);
});

// ---- ruleMode + reserveMin (Step-1 additive; nothing reads them until the Step-2 cutover) ----
test('ruleMode default is "ifr"', () => {
  const { S } = loadSettings();
  assert.equal(S.ruleMode(), 'ifr');
});
test('ruleMode persists a saved value (vfr)', () => {
  const { S } = loadSettings();
  S.save({ ruleMode: { value: 'vfr' } });
  assert.equal(S.ruleMode(), 'vfr');
});
test('ruleMode falls back to ifr for a bogus value', () => {
  const { S } = loadSettings();
  S.save({ ruleMode: { value: 'banana' } });
  assert.equal(S.ruleMode(), 'ifr');
});
test('reserveMinFor: vfr->30 (day), vfr_night->45, ifr->45 by default', () => {
  const { S } = loadSettings();
  assert.equal(S.reserveMinFor('vfr'), 30);
  assert.equal(S.reserveMinFor('vfr_day'), 30);
  assert.equal(S.reserveMinFor('vfr_night'), 45);
  assert.equal(S.reserveMinFor('ifr'), 45);
});
test('reserveMinFor: a saved override is honoured', () => {
  const { S } = loadSettings();
  S.save({ reserveMin: { ifr: 60 } });
  assert.equal(S.reserveMinFor('ifr'), 60);
});
test('reserveMinFor: unknown regime falls back to ifr minutes', () => {
  const { S } = loadSettings();
  assert.equal(S.reserveMinFor('zzz'), 45);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
