# Alternate-Airport Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the route planner require that every charging stop (and the destination) arrives with enough charge to divert to its nearest airport, and add a map overlay that draws each routed airport's alternate.

**Architecture:** Each airport's nearest other airport is pre-baked into `european_airports.csv` as two columns — `alternate_km` (great-circle distance) and `alternate_ident` (which airport) — by an offline numpy job. Both ride the existing `/api/airports` payload. `CNSRouting.planRoute` consumes `alternate_km` as a per-arrival-node deduction folded into the existing `maxLeg` edge test (gated by a new off-by-default `alternateReserve` setting, so behaviour is byte-identical until a user opts in). The desktop map resolves `alternate_ident` through `airportByIdent` to draw a purple dashed connector + distance label per routed airport, toggled from the map-options menu. The divert reserve is **not** padded by routing overhead (`alternate_km / route`) because a short divert is flown near-direct.

**Tech Stack:** Python 3 / numpy (offline data prep + Flask backend, stdlib `unittest`), browser-global ES5 JS (`static/*.js`, tested with Node `vm` harnesses), Leaflet + Jinja/Bootstrap template (`templates/index.html`).

---

## Background the implementer needs

- **`european_airports.csv` is a frozen, derived artifact.** It is produced by `prepare_data.py` filtering a raw `airports.csv` (Europe + the three `*_airport` types). That raw file is **not in the repo**, so you cannot re-run `prepare_data.py`. Instead, a new self-contained script (`airport_alternates.py`) augments the committed CSV in place. Every row in the CSV is already a landable airport, so there is no type filtering to do for alternates.
- **The planner is pure logic.** `static/routing.js` has no DOM/localStorage; it reads model factors through `window.CNSSettings` (`usableFraction`, `routingFactor`) and is unit-tested by loading it into a Node `vm` context with a shimmed `CNSSettings` (see `tests/js_settings.test.mjs` for the established pattern).
- **`maxLeg` is the single chokepoint.** In `routing.js`, `maxLeg = range × usable / route` is the max great-circle leg flyable on one charge. The edge test `if (d > maxLeg) return;` is the only place legs are accepted. The alternate reserve subtracts from `maxLeg` there and in the direct-flight short-circuit.
- **Physics (settled in design):** feasibility into arrival node *X* is `legDist + alternate_km(X) / route ≤ maxLeg`, i.e. `route·legDist + alternate_km(X) ≤ range·usable` — the main leg keeps cruise padding, the divert does not, and the divert energy stacks on top of the landing-reserve floor already baked into `usable`.
- **The map resolves alternates client-side.** `templates/index.html` holds `allAirports` (line ~1870) and `airportByIdent` (line ~1872, an `{ident: airportRecord}` map). After the API change every record carries `alternate_km` + `alternate_ident`, so the overlay looks up the alternate's coordinates with `airportByIdent[record.alternate_ident]`. Route layers live in `routeLayers[]` / `routeEndpointMarkers[]` (lines 1853-4) and are cleared+redrawn on every route change. Map-option toggles live in `#optionsMenu` (line ~1255). Colours already in use: blue `#0d6efd`, green `#198754`, orange `#ff7800`, red `#dc2626` — the alternate colour is **purple `#7c3aed`**. There is an existing `fmtDist()` helper for distance labels.
- **Toolchain paths.** Tests run from the repo root. The Python venv lives in the **main checkout**: from this worktree substitute `../../../venv/bin/python` for `./venv/bin/python`. Node is v25 (`node tests/<file>.mjs`). `scipy` is **not** installed — use numpy only.
- **Commit style.** Match the repo's plain imperative one-line subjects (e.g. "Lift map tooltip pane above network teardrops"), not `feat:` prefixes. End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Lane.** All touched files are in the desktop/backend lane. Do not stage mobile files (`static/mobile.*`, `templates/index_mobile.html`) even though `static/mobile.js` also calls `planRoute` — it inherits the shared planner change for free; mobile UI is out of scope.

## File Structure

| File | Create/Modify | Responsibility |
|------|---------------|----------------|
| `airport_alternates.py` | Create | Pure numpy nearest-neighbour (`nearest_alternate` → km + index, `nearest_alternate_km` wrapper) + in-place CSV augmenter (`augment_csv`) + `__main__` runner. |
| `european_airports.csv` | Modify (regenerate) | Gains `alternate_km` + `alternate_ident` columns (data artifact). |
| `prepare_data.py` | Modify | Add both columns on a future full regen, so the generator stays correct. |
| `sim.py` | Modify (`get_all_airports`) | Include `alternate_km` + `alternate_ident` in the `/api/airports` column whitelist. |
| `static/settings.js` | Modify | New off-by-default `alternateReserve` factor + `alternateReserveEnabled()` accessor + `activeFlags` entry. |
| `static/routing.js` | Modify | Per-arrival-node divert reserve folded into the `maxLeg` edge test + direct short-circuit. |
| `templates/index.html` | Modify | (a) `rsAlternate` toggle in the Model-settings modal; (b) `fAlternates` toggle in map options + purple dashed alternate overlay. |
| `tests/test_alternates.py` | Create | Unit tests for `nearest_alternate`/`nearest_alternate_km` + API passthrough of both columns. |
| `tests/js_routing.test.mjs` | Create | Node harness for the alternate-aware planner. |
| `tests/run_all.sh` | Modify | Add `tests/js_routing.test.mjs` to the Node loop. |

