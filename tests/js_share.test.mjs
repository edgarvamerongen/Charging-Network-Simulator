/*
 * CNSShare — node harness for the shareable-link codec (static/share.js).
 *
 * Only the pure codec (encode/decode) is exercised here; currentState()/apply()
 * touch the live DOM + planner globals and are verified in the browser. The
 * blob must round-trip the route state byte-for-byte and stay URL-safe so it
 * survives sitting in a #hash through the auth redirect.
 *
 * Run:  node tests/js_share.test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function loadShare() {
  const code = fs.readFileSync(path.join(REPO, 'static', 'share.js'), 'utf8');
  // share.js reads DOM/planner globals only INSIDE functions, so a bare window
  // + the codec primitives are all the sandbox needs to define CNSShare.
  // Pass the host JSON so decoded objects share the host realm's Object.prototype
  // (else deepStrictEqual's prototype check fails on sandbox-realm objects).
  const sandbox = { window: {}, TextEncoder, TextDecoder, Uint8Array, btoa, atob, JSON, console, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.CNSShare;
}

test('encode → decode round-trips the route state exactly', () => {
  const S = loadShare();
  const st = {
    v: 1, a: 'beta_plane', o: 'EHLE', d: 'EDDF', s: ['EDDK', 'EDDL'],
    t: 'circular', f: { n: 2, u: 'week' }, c: 'dc_320', w: true,
    ms: { chargeTarget: { enabled: true, value: 0.9 }, landingReserve: { enabled: true, minLandingSoc: 0.25 } },
  };
  assert.deepEqual(S.decode(S.encode(st)), st);
});

test('blob is URL-safe — no + / = (survives a #hash unescaped)', () => {
  const S = loadShare();
  const blob = S.encode({ v: 1, a: 'x', o: 'EHAM', d: 'EHRD', s: [], t: 'oneway', f: { n: 1, u: 'day' }, c: 'dc_50', w: false });
  assert.ok(!/[+/=]/.test(blob), 'blob has URL-unsafe characters: ' + blob);
});

test('decode rejects a corrupt blob', () => {
  const S = loadShare();
  assert.throws(() => S.decode('@@@not-a-valid-blob@@@'));
});

test('SCHEMA version is exposed for migration guards', () => {
  const S = loadShare();
  assert.equal(S.SCHEMA, 1);
});
