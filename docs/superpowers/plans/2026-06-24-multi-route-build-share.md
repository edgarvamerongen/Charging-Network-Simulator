# Multi-Route "Build" Share Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator share an entire saved network (all flights + per-airport charger setup + rotation schedule + model settings) as one short `/s/<slug>` link, just like today's single-route share.

**Architecture:** Add a second *kind* of share blob (`k:'build'`) carrying per-flight **inputs only** plus the airport config / schedule / settings-delta. It is stored through the existing schema-agnostic `/api/share` → `shares.py` slug store (no server schema change). On open, a dispatcher branches on `k`, re-simulates each flight via `/api/simulate` (reproducing fresh energies the same way the guided tour seeds a network), restores the config/schedule/settings, and renders the network. Computed outputs are never stored — they re-derive, so a shared build never goes stale.

**Tech Stack:** Vanilla JS browser globals (`CNSDemand`, `CNSState`, `CNSShare`, `CNSSettings`, Leaflet), Flask + SQLite (`shares.py`), Python stdlib `unittest`, Node `node:test` + `vm` harness.

## Global Constraints

- Share blob is discriminated by `k: 'build'` with `v: 1`. A single-route blob has **no** `k`. The dispatcher MUST branch on `k` **before** the existing `v === SCHEMA` check.
- Per-flight record (INPUTS only): `{ id, p, c, t, fn, fu, o, d?, s? }` where `p`=planeId, `c`=chargerId, `t`=tripType, `fn`=freqN, `fu`=freqUnit; `o`/`d` and each `s[]` entry are points shaped `{ i, la, lo, n }` (ident, lat, lon, name). `d` is omitted for `training` trips. `s` is omitted when empty.
- Build-level keys: `fl` (array, always present), `cfg` (the `cns_airport_cfg` object), `sch` (the `cns_schedule` object), `ms` (model-settings delta). `cfg`/`sch`/`ms` are omitted when empty.
- Never store computed outputs (`legEnergy`, `charges[]`, `battery`, distances). They are recomputed on open by `/api/simulate`.
- Restore re-simulates each flight by POSTing the stored inputs (including stored `stops`) to `/api/simulate`. It does NOT re-plan stops client-side — the stored stops ARE the route.
- `shares.MAX_STATE_BYTES = 64 * 1024` (raised from `16 * 1024`).
- Module load order in `templates/index.html`: `flight-entry.js` BEFORE `tour.js`; `buildshare.js` AFTER `share.js`.
- Every browser global a node-harness file touches MUST be read lazily inside functions and `typeof`-guarded, exactly like `static/share.js` — loading the file in a bare `vm` sandbox must never throw.
- Run Python tests: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python -m unittest tests.<module> -v` (pytest is NOT installed).
- Run JS tests: `node tests/<file>.test.mjs`.
- Register every new JS test file in `tests/run_all.sh`.

---

### Task 1: Raise the share-state cap and prove build blobs round-trip

The slug store is schema-agnostic, so a build blob already flows through `/api/share` and `/s/<slug>` unchanged. The only code change is the size cap. **Watch out:** an existing test asserts the old 16 KB limit and will break — this task updates it.

**Files:**
- Modify: `shares.py:34` (the `MAX_STATE_BYTES` constant)
- Modify: `tests/test_share_routes.py:58-62` (existing oversize test asserts the old limit)
- Test: `tests/test_shares.py` (add build round-trip), `tests/test_share_routes.py` (add build API tests)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `shares.MAX_STATE_BYTES == 64 * 1024`. Confirms `POST /api/share` accepts a `{'k':'build', ...}` state verbatim and `GET /s/<slug>` injects it as `window.__CNS_SHARE__` — the contract Task 5's dispatcher relies on.

- [ ] **Step 1: Update the existing oversize test to the new limit**

In `tests/test_share_routes.py`, change `test_create_rejects_oversize_state` (currently `16 * 1024 + 1`) to:

```python
    def test_create_rejects_oversize_state(self):
        self._login()
        big = {'v': 1, 'pad': 'x' * (64 * 1024 + 1)}
        r = self.client.post('/api/share', json={'state': big})
        self.assertEqual(r.status_code, 413)
