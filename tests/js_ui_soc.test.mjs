// tests/js_ui_soc.test.mjs — three-stage battery draw: phases sum to the leg, charges rise, reserve intact.
// Run: node --test tests/js_ui_soc.test.mjs
import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path';
import { fileURLToPath } from 'node:url'; import assert from 'node:assert/strict'; import { test } from 'node:test';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load() { const sb = { window: { CNSUI: {} }, console }; vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'static', 'ui', 'soc.js'), 'utf8'), sb); return sb.window.CNSUI.soc; }
const climb = { applies: true, eMaxKwh: 22.5, dSatKm: 75, cruisePerKm: 0.405 };
const legs = [{ distKm: 343, energyKwh: 161.4, socStartFrac: 1, socEndFrac: 0.283, toIdent: 'EDDF' },
              { distKm: 299, energyKwh: 143.6, socStartFrac: 0.94, socEndFrac: 0.30, toIdent: 'EDDM' }];
const charges = [{ atIndex: 1, energyKwh: 148, chargeMin: 28, ident: 'EDDF', departSocFrac: 0.94 },
                 { atIndex: 2, energyKwh: 157.5, chargeMin: 30, ident: 'EDDM', departSocFrac: 1 }];

test('fly segments per leg sum to the engine leg energy (bottom line unchanged)', () => {
  const s = load().series(legs, charges, 225, climb, {});
  const fly = s.segs.filter(q => q.t === 'fly');
  assert.equal(fly.length, 6);                                   // 3 stages × 2 legs
  const drop = fly.slice(0, 3).reduce((a, q) => a + (q.y0 - q.y1), 0);
  assert.ok(Math.abs(drop - 161.4 / 225 * 100) < 0.05);
});

test('climb is steeper than cruise, descent shallower; zones are flagged', () => {
  const s = load().series(legs, charges, 225, climb, {});
  const [cl, cr, de] = s.segs.filter(q => q.t === 'fly').slice(0, 3).map(q => (q.y0 - q.y1) / (q.x1 - q.x0));
  assert.ok(cl > cr && cr > de);
  assert.deepEqual(s.zones.map(z => z.t), ['climb', 'descent', 'climb', 'descent']);
});

test('charges rise to the depart SoC and the lowest point is reported', () => {
  const s = load().series(legs, charges, 225, climb, {});
  const chg = s.segs.filter(q => q.t === 'chg');
  assert.equal(chg.length, 2);
  assert.ok(Math.abs(chg[0].y1 - 94) < 0.6);
  assert.ok(Math.abs(s.low - 28.3) < 0.6);
  assert.equal(s.pts.at(-1).id, 'EDDM');
});

test('training or no climb model: one straight segment per leg', () => {
  const s = load().series([legs[0]], [charges[0]], 225, { applies: false }, { training: true });
  assert.equal(s.segs.filter(q => q.t === 'fly').length, 1);
  assert.equal(s.zones.length, 0);
});
