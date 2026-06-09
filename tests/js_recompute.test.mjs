/*
 * CNSRouting.planChain + CNSRecompute — node harness (no server: routing is pure,
 * energy via the client engine which rebuilds from coords).
 * Run:  node tests/js_recompute.test.mjs
 */
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { loadStack, AP } from './golden_capture.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANES = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(REPO, 'planes.json'), 'utf8')).map(p => [p.id, p]));
// Minimal airport catalog for the planner's candidate pool, with the fields planRoute reads.
const ap = (k, type = 'medium_airport', alt = 0) => ({ ident: k, name: AP[k].name, type, latitude_deg: AP[k].lat, longitude_deg: AP[k].lon, iata_code: '', alternate_km: alt });
const node = (k, alt = 0) => ({ ident: k, name: AP[k].name, lat: AP[k].lat, lon: AP[k].lon, alternate_km: alt });

let pass = 0, fail = 0;
const test = (n, fn) => { try { fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };

const S = loadStack(); S.CNSSettings.reset();
const beta = PLANES.beta_plane;

test('planChain: short hop needs no stop, returns origin→dest only', () => {
  const r = S.CNSRouting.planChain({
    origin: node('EHAM'), dest: node('EHGG'), manualStops: [], plane: beta,
    allowedTypes: ['medium_airport', 'large_airport'], allAirports: [ap('EHAM'), ap('EHGG')],
    maxLegKm: 400, options: {},
  });
  if (r.error) throw new Error('unexpected error: ' + r.error);
  if (r.stops.length !== 0) throw new Error(`expected 0 stops, got ${r.stops.length}`);
});

test('planChain: a manual stop is kept and tagged _manual', () => {
  const r = S.CNSRouting.planChain({
    origin: node('EHAM'), dest: node('EGLL'), manualStops: [node('EHRD')], plane: beta,
    allowedTypes: ['medium_airport', 'large_airport'],
    allAirports: [ap('EHAM'), ap('EHRD'), ap('EGLL')], maxLegKm: 400, options: {},
  });
  if (r.error) throw new Error('unexpected error: ' + r.error);
  const ehrd = r.stops.find(s => s.ident === 'EHRD');
  if (!ehrd) throw new Error('manual stop EHRD was dropped');
  if (ehrd._manual !== true) throw new Error('manual stop lost its _manual flag');
});

test('planChain: no route within range and no anchor → error', () => {
  const r = S.CNSRouting.planChain({
    origin: node('EHAM'), dest: node('EGLL'), manualStops: [], plane: beta,
    allowedTypes: ['medium_airport'], allAirports: [ap('EHAM'), ap('EGLL')],
    maxLegKm: 50, options: {},   // 50 km can't cross to London, no candidate airports
  });
  if (!r.error) throw new Error('expected an error for an unroutable too-short leg');
});

test('mergeManualFlags: copies _manual onto saved stops by ident', () => {
  const saved = [{ ident: 'EHRD', name: 'R' }, { ident: 'EDDL', name: 'D' }];
  const planned = [{ ident: 'EHRD', _manual: true }, { ident: 'EDDL', _auto: true }];
  const out = S.CNSRecompute.mergeManualFlags(saved, planned);
  if (out[0]._manual !== true) throw new Error('EHRD should be _manual');
  if (out[1]._manual === true) throw new Error('EDDL (auto) must not be _manual');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