```

- [ ] **Step 2: Add build round-trip + API tests (write them failing)**

Append to `tests/test_shares.py` inside `SharesStoreTest`:

```python
    def test_build_blob_round_trips_verbatim(self):
        build = {
            'v': 1, 'k': 'build',
            'fl': [{'id': 'f1', 'p': 'beta_plane', 'c': 'dc_320', 't': 'oneway',
                    'fn': 2, 'fu': 'day',
                    'o': {'i': 'EHLE', 'la': 52.46, 'lo': 5.52, 'n': 'Lelystad'},
                    'd': {'i': 'EDDF', 'la': 50.03, 'lo': 8.56, 'n': 'Frankfurt'}}],
            'cfg': {'EDDF': {'chargers': ['dc_320'], 'targetDepartureSoc': 0.8}},
            'sch': {'f1': ['08:00', '12:00']},
            'ms': {'chargeTarget': {'enabled': True, 'value': 0.9}},
        }
        slug = shares.save_state(build)
        self.assertEqual(shares.load_state(slug), build)

    def test_cap_is_64k(self):
        self.assertEqual(shares.MAX_STATE_BYTES, 64 * 1024)
```

Append to `tests/test_share_routes.py` inside `ShareRoutesTest`:

```python
    def test_build_blob_creates_slug_and_injects_on_open(self):
        self._login()
        build = {'v': 1, 'k': 'build', 'fl': [{'id': 'f1', 'mark': INJECT_MARK}]}
        slug = self.client.post('/api/share', json={'state': build}).get_json()['slug']
        r = self.client.get('/s/' + slug)
        self.assertEqual(r.status_code, 200)
        self.assertIn(b'window.__CNS_SHARE__ = ', r.data)
        self.assertIn(b'"k": "build"', r.data)
        self.assertIn(INJECT_MARK.encode(), r.data)
```

- [ ] **Step 3: Run the new tests to verify they FAIL**

Run: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python -m unittest tests.test_shares.SharesStoreTest.test_cap_is_64k tests.test_share_routes.ShareRoutesTest.test_create_rejects_oversize_state -v`

Expected: FAIL — `test_cap_is_64k` (cap still 16384) and `test_create_rejects_oversize_state` (64 KB+1 still rejected as expected, but the OLD code rejects at 16 KB so a 64 KB+1 body is also rejected → this one may pass; the decisive failure is `test_cap_is_64k`).

- [ ] **Step 4: Raise the cap**

In `shares.py`, change line 34 from:

```python
MAX_STATE_BYTES = 16 * 1024  # real blobs are <1 KB; cap stops arbitrary storage
```

to:

```python
MAX_STATE_BYTES = 64 * 1024  # single routes are <1 KB; multi-route build blobs are larger but still small — cap stops arbitrary storage
```

- [ ] **Step 5: Run the share test modules — all green**

Run: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python -m unittest tests.test_shares tests.test_share_routes -v`

Expected: PASS (all existing + new tests).

- [ ] **Step 6: Commit**

```bash
git add shares.py tests/test_shares.py tests/test_share_routes.py
git commit -m "feat(share): raise state cap to 64 KB for multi-route build blobs"
```

---

### Task 2: Extract the shared sim→entry mapper (`CNSFlightEntry.fromSim`)

`_entryFromSim` in `tour.js` turns an `/api/simulate` response into a demand-folder entry. Build-restore needs the identical mapping, so lift it into a shared, pure, node-testable module and make `tour.js` delegate. The only behavioural change is that `id` becomes an explicit caller-supplied value instead of being hard-prefixed with `tour_`.

**Files:**
- Create: `static/flight-entry.js`
- Modify: `static/tour.js:95-119` (`_entryFromSim`), and its call site `static/tour.js:162`
- Modify: `templates/index.html:2418-2419` (add the script include before `tour.js`)
- Test: `tests/js_flight_entry.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `window.CNSFlightEntry.fromSim(d, opts)` where `d` is an `/api/simulate` response and `opts = { origin, dest, chargerId, freqN, freqUnit, id }`. `origin`/`dest` are points `{ ident, name, lat, lon }`. Returns a demand-folder entry object whose `id` is `opts.id` verbatim. Used by Task 4's `applyBuild`.

- [ ] **Step 1: Write the failing test**

Create `tests/js_flight_entry.test.mjs`:

