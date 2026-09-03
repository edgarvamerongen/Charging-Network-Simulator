// tests/js_ui_app.test.mjs — pure parts of static/ui/app.js in a vm sandbox (no document).
// Run: node --test tests/js_ui_app.test.mjs
import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path';
import { fileURLToPath } from 'node:url'; import assert from 'node:assert/strict'; import { test } from 'node:test';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function load(data) {
  const sandbox = { window: { CNS_DATA: data, localStorage: { getItem: () => null, setItem() {} } }, console };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'static', 'ui', 'app.js'), 'utf8'), sandbox);
  return sandbox.window;
}
const DATA = { planes: [{ id: 'beta_plane', name: 'Beta Alia CX300', battery_kwh: 225, range_km: 500, default_charger_id: 'dc_320' }],
               chargers: [{ id: 'dc_320', name: 'Beta Cube 320 kW', power_kw: 320 }], cartoKeyQs: '', shareState: null };
const APS = [
  { ident: 'EHLE', iata_code: 'LEY', name: 'Lelystad Airport', municipality: 'Lelystad', type: 'medium_airport', latitude_deg: 52.45, longitude_deg: 5.51 },
  { ident: 'EDDF', iata_code: 'FRA', name: 'Frankfurt Main Airport', municipality: 'Frankfurt am Main', type: 'large_airport', latitude_deg: 50.03, longitude_deg: 8.57 },
  { ident: 'EDFH', iata_code: 'HHN', name: 'Frankfurt-Hahn Airport', municipality: 'Lautzenhausen', type: 'medium_airport', latitude_deg: 49.95, longitude_deg: 7.26 },
];

test('exports the engine adapter names on window', () => {
  const w = load(DATA);
  assert.equal(typeof w.escHtml, 'function');
  assert.equal(w.PLANES_BY_ID.beta_plane.battery_kwh, 225);
  assert.equal(w.CHARGERS_BY_ID.dc_320.power_kw, 320);
  for (const n of ['setOrigin', 'setDest', 'setStop']) assert.equal(typeof w[n], 'function', n);
});

test('search ranks exact code, then name prefix, then contains; large before small', () => {
  const w = load(DATA); w.CNSUI._setAirports(APS);
  assert.deepEqual([...w.CNSUI.search('fra').map(a => a.ident)], ['EDDF', 'EDFH']);
  assert.deepEqual([...w.CNSUI.search('ley').map(a => a.ident)], ['EHLE']);
  assert.equal(w.CNSUI.search('x').length, 0);
});

test('planeShort and shortName trim catalog names for labels', () => {
  const w = load(DATA);
  assert.equal(w.CNSUI.planeShort('Beta Alia CX300'), 'Alia CX300');
  assert.equal(w.CNSUI.planeShort('Vaeridion Microliner — Max (9 seats)'), 'Vaeridion Microliner');
  assert.equal(w.CNSUI.shortName('Frankfurt Main Airport'), 'Frankfurt Main');
});

test('default selection is the first beta plane and its default charger', () => {
  const w = load(DATA); w.CNSUI._setAirports(APS); w.CNSUI._applyDefaults();
  assert.equal(w.CNSUI.S.planeId, 'beta_plane');
  assert.equal(w.CNSUI.S.chargerId, 'dc_320');
  assert.equal(w.CNSUI.S.origin.ident, 'EHLE');
  assert.equal(w.CNSUI.S.dest.ident, 'EDDF');
});
