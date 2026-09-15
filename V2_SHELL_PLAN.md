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

- [ ] **Step 4: Create the template** — `templates/desktop.html`, verbatim.

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
- Create: `static/ui/app.js`
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

- [ ] **Step 3: Create `static/ui/app.js`**, verbatim.

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
- Create: `static/ui/soc.js`
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
- [ ] **Step 3: Create `static/ui/soc.js`**.
- [ ] **Step 4: Run to verify it passes** — 4 passed.
- [ ] **Step 5: Commit**

```bash
git add static/ui/soc.js tests/js_ui_soc.test.mjs
git commit -m "feat(v2): ui/soc.js — three-stage battery series, leg totals pinned to the engine"
```

---

### Task 5: `static/ui/map.js` — map, dots, route, popups

**Files:**
- Create: `static/ui/map.js`

**Interfaces:**
- Consumes: `CNSUI.S`, `CNSUI.airports()`, `CNSUI.assets()`, `CNSUI.chain()`, `CNS_DATA.cartoKeyQs`, `CNSUI.plan.legsForMap()` (task 6).
- Produces: `CNSUI.map = { init(), drawAirports(), drawAssets(), drawRoute(fit), drawNet(), fitNet(), setBase(name), showSmall(bool), flyTo(ap), map }`.

- [ ] **Step 1: Create the file.**
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
- Create: `static/ui/plan.js`

**Interfaces:**
- Consumes: `CNSUI.*`, `CNSFlight.simulateTrip/climbParams`, `CNSDemand.resolveTargetSoc/loadFolder/saveFolder`, `CNSFlightEntry.fromSim`, `CNSSettings.chargeRate/usableFraction`, `CNSChargers.get`, `CNSUI.soc.series`, `CNSUI.map`.
- Produces: `CNSUI.plan = { render(), simulate(), addToNetwork(), derive(), legsForMap(), onFormChange(fit) }`; `S.result` decorated exactly like the classic shell (`_origin,_dest,_chargerId,_freqN,_freqUnit`), `S.profile` = FlightProfile.

- [ ] **Step 1: Create the file.**
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
- Create: `static/ui/network.js`, `static/ui/timeline.js`

**Interfaces:**
- Consumes: `CNSDemand.computeAirports/loadFolder/saveFolder/flightsPerDay/energyAt/resolveTargetSoc/loadCfg`, `CNSScheduler.summary(ident)` (after `CNSScheduler.init` in boot), `CNSSettings.chargeRate()`.
- Produces: `CNSUI.network = { render(), remove(id) }`, `CNSUI.timeline = { render() }`.

- [ ] **Step 1: Create both files.**
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
- Create: `static/ui/palette.js`

**Interfaces:**
- Consumes: `CNSUI.*`, `CNSUI.map`, `CNSUI.plan`, `CNSUnits.set/get`, `CNSSpreadsheet.export`, `CNSShare.copyLink`, `CNSBuildShare.copyBuildLink`.
- Produces: `CNSUI.palette = { open(q), close() }`; menus wired; `cns_map_options` persistence (same keys as the classic shell for `basemap`, `fSmall`, `nrgChargerToggle`, `fSavedRoutes`).

- [ ] **Step 1: Create the file.**
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

### Task 10 (added 2026-09-03, Edgar's review): aircraft section · option 3 + NRG2FLY teardrops

**Files:** `static/ui/app.js` (`CNSUI.aircraft`: groups by `aircraft_id`, profile rows, `dims/visible/groupOf/pick`), `static/ui/plan.js` (`aircraftHtml`: stage with prev/next, status + VFR|IFR band, profile/propulsion knobs, 3×2 spec grid, reach bar, per-flight range override, filter popover), `static/ui/map.js` (teardrop pins with the inverted NRG2fly icon, `construction` variant), `static/desktop.css` (`.acsec .ac-stage .ac-band .ac-grid .ac-pop .fbtn .dot.s-* .nrg-pin`), `tests/js_ui_aircraft.test.mjs`.

**Verified:** 11/11 JS tests; in the browser: arrows cycle airframes with the counter, regime knob disables absent regimes, status filter narrows and re-selects the first visible airframe, popover closes on outside click, override toggles and shows in the reach line, 8 teardrop pins on the map. Design reference: `static/proto/aircraft-options.html` option 03. Gotcha: the section class must not be `.ac` — the autocomplete dropdown owns that selector (`display:none`).

---

### Phases 2–4 (executed 2026-09-03, "implement fully + deploy")

- **Phase 2** — `ui/planner.js` (validateRoute / recomputeRoute / planChain + circular closing / noRouteRemedy / divert overrides / range gates), route block with stops + remedies + Prefer bias, simulate payload from the planned chain, Map menu with the classic ids (airfield sizes, NRG toggle, saved routes, alternates, reach graph, leg labels) persisted in `cns_map_options`, `CNSDivertEdit` + `CNSRangeGraph` wired, popup runway verdict + photo, `ui/share.js` (route links via `CNSShare.createShortLink` → `/v2/s/<slug>`, build links via `CNSBuildShare`, restore at boot), custom-charger dialog on `CNSChargers`, one modal surface (`CNSUI.modal`).
- **Phase 3** — `ui/network.js`: ledger with the classic card math, per-airport charger slots (`cfg.chargers`), charge target (`targetDepartureSoc`), revenue day/year, monthly/yearly energy, charging minutes, overflow alert, flights with role tags / pin / feasibility, inline frequency, edit-flight dialog (re-simulates on plane or trip-type change, `rebuildEditedTrip`), replay dialog on `CNSAnimation`, isolation, scenarios, `CNSRecompute` on settings changes. `ui/timeline.js`: airport lanes from `CNSScheduler.rotationsAt` (charging here / elsewhere, waits, queued elsewhere), fleet lanes from `runGlobal().lanes`, load profile, drag-to-reschedule writing `cns_schedule`.
- **Phase 4** — `ui/settings.js` (Model settings over `CNSSettings`, active-flags badge), `ui/report.js` (airport picker → `CNSReport.generate`), `ui/tour.js` (welcome dialog, 20-step Driver.js tour with `CNSUI.tour.check()`), Tour button, review deep links `#settings #welcome #tour`.
- Verified in the browser through `CNSUI.S` and the DOM after each phase; numbers checked against the classic card and scheduler (`CNSScheduler.summary`). Not ported by design: the news ticker; airport clustering (canvas dots instead).