```javascript
/*
 * CNSFlightEntry — node harness for the sim-response → demand-folder mapper.
 * Run:  node tests/js_flight_entry.test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function load() {
  const code = fs.readFileSync(path.join(REPO, 'static', 'flight-entry.js'), 'utf8');
  const sandbox = { window: {}, console, JSON };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.CNSFlightEntry;
}

const ORIGIN = { ident: 'EHLE', name: 'Lelystad', lat: 52.46, lon: 5.52 };
const DEST = { ident: 'EDDF', name: 'Frankfurt', lat: 50.03, lon: 8.56 };

test('fromSim maps a single-leg response and preserves the explicit id', () => {
  const E = load();
  const d = {
    plane: { id: 'beta_plane', name: 'Beta Alia', svg: 'beta.svg', battery_kwh: 225, c_rate: 1 },
    charger: { name: 'Cube 320', power_kw: 320 },
    trip_type: 'oneway', leg_energy_kwh: 154.3, recharge_energy_kwh: 154.3, flight_time_h: 1.4,
  };
  const e = E.fromSim(d, { origin: ORIGIN, dest: DEST, chargerId: 'dc_320', freqN: 2, freqUnit: 'day', id: 'f1' });
  assert.equal(e.id, 'f1');
  assert.equal(e.originIdent, 'EHLE');
  assert.equal(e.originLat, 52.46);
  assert.equal(e.destIdent, 'EDDF');
  assert.equal(e.planeId, 'beta_plane');
  assert.equal(e.chargerId, 'dc_320');
  assert.equal(e.legEnergy, 154.3);
  assert.equal(e.freqN, 2);
  assert.equal(e.multiLeg, undefined);
});

test('fromSim carries multi-leg fields through', () => {
  const E = load();
  const d = {
    plane: { id: 'vaeridion', name: 'Vaeridion', svg: 'v.svg', battery_kwh: 600, c_rate: 2 },
    charger: { name: '1 MW', power_kw: 1000 },
    trip_type: 'oneway', leg_energy_kwh: 100, multi_leg: true,
    total_flight_time_h: 3.2, total_recharge_energy_kwh: 280,
    stops: [{ ident: 'EDLV', name: 'Niederrhein', lat: 51.6, lon: 6.1 }],
    charges: [{ ident: 'EDLV', energy_kwh: 120, role: 'stop', at_index: 1 }],
    legs: 2, total_distance_km: 700, total_charge_time_min: 60,
  };
  const e = E.fromSim(d, { origin: ORIGIN, dest: DEST, chargerId: 'dc_1000', freqN: 1, freqUnit: 'day', id: 'x' });
  assert.equal(e.multiLeg, true);
  assert.deepEqual(e.stops, d.stops);
  assert.deepEqual(e.charges, d.charges);
  assert.equal(e.totalDistanceKm, 700);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/js_flight_entry.test.mjs`
Expected: FAIL — cannot read `static/flight-entry.js` (file does not exist).

- [ ] **Step 3: Create the module**

Create `static/flight-entry.js`:

```javascript
/*
 * CNSFlightEntry — map an /api/simulate response into a demand-folder entry.
 * --------------------------------------------------------------------------
 * One source of truth for "sim response → folder entry", shared by the guided
 * tour's network seeding and the multi-route build-share restore. Pure: no DOM,
 * no globals — give it the sim response `d` plus the route context and it
 * returns the entry object the demand calculator stores.
 *
 *   fromSim(d, { origin, dest, chargerId, freqN, freqUnit, id })
 *     origin / dest : { ident, name, lat, lon }
 *     id            : the entry id VERBATIM (caller owns the id scheme)
 */
window.CNSFlightEntry = (function () {
    'use strict';
    function fromSim(d, opts) {
        const o = opts.origin, dst = opts.dest;
        const e = {
            id: opts.id,
            destIdent: dst.ident, destName: dst.name, destLat: dst.lat, destLon: dst.lon,
            originIdent: o.ident, originName: o.name, originLat: o.lat, originLon: o.lon,
            planeName: d.plane.name, planeId: d.plane.id, planeSvg: d.plane.svg, tripType: d.trip_type,
            chargerId: opts.chargerId, chargerName: d.charger.name, chargerPower: d.charger.power_kw,
            legEnergy: d.leg_energy_kwh, battery: d.plane.battery_kwh, c_rate: d.plane.c_rate,
            freqN: opts.freqN, freqUnit: opts.freqUnit, fleetMode: 'separate',
        };
        if (d.multi_leg) {
            Object.assign(e, {
                multiLeg: true, flightTimeH: d.total_flight_time_h,
                rechargeEnergy: d.total_recharge_energy_kwh,
                stops: d.stops, charges: d.charges, legs: d.legs,
                totalDistanceKm: d.total_distance_km, totalFlightTimeH: d.total_flight_time_h,
                totalChargeMin: d.total_charge_time_min, totalRechargeKwh: d.total_recharge_energy_kwh,
            });
        } else {
            Object.assign(e, { rechargeEnergy: d.recharge_energy_kwh, flightTimeH: d.flight_time_h });
        }
        return e;
    }
    return { fromSim };
})();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/js_flight_entry.test.mjs`
Expected: PASS (3/3).

