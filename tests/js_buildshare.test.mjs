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

test('_simPayload maps stored inputs to an /api/simulate body', () => {
  const B = load(stubs(FOLDER, {}, {}, undefined));
  const body = B._simPayload({
    id: 'f1', p: 'beta_plane', c: 'dc_320', t: 'oneway', fn: 2, fu: 'day',
    o: { i: 'EHLE', la: 52.46, lo: 5.52, n: 'Lelystad' },
    d: { i: 'EDDF', la: 50.03, lo: 8.56, n: 'Frankfurt' },
    s: [{ i: 'EDLV', la: 51.6, lo: 6.1, n: 'Niederrhein' }],
  });
  assert.deepEqual(body, {
    plane_id: 'beta_plane', charger_id: 'dc_320', trip_type: 'oneway',
    origin: { ident: 'EHLE', name: 'Lelystad', lat: 52.46, lon: 5.52 },
    destination: { ident: 'EDDF', name: 'Frankfurt', lat: 50.03, lon: 8.56 },
    stops: [{ ident: 'EDLV', name: 'Niederrhein', lat: 51.6, lon: 6.1 }],
  });
});

test('applyBuild re-simulates flights, replaces the folder, restores cfg/sch/ms', async () => {
  const saved = {};
  const restoreStubs = stubs(FOLDER, {}, {}, undefined);
  restoreStubs.CNSDemand = {
    loadFolder: () => FOLDER, loadCfg: () => ({}),
    saveFolder: (f) => { saved.folder = f; }, saveCfg: (c) => { saved.cfg = c; },
  };
  restoreStubs.CNSState = { KEYS: { sched: 'cns_schedule' }, getJSON: (k, d) => d, setJSON: (k, v) => { saved.sch = v; } };
  restoreStubs.CNSSettings = { save: (ms) => { saved.ms = ms; } };
  restoreStubs.CNSFlightEntry = { fromSim: (d, opts) => ({ id: opts.id, planeId: d.plane.id }) };
  restoreStubs.renderFolder = () => { saved.rendered = true; };
  const B = load(restoreStubs);

  // fetch stub: succeed for f1, fail (error response) for the training flight.
  const fetchStub = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.plane_id === 'beta_plane') {
      return { json: async () => ({ plane: { id: 'beta_plane', name: 'Beta', battery_kwh: 225 }, charger: { name: 'C', power_kw: 320 }, trip_type: 'oneway', leg_energy_kwh: 150 }) };
    }
    return { json: async () => ({ error: 'over range' }) };
  };

  const st = {
    v: 1, k: 'build',
    fl: [
      { id: 'f1', p: 'beta_plane', c: 'dc_320', t: 'oneway', fn: 2, fu: 'day', o: { i: 'EHLE', la: 52.46, lo: 5.52, n: 'L' }, d: { i: 'EDDF', la: 50.03, lo: 8.56, n: 'F' } },
      { id: 't1', p: 'pipistrel_velis', c: 'dc_22', t: 'training', fn: 5, fu: 'week', o: { i: 'EHTE', la: 52.24, lo: 6.05, n: 'T' } },
    ],
    cfg: { EDDF: { chargers: ['dc_320'] } },
    sch: { f1: ['08:00'] },
    ms: { chargeTarget: { enabled: true, value: 0.9 } },
  };
  const res = await B.applyBuild(st, fetchStub);

  assert.deepEqual(res, { restored: 1, dropped: 1 });
  assert.equal(saved.folder.length, 1);
  assert.equal(saved.folder[0].id, 'f1');
  assert.deepEqual(saved.cfg, { EDDF: { chargers: ['dc_320'] } });
  assert.deepEqual(saved.sch, { f1: ['08:00'] });
  assert.deepEqual(saved.ms, { chargeTarget: { enabled: true, value: 0.9 } });
  assert.equal(saved.rendered, true);
});

test('copyBuildLink refuses an empty folder', async () => {
  const toasts = [];
  const s = stubs([], {}, {}, undefined);
  s.CNSShare = { settingsDelta: () => undefined, toast: (m) => toasts.push(m) };
  const B = load(s);
  const url = await B.copyBuildLink({ createShortLink: async () => 'x', writeText: async () => {} });
  assert.equal(url, null);
  assert.match(toasts[0], /at least one flight/i);
});

test('copyBuildLink POSTs the build and returns the slug url', async () => {
  let posted = null;
  const s = stubs(FOLDER, {}, {}, undefined);
  s.CNSShare = { settingsDelta: () => undefined, toast: () => {} };
  const B = load(s);
  const url = await B.copyBuildLink({
    createShortLink: async (state) => { posted = state; return 'https://h/s/AbC1234'; },
    writeText: async () => {},
  });
  assert.equal(url, 'https://h/s/AbC1234');
  assert.equal(posted.k, 'build');
  assert.equal(posted.fl.length, 2);
});