---

### Task 1: Nearest-alternate computation

**Files:**
- Create: `airport_alternates.py`
- Test: `tests/test_alternates.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_alternates.py`:

```python
"""Tests for the pre-baked nearest-alternate columns (airport_alternates.py)
and their passthrough into the /api/airports payload."""
import unittest

from _helpers import REPO_ROOT  # noqa: F401  (ensures repo root is importable)
from airport_alternates import nearest_alternate, nearest_alternate_km


class TestNearestAlternate(unittest.TestCase):
    def test_two_near_one_far(self):
        # Points 0 and 1 are ~1 deg of longitude apart on the equator
        # (~111.19 km); point 2 is on the far side of Europe.
        lats = [0.0, 0.0, 50.0]
        lons = [0.0, 1.0, 50.0]
        km = nearest_alternate_km(lats, lons)
        self.assertAlmostEqual(km[0], 111.19, delta=1.0)
        self.assertAlmostEqual(km[1], 111.19, delta=1.0)
        self.assertGreater(km[2], 5000.0)  # remote -> nearest is far

    def test_returns_index_of_nearest(self):
        lats = [0.0, 0.0, 50.0]
        lons = [0.0, 1.0, 50.0]
        km, idx = nearest_alternate(lats, lons)
        self.assertEqual(int(idx[0]), 1)   # point 0's nearest is point 1
        self.assertEqual(int(idx[1]), 0)   # and vice-versa
        self.assertAlmostEqual(km[0], 111.19, delta=1.0)

    def test_excludes_self(self):
        # Two airports at the SAME coordinate: each one's nearest *other*
        # airport is the duplicate at 0 km. The point must never match itself.
        km = nearest_alternate_km([10.0, 10.0], [10.0, 10.0])
        self.assertAlmostEqual(km[0], 0.0, places=6)
        self.assertAlmostEqual(km[1], 0.0, places=6)

    def test_matches_independent_haversine(self):
        # Cross-check every point against sim.haversine (a separate impl).
        from sim import haversine
        lats = [52.0, 48.0, 51.5, 45.0]
        lons = [5.0, 8.0, 0.0, 12.0]
        km = nearest_alternate_km(lats, lons)
        for i in range(len(lats)):
            ref = min(haversine(lats[i], lons[i], lats[j], lons[j])
                      for j in range(len(lats)) if j != i)
            self.assertAlmostEqual(km[i], ref, delta=0.5)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python -m unittest tests.test_alternates -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'airport_alternates'`.

- [ ] **Step 3: Write the minimal implementation**

Create `airport_alternates.py`:

```python
"""Pre-compute each airport's nearest *other* airport and bake it into
european_airports.csv as two columns:
    alternate_km    great-circle distance (km) to that nearest airport
    alternate_ident the nearest airport's `ident`

The route planner reserves divert energy from `alternate_km`; the map overlay
draws the alternate by resolving `alternate_ident`. Dependency-light: numpy only
(no scipy). A chunked brute-force NN over ~7.8k points is a one-shot, ~1 s job.

Run as a script to augment the committed CSV in place:
    ./venv/bin/python airport_alternates.py
"""
import numpy as np
import pandas as pd

EARTH_KM = 6371.0


def nearest_alternate(lats, lons, chunk=512):
    """(km, idx): for each point, the great-circle distance (km) to its nearest
    *other* point and that other point's row index.

    lats, lons: 1-D array-likes of degrees, equal length n. Vectorised in
    row-chunks so peak memory is O(chunk * n), not O(n**2).
    """
    lat = np.radians(np.asarray(lats, dtype=float))
    lon = np.radians(np.asarray(lons, dtype=float))
    n = lat.size
    # Unit-sphere xyz. Nearest by chord distance == nearest by great-circle
    # (monotonic), so argmin on chord, then convert the min chord to gc km.
    x = np.cos(lat) * np.cos(lon)
    y = np.cos(lat) * np.sin(lon)
    z = np.sin(lat)
    pts = np.stack([x, y, z], axis=1)            # (n, 3)
    out_km = np.empty(n, dtype=float)
    out_idx = np.empty(n, dtype=np.int64)
    for s in range(0, n, chunk):
        e = min(s + chunk, n)
        # |a - b|**2 = 2 - 2 a.b on the unit sphere -> (e-s, n)
        d2 = 2.0 - 2.0 * (pts[s:e] @ pts.T)
        d2[np.arange(e - s), np.arange(s, e)] = np.inf   # exclude self
        d2 = np.maximum(d2, 0.0)                          # clamp fp negatives
        j = d2.argmin(axis=1)
        chord = np.sqrt(d2[np.arange(e - s), j])
        out_km[s:e] = EARTH_KM * 2.0 * np.arcsin(np.clip(chord / 2.0, 0.0, 1.0))
        out_idx[s:e] = j
    return out_km, out_idx


def nearest_alternate_km(lats, lons, chunk=512):
    """Great-circle km to each point's nearest *other* point (see
    nearest_alternate)."""
    return nearest_alternate(lats, lons, chunk)[0]


def augment_csv(path="european_airports.csv"):
    """Read the airport CSV, (re)compute the alternate columns, write back."""
    df = pd.read_csv(path)
    km, idx = nearest_alternate(df["latitude_deg"].to_numpy(),
                                df["longitude_deg"].to_numpy())
    df["alternate_km"] = np.round(km, 3)
    df["alternate_ident"] = df["ident"].to_numpy()[idx]
    df.to_csv(path, index=False)
    return df


if __name__ == "__main__":
    out = augment_csv()
    col = out["alternate_km"]
    print(f"Wrote alternate_km/alternate_ident for {len(out)} airports "
          f"(min {col.min():.1f} km, median {col.median():.1f} km, "
          f"max {col.max():.1f} km).")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./venv/bin/python -m unittest tests.test_alternates.TestNearestAlternate -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add airport_alternates.py tests/test_alternates.py
git commit -m "Add per-airport nearest-alternate computation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Bake the alternate columns into the airport catalog

**Files:**
- Modify: `european_airports.csv` (regenerate — appends two columns)
- Modify: `prepare_data.py:41-48` (so a future full regen includes the columns)

- [ ] **Step 1: Wire the computation into `prepare_data.py`**

In `prepare_data.py`, add the import near the top (after the existing `import pandas as pd`):

```python
from airport_alternates import nearest_alternate
```

Then, immediately before the `# Save result` block (`eu_airports.to_csv(...)` at line ~48), insert:

```python
# Pre-bake each airport's nearest neighbour so the route planner can reserve
# divert energy and the map can draw the alternate, without any runtime search.
eu_airports = eu_airports.copy()
_alt_km, _alt_idx = nearest_alternate(eu_airports["latitude_deg"].to_numpy(),
                                      eu_airports["longitude_deg"].to_numpy())
eu_airports["alternate_km"] = np.round(_alt_km, 3)
eu_airports["alternate_ident"] = eu_airports["ident"].to_numpy()[_alt_idx]
```

(`np` is already imported at the top of `prepare_data.py`.)

- [ ] **Step 2: Regenerate the committed CSV in place**

Run: `./venv/bin/python airport_alternates.py`
Expected output (numbers approximate):
`Wrote alternate_km/alternate_ident for 7796 airports (min 0.0 km, median ~6 km, max ~XXX km).`

Note: this rewrites the full 1.2 MB CSV. The diff should be two appended columns; if pandas cosmetically reformats existing float columns, that is acceptable.

- [ ] **Step 3: Verify the columns landed and are sane**

Run: `./venv/bin/python -c "import pandas as pd; d=pd.read_csv('european_airports.csv'); print('alternate_km' in d.columns, 'alternate_ident' in d.columns, bool(d['alternate_km'].notna().all()), bool(d['alternate_ident'].isin(d['ident']).all()))"`
Expected: `True True True True` (every alternate_ident is itself a real airport ident).

- [ ] **Step 4: Confirm the existing suite is still green**

Run: `./venv/bin/python -m unittest discover -s tests -p "test_*.py"`
Expected: OK (existing tests read only whitelisted columns, so the new columns are transparent).

- [ ] **Step 5: Commit**

```bash
git add prepare_data.py european_airports.csv
git commit -m "Bake nearest-alternate columns into the airport catalog

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Serve the alternate columns through `/api/airports`

**Files:**
- Modify: `sim.py:38-39` (the `get_all_airports` column whitelist)
- Test: `tests/test_alternates.py` (add an API-passthrough case)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_alternates.py` (above the `if __name__` block):

```python
class TestApiPassthrough(unittest.TestCase):
    def test_get_all_airports_includes_alternate_columns(self):
        from _helpers import make_sim
        rows = make_sim().get_all_airports()
        self.assertTrue(rows, "expected at least one airport row")
        self.assertIn("alternate_km", rows[0])
        self.assertIn("alternate_ident", rows[0])
        self.assertIsInstance(rows[0]["alternate_km"], (int, float))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python -m unittest tests.test_alternates.TestApiPassthrough -v`
Expected: FAIL — `assertIn("alternate_km", rows[0])` fails, because the whitelist omits the columns.

- [ ] **Step 3: Add the columns to the whitelist**

In `sim.py`, change `get_all_airports` (lines 38-39) from:

```python
        df = self.airports_df[['ident', 'name', 'municipality', 'iata_code', 'type',
                               'latitude_deg', 'longitude_deg', 'iso_country']]
```