- [ ] **Step 5: Refactor `tour.js` to delegate to the shared mapper**

In `static/tour.js`, replace the whole `_entryFromSim` function (lines ~95-119) with a thin adapter that normalizes its airport objects (catalog shape uses `latitude_deg`/`longitude_deg`) and delegates:

```javascript
    // Map a /api/simulate response into a demand-folder entry via the shared
    // CNSFlightEntry mapper (static/flight-entry.js). Tour ids are 'tour_'+tag.
    function _entryFromSim(d, origin, dest, chargerId, freqN, freqUnit, tag) {
        const norm = (ap) => ({ ident: ap.ident, name: ap.name, lat: ap.latitude_deg, lon: ap.longitude_deg });
        return CNSFlightEntry.fromSim(d, {
            origin: norm(origin), dest: norm(dest),
            chargerId: chargerId, freqN: freqN, freqUnit: freqUnit, id: 'tour_' + tag,
        });
    }
```

(The call site at `tour.js:162` passes `lelystad`/`dest` catalog objects — unchanged, `norm` handles the `latitude_deg` shape.)

- [ ] **Step 6: Add the script include before `tour.js`**

In `templates/index.html`, immediately after the `routing.js` include (line 2419) add:

```html
    <script src="/static/flight-entry.js?v={{ asset_version }}"></script>
```

- [ ] **Step 7: Re-run the mapper test + the routing test (sanity that nothing else moved)**

Run: `node tests/js_flight_entry.test.mjs && node tests/js_routing.test.mjs`
Expected: PASS both.

- [ ] **Step 8: Commit**

```bash
git add static/flight-entry.js static/tour.js templates/index.html tests/js_flight_entry.test.mjs
git commit -m "refactor(tour): extract shared CNSFlightEntry.fromSim mapper"
```

---

### Task 3: `CNSBuildShare.currentBuild()` — capture the network as a build blob

Build the read side: turn the saved folder + airport config + schedule + settings-delta into the `k:'build'` blob. This task also exposes `CNSShare.settingsDelta` so the delta logic stays single-sourced.

**Files:**
- Modify: `static/share.js:187` (export `settingsDelta`)
- Create: `static/buildshare.js` (`currentBuild` + helpers; `applyBuild`/`copyBuildLink` arrive in Task 4)
- Test: `tests/js_buildshare.test.mjs`

**Interfaces:**
- Consumes: `CNSDemand.loadFolder()`, `CNSDemand.loadCfg()` (`static/demand.js`); `CNSState.getJSON(key, dflt)`, `CNSState.KEYS.sched` (`static/state.js`); `CNSShare.settingsDelta()` (newly exported here).
- Produces: `window.CNSBuildShare.currentBuild()` → the build blob `{ v:1, k:'build', fl:[...], cfg?, sch?, ms? }`. Used by Task 4 (`copyBuildLink`) and tested here.

- [ ] **Step 1: Write the failing test**

Create `tests/js_buildshare.test.mjs`:

```javascript
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
import assert from 'node:assert/strict';
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/js_buildshare.test.mjs`
Expected: FAIL — cannot read `static/buildshare.js`.

- [ ] **Step 3: Export `settingsDelta` from `share.js`**

In `static/share.js`, change the returned object (line 187) from:

```javascript
    return { encode, decode, currentState, apply, hasLink, shareUrl, init, createShortLink, copyLink, toast, SCHEMA };
```

to (add `settingsDelta`):

```javascript
    return { encode, decode, currentState, apply, hasLink, shareUrl, init, createShortLink, copyLink, toast, SCHEMA, settingsDelta: _settingsDelta };
```

- [ ] **Step 4: Create `buildshare.js` with `currentBuild`**

Create `static/buildshare.js`:

