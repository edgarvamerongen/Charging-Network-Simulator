/*
 * CNSBuildShare — node harness for the multi-route build-share codec.
 * Stubs the browser-global data layer (CNSDemand/CNSState/CNSShare) on the
 * sandbox so the pure capture logic can be exercised without a DOM.
 * Run:  node tests/js_buildshare.test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { test } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function load(stubs) {
  const code = fs.readFileSync(path.join(REPO, 'static', 'buildshare.js'), 'utf8');
  const sandbox = Object.assign({ window: {}, console, JSON }, stubs);
  sandbox.window = Object.assign({}, stubs);   // globals are read off window
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.CNSBuildShare;
}

const FOLDER = [
  {
    id: 'f1', planeId: 'beta_plane', chargerId: 'dc_320', tripType: 'oneway', freqN: 2, freqUnit: 'day',
    originIdent: 'EHLE', originName: 'Lelystad', originLat: 52.46, originLon: 5.52,
    destIdent: 'EDDF', destName: 'Frankfurt', destLat: 50.03, destLon: 8.56,
    legEnergy: 154.3, charges: [{ ident: 'EDDF', energy_kwh: 154.3 }],   // computed output — must NOT be stored
  },
  {
    id: 't1', planeId: 'pipistrel_velis', chargerId: 'dc_22', tripType: 'training', freqN: 5, freqUnit: 'week',
    originIdent: 'EHTE', originName: 'Teuge', originLat: 52.24, originLon: 6.05,
    destIdent: 'EHTE', destName: 'Teuge', destLat: 52.24, destLon: 6.05,
  },
];

function stubs(folder, cfg, sched, ms) {
  return {
    CNSDemand: { loadFolder: () => folder, loadCfg: () => cfg },
    CNSState: { KEYS: { sched: 'cns_schedule' }, getJSON: (k, d) => (k === 'cns_schedule' ? sched : d) },
    CNSShare: { settingsDelta: () => ms },
  };
}

test('currentBuild tags the blob and lists every flight', () => {
  const B = load(stubs(FOLDER, {}, {}, undefined));
  const blob = B.currentBuild();
  assert.equal(blob.v, 1);
  assert.equal(blob.k, 'build');
  assert.equal(blob.fl.length, 2);
});

test('currentBuild stores INPUTS only — no computed energy', () => {
  const B = load(stubs(FOLDER, {}, {}, undefined));
  const f1 = B.currentBuild().fl[0];
  assert.deepEqual(f1, {
    id: 'f1', p: 'beta_plane', c: 'dc_320', t: 'oneway', fn: 2, fu: 'day',
    o: { i: 'EHLE', la: 52.46, lo: 5.52, n: 'Lelystad' },
    d: { i: 'EDDF', la: 50.03, lo: 8.56, n: 'Frankfurt' },
  });
  assert.equal('legEnergy' in f1, false);
  assert.equal('charges' in f1, false);
});

test('currentBuild omits destination for training trips', () => {
  const B = load(stubs(FOLDER, {}, {}, undefined));
  const t1 = B.currentBuild().fl[1];
  assert.equal('d' in t1, false);
  assert.equal(t1.t, 'training');
});

test('currentBuild includes cfg / sch / ms only when non-empty', () => {
  const empty = load(stubs(FOLDER, {}, {}, undefined)).currentBuild();
  assert.equal('cfg' in empty, false);
  assert.equal('sch' in empty, false);
  assert.equal('ms' in empty, false);

  const full = load(stubs(
    FOLDER,
    { EDDF: { chargers: ['dc_320'], targetDepartureSoc: 0.8 } },
    { f1: ['08:00'] },
    { chargeTarget: { enabled: true, value: 0.9 } },
  )).currentBuild();
  assert.deepEqual(full.cfg, { EDDF: { chargers: ['dc_320'], targetDepartureSoc: 0.8 } });
  assert.deepEqual(full.sch, { f1: ['08:00'] });
  assert.deepEqual(full.ms, { chargeTarget: { enabled: true, value: 0.9 } });
});
