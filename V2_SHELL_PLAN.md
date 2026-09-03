# CNS v2 shell — Phase 1 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new desktop shell at `/v2` in the design-A language that boots on the real catalogs and engines, plans and simulates a route with the JS flight engine, shows the result with the battery profile, and adds flights to the shared network — while `/` stays byte-identical.

**Architecture:** One new template (`templates/desktop.html`), one stylesheet (`static/desktop.css`, the prototype's tokens), and small UI modules under `static/ui/` on a `window.CNSUI` namespace that render by template strings + event delegation and call the existing `window.CNS*` engine modules unchanged. Persistent state stays in the engines' localStorage keys, so `/` and `/v2` share one network.

**Tech Stack:** Flask/Jinja (route + template), vanilla JS (no framework, no Bootstrap), Leaflet 1.9.4, Inter, existing engines (`static/*.js`), `node:test` + `vm` for JS unit tests, `unittest` via pytest for the route.

**Spec:** `V2_SHELL_DESIGN.md` (repo root). Phases 2–5 get their own plan files after Edgar's live review of this phase.

## Global Constraints

- `templates/index.html`, `static/*.js` engines, `sim.py` are **not modified** in this phase; `app.py` gains one route only.
- Design tokens: radius `3px` (one token), ink `#32326E`, muted `#6f7290`, accent `#d84c26` used only for the primary action and the live route, hairline `#e2e2ea`, surface `#fff`, canvas `#f3f3f7`, Inter only, no gradients/blur/glow.
- All displayed numbers come from `CNSFlight.simulateTrip` (never from `/api/simulate` fields), except the audit text.
- Every `static/ui/*.js` passes `node --check`; app boots; `tests/` green (`./venv/bin/python -m pytest -q tests/test_v2_shell.py` and `node --test tests/js_ui_*.test.mjs`).
- Copy in user-facing text is terse aviation-professional English (see repo convention), no marketing wording.
- Commit after every task with the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer.

---

## File structure

| file | responsibility |
|---|---|
| `app.py` (+8 lines after `index()`) | `GET /v2` → `desktop.html` with the same context as `/` |
| `templates/desktop.html` (new) | markup + Jinja→JSON bridge (`window.CNS_DATA`) + script tags; no inline CSS/JS beyond the bridge |
| `static/desktop.css` (new) | tokens + components, taken verbatim from the prototype's `<style>` block |
| `static/ui/app.js` (new) | `window.CNSUI`: state `S`, catalogs, airports, search, formatters, window adapter for the engines, boot, `render()` |
| `static/ui/soc.js` (new) | pure: `CNSUI.soc.series(legs, charges, batteryKwh, climb)` → points/segments for the battery chart |
| `static/ui/map.js` (new) | Leaflet map, basemaps, airport dots, NRG squares, route/labels/endpoints, saved routes, popups |
| `static/ui/plan.js` (new) | rail in Plan mode: form, simulate (API + engine), result card, add to network |
| `static/ui/network.js` (new) | rail in Network mode: read-only ledger over `CNSDemand.computeAirports()`, remove flight |
| `static/ui/timeline.js` (new) | drawer header/summary only (lanes land in phase 3) |
| `static/ui/palette.js` (new) | topbar menus, units, ⌘K palette |
| `tests/test_v2_shell.py` (new) | route + template smoke |
| `tests/js_ui_app.test.mjs`, `tests/js_ui_soc.test.mjs` (new) | pure-logic unit tests |

---

### Task 1: `/v2` route + template skeleton

**Files:**
- Modify: `app.py` (insert after the `index()` function, before `share_open`)
- Create: `templates/desktop.html`
- Test: `tests/test_v2_shell.py`

**Interfaces:**
- Produces: route `/v2` rendering `desktop.html` with `planes, chargers, asset_version` (+ `carto_key_qs` from the existing context processor); `window.CNS_DATA = {planes, chargers, cartoKeyQs, shareState, assetVersion}` for the UI modules.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_v2_shell.py
"""
/v2 desktop shell — route + template smoke tests (in-process Flask client).
Auth env is set BEFORE importing app, like tests/test_auth.py.
"""
import os
import unittest

os.environ.setdefault('CNS_APP_PASSWORD', 'test-secret-pw')
os.environ.setdefault('CNS_SECRET_KEY', 'unit-test-fixed-key')
os.environ.setdefault('CNS_INSECURE_COOKIES', '1')

import app as cns_app  # noqa: E402


class V2ShellTestCase(unittest.TestCase):
    def setUp(self):
        cns_app.app.config['TESTING'] = True
        self.client = cns_app.app.test_client()
        self._auth = cns_app.AUTH_ENABLED
        cns_app.AUTH_ENABLED = False

    def tearDown(self):
        cns_app.AUTH_ENABLED = self._auth

    def test_v2_renders_the_new_shell(self):
        r = self.client.get('/v2')
        self.assertEqual(r.status_code, 200)
        html = r.get_data(as_text=True)
        self.assertIn('window.CNS_DATA', html)
        self.assertIn('/static/desktop.css', html)
        self.assertIn('/static/ui/app.js', html)
        self.assertIn('/static/flight-model.js', html)      # engines are loaded
        self.assertNotIn('bootstrap', html)                 # no Bootstrap in v2

    def test_v2_bridge_carries_catalogs(self):
        html = self.client.get('/v2').get_data(as_text=True)
        self.assertIn('"battery_kwh"', html)                # planes JSON
        self.assertIn('"power_kw"', html)                   # chargers JSON

    def test_classic_shell_is_untouched(self):
        html = self.client.get('/?desktop=1').get_data(as_text=True)
        self.assertIn('id="simForm"', html)
        self.assertNotIn('window.CNS_DATA', html)

    def test_v2_is_gated_like_index(self):
        cns_app.AUTH_ENABLED = True
        r = self.client.get('/v2')
        self.assertEqual(r.status_code, 302)
        self.assertIn('/login', r.headers['Location'])
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./venv/bin/python -m pytest -q tests/test_v2_shell.py`
Expected: FAIL — `/v2` returns 404 (`assert 404 == 200`).

- [ ] **Step 3: Add the route**

Insert in `app.py` directly after the `index()` function:

```python
@app.route('/v2')
def index_v2():
    """The v2 desktop shell (V2_SHELL_DESIGN.md). Same context as `/`, no
    mobile redirect — it is desktop-only until it replaces `/`."""
    return render_template('desktop.html', planes=simulator.planes,
                           chargers=simulator.chargers, asset_version=ASSET_VERSION)
```

- [ ] **Step 4: Create the template** — Appendix A (`templates/desktop.html`), verbatim.

- [ ] **Step 5: Run the tests**

Run: `./venv/bin/python -m pytest -q tests/test_v2_shell.py`
Expected: 4 passed. (The CSS/JS files referenced do not need to exist for the template test.)

- [ ] **Step 6: Commit**

```bash
git add app.py templates/desktop.html tests/test_v2_shell.py
git commit -m "feat(v2): /v2 route + desktop.html shell skeleton with the CNS_DATA bridge"
```

---

### Task 2: `static/desktop.css` — the token layer and components

**Files:**
- Create: `static/desktop.css`

**Interfaces:**
- Produces: every class the prototype uses (`.topbar .seg .tb .search .dd .ac .rail .ph .sec .lbl .fld .seg.sm .route .stop .freq .chg .btns .btn .pick .rh2 .stats .cost .split .soc .acc .tbl .calc .tiles .ntool .ap .fl .fleet .bays .step .empty .drawer .gantt .grow .track .blk .glegend .toast .cmdk* .kbd .scen .chip [hidden]`) plus `.v2tag`.

- [ ] **Step 1: Extract the prototype's stylesheet**

```bash
python3 - <<'PY'
src=open('static/proto/instrument.html').read()
css=src[src.index('<style>')+7:src.index('</style>')]
css=css.replace('.mock{','.mock-unused{')          # the corner label is not part of the app
css='/* CNS v2 — design tokens + components (V2_SHELL_DESIGN.md §3). Source of truth: this file; the prototype under static/proto is frozen. */\n'+css
css+='\n/* v2 preview tag in the topbar */\n.v2tag{font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);border:1px solid var(--accent);border-radius:var(--r);padding:1px 6px;margin-left:8px;text-decoration:none}\n.v2tag:hover{background:var(--accent);color:#fff}\n'
open('static/desktop.css','w').write(css); print(len(css.splitlines()),'lines')
PY
```

- [ ] **Step 2: Verify it serves and parses**

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5079/static/desktop.css` (with the worktree server up) → `200`; `grep -c 'backdrop-filter' static/desktop.css` → `0`; `grep -cE 'border-radius:\s*(8|12|14|18|24)px' static/desktop.css` → `0`.

- [ ] **Step 3: Commit**

```bash
git add static/desktop.css
git commit -m "feat(v2): desktop.css — Instrument tokens and components from the prototype"
```

---

### Task 3: `static/ui/app.js` — state, catalogs, adapter, boot

**Files:**
- Create: `static/ui/app.js` (Appendix B)
- Test: `tests/js_ui_app.test.mjs`

**Interfaces:**
- Consumes: `window.CNS_DATA`, `CNSUnits`, `CNSChargers`, `CNSScheduler`, `CNSDemand`.
- Produces: `window.CNSUI = { S, PLANES, CHARGERS, airports(), byId(), assets(), $, $$, esc, fmt:{km,ukm,dist,h,min,eur,kw}, plane(), charger(), chain(), search(q), toast(t), perDay(f), planeShort(n), shortName(n), render(), boot() }`; window adapter names listed in the spec §3.

- [ ] **Step 1: Write the failing test**

```js
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
  assert.deepEqual(w.CNSUI.search('fra').map(a => a.ident), ['EDDF', 'EDFH']);
  assert.deepEqual(w.CNSUI.search('ley').map(a => a.ident), ['EHLE']);
  assert.deepEqual(w.CNSUI.search('x'), []);
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/js_ui_app.test.mjs`
Expected: FAIL — `ENOENT static/ui/app.js`.

- [ ] **Step 3: Create `static/ui/app.js`** — Appendix B, verbatim.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/js_ui_app.test.mjs` → 4 passed. Also `node --check static/ui/app.js`.

- [ ] **Step 5: Commit**

```bash
git add static/ui/app.js tests/js_ui_app.test.mjs
git commit -m "feat(v2): ui/app.js — state, catalogs, search, engine adapter, boot"
```

---

### Task 4: `static/ui/soc.js` — battery profile series (pure)

**Files:**
- Create: `static/ui/soc.js` (Appendix C)
- Test: `tests/js_ui_soc.test.mjs`

**Interfaces:**
- Consumes: engine legs `{distKm, energyKwh, socStartFrac, socEndFrac, toIdent}`, charges `{atIndex, energyKwh, chargeMin, ident, departSocFrac}`, `batteryKwh`, `climb = CNSFlight.climbParams(plane)` (`{applies, eMaxKwh, dSatKm, cruisePerKm}`).
- Produces: `CNSUI.soc.series(legs, charges, batteryKwh, climb, {training})` → `{ segs:[{t:'fly'|'chg', x0,y0,x1,y1, id?, min?}], zones:[{t:'climb'|'descent', x0,x1}], pts:[{x, soc, id}], low }` with `x` in % of total distance and `soc` in %.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run to verify it fails** — `node --test tests/js_ui_soc.test.mjs` → ENOENT.
- [ ] **Step 3: Create `static/ui/soc.js`** — Appendix C.
- [ ] **Step 4: Run to verify it passes** — 4 passed.
- [ ] **Step 5: Commit**

```bash
git add static/ui/soc.js tests/js_ui_soc.test.mjs
git commit -m "feat(v2): ui/soc.js — three-stage battery series, leg totals pinned to the engine"
```

---

### Task 5: `static/ui/map.js` — map, dots, route, popups

**Files:**
- Create: `static/ui/map.js` (Appendix D)

**Interfaces:**
- Consumes: `CNSUI.S`, `CNSUI.airports()`, `CNSUI.assets()`, `CNSUI.chain()`, `CNS_DATA.cartoKeyQs`, `CNSUI.plan.legsForMap()` (task 6).
- Produces: `CNSUI.map = { init(), drawAirports(), drawAssets(), drawRoute(fit), drawNet(), fitNet(), setBase(name), showSmall(bool), flyTo(ap), map }`.

- [ ] **Step 1: Create the file** — Appendix D.
- [ ] **Step 2: Syntax check** — `node --check static/ui/map.js`.
- [ ] **Step 3: Browser check** (worktree server on 5079): open `http://localhost:5079/v2`; in the console `CNSUI.airports().length` → 7796; `document.querySelectorAll('.leaflet-tile-pane img').length > 0`; `Object.keys(CNSUI.assets()).length` → 8; click an airport dot → popup with Departure/Destination/Stop buttons.
- [ ] **Step 4: Commit**

```bash
git add static/ui/map.js
git commit -m "feat(v2): ui/map.js — quiet basemap, airport dots, NRG squares, route furniture"
```

---

### Task 6: `static/ui/plan.js` — form, simulate through the engine, result

**Files:**
- Create: `static/ui/plan.js` (Appendix E)

**Interfaces:**
- Consumes: `CNSUI.*`, `CNSFlight.simulateTrip/climbParams`, `CNSDemand.resolveTargetSoc/loadFolder/saveFolder`, `CNSFlightEntry.fromSim`, `CNSSettings.chargeRate/usableFraction`, `CNSChargers.get`, `CNSUI.soc.series`, `CNSUI.map`.
- Produces: `CNSUI.plan = { render(), simulate(), addToNetwork(), derive(), legsForMap(), onFormChange(fit) }`; `S.result` decorated exactly like the classic shell (`_origin,_dest,_chargerId,_freqN,_freqUnit`), `S.profile` = FlightProfile.

- [ ] **Step 1: Create the file** — Appendix E.
- [ ] **Step 2: Syntax check** — `node --check static/ui/plan.js`.
- [ ] **Step 3: Browser check** — `/v2#result`: rail shows `EHLE → EDDF`, stats present, battery chart present; `CNSUI.S.profile.totals.energyUsedKwh` equals the ENERGY tile; compare with `/?desktop=1` for the same route: energy, charge min and €/day match to the rounding. `/v2#multi`: two legs, one stop, chart shows two climb zones.
- [ ] **Step 4: Add to network round-trip** — click *Add to network* on `/v2`; open `/?desktop=1`: the demand calculator lists the flight; remove it there; reload `/v2#network`: it is gone.
- [ ] **Step 5: Commit**

```bash
git add static/ui/plan.js
git commit -m "feat(v2): ui/plan.js — form, simulate via CNSFlight, result card with battery profile, add to network"
```

---

### Task 7: `static/ui/network.js` + `static/ui/timeline.js` — read-only network and drawer header

**Files:**
- Create: `static/ui/network.js`, `static/ui/timeline.js` (Appendix F)

**Interfaces:**
- Consumes: `CNSDemand.computeAirports/loadFolder/saveFolder/flightsPerDay/energyAt/resolveTargetSoc/loadCfg`, `CNSScheduler.summary(ident)` (after `CNSScheduler.init` in boot), `CNSSettings.chargeRate()`.
- Produces: `CNSUI.network = { render(), remove(id) }`, `CNSUI.timeline = { render() }`.

- [ ] **Step 1: Create both files** — Appendix F.
- [ ] **Step 2: Syntax check** — `node --check static/ui/network.js static/ui/timeline.js`.
- [ ] **Step 3: Browser check** — with two flights added: Network mode lists their airports with flights/day, kWh/day (from `CNSDemand.energyAt`) and peak kW (from `CNSScheduler.summary`); the numbers equal the classic drawer's per-airport cards for the same folder; × removes a flight in both shells.
- [ ] **Step 4: Commit**

```bash
git add static/ui/network.js static/ui/timeline.js
git commit -m "feat(v2): ui/network.js + ui/timeline.js — read-only ledger over the shared folder"
```

---

### Task 8: `static/ui/palette.js` — topbar menus, units, ⌘K

**Files:**
- Create: `static/ui/palette.js` (Appendix G)

**Interfaces:**
- Consumes: `CNSUI.*`, `CNSUI.map`, `CNSUI.plan`, `CNSUnits.set/get`, `CNSSpreadsheet.export`, `CNSShare.copyLink`, `CNSBuildShare.copyBuildLink`.
- Produces: `CNSUI.palette = { open(q), close() }`; menus wired; `cns_map_options` persistence (same keys as the classic shell for `basemap`, `fSmall`, `nrgChargerToggle`, `fSavedRoutes`).

- [ ] **Step 1: Create the file** — Appendix G.
- [ ] **Step 2: Browser check** — ⌘K opens; typing `fra` lists EDDF with actions; Enter flies; `Units: NM` re-renders distances; Map menu switches basemaps; Export → XLSX downloads; Share link copies (toast).
- [ ] **Step 3: Commit**

```bash
git add static/ui/palette.js
git commit -m "feat(v2): ui/palette.js — topbar menus, units, command palette"
```

---

### Task 9: Verification pass, deep links, handoff

- [ ] **Step 1: Full checks**

```bash
for f in static/ui/*.js; do node --check "$f" || exit 1; done
node --test tests/js_ui_app.test.mjs tests/js_ui_soc.test.mjs
./venv/bin/python -m pytest -q tests/test_v2_shell.py tests/test_auth.py
git diff --stat main..HEAD -- templates/index.html static/flight-model.js static/scheduler.js   # must be empty
```

- [ ] **Step 2: Headless captures** of `/v2`, `/v2#result`, `/v2#multi`, `/v2#network` at 1440×900 (Chrome `--headless=new --screenshot`; kill the process after the PNG appears) and a numbers cross-check table `/` vs `/v2` for EHLE→EDDF and EHLE→EDDF→EDDM (energy, charge min, €/day, peak kW at EDDF).
- [ ] **Step 3: Commit anything left, then stop for Edgar's live review.** Phase 2 planning starts only after his feedback.

---

## Appendix A — `templates/desktop.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Charging Network Simulator</title>
    <link rel="icon" href="/pics/logos/fav.ico">
    <link rel="apple-touch-icon" href="/pics/logos/NRG2fly_logo_compact.png">
    <meta property="og:title" content="NRG2fly Charging Network Simulator">
    <meta property="og:image" content="https://cns.nrg2fly.nl/pics/og_card.png">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
    <link rel="stylesheet" href="/static/desktop.css?v={{ asset_version }}">
</head>
<body>
<svg width="0" height="0" style="position:absolute"><defs>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></symbol>
<symbol id="i-gear" viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></symbol>
<symbol id="i-chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></symbol>
<symbol id="i-down" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
<symbol id="i-reset" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></symbol>
<symbol id="i-share" viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></symbol>
<symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></symbol>
<symbol id="i-layers" viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/></symbol>
<symbol id="i-dl" viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M4 20h16"/></symbol>
<symbol id="i-plane" viewBox="0 0 24 24"><path d="M10.5 13.5 3 11l1-2 6 1 5-5 2 1-3 5 4 5-1 2-5-3-4 4-1-1z"/></symbol>
<symbol id="i-net" viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="m7 11 10-4M7 13l10 4"/></symbol>
<symbol id="i-help" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.7M12 17h.01"/></symbol>
</defs></svg>

<header class="topbar">
  <div class="brand"><img src="/pics/logos/NRG2fly_logo_kleur_wide.png" alt="NRG2FLY"><span class="t">Charging Network Simulator</span><a class="v2tag" href="/?desktop=1" title="Open the classic version">v2 preview</a></div>
  <div class="seg" id="modeSeg"><button data-mode="plan" class="on"><svg class="ic"><use href="#i-plane"/></svg>Plan</button><button data-mode="network"><svg class="ic"><use href="#i-net"/></svg>Network <span id="netCount" class="num"></span></button></div>
  <span class="sp"></span>
  <div class="search"><svg class="ic"><use href="#i-search"/></svg><input id="q" placeholder="Find airport — ICAO, IATA or name" autocomplete="off"><span class="kbd" id="kbdHint" title="Command palette">⌘K</span><div class="ac" id="qAc"></div></div>
  <div style="position:relative"><button class="tb" id="mapBtn"><svg class="ic"><use href="#i-layers"/></svg>Map</button>
    <div class="dd" id="mapDd"><div class="h">Basemap</div>
      <button data-base="light" class="on">Light</button><button data-base="street">Street</button><button data-base="sat">Satellite</button>
      <hr><div class="h">Layers</div>
      <label><input type="checkbox" id="ckSmall"> Small airfields</label>
      <label><input type="checkbox" id="ckAssets" checked> NRG2FLY chargers</label>
      <label><input type="checkbox" id="ckNet" checked> Saved network routes</label>
    </div></div>
  <div class="units"><span>Units</span><div class="seg" id="unitSeg"><button data-u="km" class="on">km</button><button data-u="nm">NM</button></div></div>
  <div style="position:relative"><button class="tb" id="expBtn"><svg class="ic"><use href="#i-dl"/></svg>Export</button>
    <div class="dd" id="expDd"><button data-exp="pdf">Advisory report (PDF)</button><button data-exp="xlsx">Demand workbook (XLSX)</button><button data-exp="share">Share this route</button><button data-exp="build">Share the network build</button><a href="/static/NRG2fly_onepager.pdf" target="_blank" rel="noopener" style="display:flex;align-items:center;height:30px;padding:0 8px;font-size:12.5px;text-decoration:none;color:var(--ink)">One-pager</a></div></div>
  <div style="position:relative"><button class="tb icon" id="setBtn" title="Model settings"><svg class="ic"><use href="#i-gear"/></svg></button>
    <div class="dd" id="setDd" style="min-width:240px"><div class="h">Model settings</div><div class="hint" style="padding:0 8px 6px" id="setSummary"></div><hr><div class="hint" style="padding:0 8px 6px">Editing lands in phase 4 — use the classic version to change settings; both shells read the same values.</div></div></div>
</header>

<div id="map"></div>
<aside class="rail" id="rail"><div class="body" id="railBody"></div><div id="railFoot"></div></aside>

<section class="drawer" id="drawer">
  <div class="dh" id="drawerHead"><div class="t">Demand timeline <span id="drawerSub">no flights yet</span></div><div class="tools"><button class="chip" id="focChip" data-act="focus" data-ap="" hidden></button><div class="seg" id="laneSeg" style="height:24px"><button data-lanes="airports" class="on" style="padding:0 9px;font-size:11.5px">Airports</button><button data-lanes="fleet" style="padding:0 9px;font-size:11.5px">Fleet</button></div><span class="dep-lbl">Departures</span><button class="sw" id="depSw" title="Show departures on the timeline"></button><svg class="ic"><use href="#i-down"/></svg></div></div>
  <div class="gantt" id="gantt"></div>
</section>

<div class="cmdk" id="cmdk" hidden><div class="cmdk-dim" data-cmdk="close"></div>
  <div class="cmdk-box"><div class="cmdk-in"><svg class="ic"><use href="#i-search"/></svg><input id="cmdkIn" placeholder="Airports, aircraft, chargers, or an action…" autocomplete="off" spellcheck="false"></div>
  <div class="cmdk-list" id="cmdkList"></div><div class="cmdk-foot"><span>↑↓ move</span><span>↵ run</span><span>esc close</span><span style="margin-left:auto">⌘K anywhere</span></div></div></div>
<div class="toast" id="toast"></div>

<script>
window.CNS_DATA = {
  planes: {{ planes|tojson }},
  chargers: {{ chargers|tojson }},
  cartoKeyQs: {{ carto_key_qs|tojson }},
  shareState: {{ (share_state if share_state is defined else none)|tojson }},
  assetVersion: {{ asset_version|tojson }}
};
</script>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="/static/state.js?v={{ asset_version }}"></script>
<script src="/static/units.js?v={{ asset_version }}"></script>
<script src="/static/settings.js?v={{ asset_version }}"></script>
<script src="/static/chargers.js?v={{ asset_version }}"></script>
<script src="/static/demand.js?v={{ asset_version }}"></script>
<script src="/static/routing.js?v={{ asset_version }}"></script>
<script src="/static/flight-model.js?v={{ asset_version }}"></script>
<script src="/static/recompute.js?v={{ asset_version }}"></script>
<script src="/static/charging.js?v={{ asset_version }}"></script>
<script src="/static/scheduler.js?v={{ asset_version }}"></script>
<script src="/static/animation.js?v={{ asset_version }}"></script>
<script src="/static/report.js?v={{ asset_version }}"></script>
<script src="/static/spreadsheet.js?v={{ asset_version }}"></script>
<script src="/static/flight-entry.js?v={{ asset_version }}"></script>
<script src="/static/share.js?v={{ asset_version }}"></script>
<script src="/static/buildshare.js?v={{ asset_version }}"></script>
<script src="/static/range-graph.js?v={{ asset_version }}"></script>
<script src="/static/runway.js?v={{ asset_version }}"></script>
<script src="/static/divert-edit.js?v={{ asset_version }}"></script>
<script src="/static/ui/app.js?v={{ asset_version }}"></script>
<script src="/static/ui/soc.js?v={{ asset_version }}"></script>
<script src="/static/ui/map.js?v={{ asset_version }}"></script>
<script src="/static/ui/plan.js?v={{ asset_version }}"></script>
<script src="/static/ui/network.js?v={{ asset_version }}"></script>
<script src="/static/ui/timeline.js?v={{ asset_version }}"></script>
<script src="/static/ui/palette.js?v={{ asset_version }}"></script>
<script>CNSUI.boot();</script>
</body>
</html>
```

## Appendix B — `static/ui/app.js`

```js
/* CNS v2 — ui/app.js: state, catalogs, airports, search, formatters, the engine adapter, boot.
   Everything renders from `S`; persistent state lives in the engines' localStorage keys. */
window.CNSUI = (function () {
  const D = window.CNS_DATA || { planes: [], chargers: [], cartoKeyQs: '', shareState: null };
  const PLANES = (D.planes || []).slice();
  const CHARGERS = (D.chargers || []).slice();
  const SEED = { origin: 'EHLE', dest: 'EDDF' };
  const S = {
    mode: 'plan', rail: 'form', planeId: null, chargerId: null,
    origin: null, dest: null, stops: [], trip: 'one-way', freq: 1, per: 'day',
    result: null, profile: null, busy: false, err: '',
    filter: '', lanes: 'airports', showDep: false,
    base: 'light', showSmall: false, showAssets: true, showNet: true,
    allChargers: false, picking: false, open: { route: true, charging: false, calc: false }, openAp: {}
  };
  let AIRPORTS = [], AP_BY_ID = {}, ASSETS = {};

  // ---- helpers ------------------------------------------------------------
  const hasDoc = typeof document !== 'undefined';
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const U = () => window.CNSUnits || null;
  const nautical = () => !!(U() && U().isNautical && U().isNautical());
  const km = v => nautical() ? v / 1.852 : v;
  const ukm = () => nautical() ? 'NM' : 'km';
  const fmt = {
    km, ukm,
    dist: v => Math.round(km(v)).toLocaleString('en') + ' ' + ukm(),
    h: min => { const m = Math.round(min); return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); },
    min: m => m >= 60 ? fmt.h(m) + ' h' : Math.round(m) + ' min',
    eur: v => v.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    kw: v => v >= 1000 ? (v / 1000).toFixed(1) + ' MW' : Math.round(v) + ' kW',
    kwh: v => v >= 1000 ? (v / 1000).toFixed(1) + ' MWh' : Math.round(v) + ' kWh'
  };
  const perDay = f => f.per === 'day' || f.freqUnit === 'day' ? +(f.freq ?? f.freqN ?? 1) : +(f.freq ?? f.freqN ?? 1) / 7;
  const planeShort = n => String(n || '').replace(/^Beta /, '').split(' — ')[0].replace(/ \(.*\)$/, '');
  const shortName = n => String(n || '').replace(/\s+(International\s+)?Airport$/i, '').replace(/\s+Airfield$/i, '');
  const plane = () => PLANES.find(p => p.id === S.planeId) || PLANES[0];
  const charger = () => CHARGERS.find(c => c.id === S.chargerId) || CHARGERS[0];
  const ll = a => [a.latitude_deg ?? a.lat, a.longitude_deg ?? a.lon];
  const chain = () => {
    const st = S.stops.filter(Boolean);
    if (S.trip === 'training') return S.origin ? [S.origin] : [];
    const c = [S.origin, ...st, S.dest].filter(Boolean);
    if (S.trip === 'circular' && S.origin && S.dest) c.push(S.origin);
    return c;
  };
  function toast(t) { if (!hasDoc) return; const e = $('#toast'); e.textContent = t; e.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => e.classList.remove('show'), 2200); }

  // ---- airport search (client-side over /api/airports) ---------------------
  const RANK = { large_airport: 0, medium_airport: 1, small_airport: 2 };
  function search(q) {
    q = (q || '').trim().toLowerCase(); if (q.length < 2) return [];
    const out = [];
    for (const a of AIRPORTS) {
      const id = a.ident.toLowerCase(), ia = (a.iata_code || '').toLowerCase(), nm = a.name.toLowerCase(), mu = (a.municipality || '').toLowerCase();
      let r; if (q === id || q === ia) r = 0; else if (nm.startsWith(q) || mu.startsWith(q)) r = 1; else if (nm.split(' ').some(w => w.startsWith(q))) r = 2; else if (nm.includes(q) || mu.includes(q) || id.startsWith(q)) r = 3; else continue;
      out.push([r, RANK[a.type] ?? 3, a]);
    }
    return out.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2].name.localeCompare(y[2].name)).slice(0, 8).map(x => x[2]);
  }

  // ---- engine adapter: names the engines read off `window` -----------------
  function rebuildIndexes() {
    window.PLANES_BY_ID = Object.fromEntries(PLANES.map(p => [p.id, p]));
    window.CHARGERS_BY_ID = Object.fromEntries(CHARGERS.map(c => [c.id, c]));
    window.airportByIdent = AP_BY_ID;       // report.js reads window.airportByIdent — dangling in the classic shell
  }
  window.escHtml = esc;
  window.folderMap = null;                  // tour.js reads it; the replay map sets it in phase 3
  window.setOrigin = ap => { S.origin = ap; CNSUI.plan && CNSUI.plan.onFormChange(true); };
  window.setDest = ap => { S.dest = ap; CNSUI.plan && CNSUI.plan.onFormChange(true); };
  window.setStop = ap => { S.stops.push(ap); CNSUI.plan && CNSUI.plan.onFormChange(true); };
  rebuildIndexes();

  function _setAirports(list) { AIRPORTS = list.filter(a => a.ident && a.latitude_deg != null); AP_BY_ID = {}; AIRPORTS.forEach(a => AP_BY_ID[a.ident] = a); rebuildIndexes(); }
  function _applyDefaults() {
    const beta = PLANES.find(p => /^beta/i.test(p.id)) || PLANES[0];
    S.planeId = beta ? beta.id : null;
    const dc = beta && beta.default_charger_id; S.chargerId = (dc && CHARGERS.find(c => c.id === dc)) ? dc : (CHARGERS[0] && CHARGERS[0].id);
    S.origin = AP_BY_ID[SEED.origin] || null; S.dest = AP_BY_ID[SEED.dest] || null;
  }

  // ---- render + boot -------------------------------------------------------
  function render() {
    if (!hasDoc) return;
    $('#rail').classList.toggle('wide', S.mode === 'network');
    if (S.mode === 'network') CNSUI.network.render(); else CNSUI.plan.render();
    CNSUI.timeline.render();
    $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
  }
  function setMode(m) {
    S.mode = m; document.body.classList.toggle('net', m === 'network');
    if (m === 'network') CNSUI.map.hideRoute(); else CNSUI.map.showRoute();
    render(); if (m === 'network') { CNSUI.map.drawNet(); CNSUI.map.fitNet(); }
  }
  async function boot() {
    if (!hasDoc) return;
    if (window.CNSChargers) { try { await CNSChargers.load(); (CNSChargers.list() || []).forEach(c => { if (!CHARGERS.find(x => x.id === c.id)) CHARGERS.push(Object.assign({ type: 'Custom', image: '' }, c)); }); } catch (e) { console.warn('[v2] custom chargers unavailable', e); } }
    const [aps, assets] = await Promise.all([fetch('/api/airports').then(r => r.json()), fetch('/api/airport-chargers').then(r => r.json()).catch(() => ({}))]);
    _setAirports(aps); ASSETS = assets || {};
    if (window.CNSScheduler) CNSScheduler.init({ chargers: window.CHARGERS_BY_ID, onChange: () => render() });
    if (window.CNSAnimation) CNSAnimation.init();
    CNSUI.map.init();
    _applyDefaults();
    render(); CNSUI.map.drawRoute(true); CNSUI.map.drawNet();
    if (window.CNSUnits && CNSUnits.onChange) CNSUnits.onChange(() => { render(); CNSUI.map.drawRoute(false); });
    if (window.CNSSettings && CNSSettings.subscribe) CNSSettings.subscribe(() => { if (S.result) CNSUI.plan.resimulate(); render(); });
    // deep links kept from the prototype: #result #multi #network (+ :ICAO isolation later)
    const [h] = location.hash.replace('#', '').split(':');
    if (h === 'multi') { S.dest = AP_BY_ID['EDDM'] || S.dest; S.stops = [AP_BY_ID['EDDF']].filter(Boolean); await CNSUI.plan.simulate(); }
    if (h === 'result') await CNSUI.plan.simulate();
    if (h === 'network') setMode('network');
    document.addEventListener('click', e => { const b = e.target.closest('#modeSeg button'); if (b) setMode(b.dataset.mode); });
  }

  return { S, PLANES, CHARGERS, SEED, D, airports: () => AIRPORTS, byId: () => AP_BY_ID, assets: () => ASSETS,
           $, $$, esc, fmt, perDay, planeShort, shortName, plane, charger, ll, chain, toast, search,
           render, setMode, boot, rebuildIndexes, _setAirports, _applyDefaults };
})();
```

## Appendix C — `static/ui/soc.js`

```js
/* CNS v2 — ui/soc.js: battery-through-the-trip series. Pure. Each leg's total is the engine's
   energyKwh; inside the leg the draw is three stages (climb / cruise / descent) that sum to it. */