```javascript
/*
 * CNSBuildShare — share a whole saved NETWORK (multi-route "build") as one
 * short /s/<slug> link, the sibling of CNSShare (single route, static/share.js).
 *
 * A build blob is { v:1, k:'build', fl:[...flights...], cfg, sch, ms }, stored
 * verbatim by the existing /api/share slug store. Per flight we keep only the
 * INPUTS (plane, charger, trip type, frequency, origin/destination/stops). The
 * computed energies are deliberately dropped and recomputed on open via
 * /api/simulate, so a shared build never goes stale when the catalog or model
 * changes — the same philosophy as the single-route share re-planning its stops.
 *
 * Browser globals (CNSDemand, CNSState, CNSShare, CNSSettings, CNSFlightEntry,
 * renderFolder) are read LAZILY inside functions and typeof-guarded, so loading
 * this file in the bare node test harness never throws.
 */
window.CNSBuildShare = (function () {
    'use strict';
    const SCHEMA = 1;

    // Compact point: ident/lat/lon/name, omitting blanks to keep the blob small.
    function _pt(ident, name, lat, lon) {
        const p = {};
        if (ident) p.i = ident;
        if (name) p.n = name;
        if (lat != null) p.la = lat;
        if (lon != null) p.lo = lon;
        return p;
    }

    // Read the saved network into a build blob (INPUTS only).
    function currentBuild() {
        const D = (typeof CNSDemand !== 'undefined') ? CNSDemand : null;
        const folder = (D && D.loadFolder) ? D.loadFolder() : [];
        const fl = folder.map((t) => {
            const rec = {
                id: t.id, p: t.planeId, c: t.chargerId,
                t: t.tripType, fn: t.freqN, fu: t.freqUnit,
                o: _pt(t.originIdent, t.originName, t.originLat, t.originLon),
            };
            if (t.tripType !== 'training' && t.destIdent) {
                rec.d = _pt(t.destIdent, t.destName, t.destLat, t.destLon);
            }
            const stops = (t.stops || [])
                .map((s) => _pt(s.ident, s.name, s.lat, s.lon))
                .filter((s) => s.la != null && s.lo != null);
            if (stops.length) rec.s = stops;
            return rec;
        });

        const blob = { v: SCHEMA, k: 'build', fl };
        const cfg = (D && D.loadCfg) ? D.loadCfg() : {};
        if (cfg && Object.keys(cfg).length) blob.cfg = cfg;
        const St = (typeof CNSState !== 'undefined') ? CNSState : null;
        const sch = (St && St.getJSON) ? St.getJSON(St.KEYS.sched, {}) : {};
        if (sch && Object.keys(sch).length) blob.sch = sch;
        const ms = (typeof CNSShare !== 'undefined' && CNSShare.settingsDelta) ? CNSShare.settingsDelta() : undefined;
        if (ms) blob.ms = ms;
        return blob;
    }

    return { currentBuild, SCHEMA };
})();
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node tests/js_buildshare.test.mjs`
Expected: PASS (4/4).

- [ ] **Step 6: Re-run the single-route share test (the `settingsDelta` export must not break it)**

Run: `node tests/js_share.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add static/share.js static/buildshare.js tests/js_buildshare.test.mjs
git commit -m "feat(buildshare): capture saved network as a build blob (currentBuild)"
```

---

### Task 4: `applyBuild()` + `copyBuildLink()` — restore and share

The write/restore side. `applyBuild` re-simulates each stored flight in parallel, rebuilds the folder, and restores config/schedule/settings. `copyBuildLink` POSTs the blob through the existing slug store and copies the link.

**Files:**
- Modify: `static/buildshare.js` (add `_simPayload`, `_restoreFlight`, `applyBuild`, `copyBuildLink` to the module, and export them)
- Test: `tests/js_buildshare.test.mjs` (add restore + payload tests)

**Interfaces:**
- Consumes: `CNSFlightEntry.fromSim` (Task 2); `currentBuild` (Task 3); `CNSShare.createShortLink(state)` (`static/share.js`); `CNSDemand.saveFolder/saveCfg`; `CNSState.setJSON`; `CNSSettings.save`; the global `renderFolder()` (`templates/index.html`); `fetch`, `navigator.clipboard`.
- Produces: `applyBuild(st, _fetch?)` → `Promise<{ restored, dropped }>`; `copyBuildLink(_deps?)` → `Promise<string|null>`. Task 5's dispatcher calls `applyBuild`; Task 5's button calls `copyBuildLink`. `_fetch`/`_deps` are injectable for tests; both default to the real browser APIs.

- [ ] **Step 1: Write the failing tests**

Append to `tests/js_buildshare.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node tests/js_buildshare.test.mjs`
Expected: FAIL — `_simPayload`, `applyBuild`, `copyBuildLink` are undefined.

