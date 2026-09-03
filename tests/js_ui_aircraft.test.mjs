// tests/js_ui_aircraft.test.mjs — airframe groups, profile rows, filters and knob picking (static/ui/app.js).
// Run: node --test tests/js_ui_aircraft.test.mjs
import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path';
import { fileURLToPath } from 'node:url'; import assert from 'node:assert/strict'; import { test } from 'node:test';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANES = [
  { id: 'beta_plane', aircraft_id: 'beta_alia', name: 'Beta Alia CX300', type: 'CTOL', propulsion: 'fully electric', regime: 'VFR', status: 'prototype flying', profile_label: 'Standard' },
  { id: 'vaeridion', aircraft_id: 'vaeridion', name: 'Microliner — Max', type: 'CTOL', propulsion: 'fully electric', regime: 'VFR', status: 'under construction', profile_label: 'Max (9 seats)' },
  { id: 'vaeridion_light', aircraft_id: 'vaeridion', name: 'Microliner — Light', type: 'CTOL', propulsion: 'fully electric', regime: 'VFR', status: 'under construction', profile_label: 'Light (4 seats)' },
  { id: 'es30_e', aircraft_id: 'es30', name: 'ES-30 electric', type: 'CTOL', propulsion: 'fully electric', regime: 'IFR', status: 'in development', profile_label: 'Standard' },
  { id: 'es30_h', aircraft_id: 'es30', name: 'ES-30 hybrid', type: 'CTOL', propulsion: 'hybrid', regime: 'IFR', status: 'in development', profile_label: 'Standard' },
  { id: 'joby', aircraft_id: 'joby', name: 'Joby S4', type: 'eVTOL', propulsion: 'fully electric', regime: 'VFR', status: 'certified', profile_label: 'Standard' },
];
function load() { const sb = { window: { CNS_DATA: { planes: PLANES, chargers: [] }, localStorage: { getItem: () => null, setItem() {} } }, console }; sb.window.window = sb.window;
  vm.createContext(sb); vm.runInContext(fs.readFileSync(path.join(REPO, 'static', 'ui', 'app.js'), 'utf8'), sb); return sb.window.CNSUI.aircraft; }

test('rows sharing aircraft_id form one airframe group', () => {
  const AC = load(); const g = AC.groups();
  assert.deepEqual([...g.map(x => x.key)], ['beta_alia', 'vaeridion', 'es30', 'joby']);
  assert.equal(AC.groupOf('vaeridion_light').key, 'vaeridion');
});
test('filter dimensions only render when the catalog varies on them', () => {
  const AC = load(); const dims = AC.dims();
  assert.deepEqual([...dims.map(d => d.key)], ['type', 'propulsion', 'status']);
  assert.deepEqual([...dims[0].values], ['CTOL', 'eVTOL']);
  assert.deepEqual([...AC.visible({ type: 'eVTOL' }).map(g => g.key)], ['joby']);
  assert.deepEqual([...AC.visible({ propulsion: 'hybrid' }).map(g => g.key)], ['es30']);
  assert.equal(AC.visible({ type: 'eVTOL', propulsion: 'hybrid' }).length, 0);
});
test('knobs pick the best profile row and relax in order: label, regime, propulsion', () => {
  const AC = load(); const v = AC.groupOf('vaeridion'), e = AC.groupOf('es30_e');
  assert.equal(AC.pick(v, { label: 'Light (4 seats)', regime: 'VFR', propulsion: 'fully electric' }).id, 'vaeridion_light');
  assert.equal(AC.pick(e, { label: 'Standard', regime: 'IFR', propulsion: 'hybrid' }).id, 'es30_h');
  assert.equal(AC.pick(e, { label: 'Nope', regime: 'VFR', propulsion: 'hybrid' }).id, 'es30_h');   // propulsion still honoured
  assert.equal(AC.pick(v, { label: 'Nope', regime: 'IFR', propulsion: 'x' }).id, 'vaeridion');      // nothing matches → first row
});