(function () {
  const DESC = 0.20, PHASE = 0.60;   // display knobs: descent draw as a fraction of cruise; phase length as a fraction of min(d, d_sat)
  function phases(leg, climb, training) {
    const dk = leg.distKm, E = leg.energyKwh;
    if (!climb || !climb.applies || training || !(dk > 0)) return [{ t: 'cruise', km: dk, e: E }];
    const ph = Math.min(PHASE * Math.min(dk, climb.dSatKm), dk / 2);
    const eDesc = DESC * climb.cruisePerKm * ph, eCr = climb.cruisePerKm * Math.max(0, dk - 2 * ph), eCl = Math.max(0, E - eCr - eDesc);
    return [{ t: 'climb', km: ph, e: eCl }, { t: 'cruise', km: Math.max(0, dk - 2 * ph), e: eCr }, { t: 'descent', km: ph, e: E - eCl - eCr }].filter(s => s.km > 0);
  }
  function series(legs, charges, batteryKwh, climb, opts) {
    opts = opts || {}; const B = batteryKwh || 1; const total = legs.reduce((s, l) => s + l.distKm, 0) || 1;
    const segs = [], zones = [], pts = [];
    let x = 0, soc = (legs[0] && legs[0].socStartFrac != null ? legs[0].socStartFrac : 1) * 100;
    pts.push({ x: 0, soc, id: legs[0] && legs[0].fromIdent || '' });
    legs.forEach((l, i) => {
      let x0 = x, s0 = soc;
      phases(l, climb, opts.training).forEach(p => { const x1 = x0 + p.km / total * 100, s1 = s0 - p.e / B * 100; segs.push({ t: 'fly', x0, y0: s0, x1, y1: s1 }); if (p.t !== 'cruise') zones.push({ t: p.t, x0, x1 }); x0 = x1; s0 = s1; });
      soc -= l.energyKwh / B * 100; x += l.distKm / total * 100;
      pts.push({ x, soc, id: l.toIdent || '' });
      const q = charges.find(c => c.atIndex === i + 1);
      if (q && q.energyKwh > 0.05) { const s2 = q.departSocFrac != null ? q.departSocFrac * 100 : Math.min(100, soc + q.energyKwh / B * 100); segs.push({ t: 'chg', x0: x, y0: soc, x1: x, y1: s2, id: q.ident, min: q.chargeMin }); soc = s2; }
    });
    return { segs, zones, pts, low: pts.reduce((m, p) => Math.min(m, p.soc), 100) };
  }
  window.CNSUI = window.CNSUI || {}; window.CNSUI.soc = { series, phases };
})();
```

## Appendix D — `static/ui/map.js`

```js
/* CNS v2 — ui/map.js: Leaflet map + furniture in the Instrument language. */
(function () {
  const UI = window.CNSUI, S = UI.S;
  let map, BASES, dotsBig, dotsSmall, assetLayer, routeLayer, netLayer;
  const DOT = { large_airport: { r: 3.6, o: .55 }, medium_airport: { r: 2.6, o: .5 }, small_airport: { r: 1.8, o: .35 } };
  function popupHtml(a) {
    const rw = a.rwy_paved_m || a.rwy_grass_m || a.rwy_unknown_m;
    return `<div class="pp"><div class="t"><span>${UI.esc(a.name)}</span><span class="ic2">${UI.esc(a.ident)}${a.iata_code ? ' · ' + UI.esc(a.iata_code) : ''}</span></div>
      <div class="m">${UI.esc(a.municipality || '')}${a.municipality ? ' · ' : ''}${UI.esc((a.type || '').replace('_', ' '))}${rw ? ' · runway ' + Math.round(rw) + ' m' : ' · no runway data'}</div>
      <div class="acts"><button onclick="setOrigin(airportByIdent['${UI.esc(a.ident)}'])">Departure</button><button onclick="setDest(airportByIdent['${UI.esc(a.ident)}'])">Destination</button><button onclick="setStop(airportByIdent['${UI.esc(a.ident)}'])">Stop</button></div></div>`;
  }
  function init() {
    map = L.map('map', { zoomControl: false, preferCanvas: true, zoomSnap: .25 }).setView([51.6, 6.5], 6.25);
    const key = (UI.D && UI.D.cartoKeyQs) || '';
    BASES = {
      light: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, attribution: 'Esri, HERE, Garmin, © OSM' }),
      street: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png' + key, { maxZoom: 19, attribution: '© OSM © CARTO' }),
      sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: 'Esri, Maxar, Earthstar' })
    };
    BASES[S.base] ? BASES[S.base].addTo(map) : BASES.light.addTo(map);
    map.createPane('dots').style.zIndex = 350; map.createPane('net').style.zIndex = 380; map.createPane('rt').style.zIndex = 400; map.createPane('pins').style.zIndex = 450;
    dotsBig = L.layerGroup().addTo(map); dotsSmall = L.layerGroup(); assetLayer = L.layerGroup().addTo(map); routeLayer = L.layerGroup().addTo(map); netLayer = L.layerGroup().addTo(map);
    map.on('zoomend', () => { const want = S.showSmall || map.getZoom() >= 7.5; if (want && !map.hasLayer(dotsSmall)) dotsSmall.addTo(map); if (!want && map.hasLayer(dotsSmall)) map.removeLayer(dotsSmall); });
    drawAirports(); drawAssets();
  }
  function drawAirports() {
    dotsBig.clearLayers(); dotsSmall.clearLayers();
    UI.airports().forEach(a => { const d = DOT[a.type] || DOT.small_airport;
      const m = L.circleMarker(UI.ll(a), { pane: 'dots', radius: d.r, weight: 0, fillColor: '#4a4d6e', fillOpacity: d.o });
      m.bindPopup(() => popupHtml(a), { offset: [0, -2] });
      (a.type === 'small_airport' ? dotsSmall : dotsBig).addLayer(m); });
  }
  function drawAssets() {
    assetLayer.clearLayers(); if (!S.showAssets) return;
    Object.values(UI.assets()).forEach(x => { const a = UI.byId()[x.icao]; if (!a) return;
      const m = L.marker(UI.ll(a), { pane: 'pins', icon: L.divIcon({ className: '', html: '<div class="asset"></div>', iconSize: [10, 10], iconAnchor: [5, 5] }) });
      m.bindPopup(`<div class="pp"><div class="t"><span>${UI.esc(x.name)}</span><span class="ic2">${UI.esc(x.icao)}</span></div><div class="m">${UI.esc(x.network || 'NRG2FLY')} charging</div>
        <div class="plugs">${(x.plugs || []).map(p => `<div><span>${UI.esc(p.label)} · ${UI.esc(p.connector)}</span><b class="num">${p.power_kw} kW</b></div>`).join('')}</div></div>`);
      assetLayer.addLayer(m); });
  }
  function hav(a, b) { const R = 6371, dL = (b[0] - a[0]) * Math.PI / 180, dN = (b[1] - a[1]) * Math.PI / 180, x = Math.sin(dL / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dN / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
  function drawRoute(fit) {
    routeLayer.clearLayers(); const c = UI.chain();
    if (S.trip === 'training' && S.origin) { const p = UI.plane(); const r = ((p.training_range_km || 60) / 2) * 1000; routeLayer.addLayer(L.circle(UI.ll(S.origin), { pane: 'rt', radius: r, color: '#d84c26', weight: 2, fillColor: '#d84c26', fillOpacity: .06, dashArray: '4 6' })); if (fit) map.fitBounds(L.latLng(UI.ll(S.origin)).toBounds(r * 2.6), { paddingTopLeft: [360, 60], animate: false }); return; }
    if (c.length < 2) return;
    const pts = c.map(UI.ll);
    routeLayer.addLayer(L.polyline(pts, { pane: 'rt', color: '#fff', weight: 5, opacity: .95, lineCap: 'round', lineJoin: 'round' }));
    routeLayer.addLayer(L.polyline(pts, { pane: 'rt', color: '#d84c26', weight: 2, opacity: 1, lineCap: 'round', lineJoin: 'round' }));
    if (S.trip === 'retour') routeLayer.addLayer(L.polyline(pts, { pane: 'rt', color: '#fff', weight: 2, opacity: .9, dashArray: '6 8', lineCap: 'butt' }));
    c.forEach((a, i) => { const stop = i > 0 && i < c.length - 1; routeLayer.addLayer(L.marker(UI.ll(a), { pane: 'pins', interactive: false, icon: L.divIcon({ className: '', html: `<div class="ep${stop ? ' stop' : ''}"></div>`, iconSize: [11, 11], iconAnchor: [5.5, 5.5] }) })); });
    const legs = UI.plan && UI.plan.legsForMap ? UI.plan.legsForMap() : null;
    for (let i = 0; i < pts.length - 1; i++) { const mid = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]; let txt = UI.fmt.dist(hav(pts[i], pts[i + 1]));
      if (legs && legs[i]) txt = `${UI.fmt.dist(legs[i].distKm)} · ${UI.fmt.h(legs[i].flightMin)} h · ${Math.round(legs[i].energyKwh)} kWh`;
      routeLayer.addLayer(L.marker(mid, { pane: 'pins', interactive: false, icon: L.divIcon({ className: '', html: `<div class="leglbl num">${txt}</div>`, iconSize: [0, 0] }) })); }
    if (fit) map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [360, 60], paddingBottomRight: [40, 80], maxZoom: 9, animate: false });
  }
  function drawNet() {
    netLayer.clearLayers(); if (!S.showNet || !window.CNSDemand) return;
    CNSDemand.loadFolder().forEach(t => { const pts = [[t.originLat, t.originLon], ...(t.stops || []).map(s => [s.lat, s.lon]), [t.destLat, t.destLon]].filter(p => p[0] != null && p[1] != null);
      if (t.tripType === 'retour' || t.tripType === 'circular') pts.push([t.originLat, t.originLon]);
      if (pts.length < 2) return; const idents = [t.originIdent, ...(t.stops || []).map(s => s.ident), t.destIdent];
      const hit = !S.filter || idents.includes(S.filter);
      netLayer.addLayer(L.polyline(pts, { pane: 'net', color: '#32326E', weight: hit && S.filter ? 2 : 1.5, opacity: S.filter ? (hit ? .8 : .12) : .45 })); });
  }
  function fitNet() { const pts = []; netLayer.eachLayer(l => { if (l.getLatLngs) pts.push(...l.getLatLngs()); }); if (pts.length) map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [560, 60], paddingBottomRight: [40, 80], maxZoom: 8, animate: false }); }
  function setBase(n) { Object.values(BASES).forEach(b => map.removeLayer(b)); (BASES[n] || BASES.light).addTo(map); S.base = n; }
  function flyTo(a) { map.flyTo(UI.ll(a), Math.max(map.getZoom(), 8)); setTimeout(() => L.popup({ offset: [0, -2] }).setLatLng(UI.ll(a)).setContent(popupHtml(a)).openOn(map), 400); }
  UI.map = { init, drawAirports, drawAssets, drawRoute, drawNet, fitNet, setBase, flyTo, showSmall: v => { S.showSmall = v; map.fire('zoomend'); },
             hideRoute: () => map.hasLayer(routeLayer) && map.removeLayer(routeLayer), showRoute: () => !map.hasLayer(routeLayer) && routeLayer.addTo(map), get map() { return map; } };
})();
```

## Appendix E — `static/ui/plan.js`

```js
/* CNS v2 — ui/plan.js: the Plan rail (form → simulate → result). Numbers come from CNSFlight. */
(function () {
  const UI = window.CNSUI, S = UI.S, $ = UI.$, $$ = UI.$$, esc = UI.esc, fmt = UI.fmt;
  const tripLabel = { 'one-way': 'One-way', retour: 'Return', circular: 'Circular', training: 'Training' };
  const tripHint = { 'one-way': 'A to B · charge to full at the destination', retour: 'A to B and back · charge at both ends', circular: 'A → stops → A · needs at least one stop', training: 'Circuits at the departure airport' };
  const hav = (a, b) => { const R = 6371, dL = (b[0] - a[0]) * Math.PI / 180, dN = (b[1] - a[1]) * Math.PI / 180, x = Math.sin(dL / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dN / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
  const usableKm = p => { const f = (window.CNSSettings && CNSSettings.usableFraction) ? CNSSettings.usableFraction(p) : 0.7; return (window.CNSFlight && CNSFlight.maxFlownLegKm) ? Math.round(CNSFlight.maxFlownLegKm(p)) : Math.round(p.range_km * f); };
  const directKm = () => { const c = UI.chain(); let d = 0; for (let i = 0; i < c.length - 1; i++) d += hav(UI.ll(c[i]), UI.ll(c[i + 1])); return d; };
  const longestLeg = () => { const c = UI.chain(); let m = 0; for (let i = 0; i < c.length - 1; i++) m = Math.max(m, hav(UI.ll(c[i]), UI.ll(c[i + 1]))); return m; };
  const kwLabel = c => c.power_kw >= 1000 ? (c.power_kw / 1000) + ' MW' : c.power_kw + ' kW';
  const cName = c => c.name.replace(/\s*\d+(\.\d+)?\s*(k|M)W$/, '');

  function acHtml(list) { return list.map(a => `<button data-id="${esc(a.ident)}"><span class="id">${esc(a.ident)}</span><span class="nm">${esc(a.name)}<small>${esc(a.municipality || '')}</small></span><span class="ty">${esc((a.type || '').split('_')[0])}</span></button>`).join(''); }
  function bindAc(input, box, onPick) {
    input.addEventListener('input', () => { const l = UI.search(input.value); box.innerHTML = acHtml(l); box.classList.toggle('open', l.length > 0); });
    input.addEventListener('focus', () => { if (box.innerHTML) box.classList.add('open'); });
    input.addEventListener('keydown', e => { if (e.key === 'Escape') box.classList.remove('open'); if (e.key === 'Enter') { const b = $('button', box); if (b) { b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); e.preventDefault(); } } });
    box.addEventListener('mousedown', e => { const b = e.target.closest('button'); if (!b) return; e.preventDefault(); onPick(UI.byId()[b.dataset.id]); box.classList.remove('open'); });
    document.addEventListener('mousedown', e => { if (!box.contains(e.target) && e.target !== input) box.classList.remove('open'); });
  }

  function renderForm() {
    const p = UI.plane(), ch = UI.charger(); const c = UI.chain(); const d = directKm(); const reach = usableKm(p); const fits = longestLeg() <= reach;
    const stopsHtml = S.stops.map((s, i) => `<div class="fld wp" data-stop="${i}"><input placeholder="Add a charging stop…" value="${esc(s ? s.name : '')}" data-ac="stop${i}"><button class="x" data-act="rmStop" data-i="${i}" title="Remove stop"><svg class="ic"><use href="#i-x"/></svg></button><span class="icao">${esc(s ? s.ident : '')}</span><div class="ac" id="ac-stop${i}"></div></div>`).join('');
    const chList = S.allChargers ? UI.CHARGERS.slice().sort((a, b) => b.power_kw - a.power_kw) : [ch, ...UI.CHARGERS.filter(x => x.id !== ch.id).sort((a, b) => Math.abs(a.power_kw - ch.power_kw) - Math.abs(b.power_kw - ch.power_kw)).slice(0, 2)].sort((a, b) => b.power_kw - a.power_kw);
    const pickHtml = S.picking ? `<div class="pick">${UI.PLANES.map(x => `<button data-act="plane" data-id="${x.id}" class="${x.id === S.planeId ? 'on' : ''}"><img src="/pics/${esc(x.image || '')}" onerror="this.onerror=null;this.src='/pics/plane_svgs/${esc(x.svg || 'beta.svg')}'" alt=""><span><span class="n">${esc(x.name)}</span><br><span class="m">${esc(x.oem || '')} · ${x.seats} seats · ${x.battery_kwh ? x.battery_kwh + ' kWh' : 'no battery'} · ${esc(x.status || '')}</span></span><span class="r num">${x.range_km} km<small>${esc(x.regime || '')}${x.max_charge_kw ? ' · ' + x.max_charge_kw + ' kW max' : ''}</small></span></button>`).join('')}</div>` : '';
    $('#railBody').innerHTML = `
    <div class="ph"><h3>Create a route</h3><div class="tools"><span class="hint" style="margin:0">${esc(p.regime || '')}${p.range_incl_reserves ? ' · range incl. reserves' : ''}</span></div></div>
    <div class="sec"><div class="lbl"><span class="cap">Aircraft</span><button class="lnk" data-act="pick">${S.picking ? 'Close' : 'Change'}</button></div>${pickHtml}
      <div class="row" style="${S.picking ? 'margin-top:10px' : ''}"><img class="thumb" src="/pics/${esc(p.image || '')}" onerror="this.onerror=null;this.src='/pics/plane_svgs/${esc(p.svg || 'beta.svg')}'" alt=""><div><div class="name">${esc(p.name)}</div><div class="meta">${esc(p.oem || '')} · ${p.seats} seats · ${p.battery_kwh} kWh · ${p.range_km} km · ${esc(p.regime || '')}</div></div></div>
      <div class="bar"><i class="${fits ? '' : 'over'}" style="width:${Math.min(100, Math.round(reach / p.range_km * 100))}%"></i></div>
      <div class="meta num">Usable reach ${fmt.dist(reach)} of ${fmt.dist(p.range_km)} · ${p.speed_kmh} km/h</div></div>
    <div class="sec"><div class="lbl"><span class="cap">Route</span><button class="lnk" data-act="addStop">+ Add stop</button></div>
      <div class="fld"><input placeholder="Departure airport" value="${esc(S.origin ? S.origin.name : '')}" data-ac="origin"><span class="icao">${esc(S.origin ? S.origin.ident : '')}</span><div class="ac" id="ac-origin"></div></div>
      ${stopsHtml}
      ${S.trip === 'training' ? '' : `<div class="fld"><input placeholder="Destination airport" value="${esc(S.dest ? S.dest.name : '')}" data-ac="dest"><span class="icao">${esc(S.dest ? S.dest.ident : '')}</span><div class="ac" id="ac-dest"></div></div>`}
      ${c.length >= 2 ? `<div class="route"><div class="rh ${fits ? '' : 'bad'}"><span><b>${c.length > 2 ? (c.length - 1) + ' legs' : 'Direct'}</b> · <span class="num">${fmt.dist(d)}</span></span><span>${fits ? 'fits the usable reach' : 'longest leg exceeds reach'}</span></div>
        ${c.map((a, i) => `<div class="stop"><span class="n num">${String(i + 1).padStart(2, '0')}</span><span>${esc(a.name)}</span><span class="d num">${i === 0 ? esc(a.ident) : fmt.dist(hav(UI.ll(c[i - 1]), UI.ll(a)))}</span></div>`).join('')}</div>` : ''}</div>
    <div class="sec"><div class="cap" style="margin-bottom:8px">Trip type</div><div class="seg sm" data-seg="trip">${Object.keys(tripLabel).map(k => `<button data-v="${k}" class="${S.trip === k ? 'on' : ''}">${tripLabel[k]}</button>`).join('')}</div><div class="hint">${tripHint[S.trip]}</div></div>
    <div class="sec"><div class="cap" style="margin-bottom:8px">Frequency</div><div class="freq"><input type="number" min="1" max="2000" value="${S.freq}" data-act="freq" class="num"><span class="t">routes /</span><div class="seg sm" data-seg="per"><button data-v="day" class="${S.per === 'day' ? 'on' : ''}">day</button><button data-v="week" class="${S.per === 'week' ? 'on' : ''}">week</button></div></div></div>
    <div class="sec"><div class="lbl"><span class="cap">Charger</span><button class="lnk" data-act="allChargers">${S.allChargers ? 'Fewer' : 'All chargers'}</button></div>
      ${chList.map(x => `<button class="chg ${x.id === S.chargerId ? 'on' : ''}" data-act="charger" data-id="${x.id}"><img src="/pics/${esc(x.image || '')}" alt=""><span class="n">${esc(cName(x))}</span><span class="kw num">${kwLabel(x)}</span></button>`).join('')}
      ${p.max_charge_kw && ch.power_kw > p.max_charge_kw ? `<div class="hint num">Aircraft accepts max ${p.max_charge_kw} kW — the charger is capped.</div>` : ''}</div>
    ${S.err ? `<div class="sec err">${esc(S.err)}</div>` : ''}`;
    $('#railFoot').innerHTML = `<div class="btns"><button class="btn p ${S.busy ? 'busy' : ''}" data-act="simulate">${S.busy ? 'Simulating…' : 'Simulate'}</button><button class="btn i" data-act="reset" title="Reset"><svg class="ic"><use href="#i-reset"/></svg></button></div>`;
    $$('[data-ac]').forEach(inp => { const key = inp.dataset.ac; bindAc(inp, $('#ac-' + key), a => { if (key === 'origin') S.origin = a; else if (key === 'dest') S.dest = a; else S.stops[+key.slice(4)] = a; onFormChange(true); }); });
  }
  function onFormChange(fit) { S.result = null; S.profile = null; S.err = ''; S.rail = 'form'; UI.render(); UI.map.drawRoute(fit); }

  // ---- simulate: the classic payload + the engine profile ---------------------
  const toC = a => ({ ident: a.ident, name: a.name, lat: a.latitude_deg, lon: a.longitude_deg });
  function engineProfile(data) {
    const p = UI.plane(); const o = data._origin, d = data._dest; const wp = x => ({ ident: x.ident, name: x.name, lat: x.lat, lon: x.lon });
    const waypoints = data.trip_type === 'training' ? [wp(o)] : [wp(o), ...(data.stops || []).map(wp), wp(d)];
    return CNSFlight.simulateTrip(p, waypoints, { tripType: data.trip_type, getTargetSoc: () => (window.CNSDemand && CNSDemand.resolveTargetSoc ? CNSDemand.resolveTargetSoc({}) : null), getChargerKw: () => (data.charger && data.charger.power_kw) || UI.charger().power_kw || 0, trainingRangeKm: data.training_range_km });
  }
  async function simulate() {
    if (S.trip === 'training' && !S.origin) { S.err = 'Pick a departure airport.'; UI.render(); return; }
    if (S.trip !== 'training' && (!S.origin || !S.dest)) { S.err = 'Pick a departure and a destination.'; UI.render(); return; }
    if (S.trip === 'circular' && !S.stops.filter(Boolean).length) { S.err = 'A circular trip needs at least one stop.'; UI.render(); return; }
    const stops = S.stops.filter(Boolean).map(toC); const p = UI.plane(), ch = UI.charger();
    const payload = { origin: toC(S.origin), destination: S.trip === 'training' ? toC(S.origin) : toC(S.dest), plane_id: S.planeId, charger_id: S.chargerId, trip_type: S.trip };
    if (S.trip === 'training') payload.training_range_km = p.training_range_km || 0;
    if (window.CNSChargers && CNSChargers.get && CNSChargers.get(S.chargerId)) payload.charger = CNSChargers.get(S.chargerId);
    if (S.trip === 'circular') { const ring = [...stops, toC(S.dest)]; payload.destination = ring[ring.length - 1]; payload.stops = ring.slice(0, -1); }
    else if (stops.length) payload.stops = stops;
    S.busy = true; S.err = ''; UI.render();
    try { const r = await fetch('/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); const j = await r.json();
      if (!r.ok || j.error) { S.err = j.error || ('Simulate failed (' + r.status + ')'); S.result = null; S.profile = null; }
      else { j._origin = toC(S.origin); j._dest = S.trip === 'training' ? toC(S.origin) : toC(S.dest); j._chargerId = S.chargerId; j._freqN = Math.max(1, Math.min(2000, S.freq)); j._freqUnit = S.per; if (!j.charger) j.charger = { id: ch.id, name: ch.name, power_kw: ch.power_kw };
        S.result = j; S.profile = engineProfile(j); S.rail = 'result'; S.open = { route: true, charging: false, calc: false }; }
    } catch (e) { S.err = 'Simulate failed: ' + e.message; }
    S.busy = false; UI.render(); UI.map.drawRoute(true);
  }
  function resimulate() { if (S.result) { S.profile = engineProfile(S.result); UI.map.drawRoute(false); } }

  // ---- result -----------------------------------------------------------------
  function derive() {
    const pr = S.profile; if (!pr) return null; const T = pr.totals || {};
    const charged = (pr.charges || []).reduce((s, c) => s + (c.energyKwh || 0), 0);
    return { legs: pr.legs || [], charges: pr.charges || [], used: T.energyUsedKwh || 0, charged, chargeMin: T.chargeMin || 0, flyMin: T.flightMin || 0, travelMin: T.travelMin || ((T.flightMin || 0) + (T.enRouteMin || 0)), dist: T.distKm || 0, terminal: pr.terminal || {}, training: !!pr.training };
  }
  const legsForMap = () => { const d = derive(); return d ? d.legs : null; };
  function renderResult() {
    const r = S.result, d = derive(), p = UI.plane(), ch = UI.charger(); const c = UI.chain();
    const fpd = UI.perDay({ freq: S.freq, per: S.per }); const rate = (window.CNSSettings && CNSSettings.chargeRate) ? CNSSettings.chargeRate() : 0.6; const costDay = d.charged * fpd * rate;
    const climb = (window.CNSFlight && CNSFlight.climbParams) ? CNSFlight.climbParams(p) : { applies: false };
    const soc = UI.soc.series(d.legs, d.charges, p.battery_kwh || 1, climb, { training: d.training });
    const RES = Math.round((1 - ((window.CNSSettings && CNSSettings.usableFraction) ? CNSSettings.usableFraction(p) : 0.7)) * 100);
    const X = v => 6 + v * 3.88, Y = v => 6 + (100 - Math.max(0, v)) * 0.72;
    const socSvg = `<div class="soc"><div class="lbl"><span class="cap">Battery</span><span class="r">lowest <b class="${soc.low < RES ? 'low' : ''}">${Math.round(soc.low)} %</b>${(soc.pts.find(q => q.soc === soc.low) || {}).id ? ' at ' + esc(soc.pts.find(q => q.soc === soc.low).id) : ''} · reserve ${RES} %</span></div>
      <svg viewBox="0 0 400 92" preserveAspectRatio="none">${soc.zones.map(z => `<rect x="${X(z.x0).toFixed(1)}" y="4" width="${(X(z.x1) - X(z.x0)).toFixed(1)}" height="74" fill="${z.t === 'climb' ? 'rgba(216,76,38,.07)' : 'rgba(50,50,110,.05)'}"/>`).join('')}
      <line x1="6" y1="${Y(RES).toFixed(1)}" x2="394" y2="${Y(RES).toFixed(1)}" stroke="#cfcfda" stroke-dasharray="3 4"/><line x1="6" y1="${Y(0).toFixed(1)}" x2="394" y2="${Y(0).toFixed(1)}" stroke="#e2e2ea"/>
      ${soc.segs.map(s => `<path d="M${X(s.x0).toFixed(1)} ${Y(s.y0).toFixed(1)} L${X(s.x1).toFixed(1)} ${Y(s.y1).toFixed(1)}" stroke="${s.t === 'fly' ? '#32326E' : '#d84c26'}" stroke-width="${s.t === 'fly' ? 2 : 2.5}" fill="none" stroke-linecap="round"/>`).join('')}
      ${soc.pts.map((q, i) => `<circle cx="${X(q.x).toFixed(1)}" cy="${Y(q.soc).toFixed(1)}" r="3" fill="${q.soc < RES ? '#b3261e' : '#32326E'}"/><text x="${X(q.x).toFixed(1)}" y="${(Y(q.soc) + (i === 0 ? -8 : 14)).toFixed(1)}" font-size="10" font-weight="600" fill="${q.soc < RES ? '#b3261e' : '#32326E'}" text-anchor="${i === 0 ? 'start' : i === soc.pts.length - 1 ? 'end' : 'middle'}">${Math.round(q.soc)} %${q.id ? ' · ' + esc(q.id) : ''}</text>`).join('')}
      <text x="6" y="${(Y(RES) + 11).toFixed(1)}" font-size="9" fill="#6f7290">reserve ${RES} %</text></svg></div>`;
    $('#railBody').innerHTML = `
    <div class="rh2"><div><div class="ttl">${c.map(a => esc(a.ident)).join(' <span class="ar">→</span> ')}</div><div class="m">${esc(p.name)} · ${tripLabel[S.trip]} · ${S.freq} / ${S.per} · ${esc(ch.name)}</div></div><button class="lnk" data-act="edit">Edit</button></div>
    <div class="stats"><div><div class="cap">Energy</div><div class="v num">${Math.round(d.used)}<small>kWh</small></div><div class="s">${d.legs.length > 1 ? d.legs.length + ' legs' : 'per flight'}</div></div>
      <div><div class="cap">Travel</div><div class="v num">${fmt.h(d.travelMin)}<small>h</small></div><div class="s">${d.travelMin > d.flyMin + 0.5 ? 'incl. charging' : 'block time'}</div></div>
      <div><div class="cap">Charge</div><div class="v num">${Math.round(d.chargeMin)}<small>min</small></div><div class="s">${d.charges.length > 1 ? 'over ' + d.charges.length + ' stops' : 'at ' + esc(d.terminal.ident || 'destination')}</div></div></div>
    <div class="cost"><div class="v num">€${fmt.eur(costDay)}<small>/ day</small></div><div class="m num">${Math.round(d.charged * fpd)} kWh · €${rate.toFixed(2)} / kWh</div></div>
    <div class="split"><div class="b"><i class="f" style="flex:${(d.flyMin / 60).toFixed(3)}"></i><i class="c" style="flex:${(d.chargeMin / 60).toFixed(3)}"></i></div><div class="lg"><span><i></i>Fly ${fmt.h(d.flyMin)} h</span><span><i class="c"></i>Charge ${fmt.min(d.chargeMin)}</span><span style="margin-left:auto" class="num">${fmt.dist(d.dist)}</span></div></div>
    ${socSvg}
    <div class="acc ${S.open.route ? 'open' : ''}" data-acc="route"><button><span>Route <span class="sub">${d.legs.length} leg${d.legs.length > 1 ? 's' : ''} · ${c.length - 2 > 0 ? (c.length - 2) + ' stop' + (c.length - 2 > 1 ? 's' : '') : 'no stops'}</span></span><svg class="ic"><use href="#i-chev"/></svg></button>
      <div class="pane"><table class="tbl"><tr><th>Leg</th><th class="r">${fmt.ukm()}</th><th class="r">Time</th><th class="r">kWh</th></tr>
      ${d.legs.map((l, i) => `<tr><td><span class="mu num">${String(i + 1).padStart(2, '0')}</span> ${esc(UI.shortName(l.fromName))} → ${esc(UI.shortName(l.toName))}${l.overRange ? ' <span class="mu" style="color:var(--danger)">over range</span>' : ''}</td><td class="r num">${Math.round(fmt.km(l.distKm))}</td><td class="r num">${fmt.h(l.flightMin)}</td><td class="r num">${Math.round(l.energyKwh)}</td></tr>`).join('')}</table>
      ${climb.applies && !d.training ? `<div class="hint num">Includes up to ${Math.round(climb.eMaxKwh)} kWh net climb per leg, saturating at ${Math.round(climb.dSatKm)} km.</div>` : ''}</div></div>
    <div class="acc ${S.open.charging ? 'open' : ''}" data-acc="charging"><button><span>Charging <span class="sub">${esc(ch.name)} · ${Math.round(d.charged)} kWh</span></span><svg class="ic"><use href="#i-chev"/></svg></button>
      <div class="pane"><table class="tbl"><tr><th>Where</th><th class="r">Arrive</th><th class="r">To</th><th class="r">kWh</th><th class="r">Time</th></tr>
      ${d.charges.map(x => `<tr><td>${esc(x.ident || '')} ${esc(UI.shortName(x.name))} <span class="mu">${x.isTerminal ? 'terminal' : 'en route'}</span></td><td class="r num">${Math.round((x.arrivalSocFrac || 0) * 100)} %</td><td class="r num">${Math.round((x.targetSocFrac || 0) * 100)} %</td><td class="r num">${Math.round(x.energyKwh)}</td><td class="r num">${fmt.min(x.chargeMin)}</td></tr>`).join('')}</table></div></div>
    <div class="acc ${S.open.calc ? 'open' : ''}" data-acc="calc"><button><span>Calculation</span><svg class="ic"><use href="#i-chev"/></svg></button>
      <div class="pane calc num"><div><span class="mu">Battery</span> ${p.battery_kwh} kWh · usable ${Math.round(((window.CNSSettings && CNSSettings.usableFraction) ? CNSSettings.usableFraction(p) : 0.7) * 100)} %</div>
      <div><span class="mu">Energy</span> ${d.legs.map(l => Math.round(l.energyKwh)).join(' + ')} = <b>${Math.round(d.used)} kWh</b></div>
      <div><span class="mu">Charge</span> ${Math.round(d.charged)} kWh at ${esc(ch.name)} = <b>${fmt.min(d.chargeMin)}</b></div>
      <div><span class="mu">Cost</span> ${Math.round(d.charged)} kWh × ${fpd.toFixed(fpd % 1 ? 2 : 0)} / day × €${rate.toFixed(2)} = <b>€${fmt.eur(costDay)}</b></div>
      <div class="mu" style="margin-top:6px">Engine audit (raw model): ${esc(String(r.leg_energy_kwh))} kWh/leg · ${esc(String(r.charge_time_min ?? r.total_charge_time_min))} min charge</div></div></div>`;
    $('#railFoot').innerHTML = `<div class="btns"><button class="btn p" data-act="add">Add to network</button><button class="btn i" data-act="share" title="Copy a share link"><svg class="ic"><use href="#i-share"/></svg></button></div>`;
  }
  function addToNetwork() {
    const r = S.result; if (!r || !window.CNSFlightEntry || !window.CNSDemand) return;
    const entry = CNSFlightEntry.fromSim(r, { origin: S.origin, dest: S.trip === 'training' ? S.origin : S.dest, chargerId: S.chargerId, freqN: S.freq, freqUnit: S.per });
    const folder = CNSDemand.loadFolder(); folder.push(entry); CNSDemand.saveFolder(folder);
    if (window.CNSScheduler && CNSScheduler.runGlobal) CNSScheduler.runGlobal();
    UI.toast(`Added ${UI.chain().map(a => a.ident).join(' → ')} to the network`); UI.map.drawNet(); UI.render();
  }
  function resetForm() { UI._applyDefaults(); S.stops = []; S.trip = 'one-way'; S.freq = 1; S.per = 'day'; S.picking = false; S.allChargers = false; onFormChange(true); }
  function render() { if (S.rail === 'result' && S.profile) renderResult(); else renderForm(); }

  document.addEventListener('click', e => {
    if (S.mode !== 'plan') return;
    const t = e.target.closest('[data-act],[data-seg] button,[data-acc]>button'); if (!t) return;
    const seg = t.closest('[data-seg]'); if (seg) { S[seg.dataset.seg] = t.dataset.v; if (seg.dataset.seg === 'trip') onFormChange(true); else UI.render(); return; }
    const acc = t.closest('[data-acc]'); if (acc) { S.open[acc.dataset.acc] = !S.open[acc.dataset.acc]; acc.classList.toggle('open'); return; }
    switch (t.dataset.act) {
      case 'simulate': simulate(); break;
      case 'reset': resetForm(); UI.toast('Form reset'); break;
      case 'edit': S.rail = 'form'; UI.render(); break;
      case 'add': addToNetwork(); break;
      case 'share': if (window.CNSShare && CNSShare.copyLink) CNSShare.copyLink(); else UI.toast('Share link — phase 2'); break;
      case 'pick': S.picking = !S.picking; UI.render(); break;
      case 'plane': { S.planeId = t.dataset.id; S.picking = false; const dc = UI.plane().default_charger_id; if (dc && UI.CHARGERS.find(c => c.id === dc)) S.chargerId = dc; onFormChange(false); break; }
      case 'charger': S.chargerId = t.dataset.id; onFormChange(false); break;
      case 'allChargers': S.allChargers = !S.allChargers; UI.render(); break;
      case 'addStop': S.stops.push(null); UI.render(); setTimeout(() => { const i = $$('[data-ac^=stop]').pop(); i && i.focus(); }, 0); break;
      case 'rmStop': S.stops.splice(+t.dataset.i, 1); onFormChange(true); break;
    }
  });
  document.addEventListener('change', e => { const t = e.target; if (t.dataset.act === 'freq') { S.freq = Math.max(1, Math.min(2000, +t.value || 1)); if (S.result) UI.render(); } });
  document.addEventListener('input', e => { if (e.target.dataset.act === 'freq') S.freq = Math.max(1, Math.min(2000, +e.target.value || 1)); });

  UI.plan = { render, simulate, resimulate, addToNetwork, derive, legsForMap, onFormChange, resetForm };
})();
```

## Appendix F — `static/ui/network.js` and `static/ui/timeline.js`

```js
/* CNS v2 — ui/network.js: Network rail, read-only over the shared folder (phase 1). */
(function () {
  const UI = window.CNSUI, S = UI.S, $ = UI.$, esc = UI.esc, fmt = UI.fmt;
  const tripLabel = { 'one-way': 'One-way', retour: 'Return', circular: 'Circular', training: 'Training' };
  function rows() {
    if (!window.CNSDemand) return [];
    const aps = CNSDemand.computeAirports(); const cfg = CNSDemand.loadCfg ? CNSDemand.loadCfg() : {};
    return Object.values(aps).map(a => {
      const trips = []; a.contribs.forEach(c => { if (!trips.includes(c.t)) trips.push(c.t); });
      const flights = trips.reduce((s, t) => s + CNSDemand.flightsPerDay(t), 0);
      const full = !!(cfg[a.ident] && cfg[a.ident].fullCharge);
      const kwh = a.contribs.reduce((s, c) => s + (CNSDemand.energyAt(c.t, a.ident, full) || 0) * CNSDemand.flightsPerDay(c.t), 0);
      const sum = (window.CNSScheduler && CNSScheduler.summary) ? CNSScheduler.summary(a.ident) : {};
      return { ident: a.ident, name: a.name, trips, flights, kwh, peak: sum.peakKw || 0, overflow: !!sum.overflow, chargeMin: sum.chargeMin || 0 };
    }).sort((x, y) => y.kwh - x.kwh);
  }
  function render() {
    const R = rows(); const flights = R.reduce((s, a) => s + a.flights, 0) / 2; const kwh = R.reduce((s, a) => s + a.kwh, 0); const peak = R.reduce((s, a) => s + a.peak, 0);
    const folder = CNSDemand.loadFolder(); const rate = (window.CNSSettings && CNSSettings.chargeRate) ? CNSSettings.chargeRate() : 0.6;
    $('#railBody').innerHTML = `
    <div class="ph"><div><h3>Network</h3><div class="sub num">${R.length} airport${R.length === 1 ? '' : 's'} · ${folder.length} route${folder.length === 1 ? '' : 's'}</div></div><div class="tools">${folder.length ? '<button class="lnk" data-act="clear">Clear all</button>' : ''}</div></div>
    ${folder.length ? `<div class="tiles"><div><div class="cap">Airports</div><div class="v num">${R.length}</div></div><div><div class="cap">Routes</div><div class="v num">${folder.length}</div></div><div><div class="cap">Energy</div><div class="v num">${kwh >= 1000 ? (kwh / 1000).toFixed(1) : Math.round(kwh)}<small>${kwh >= 1000 ? 'MWh' : 'kWh'} / day</small></div></div><div><div class="cap">Peak</div><div class="v num">${peak >= 1000 ? (peak / 1000).toFixed(1) : Math.round(peak)}<small>${peak >= 1000 ? 'MW' : 'kW'} · sum</small></div></div></div>
    <div class="ntool"><span class="cap">Show</span><select data-act="filter"><option value="">All airports</option>${R.map(a => `<option value="${a.ident}" ${S.filter === a.ident ? 'selected' : ''}>${a.ident} · ${esc(UI.shortName(a.name))}</option>`).join('')}</select><span class="sp"></span><span class="hint num" style="margin:0">€${fmt.eur(kwh * rate)} / day</span></div>
    ${R.filter(a => !S.filter || a.ident === S.filter).map(a => `<div class="ap ${S.openAp[a.ident] ? 'open' : ''}" data-ap="${a.ident}"><button><span class="id">${a.ident}</span><span class="nm">${esc(UI.shortName(a.name))}<small>${a.trips.length} route${a.trips.length === 1 ? '' : 's'}${a.overflow ? ' · <span style="color:var(--danger)">overflow</span>' : ''}</small></span>
      <span class="st num">${a.flights % 1 ? a.flights.toFixed(1) : a.flights}<small>movements / day</small></span><span class="st num">${a.kwh ? Math.round(a.kwh) : '—'}<small>kWh / day</small></span><span class="st num">${a.peak || '—'}<small>peak kW</small></span><svg class="ic"><use href="#i-chev"/></svg></button>
      <div class="pane">${a.trips.map(t => `<div class="fl"><span class="t">${esc(t.originIdent)} → ${esc(t.destIdent)}${t.multiLeg ? ' <span class="mu">via ' + (t.stops || []).map(s => esc(s.ident)).join(', ') + '</span>' : ''}<small>${esc(UI.planeShort(t.planeName))} · ${tripLabel[t.tripType] || t.tripType}</small></span><span class="mu num">${t.freqN} / ${t.freqUnit}</span><span class="mu num">${Math.round(t.rechargeEnergy || t.totalRechargeKwh || 0)} kWh</span><button class="rm" data-act="rm" data-id="${esc(t.id)}" title="Remove"><svg class="ic"><use href="#i-x"/></svg></button></div>`).join('')}
      <div class="hint" style="padding-top:8px">Chargers, charge target and the rotation lanes land in phase 3 — edit them in the classic version for now.</div></div></div>`).join('')}`
    : `<div class="empty"><b>No routes in the network yet</b>Plan a route and add it — each flight contributes charging demand to its departure and arrival airports.</div>`}`;
    $('#railFoot').innerHTML = folder.length ? `<div class="btns"><button class="btn p" data-act="build">Share build</button><button class="btn" data-act="xlsx">XLSX</button></div>` : '';
    $('#netCount').textContent = folder.length || '';
  }
  function remove(id) { CNSDemand.saveFolder(CNSDemand.loadFolder().filter(t => t.id !== id)); if (window.CNSScheduler && CNSScheduler.runGlobal) CNSScheduler.runGlobal(); UI.map.drawNet(); UI.render(); }
  document.addEventListener('click', e => {
    if (S.mode !== 'network') return;
    const t = e.target.closest('[data-act],[data-ap]>button'); if (!t) return;
    const ap = t.closest('[data-ap]'); if (ap && !t.dataset.act) { S.openAp[ap.dataset.ap] = !S.openAp[ap.dataset.ap]; ap.classList.toggle('open'); return; }
    switch (t.dataset.act) {
      case 'rm': remove(t.dataset.id); break;
      case 'clear': if (confirm('Remove all routes from the network?')) { CNSDemand.saveFolder([]); if (window.CNSScheduler && CNSScheduler.runGlobal) CNSScheduler.runGlobal(); UI.map.drawNet(); UI.render(); } break;
      case 'build': if (window.CNSBuildShare && CNSBuildShare.copyBuildLink) CNSBuildShare.copyBuildLink({}); break;
      case 'xlsx': if (window.CNSSpreadsheet) CNSSpreadsheet.export(t); break;
    }
  });
  document.addEventListener('change', e => { if (e.target.dataset.act === 'filter') { S.filter = e.target.value; UI.render(); UI.map.drawNet(); UI.map.fitNet(); } });
  UI.network = { render, remove, rows };
})();
```

```js
/* CNS v2 — ui/timeline.js: drawer header + summary (phase 1); lanes from CNSScheduler land in phase 3. */
(function () {
  const UI = window.CNSUI, S = UI.S, $ = UI.$;
  function render() {
    const folder = window.CNSDemand ? CNSDemand.loadFolder() : [];
    const R = UI.network ? UI.network.rows() : [];
    $('#drawerSub').textContent = folder.length ? `${R.length} airports · ${folder.length} routes · peak ${UI.fmt.kw(R.reduce((s, a) => s + a.peak, 0))} (sum of airports)` : 'no flights yet';
    $('#gantt').innerHTML = folder.length ? `<div class="empty">Rotation lanes arrive in phase 3. The classic version shows them per airport in the demand calculator.</div>` : `<div class="empty">Add a route to the network to see its charging sessions on the day.</div>`;
    $('#drawer').style.setProperty('--drawer-h', '140px');
    $('#laneSeg').hidden = true; $('#depSw').hidden = true; $('.dep-lbl').hidden = true;
  }
  document.addEventListener('click', e => { if (e.target.closest('#drawerHead') && !e.target.closest('button')) $('#drawer').classList.toggle('open'); });
  UI.timeline = { render };
})();
```

## Appendix G — `static/ui/palette.js`

```js
/* CNS v2 — ui/palette.js: topbar menus, units, map options persistence, ⌘K command palette. */
(function () {
  const UI = window.CNSUI, S = UI.S, $ = UI.$, $$ = UI.$$, esc = UI.esc;
  const KEY = 'cns_map_options';
  function loadOpts() { try { const o = JSON.parse(localStorage.getItem(KEY) || '{}'); if (o.basemap === 'street' || o.basemap === 'sat' || o.basemap === 'light') S.base = o.basemap; if ('fSmall' in o) S.showSmall = !!o.fSmall; if ('nrgChargerToggle' in o) S.showAssets = !!o.nrgChargerToggle; if ('fSavedRoutes' in o) S.showNet = !!o.fSavedRoutes; } catch (e) {} }
  function saveOpts() { try { const o = JSON.parse(localStorage.getItem(KEY) || '{}'); Object.assign(o, { basemap: S.base, fSmall: S.showSmall, nrgChargerToggle: S.showAssets, fSavedRoutes: S.showNet }); localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} }
  loadOpts();
  // ---- topbar ----------------------------------------------------------------
  document.addEventListener('click', e => {
    const dd = { mapBtn: 'mapDd', expBtn: 'expDd', setBtn: 'setDd' }; const tb = e.target.closest('#mapBtn,#expBtn,#setBtn');
    $$('.dd').forEach(x => { if (!(tb && x.id === dd[tb.id]) && !x.contains(e.target)) x.classList.remove('open'); });
    if (tb) { const box = $('#' + dd[tb.id]); box.classList.toggle('open'); if (tb.id === 'setBtn' && window.CNSSettings) $('#setSummary').textContent = (CNSSettings.activeFlags ? CNSSettings.activeFlags() : []).join(' · ') || 'defaults'; return; }
    const b = e.target.closest('#mapDd [data-base]'); if (b) { UI.map.setBase(b.dataset.base); $$('#mapDd [data-base]').forEach(x => x.classList.toggle('on', x === b)); saveOpts(); return; }
    const u = e.target.closest('#unitSeg button'); if (u) { if (window.CNSUnits) CNSUnits.set(u.dataset.u === 'nm' ? 'nautical' : 'metric'); $$('#unitSeg button').forEach(x => x.classList.toggle('on', x === u)); return; }
    const x = e.target.closest('#expDd [data-exp]'); if (x) { $$('.dd').forEach(d => d.classList.remove('open')); runExport(x.dataset.exp, x); return; }
    if (e.target.closest('#kbdHint')) open('');
    if (e.target.closest('[data-cmdk=close]')) close();
  });
  document.addEventListener('change', e => { const t = e.target;
    if (t.id === 'ckSmall') { UI.map.showSmall(t.checked); saveOpts(); }
    if (t.id === 'ckAssets') { S.showAssets = t.checked; UI.map.drawAssets(); saveOpts(); }
    if (t.id === 'ckNet') { S.showNet = t.checked; UI.map.drawNet(); saveOpts(); } });
  function runExport(kind, btn) {
    if (kind === 'xlsx' && window.CNSSpreadsheet) return CNSSpreadsheet.export(btn);
    if (kind === 'share' && window.CNSShare) return CNSShare.copyLink();
    if (kind === 'build' && window.CNSBuildShare) return CNSBuildShare.copyBuildLink({});
    if (kind === 'pdf') return UI.toast('PDF report needs the airport picker — phase 4. Use the classic version for now.');
  }
  // sync the topbar controls to persisted state
  function syncControls() { $$('#mapDd [data-base]').forEach(x => x.classList.toggle('on', x.dataset.base === S.base)); $('#ckSmall').checked = S.showSmall; $('#ckAssets').checked = S.showAssets; $('#ckNet').checked = S.showNet;
    const nm = window.CNSUnits && CNSUnits.isNautical && CNSUnits.isNautical(); $$('#unitSeg button').forEach(x => x.classList.toggle('on', (x.dataset.u === 'nm') === !!nm)); }
  document.addEventListener('DOMContentLoaded', syncControls);
  // ---- header search: fly to ----------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => { const inp = $('#q'), box = $('#qAc');
    inp.addEventListener('input', () => { const l = UI.search(inp.value); box.innerHTML = l.map(a => `<button data-id="${esc(a.ident)}"><span class="id">${esc(a.ident)}</span><span class="nm">${esc(a.name)}<small>${esc(a.municipality || '')}</small></span><span class="ty">${esc((a.type || '').split('_')[0])}</span></button>`).join(''); box.classList.toggle('open', l.length > 0); });
    box.addEventListener('mousedown', e => { const b = e.target.closest('button'); if (!b) return; e.preventDefault(); inp.value = ''; box.classList.remove('open'); UI.map.flyTo(UI.byId()[b.dataset.id]); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { const b = $('button', box); if (b) b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } if (e.key === 'Escape') box.classList.remove('open'); });
    document.addEventListener('mousedown', e => { if (!box.contains(e.target) && e.target !== inp) box.classList.remove('open'); }); });
  // ---- command palette ------------------------------------------------------------
  const CMD = { items: [], hl: 0 };
  function items(q) {
    const ql = (q || '').trim().toLowerCase(); const L = []; const add = (g, label, run, k, sub) => L.push({ g, label, run, k, sub });
    if (ql.length >= 2) UI.search(ql).slice(0, 4).forEach((a, ai) => {
      add('Airports', `<b>${esc(a.ident)}</b> ${esc(a.name)}`, () => UI.map.flyTo(a), 'fly to', esc(a.municipality || ''));
      if (ai > 0) return;
      add('Airports', `Set <b>${esc(a.ident)}</b> as departure`, () => { S.origin = a; UI.setMode('plan'); UI.plan.onFormChange(true); }, 'D');
      add('Airports', `Set <b>${esc(a.ident)}</b> as destination`, () => { S.dest = a; UI.setMode('plan'); UI.plan.onFormChange(true); }, 'A');
      add('Airports', `Add <b>${esc(a.ident)}</b> as a stop`, () => { S.stops.push(a); UI.setMode('plan'); UI.plan.onFormChange(true); }, 'S'); });
    const hit = s => !ql || s.toLowerCase().includes(ql);
    UI.PLANES.filter(p => ql && hit(p.name)).slice(0, 3).forEach(p => add('Aircraft', `Aircraft: ${esc(p.name)}`, () => { S.planeId = p.id; const dc = p.default_charger_id; if (dc && UI.CHARGERS.find(c => c.id === dc)) S.chargerId = dc; UI.setMode('plan'); UI.plan.onFormChange(false); }, '', `${p.range_km} km · ${p.battery_kwh || 0} kWh`));
    UI.CHARGERS.filter(c => ql && hit(c.name)).slice(0, 3).forEach(c => add('Chargers', `Charger: ${esc(c.name)}`, () => { S.chargerId = c.id; UI.setMode('plan'); UI.plan.onFormChange(false); }));
    const A = [
      ['Simulate the current route', () => { UI.setMode('plan'); UI.plan.simulate(); }, '↵'],
      S.result ? ['Add the result to the network', () => UI.plan.addToNetwork()] : null,
      [S.mode === 'network' ? 'Switch to Plan mode' : 'Switch to Network mode', () => UI.setMode(S.mode === 'network' ? 'plan' : 'network'), 'N'],
      ['Basemap: Light', () => $('#mapDd [data-base=light]').click()], ['Basemap: Street', () => $('#mapDd [data-base=street]').click()], ['Basemap: Satellite', () => $('#mapDd [data-base=sat]').click()],
      ['Units: kilometres', () => $('#unitSeg [data-u=km]').click()], ['Units: nautical miles', () => $('#unitSeg [data-u=nm]').click()],
      ['Export demand workbook (XLSX)', () => runExport('xlsx', $('#expBtn')), '⇧X'], ['Share this route', () => runExport('share'), '⇧L'], ['Share the network build', () => runExport('build')],
      ['Reset the route form', () => { UI.setMode('plan'); UI.plan.resetForm(); }],
      ['Open the classic version', () => { location.href = '/?desktop=1'; }],
    ].filter(Boolean).filter(([l]) => hit(l));
    A.slice(0, ql ? 8 : 10).forEach(([l, run, k]) => add('Actions', esc(l), run, k || ''));
    return L.slice(0, 14);
  }
  function renderList() { const list = $('#cmdkList'); if (!CMD.items.length) { list.innerHTML = '<div class="none">Nothing matches. Try an ICAO code, a city, an aircraft or an action.</div>'; return; }
    let g = ''; list.innerHTML = CMD.items.map((it, i) => { const h = it.g !== g ? `<div class="grp">${it.g}</div>` : ''; g = it.g; return `${h}<div class="it ${i === CMD.hl ? 'on' : ''}" data-i="${i}"><span>${it.label}${it.sub ? ` <span class="sub">${it.sub}</span>` : ''}</span>${it.k ? `<span class="k">${it.k}</span>` : ''}</div>`; }).join('');
    const on = list.querySelector('.it.on'); if (on) on.scrollIntoView({ block: 'nearest' }); }
  function open(q) { $('#cmdk').hidden = false; const inp = $('#cmdkIn'); inp.value = q || ''; CMD.items = items(inp.value); CMD.hl = 0; renderList(); inp.focus(); }
  function close() { $('#cmdk').hidden = true; }
  function run(i) { const it = CMD.items[i]; if (!it) return; close(); it.run(); }
  document.addEventListener('DOMContentLoaded', () => {
    $('#cmdkIn').addEventListener('input', e => { CMD.items = items(e.target.value); CMD.hl = 0; renderList(); });
    $('#cmdkIn').addEventListener('keydown', e => { if (e.key === 'ArrowDown') { CMD.hl = Math.min(CMD.items.length - 1, CMD.hl + 1); renderList(); e.preventDefault(); } else if (e.key === 'ArrowUp') { CMD.hl = Math.max(0, CMD.hl - 1); renderList(); e.preventDefault(); } else if (e.key === 'Enter') { run(CMD.hl); e.preventDefault(); } else if (e.key === 'Escape') close(); });
    $('#cmdkList').addEventListener('click', e => { const it = e.target.closest('.it'); if (it) run(+it.dataset.i); });
    $('#cmdkList').addEventListener('mousemove', e => { const it = e.target.closest('.it'); if (it && +it.dataset.i !== CMD.hl) { CMD.hl = +it.dataset.i; renderList(); } }); });
  document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#cmdk').hidden ? open('') : close(); } else if (e.key === 'Escape' && !$('#cmdk').hidden) close(); });
  UI.palette = { open, close, items };
})();
```