- [ ] **Step 3: Add the restore + share functions**

In `static/buildshare.js`, insert these functions before the `return { ... }` line, and extend the export. First, the functions (place after `currentBuild`):

```javascript
    // A stored flight's inputs → an /api/simulate request body.
    function _simPayload(fl) {
        const wp = (p) => ({ ident: p.i, name: p.n, lat: p.la, lon: p.lo });
        const body = { plane_id: fl.p, charger_id: fl.c, trip_type: fl.t, origin: wp(fl.o) };
        if (fl.d) body.destination = wp(fl.d);
        if (fl.s && fl.s.length) body.stops = fl.s.map(wp);
        return body;
    }

    // Re-simulate one stored flight → a folder entry (null if it can't fly now).
    async function _restoreFlight(fl, _fetch) {
        const f = _fetch || (typeof fetch !== 'undefined' ? fetch : null);
        if (!f) return null;
        let d;
        try {
            d = await f('/api/simulate', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(_simPayload(fl)),
            }).then((r) => r.json());
        } catch (e) { return null; }
        if (!d || d.error || !d.plane) return null;
        const wp = (p) => ({ ident: p.i, name: p.n, lat: p.la, lon: p.lo });
        return CNSFlightEntry.fromSim(d, {
            origin: wp(fl.o), dest: fl.d ? wp(fl.d) : wp(fl.o),
            chargerId: fl.c, freqN: fl.fn, freqUnit: fl.fu, id: fl.id,
        });
    }

    // Restore a build blob: settings first, then re-simulate every flight in
    // parallel, replace the folder, and reapply per-airport config + schedule.
    async function applyBuild(st, _fetch) {
        if (!st || st.k !== 'build') return { restored: 0, dropped: 0 };
        if (st.ms && typeof CNSSettings !== 'undefined' && CNSSettings.save) {
            try { CNSSettings.save(st.ms); } catch (e) { /* ignore */ }
        }
        const specs = Array.isArray(st.fl) ? st.fl : [];
        const entries = await Promise.all(specs.map((fl) => _restoreFlight(fl, _fetch)));
        const ok = entries.filter(Boolean);
        const dropped = specs.length - ok.length;

        if (typeof CNSDemand !== 'undefined') {
            if (CNSDemand.saveFolder) CNSDemand.saveFolder(ok);
            if (st.cfg && CNSDemand.saveCfg) CNSDemand.saveCfg(st.cfg);
        }
        if (st.sch && typeof CNSState !== 'undefined' && CNSState.setJSON) {
            CNSState.setJSON(CNSState.KEYS.sched, st.sch);
        }
        if (typeof renderFolder === 'function') renderFolder();
        if (dropped && typeof CNSShare !== 'undefined' && CNSShare.toast) {
            CNSShare.toast(dropped + ' flight' + (dropped > 1 ? 's' : '') + ' couldn’t be restored — skipped', 4500);
        }
        return { restored: ok.length, dropped };
    }

    // POST the current network as a build and copy its /s/<slug> link. _deps is
    // injectable for tests; defaults to CNSShare.createShortLink + the clipboard.
    async function copyBuildLink(_deps) {
        const deps = _deps || {};
        const createShortLink = deps.createShortLink
            || (typeof CNSShare !== 'undefined' ? CNSShare.createShortLink : null);
        const writeText = deps.writeText
            || ((typeof navigator !== 'undefined' && navigator.clipboard) ? navigator.clipboard.writeText.bind(navigator.clipboard) : null);
        const toast = (m, ms) => { if (typeof CNSShare !== 'undefined' && CNSShare.toast) CNSShare.toast(m, ms); };

        const folder = (typeof CNSDemand !== 'undefined' && CNSDemand.loadFolder) ? CNSDemand.loadFolder() : [];
        if (!folder.length) { toast('Add at least one flight before sharing a build.', 3500); return null; }

        let url;
        try { url = await createShortLink(currentBuild()); }
        catch (e) { toast('Couldn’t create a share link — try again.', 4000); return null; }   // build links are slug-only: no hash fallback

        try { if (writeText) await writeText(url); toast('Build link copied'); }
        catch (e) { if (typeof window !== 'undefined' && window.prompt) window.prompt('Copy this shareable build link:', url); }
        return url;
    }
```

Then change the export line from:

```javascript
    return { currentBuild, SCHEMA };
```

to:

```javascript
    return { currentBuild, applyBuild, copyBuildLink, _simPayload, SCHEMA };
```