to:

```python
        df = self.airports_df[['ident', 'name', 'municipality', 'iata_code', 'type',
                               'latitude_deg', 'longitude_deg', 'iso_country',
                               'alternate_km', 'alternate_ident']]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./venv/bin/python -m unittest tests.test_alternates -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add sim.py tests/test_alternates.py
git commit -m "Serve alternate columns through the airports API

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `alternateReserve` model setting

**Files:**
- Modify: `static/settings.js` (DEFAULTS, accessor, activeFlags, exports)
- Test: `tests/js_settings.test.mjs` (add cases)

- [ ] **Step 1: Write the failing test**

In `tests/js_settings.test.mjs`, add these cases before the final `console.log` summary line:

```javascript
// ---- alternateReserve ------------------------------------------------------
test('defaults: alternateReserveEnabled() false when off', () => {
  const { S } = loadSettings();
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/js_settings.test.mjs`
Expected: FAIL — `S.alternateReserveEnabled is not a function`.

- [ ] **Step 3: Implement the setting**

In `static/settings.js`:

(a) In `DEFAULTS` (after the `landingReserve` line, ~line 51) add:

```javascript
        alternateReserve:  { enabled: false },                       // divert-to-nearest-airport reserve; uses each airport's pre-baked alternate_km
```

(b) Add the accessor (place it after `routingFactor`, ~line 126):

```javascript
    /** Whether the planner must reserve charge at every stop/destination to
     *  divert to its nearest airport. Boolean toggle — the reserve magnitude is
     *  each airport's own `alternate_km` (read by the planner), so there is no
     *  slider here. Identity (false) by default so saved plans are unchanged. */
    function alternateReserveEnabled() {
        const s = loadAll().alternateReserve;
        return !!(s && s.enabled);
    }
```

(c) In `activeFlags` (the returned object, ~lines 206-214), add the flag and fold it into `anyOn`:

```javascript
            landingReserve:    !!s.landingReserve.enabled,
            chargerEfficiency: !!s.chargerEfficiency.enabled,
            chargeTaper:       !!s.chargeTaper.enabled,
            routingPadding:    !!s.routingPadding.enabled,
            chargeTarget:      !!(s.chargeTarget && s.chargeTarget.enabled),
            alternateReserve:  !!(s.alternateReserve && s.alternateReserve.enabled),
            anyOn: !!(s.landingReserve.enabled || s.chargerEfficiency.enabled ||
                      s.chargeTaper.enabled || s.routingPadding.enabled ||
                      (s.chargeTarget && s.chargeTarget.enabled) ||
                      (s.alternateReserve && s.alternateReserve.enabled)),
```

(d) In the `return { ... }` export block (~line 221-222), add `alternateReserveEnabled`:

```javascript
        usableFraction, gridDemandFactor, routingFactor, chargeTimeMin,
        effectiveChargePower, chargeTargetDefault, chargeRate, activeFlags,
        alternateReserveEnabled,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/js_settings.test.mjs`
Expected: PASS (all settings tests, including the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add static/settings.js tests/js_settings.test.mjs
git commit -m "Add off-by-default alternate-reserve model setting

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Alternate-aware edge test in the planner

**Files:**
- Modify: `static/routing.js` (reserve helper + edge test + direct short-circuit)
- Test: `tests/js_routing.test.mjs` (new Node harness)

- [ ] **Step 1: Write the failing test**

Create `tests/js_routing.test.mjs`:

```javascript
/*
 * Node harness for the browser-global CNSRouting planner (static/routing.js).
 *
 * routing.js attaches to window.CNSRouting and reads model factors through
 * window.CNSSettings. We load it in a vm context with a CNSSettings shim whose
 * usable / route / alternate-toggle we control per test, then drive planRoute
 * over a tiny synthetic geography on the equator (where 1 deg of longitude is a
 * fixed ~111.19 km, so leg distances are predictable).
 *
 * Run:  node tests/js_routing.test.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function loadRouting(flags) {
  const code = fs.readFileSync(path.join(REPO, 'static', 'routing.js'), 'utf8');
  const CNSSettings = {
    usableFraction: () => (flags.usable != null ? flags.usable : 1.0),
    routingFactor:  () => (flags.route  != null ? flags.route  : 1.0),
    alternateReserveEnabled: () => !!flags.requireAlt,
  };
  const sandbox = {
    window: { CNSSettings }, CNSSettings,
    console, JSON, Math, Object, Array, Set, Number, Infinity,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.CNSRouting;
}

// Equator airport at a given longitude; alt = its alternate_km.
const ap = (ident, lon, alt) => ({
  ident, name: ident, type: 'medium_airport',
  latitude_deg: 0, longitude_deg: lon, iata_code: '', alternate_km: alt,
});
const node = (ident, lon, alt) => ({ ident, lat: 0, lon, alternate_km: alt });
const PLANE = (range_km) => ({ range_km });

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

console.log('CNSRouting (static/routing.js) — node harness\n');

// Geography for all cases: equator airports, so 1 deg lon = ~111.19 km.
// O at lon 0; candidate stop at lon 1.5 (O->stop ~= 166.79 km); typical dest at
// lon 3.0 (O->D direct ~= 333.58 km, beyond a 200 km maxLeg -> needs a stop).

// 1. Toggle OFF: a feasible multi-stop route is produced (baseline).
test('alternate OFF: O-A-D via one stop when direct is out of range', () => {
  const R = loadRouting({ requireAlt: false });
  const O = node('O', 0.0, 0), D = node('D', 3.0, 0), A = ap('A', 1.5, 999);
  const res = R.planRoute({ origin: O, destination: D, plane: PLANE(200),
    allowedTypes: ['medium_airport'], allAirports: [O, A, D], options: {} });
  assert.equal(res.error, undefined, res.error);
  assert.equal(res.legCount, 2);
  assert.deepEqual(res.stops.map(s => s.ident), ['A']);
});

// 2. Toggle ON, all alternate_km = 0: identical route to OFF (reserve term is 0).
test('alternate ON with zero alternate_km reproduces the OFF route', () => {
  const O = node('O', 0.0, 0), D = node('D', 3.0, 0), A = ap('A', 1.5, 0);
  const call = (requireAlt) => loadRouting({ requireAlt }).planRoute({
    origin: O, destination: D, plane: PLANE(200),
    allowedTypes: ['medium_airport'], allAirports: [O, A, D], options: {} });
  const off = call(false), on = call(true);
  assert.equal(on.error, undefined, on.error);
  assert.equal(on.legCount, off.legCount);
  assert.deepEqual(on.stops.map(s => s.ident), off.stops.map(s => s.ident));
});

// 3. A poorly-covered stop is rejected when its divert reserve won't fit.
//    O->A = 166.79 km, maxLeg = 200. altA = 50 -> 166.79 + 50 = 216.79 > 200.
//    No other candidate -> no route.
test('alternate ON: stop with a far alternate is rejected (no route)', () => {
  const O = node('O', 0.0, 0), D = node('D', 3.0, 5), A = ap('A', 1.5, 50);
  const res = loadRouting({ requireAlt: true }).planRoute({
    origin: O, destination: D, plane: PLANE(200),
    allowedTypes: ['medium_airport'], allAirports: [O, A, D], options: {} });
  assert.ok(res.error, 'expected a no-route error');
  assert.equal(res.legCount, 0);
});

// 4. With a better-covered alternative stop B, ON routes through B not A.
//    A at lon 1.5 altA = 50 (rejected); B at lon 1.5 altB = 5 (accepted).
test('alternate ON: planner picks the well-covered stop B over A', () => {
  const O = node('O', 0.0, 0), D = node('D', 3.0, 5);
  const A = ap('A', 1.5, 50), B = ap('B', 1.5, 5);
  const res = loadRouting({ requireAlt: true }).planRoute({
    origin: O, destination: D, plane: PLANE(200),
    allowedTypes: ['medium_airport'], allAirports: [O, A, B, D], options: {} });
  assert.equal(res.error, undefined, res.error);
  assert.deepEqual(res.stops.map(s => s.ident), ['B']);
});

// 5. Direct-flight short-circuit deducts the DESTINATION's alternate.
//    O->D = 111.19 km, maxLeg = 130. altD = 30 -> 111.19 + 30 = 141.19 > 130,
//    so the direct hop is no longer allowed and (no stops available) it errors.
test('alternate ON: direct flight blocked when destination alternate too far', () => {
  const O = node('O', 0.0, 0), D = node('D', 1.0, 30);
  const res = loadRouting({ requireAlt: true }).planRoute({
    origin: O, destination: D, plane: PLANE(130),
    allowedTypes: ['medium_airport'], allAirports: [O, D], options: {} });
  assert.ok(res.error, 'expected the padded direct hop to be rejected');
});
test('alternate ON: direct flight allowed when destination alternate is near', () => {
  const O = node('O', 0.0, 0), D = node('D', 1.0, 10);
  const res = loadRouting({ requireAlt: true }).planRoute({
    origin: O, destination: D, plane: PLANE(130),
    allowedTypes: ['medium_airport'], allAirports: [O, D], options: {} });
  assert.equal(res.error, undefined, res.error);
  assert.equal(res.legCount, 1);
  assert.equal(res.stops.length, 0);
});

// 6. The divert reserve is NOT padded: it is alternate_km / route. Hold
//    maxLeg = 200 in both runs (range = 200*route, so maxLeg = range/route = 200).
//    O->stop = 166.79 km, altA = 35:
//      route 1.25: reserve 35/1.25 = 28.0 -> 166.79 + 28.0 = 194.79 <= 200 -> A accepted
//      route 1.0 : reserve 35/1.0  = 35.0 -> 166.79 + 35.0 = 201.79  > 200 -> A rejected (no route)
test('alternate reserve scales with 1/route (divert is unpadded)', () => {
  const mk = (route) => {
    const O = node('O', 0.0, 0), D = node('D', 3.0, 5), A = ap('A', 1.5, 35);
    return loadRouting({ requireAlt: true, route }).planRoute({
      origin: O, destination: D, plane: PLANE(200 * route),
      allowedTypes: ['medium_airport'], allAirports: [O, A, D], options: {} });
  };
  const padded = mk(1.25);   // reserve divided by 1.25 -> fits
  assert.equal(padded.error, undefined, padded.error);
  assert.deepEqual(padded.stops.map(s => s.ident), ['A']);
  const unscaled = mk(1.0);  // reserve full -> A rejected -> no route
  assert.ok(unscaled.error, 'expected A to be rejected at route=1.0');
});

// 7. A node with no ident / no alternate_km imposes no reserve (fallback).
test('alternate ON: non-airport destination (no alternate_km) imposes no reserve', () => {
  const O = node('O', 0.0, 0);
  const D = { lat: 0, lon: 1.0 };  // custom point: no ident, no alternate_km
  const res = loadRouting({ requireAlt: true }).planRoute({
    origin: O, destination: D, plane: PLANE(130),
    allowedTypes: ['medium_airport'], allAirports: [O], options: {} });
  assert.equal(res.error, undefined, res.error);
  assert.equal(res.legCount, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/js_routing.test.mjs`
Expected: FAIL — the alternate-ON cases fail because `routing.js` ignores `alternateReserveEnabled` / `alternate_km` (e.g. test 3 finds a route instead of erroring).

- [ ] **Step 3: Implement the reserve in `routing.js`**

(a) After the `route` line (line 67: `const route = (window.CNSSettings ? CNSSettings.routingFactor() : 1.0);`), insert:

```javascript
        const requireAlt = (window.CNSSettings && CNSSettings.alternateReserveEnabled)
                         ? CNSSettings.alternateReserveEnabled() : false;
        // Per-airport divert reserve. Every ARRIVAL node (each stop + the
        // destination) must arrive holding enough charge to reach its nearest
        // airport — that airport's pre-baked great-circle `alternate_km`. We
        // divide by `route` so the short divert is NOT inflated by cruise
        // airways padding (a divert is flown near-direct). Built once and only
        // when the toggle is on, so the planner is identical when off.
        const altByIdent = new Map();
        if (requireAlt) {
            for (const a of allAirports) {
                if (a && a.ident != null) altByIdent.set(a.ident, +a.alternate_km || 0);
            }
        }
        const altReserveKm = (n) => {
            if (!requireAlt || !n) return 0;
            const km = (n.ident != null && altByIdent.has(n.ident))
                     ? altByIdent.get(n.ident)
                     : (+n.alternate_km || 0);
            return km / route;
        };
```

(b) Change the direct short-circuit (line 77) from:

```javascript
        if (direct <= maxLeg) return { stops: [], totalDistanceKm: direct, legCount: 1 };
```

to:

```javascript
        if (direct <= maxLeg - altReserveKm(destination)) return { stops: [], totalDistanceKm: direct, legCount: 1 };
```

(c) Inside `astar(C)`, after the `pos` and `type` helpers (lines 99-100), add an object accessor:

```javascript
            const obj  = (i) => i === ORIG ? origin : i === DEST ? destination : C[i - 1].a;
```

(d) In the `relax` closure, change the flyability check (line 116) from:

```javascript
                    if (d > maxLeg) return;                   // not flyable on one charge
```

to:

```javascript
                    if (d + altReserveKm(obj(j)) > maxLeg) return;   // not flyable incl. divert reserve
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/js_routing.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 5: Confirm no regression in the other Node harnesses**

Run: `node tests/js_settings.test.mjs && node tests/js_charging.test.mjs && node tests/js_demand.test.mjs && node tests/js_flight_model.test.mjs`
Expected: each prints `N passed, 0 failed`.

- [ ] **Step 6: Commit**

```bash
git add static/routing.js tests/js_routing.test.mjs
git commit -m "Reserve per-airport divert range in the route planner

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Model-settings toggle UI

**Files:**
- Modify: `templates/index.html` (toggle markup ~line 1606; config map ~line 3872)

This task has no unit test (DOM wiring); it is verified in the browser at Step 4.

- [ ] **Step 1: Add the toggle markup**

In `templates/index.html`, inside the "Available range" `.rs-grid` (which currently ends at line 1606 with `</div>` after the routing-padding cell), add a third `.rs-cell` immediately before that closing `</div>` of the grid:

```html
                        <div class="rs-cell">
                            <div class="rs-cell-head">
                                <label class="rs-toggle"><input type="checkbox" id="rsAlternate"><span>Alternate reserve</span></label>
                                <span class="rs-q" tabindex="0" data-bs-toggle="tooltip" data-bs-title="Every stop and the destination must arrive holding enough charge to divert to its nearest airport. The reserve is each airport's own distance to the nearest runway — no routing padding, since a short divert is flown direct. Remote fields cost more range than well-served ones.">?</span>
                            </div>
                            <div class="rs-cell-ctrl">
                                <span class="rs-val">auto · per-airport</span>
                            </div>
                        </div>
```

- [ ] **Step 2: Register it in the settings config map**

In the Model-settings IIFE `map` object (lines 3866-3873), add an entry (after the `routingPadding` line). It is parameter-free, so `extras` is empty:

```javascript
                alternateReserve:  { check: 'rsAlternate',     extras: {} },
```

(The existing `syncFromState`, `commit`, `updateBadge` and the change-listener loop all iterate this map, so the toggle persists, re-plans via the existing settings subscriber, and counts toward the model badge with no further wiring.)

- [ ] **Step 3: Start the app**

Use the preview tooling (preview_start) for the desktop server, or:
`DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python app.py` → http://127.0.0.1:5055
(Template edits need a server restart — Flask debug is off.)

- [ ] **Step 4: Verify in the browser**

1. Open Model settings (⚙). Confirm a new **Alternate reserve** toggle appears under "Available range", off by default, badge count unchanged.
2. Plan a route long enough to need a stop (e.g. a Beta Alia hop beyond ~500 km). Note the stops.
3. Toggle **Alternate reserve** on. Confirm the route re-plans live and the badge increments by 1.
4. Confirm the route either gains/changes a stop or shows the no-route message for a deliberately marginal case; toggling off restores the original route.

Capture a screenshot of the toggle + re-planned route as proof.

- [ ] **Step 5: Commit**

```bash
git add templates/index.html
git commit -m "Surface the alternate-reserve toggle in Model settings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Map "Show alternates" overlay

**Files:**
- Modify: `templates/index.html` (CSS for the label; `#optionsMenu` toggle ~line 1255; overlay state + helpers near `routeLayers` ~line 1853; toggle listener near the `.airport-filter` listeners ~line 2773; two hooks in the route-render/clear routine ~line 2960-3090)

Purple dashed connector + marker + permanent distance label from each routed airport to its nearest alternate, toggled from map options. This is verified in the browser (Step 7).

**Read first:** open `templates/index.html` around lines **2940-3090** — the route-render routine that clears `routeLayers`/`routeEndpointMarkers` and redraws the chain `[origin, ...stops, destination]`. You will add two one-line hooks there (Step 5). The chain elements carry `.ident` for the origin, each stop, and the destination.

- [ ] **Step 1: Add the label CSS**

In the `<style>` block of `templates/index.html` (any rule near the other map styles), add:

```css
        .alt-dist-label {
            background: #fff; color: #7c3aed; border: 1px solid #7c3aed;
            border-radius: 6px; font-size: .7rem; font-weight: 700;
            padding: 1px 5px; box-shadow: var(--shadow-sm); white-space: nowrap;
        }
        .alt-dist-label::before { display: none; }   /* hide the tooltip caret */
```

- [ ] **Step 2: Add the map-options toggle**

In `#optionsMenu` (line ~1255), after the airport-filter group (the `.opt-check` labels around lines 1258-1260), add:

```html
                        <label class="opt-check"><input type="checkbox" id="fAlternates"><span>Alternates</span></label>
```

- [ ] **Step 3: Add overlay state + helper functions**

Near the route-layer state (after `let routeEndpointMarkers = [];` at line ~1854), add:

```javascript
        let alternateLayers = [];     // purple dashed connectors + alt markers/labels
        let lastRouteChain  = [];     // the chain currently on the map, for live re-toggling

        function clearAlternates() {
            alternateLayers.forEach(l => map.removeLayer(l));
            alternateLayers = [];
        }

        // For every routed airport with a known nearest alternate, draw a purple
        // dashed connector to that alternate, a marker on it, and a permanent
        // distance label. Alternate coords resolve through airportByIdent (the
        // alternate is always a loaded airport).
        function drawAlternates(chain) {
            clearAlternates();
            (chain || []).forEach(n => {
                const full = n && n.ident ? airportByIdent[n.ident] : null;
                if (!full || !full.alternate_ident) return;
                const alt = airportByIdent[full.alternate_ident];
                if (!alt) return;
                const from = [full.latitude_deg, full.longitude_deg];
                const to   = [alt.latitude_deg, alt.longitude_deg];
                const line = L.polyline([from, to], {
                    color: '#7c3aed', weight: 2.5, dashArray: '5 6', opacity: 0.9,
                });
                const dot = L.circleMarker(to, {
                    radius: 5, fillColor: '#7c3aed', color: '#fff',
                    weight: 1.5, fillOpacity: 0.9,
                });
                const km = (full.alternate_km != null)
                    ? full.alternate_km
                    : CNSRouting.haversineKm({ lat: from[0], lon: from[1] },
                                             { lat: to[0], lon: to[1] });
                dot.bindTooltip(`${alt.ident} · ${fmtDist(km)}`, {
                    permanent: true, direction: 'top', offset: [0, -4],
                    className: 'alt-dist-label',
                });
                line.addTo(map); dot.addTo(map);
                alternateLayers.push(line, dot);
            });
        }

        // Re-evaluate the overlay for the current route (after a redraw, or when
        // the toggle flips).
        function refreshAlternates() {
            const cb = document.getElementById('fAlternates');
            if (cb && cb.checked) drawAlternates(lastRouteChain);
            else clearAlternates();
        }
```

- [ ] **Step 4: Wire the toggle**

Next to where the `.airport-filter` change listeners are registered (line ~2773), add:

```javascript
        const fAltCb = document.getElementById('fAlternates');
        if (fAltCb) fAltCb.addEventListener('change', refreshAlternates);
```

- [ ] **Step 5: Hook the route-render routine**

In the route-render routine you read (lines ~2940-3090):

(a) Where it clears the route at the start (the line `routeLayers.forEach(l => map.removeLayer(l)); routeLayers = [];`, ~line 3024 — or the equivalent clear of `routeEndpointMarkers`), also clear the overlay:

```javascript
            clearAlternates();
```

(b) At the **end** of the routine, after the chain has been drawn, record it and refresh the overlay. Use the ident-bearing chain (the trip's origin + planned stops + destination — the same source the validation uses, e.g. `[t.origin, ...plannedStops, t.dest]`):

```javascript
            lastRouteChain = [t.origin, ...plannedStops, t.dest].filter(p => p && p.ident);
            refreshAlternates();
```

If `t`, `plannedStops`, or `t.dest` are not in scope at that exact point, build `lastRouteChain` from whatever array of route points the routine just drew — each element needs a `.ident` so `airportByIdent` can resolve it.

- [ ] **Step 6: Start (or restart) the app**

Template edits need a server restart: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python app.py` → http://127.0.0.1:5055 (or preview_start).

- [ ] **Step 7: Verify in the browser**

1. Plan a multi-stop route (e.g. a long Beta Alia route with a couple of stops).
2. Open map options, tick **Alternates**.
3. Confirm: a **purple dashed line** runs from each routed airport (origin, each stop, destination) to a nearby airport, with a purple marker and a permanent label like `EHLE · 8 km`. The colour is clearly distinct from the blue route legs and orange/charger markers.
4. Re-plan (change destination); confirm the overlay follows the new route. Untick **Alternates**; confirm all purple lines/markers/labels disappear.

Capture a screenshot of the route with the alternate overlay on.

- [ ] **Step 8: Commit**

```bash
git add templates/index.html
git commit -m "Add map overlay for routed-airport alternates

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Wire into the suite runner and verify end-to-end

**Files:**
- Modify: `tests/run_all.sh:27` (add the new Node harness)

- [ ] **Step 1: Add the routing harness to the runner**

In `tests/run_all.sh`, change the Node loop (line 27) from:

```bash
for f in tests/js_settings.test.mjs tests/js_charging.test.mjs tests/js_demand.test.mjs tests/js_flight_model.test.mjs; do
```

to:

```bash
for f in tests/js_settings.test.mjs tests/js_charging.test.mjs tests/js_demand.test.mjs tests/js_flight_model.test.mjs tests/js_routing.test.mjs; do
```

- [ ] **Step 2: Run the whole suite**

Run: `bash tests/run_all.sh`
Expected: Python layer OK, every Node harness prints `0 failed`, final line `ALL LAYERS PASSED`. (The golden/API layers self-skip if `:5055` is down — that is fine.)

- [ ] **Step 3: Commit**

```bash
git add tests/run_all.sh
git commit -m "Run the routing-planner harness in the full test suite

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Final review**

Run: `git diff --stat main..HEAD`
Expected: ONLY these files — `airport_alternates.py`, `european_airports.csv`, `prepare_data.py`, `sim.py`, `static/settings.js`, `static/routing.js`, `templates/index.html`, `tests/test_alternates.py`, `tests/js_routing.test.mjs`, `tests/js_settings.test.mjs`, `tests/run_all.sh`, and this plan doc. No mobile files. If anything else appears, it belongs to another session — leave it unstaged.

---

## Notes / deferred (YAGNI — not in this plan)

- **Safety-margin slider** (`alternate_km × 1.x`): the toggle is parameter-free for v1; the reserve is the raw alternate distance.
- **Default ON**: the planner reserve ships OFF so it doesn't disturb the seeded tour, saved plans, or existing goldens. The map overlay is independent (off until toggled) and works regardless of the reserve toggle. Flip the reserve default in a follow-up once validated.
- **Mobile**: `static/mobile.js` inherits the shared planner change automatically (default OFF = no change); its own Model-settings + map-overlay surfaces are the mobile session's responsibility.
- **Mid-leg coverage**: reserve guarantees divert capability on arrival at each node, not continuously along a leg (standard alternate semantics).