- [ ] **Step 4: Run the full buildshare test to verify it passes**

Run: `node tests/js_buildshare.test.mjs`
Expected: PASS (8/8).

- [ ] **Step 5: Commit**

```bash
git add static/buildshare.js tests/js_buildshare.test.mjs
git commit -m "feat(buildshare): applyBuild restore + copyBuildLink share"
```

---

### Task 5: Wire the build share into the UI and restore path

Connect the module to the page: load the scripts, add the "Share build" button, branch the share dispatcher on `k`, fit the map to the restored network, and register the new JS tests. Verified end-to-end in the browser preview.

**Files:**
- Modify: `templates/index.html:2430` (add `buildshare.js` include after `share.js`)
- Modify: `templates/index.html:2044` (add the "Share build" button next to Export XLSX)
- Modify: `templates/index.html:5473` (add the button's click handler)
- Modify: `templates/index.html:3809` (add `fitSavedRoutes()` next to `drawSavedRoutes`)
- Modify: `templates/index.html:6162-6166` (dispatcher: branch on `k:'build'`)
- Modify: `tests/run_all.sh:30` (register the two new JS test files)

**Interfaces:**
- Consumes: `CNSBuildShare.copyBuildLink()` and `CNSBuildShare.applyBuild(st)` (Task 4); the existing `savedRoutesLayer`, `map`, `_fitPadding()`, `renderFolder()`, `demandDrawer`.
- Produces: the user-facing feature. No new interface for later tasks (final task).

- [ ] **Step 1: Add the `buildshare.js` script include**

In `templates/index.html`, immediately after the `share.js` include (line 2430) add:

```html
    <script src="/static/buildshare.js?v={{ asset_version }}"></script>
```

- [ ] **Step 2: Add the "Share build" button next to Export XLSX**

In `templates/index.html`, find the Export button at line 2044 (`id="exportSpreadsheet"`). Immediately after it, add:

```html
                    <button id="shareBuild" class="btn-cns btn-sm-cns" type="button" title="Copy a shareable link to this whole network — all flights, chargers & schedule"><span aria-hidden="true">🔗</span> Share build</button>
```

- [ ] **Step 3: Add the button's click handler**

In `templates/index.html`, immediately after the `exportSpreadsheet` handler (line 5473) add:

```javascript
        document.getElementById('shareBuild')?.addEventListener('click', () => { if (window.CNSBuildShare) CNSBuildShare.copyBuildLink(); });
```

- [ ] **Step 4: Add a `fitSavedRoutes()` helper**

In `templates/index.html`, immediately after the `drawSavedRoutes` function (it ends around line 3833, just before the `fSavedRoutes` listener at 3835) add:

```javascript
        // Fit the map to the saved-route network overlay (used after restoring a shared build).
        function fitSavedRoutes() {
            const ls = savedRoutesLayer.getLayers();
            if (ls.length) { try { map.fitBounds(L.featureGroup(ls).getBounds(), _fitPadding()); } catch (e) { /* ignore */ } }
        }
```

- [ ] **Step 5: Branch the share dispatcher on `k:'build'`**

In `templates/index.html`, replace the existing dispatcher block (lines 6162-6166):

```javascript
            if (window.__CNS_SHARE__ && window.CNSShare) {                                       // short /s/ link
                if (window.__CNS_SHARE__.v === CNSShare.SCHEMA) CNSShare.apply(window.__CNS_SHARE__);
                else { CNSShare.toast('This shared link is from a different version.'); _applyDefaultFlight(); }
            }
            else if (window.CNSShare && CNSShare.hasLink()) CNSShare.init();                     // legacy #r= hash link
```

with (build branch FIRST, since a build blob also has `v === 1`):

```javascript
            const _sh = window.__CNS_SHARE__;
            if (_sh && _sh.k === 'build' && window.CNSBuildShare) {                              // multi-route build link
                CNSBuildShare.applyBuild(_sh).then(() => { fitSavedRoutes(); demandDrawer.classList.add('open'); });
            }
            else if (_sh && window.CNSShare) {                                                   // short /s/ single-route link
                if (_sh.v === CNSShare.SCHEMA) CNSShare.apply(_sh);
                else { CNSShare.toast('This shared link is from a different version.'); _applyDefaultFlight(); }
            }
            else if (window.CNSShare && CNSShare.hasLink()) CNSShare.init();                     // legacy #r= hash link
```

(`demandDrawer` is already in scope — defined at line 6127 in the same block.)

- [ ] **Step 6: Register the new JS tests in the runner**

In `tests/run_all.sh`, add `tests/js_flight_entry.test.mjs` and `tests/js_buildshare.test.mjs` to the `for f in ...` list (line 30), e.g. after `tests/js_share.test.mjs`:

```bash
for f in tests/js_settings.test.mjs tests/js_units.test.mjs tests/js_charging.test.mjs tests/js_demand.test.mjs tests/js_flight_model.test.mjs tests/js_flight_padding.test.mjs tests/js_flight_adapter.test.mjs tests/js_interim_charging.test.mjs tests/js_routing.test.mjs tests/js_recompute.test.mjs tests/js_share.test.mjs tests/js_flight_entry.test.mjs tests/js_buildshare.test.mjs tests/js_range_graph.test.mjs; do
```

- [ ] **Step 7: Run the full JS + share Python suite**

Run: `node tests/js_flight_entry.test.mjs && node tests/js_buildshare.test.mjs && node tests/js_share.test.mjs && DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python -m unittest tests.test_shares tests.test_share_routes -v`
Expected: PASS all.

- [ ] **Step 8: Browser preview — end-to-end build share**

Start the app via `preview_start` (config `cns-preview`, port 5079). Then:
1. Build a small network: add 3 flights out of Lelystad (e.g. EHLE→EHAM retour, EHLE→EDDF one-way, EHLE→EHRD retour) via the planner's "Add to demand calculator".
2. Assign a per-airport charger on one airport and set a take-off time (so `cfg` + `sch` are non-empty).
3. Open the demand drawer, click **Share build** — confirm the "Build link copied" toast.
4. Read the clipboard link (`preview_eval`: `navigator.clipboard.readText()`), open it with `_=${Date.now()}` cache-buster in the same preview.
5. Confirm: the drawer opens, all 3 flights reappear in the folder, the map fits to the network, the assigned charger + schedule are present, and `preview_console_logs` (level error) is clean.

Capture a `preview_screenshot` of the restored network as proof.

- [ ] **Step 9: Commit**

```bash
git add templates/index.html tests/run_all.sh
git commit -m "feat(buildshare): Share build button + restore dispatcher wiring"
```

---

## Self-Review

**1. Spec coverage** (design Sections 1–5 from the conversation):
- §1 State schema (`k:'build'`, `fl` inputs-only, `cfg`/`sch`/`ms`) → Task 3 (`currentBuild`) + Task 1 (storage). ✅
- §2 Save flow + "Share build" button reusing `createShortLink` → Task 4 (`copyBuildLink`) + Task 5 (button/handler). ✅
- §3 Restore flow (dispatcher on `k`, re-simulate, replace folder, apply cfg/sched/settings, render+fit, toast) → Task 4 (`applyBuild`) + Task 5 (dispatcher/fit). ✅
- §3 Refactor `_entryFromSim` into a shared helper → Task 2. ✅
- §4 Edge cases: cap bump + 413 → Task 1; kind coexistence → Task 5 dispatcher (build branch first); partial sim failure (skip + toast) → Task 4 `applyBuild` + its test; custom airports survive (coords in blob) → Task 3 `_pt`. ✅
- §5 Testing: Python (cap/round-trip/inject/413) → Task 1; JS (currentBuild inputs-only, dispatcher mapper, applyBuild) → Tasks 2–4; manual preview → Task 5 Step 8. ✅

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows the assertion and the exact run command with expected result. ✅

**3. Type consistency:**
- Point shape `{ i, la, lo, n }` is identical in Task 3 (`_pt` producing it) and Task 4 (`_simPayload`/`_restoreFlight` consuming it via `wp`). ✅
- `CNSFlightEntry.fromSim(d, { origin, dest, chargerId, freqN, freqUnit, id })` — defined in Task 2, called identically in Task 2 (tour adapter) and Task 4 (`_restoreFlight`). `origin`/`dest` are `{ident,name,lat,lon}` in all callers. ✅
- `applyBuild(st, _fetch)` returns `{ restored, dropped }` — asserted in Task 4 test, consumed (ignored value, `.then`) in Task 5 dispatcher. ✅
- `currentBuild()` blob keys (`v,k,fl,cfg,sch,ms`) match what Task 1's tests store and what Task 5's dispatcher reads (`_sh.k`). ✅
- `CNSShare.settingsDelta` exported in Task 3 and consumed by `currentBuild` in the same task. ✅

No gaps found.
