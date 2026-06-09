# Recompute saved flights on settings change — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When any model setting changes, re-plan every saved Demand-Calculator flight under the current settings — preserving manual stops, honouring the alternate-airport divert reserve — and store whether each flight is still feasible.

**Architecture:** Extract the planner's chain-build/gap-fill into one shared pure function `CNSRouting.planChain` (so re-planning is literally the same code as the live planner). A new `CNSRecompute` module re-plans a saved trip through `planChain` and re-derives its energy through the existing client engine `CNSFlight.simulateTrip` (no HTTP). A debounced trigger in `index.html` recomputes all flights on a settings change and on Model-settings open, then re-renders.

**Tech Stack:** Vanilla browser JS (IIFE modules on `window`), Node ESM test harnesses (`node:test`-free, hand-rolled `test()` like the existing `tests/js_*.test.mjs`), `tests/golden_capture.mjs` `loadStack()` for module loading in Node.

**Spec:** `docs/superpowers/specs/2026-06-09-recompute-flights-on-settings-change-design.md`

---

## File structure

| File | Responsibility | Change |
|------|----------------|--------|
| `static/routing.js` | Range-constrained routing. Add `planChain` — preserve manual stops, auto-fill gaps. | Modify |
| `static/recompute.js` | NEW. `CNSRecompute.recomputeFlight(trip, ctx)` + `recomputeAll(trips, ctx)`. Pure (no DOM). | Create |
| `templates/index.html` | Refactor `recomputeRoute` onto `planChain`; preserve `_manual` in add/edit; debounced `recomputeAllFlights` wired to settings change + modal open; load `recompute.js`; add `sidStarPadding` to the planner routing signature. | Modify |
| `tests/golden_capture.mjs` | `loadStack()` must also load `recompute.js`. | Modify |
| `tests/js_recompute.test.mjs` | NEW. Tests for `planChain`, `recomputeFlight`, feasibility flips, alternate reserve, idempotency. | Create |
| `tests/run_all.sh` | Run the new test. | Modify |

Manual-stop convention used throughout: a stop object carries `_manual: true` (operator chose it) or `_auto: true` (planner inserted it). A legacy saved stop with neither is treated as manual.

---

## Task 1: Extract `CNSRouting.planChain`

**Files:**
- Modify: `static/routing.js` (add `planChain`, export it)
- Modify: `templates/index.html:2442-2485` (`recomputeRoute` calls `planChain`)
- Test: `tests/js_recompute.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/js_recompute.test.mjs`:

```js
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it — expect FAIL (planChain undefined)**

Run: `node tests/js_recompute.test.mjs`
Expected: FAILs with `S.CNSRouting.planChain is not a function`.

- [ ] **Step 3: Add `planChain` to `static/routing.js`**

Inside the `CNSRouting` IIFE, before `return { planRoute, haversineKm, routedKm };`, add:

```js
    // Build a full stop chain that PRESERVES the caller's manual stops and auto-fills
    // each gap between them with planRoute. This is the exact chain-build the live
    // planner uses; index.html's recomputeRoute and CNSRecompute both call it so the
    // re-planning path is identical by construction (not two implementations agreeing).
    //   manualStops: [{ ident, name, lat, lon, alternate_km, ... }]  (order preserved)
    // Returns { stops: [ …each tagged _manual or _auto ], legCount, error }.
    function planChain(opts) {
        const { origin, dest, plane, allAirports } = opts;
        const manualStops = (opts.manualStops || []).map(s => ({ ...s, _manual: true }));
        const allowedTypes = opts.allowedTypes || [];
        const blacklist = opts.blacklist instanceof Set ? opts.blacklist : new Set(opts.blacklist || []);
        const maxLegKm = opts.maxLegKm;
        const chain = [origin, ...manualStops, dest];
        const usedIdents = new Set(chain.map(p => p && p.ident).filter(Boolean));
        const stops = [];
        for (let i = 0; i < chain.length - 1; i++) {
            const filtered = allAirports.filter(a => !usedIdents.has(a.ident) && !blacklist.has(a.ident));
            const seg = planRoute({
                origin: chain[i], destination: chain[i + 1], plane,
                allAirports: filtered, allowedTypes,
                options: Object.assign({}, opts.options || {}, { maxLegKm }),
            });
            if (seg.error && manualStops.length === 0) {
                return { stops: [], legCount: 0, error: seg.error };
            }
            (seg.stops || []).forEach(s => { stops.push({ ...s, _auto: true }); if (s.ident) usedIdents.add(s.ident); });
            if (i < chain.length - 2) stops.push(manualStops[i]);   // the manual anchor ending this gap
        }
        return { stops, legCount: stops.length + 1, error: null };
    }
```

Change the export line to:

```js
    return { planRoute, planChain, haversineKm, routedKm };
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `node tests/js_recompute.test.mjs`
Expected: `3 passed, 0 failed`.

- [ ] **Step 5: Refactor `recomputeRoute` (index.html:2442-2485) onto `planChain`**

Replace the manual-gather + gap-fill loop (the block from `// Manual stops from form fields` through `plannedStops = result;`) with:

```js
            // Manual stops from form fields, in the order the user arranged them.
            const manual = [];
            document.querySelectorAll('#stopsContainer .stop-field .stop-input').forEach(inp => {
                const ident = inp.dataset.ident; if (!ident) return;
                const apx = airportByIdent[ident]; if (!apx) return;
                manual.push({ ident: apx.ident, name: apx.name, type: apx.type, lat: apx.latitude_deg, lon: apx.longitude_deg, iata_code: apx.iata_code || '', alternate_km: apx.alternate_km });
            });
            plannedSource = manual.length ? 'user' : 'auto';

            const chainRes = CNSRouting.planChain({
                origin: t.origin, dest: t.dest, manualStops: manual, plane,
                allowedTypes: _allowedTypes(), allAirports,
                blacklist: _blacklistedStopIdents,
                maxLegKm: _availableRangeKm(plane),
                options: _routingOptions(),
            });
            if (chainRes.error && manual.length === 0) { plannedError = chainRes.error; renderStops(); return; }
            plannedStops = chainRes.stops;
```

(`_terminus()` already carries `alternate_km` on `t.origin`/`t.dest`; `planChain` reads it for the per-arrival divert reserve.)

- [ ] **Step 6: Verify the planner still works — full suite + smoke**

Run: `CNS_BASE_URL=http://127.0.0.1:5055 bash tests/run_all.sh` (server up). Expect `ALL LAYERS PASSED`. Then in the browser: plan Lelystad→a far airport, confirm auto-stops still appear and manual stops are preserved on a Re-suggest.

- [ ] **Step 7: Commit**

```bash
git add static/routing.js templates/index.html tests/js_recompute.test.mjs
git commit -m "refactor(routing): extract CNSRouting.planChain (preserve manual, fill gaps)"
```

---

## Task 2: Preserve `_manual` on saved stops through add + edit

**Files:**
- Modify: `templates/index.html` (the `addFolder` handler ~`:4279-4292` and `_rebuildEditedTrip` ~`:4493`)
- Test: `tests/js_recompute.test.mjs` (pure merge helper)

The saved `trip.stops` come from `d.stops` (the `/api/simulate` result, which strips `_manual`). `plannedStops` (the planner's chain) still has the flags. Merge the flags onto the saved stops by ident.

- [ ] **Step 1: Write the failing test for the merge helper**

Append to `tests/js_recompute.test.mjs` (before the final `console.log`):

```js
test('mergeManualFlags: copies _manual onto saved stops by ident', () => {
  const saved = [{ ident: 'EHRD', name: 'R' }, { ident: 'EDDL', name: 'D' }];
  const planned = [{ ident: 'EHRD', _manual: true }, { ident: 'EDDL', _auto: true }];
  const out = S.CNSRecompute.mergeManualFlags(saved, planned);
  if (out[0]._manual !== true) throw new Error('EHRD should be _manual');
  if (out[1]._manual === true) throw new Error('EDDL (auto) must not be _manual');
});
```

- [ ] **Step 2: Run it — expect FAIL (CNSRecompute undefined)**

Run: `node tests/js_recompute.test.mjs`
Expected: FAIL `Cannot read properties of undefined (reading 'mergeManualFlags')`. (This drives creating `recompute.js` in Task 3; do Step 3 here only after Task 3 Step 3 defines the module, or define the helper now.) To keep Task 2 self-contained, define `recompute.js` with just this helper now:

- [ ] **Step 3: Create `static/recompute.js` with the merge helper**

```js
/*
 * CNSRecompute — re-plan saved Demand-Calculator flights under current model
 * settings and recompute feasibility. Pure (no DOM): the caller supplies the
 * airport catalog + per-plane available-range. Depends on CNSRouting, CNSFlight.
 */
window.CNSRecompute = (function () {
    // Copy the planner's _manual flag onto the saved stop objects (which come from
    // /api/simulate and have lost it), matched by ident. Auto stops stay unflagged.
    function mergeManualFlags(savedStops, plannedStops) {
        const manualIdents = new Set((plannedStops || []).filter(s => s && s._manual).map(s => s.ident));
        return (savedStops || []).map(s => (s && manualIdents.has(s.ident)) ? { ...s, _manual: true } : { ...s });
    }

    return { mergeManualFlags };
})();
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `node tests/js_recompute.test.mjs` → all pass. (Requires `loadStack` to load `recompute.js` — do Task 4 Step 3 first if `S.CNSRecompute` is undefined in Node.)

- [ ] **Step 5: Wire the merge into add + edit (index.html)**

In the `addFolder` handler, in the `if (d.multi_leg)` block, change `stops: d.stops,` to:

```js
                    stops: CNSRecompute.mergeManualFlags(d.stops, plannedStops),
```

In `_rebuildEditedTrip`, find the equivalent `stops: d.stops` assignment and change it the same way:

```js
                    stops: CNSRecompute.mergeManualFlags(d.stops, plannedStops),
```

(`plannedStops` is the planner's current chain, in scope at add/edit time.)

- [ ] **Step 6: Commit**

```bash
git add static/recompute.js templates/index.html tests/js_recompute.test.mjs
git commit -m "feat(dc): preserve manual-stop flags on saved flights (add + edit)"
```

---

## Task 3: `CNSRecompute.recomputeFlight`

**Files:**
- Modify: `static/recompute.js`
- Test: `tests/js_recompute.test.mjs`

`recomputeFlight(trip, ctx)` returns a NEW trip object with refreshed `stops`/`charges`/`legs`/`legEnergy` and `feasible`/`infeasibleReason`. `ctx = { allAirports, planeFor(trip)→spec, availableRangeKm(plane)→km, allowedTypes }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/js_recompute.test.mjs`:

```js
// Build a saved retour trip + a ctx the way index.html will.
function tripFor(o, d, planeId = 'beta_plane', stops = []) {
  const P = PLANES[planeId];
  return { id: 't', planeId, planeName: P.name, tripType: 'retour',
    originIdent: o, originName: AP[o].name, originLat: AP[o].lat, originLon: AP[o].lon,
    destIdent: d, destName: AP[d].name, destLat: AP[d].lat, destLon: AP[d].lon,
    battery: P.battery_kwh, range_km: P.range_km, speed_kmh: P.speed_kmh, c_rate: P.c_rate,
    chargerId: 'dc_250', chargerName: '250 kW DC', chargerPower: 250,
    freqN: 1, freqUnit: 'day', fleetMode: 'separate', stops };
}
const CATALOG = ['EHAM', 'EHGG', 'EHRD', 'EGLL', 'LFPG'].map(k => ap(k));
const ctx = (rangeKm) => ({
  allAirports: CATALOG,
  allowedTypes: ['medium_airport', 'large_airport'],
  planeFor: (t) => ({ id: t.planeId, name: t.planeName, battery_kwh: t.battery, range_km: t.range_km, speed_kmh: t.speed_kmh, c_rate: t.c_rate }),
  // mirrors index.html _availableRangeKm (no per-flight override path here)
  availableRangeKm: (plane) => {
    const route = S.CNSSettings.routingFactor();
    const sid = S.CNSSettings.sidStarPaddingKm ? S.CNSSettings.sidStarPaddingKm() : 0;
    const base = (rangeKm != null ? rangeKm : plane.range_km) * S.CNSSettings.usableFraction(plane) / route;
    return Math.max(0, base - sid / route);
  },
});

test('recomputeFlight: a short retour is feasible', () => {
  S.CNSSettings.reset();
  const out = S.CNSRecompute.recomputeFlight(tripFor('EHAM', 'EHGG'), ctx());
  if (out.feasible !== true) throw new Error('short retour should be feasible: ' + out.infeasibleReason);
});

test('recomputeFlight: cutting available range below the leg flips to infeasible', () => {
  S.CNSSettings.reset();
  // EHAM→EGLL direct is ~360 km; force available range to 100 km with no usable stop.
  const out = S.CNSRecompute.recomputeFlight(tripFor('EHAM', 'EGLL'), { ...ctx(), allAirports: [ap('EHAM'), ap('EGLL')], availableRangeKm: () => 100 });
  if (out.feasible !== false) throw new Error('expected infeasible when no route fits');
  if (!out.infeasibleReason) throw new Error('infeasible flight must carry a reason');
});

test('recomputeFlight: idempotent at unchanged settings', () => {
  S.CNSSettings.reset();
  const t0 = tripFor('EHAM', 'EHGG');
  const a = S.CNSRecompute.recomputeFlight(t0, ctx());
  const b = S.CNSRecompute.recomputeFlight(a, ctx());
  if (JSON.stringify(a.stops) !== JSON.stringify(b.stops)) throw new Error('stops drift on re-recompute');
  if (Math.abs((a.legEnergy || 0) - (b.legEnergy || 0)) > 1e-6) throw new Error('legEnergy drift on re-recompute');
});

test('recomputeFlight: alternate reserve can flip feasibility', () => {
  S.CNSSettings.reset();
  // A leg that just fits on raw range but not once the destination must also hold
  // a large alternate divert. Destination EGLL given a big alternate_km.
  const big = ['EHAM', 'EHRD', 'EGLL'].map(k => ap(k, 'medium_airport', k === 'EGLL' ? 120 : 0));
  const t = tripFor('EHAM', 'EGLL');
  S.CNSSettings.save({ alternateReserve: { enabled: false } });
  const off = S.CNSRecompute.recomputeFlight(t, { ...ctx(), allAirports: big });
  S.CNSSettings.save({ alternateReserve: { enabled: true } });
  const on = S.CNSRecompute.recomputeFlight(t, { ...ctx(), allAirports: big });
  if (!(off.feasible === true)) throw new Error('should fit with the reserve off');
  if (on.feasible === off.feasible && JSON.stringify(on.stops) === JSON.stringify(off.stops))
    throw new Error('alternate reserve had no effect on routing/feasibility');
});
```

- [ ] **Step 2: Run — expect FAIL (recomputeFlight undefined)**

Run: `node tests/js_recompute.test.mjs`
Expected: FAILs on `recomputeFlight is not a function`.

- [ ] **Step 3: Implement `recomputeFlight` in `static/recompute.js`**

Add inside the IIFE (before `return`):

```js
    // Map an engine profile.charges[] entry to the stored shape computeAirports reads.
    function _storeCharge(ch) {
        return { ident: ch.ident, name: ch.name, lat: ch.lat, lon: ch.lon, role: ch.role, at_index: ch.atIndex, energy_kwh: ch.energyKwh };
    }
    function _storeLeg(l) {
        return { from: { name: l.fromName, ident: l.fromIdent }, to: { name: l.toName, ident: l.toIdent }, distance_km: l.distKm, flight_time_h: (l.flightMin || 0) / 60, energy_kwh: l.energyKwh };
    }

    // Re-plan one saved trip under current settings; return a NEW trip with refreshed
    // route + feasibility. Training/direct skip routing.
    function recomputeFlight(trip, ctx) {
        const t = { ...trip };
        if (trip.tripType === 'training') { t.feasible = true; t.infeasibleReason = null; return t; }
        const plane = ctx.planeFor(trip);
        const node = (ident, name, lat, lon) => {
            const full = ident && ctx.allAirports.find(a => a.ident === ident);
            return { ident, name, lat: +lat, lon: +lon, alternate_km: full ? full.alternate_km : undefined };
        };
        const origin = node(trip.originIdent, trip.originName, trip.originLat, trip.originLon);
        const dest = node(trip.destIdent, trip.destName, trip.destLat, trip.destLon);
        // Legacy trips (no _manual markers) → treat every stored stop as manual (preserve it).
        const stops = Array.isArray(trip.stops) ? trip.stops : [];
        const anyTagged = stops.some(s => s && (s._manual || s._auto));
        const manualStops = stops.filter(s => s && (anyTagged ? s._manual : true))
            .map(s => node(s.ident, s.name, s.lat, s.lon));

        const chain = window.CNSRouting.planChain({
            origin, dest, manualStops, plane,
            allowedTypes: ctx.allowedTypes, allAirports: ctx.allAirports,
            maxLegKm: ctx.availableRangeKm(plane), options: {},
        });
        if (chain.error) { t.feasible = false; t.infeasibleReason = chain.error; return t; }

        // Re-derive energy through the SAME client engine the DES/DC display uses.
        const wps = [origin, ...chain.stops, dest].map(n => ({ ident: n.ident, name: n.name, lat: n.lat, lon: n.lon }));
        const prof = window.CNSFlight.simulateTrip(plane, wps, {
            tripType: trip.tripType,
            getTargetSoc: (id) => (window.CNSDemand && window.CNSDemand.resolveTargetSoc) ? window.CNSDemand.resolveTargetSoc((window.CNSDemand.loadCfg && window.CNSDemand.loadCfg()[id]) || null) : null,
            getChargerKw: () => +trip.chargerPower || 0,
        });
        const overLeg = (prof.legs || []).findIndex(l => l.overRange);
        if (overLeg >= 0) {
            t.feasible = false;
            t.infeasibleReason = `leg ${overLeg + 1} exceeds the aircraft's range at the current settings`;
            return t;
        }
        // Persist the refreshed route. Keep stop coords from chain (tagged), charges/legs from the engine.
        t.stops = chain.stops.map(s => ({ ident: s.ident, name: s.name, lat: s.lat, lon: s.lon, type: s.type, iata_code: s.iata_code || '', _manual: !!s._manual, _auto: !!s._auto }));
        t.multiLeg = chain.stops.length > 0;
        t.charges = (prof.charges || []).filter(c => (c.energyKwh || 0) > 0).map(_storeCharge);
        t.legs = (prof.legs || []).map(_storeLeg);
        t.legEnergy = (prof.legs && prof.legs[0]) ? prof.legs[0].energyKwh : trip.legEnergy;
        t.feasible = true; t.infeasibleReason = null;
        return t;
    }
```

Update the export:

```js
    return { mergeManualFlags, recomputeFlight };
```

- [ ] **Step 4: Run the tests — expect PASS**

Run: `node tests/js_recompute.test.mjs`
Expected: all pass (requires `loadStack` to load `recompute.js` — Task 4 Step 3). If `S.CNSRecompute` is undefined, do Task 4 Step 3 first, then return here.

- [ ] **Step 5: Commit**

```bash
git add static/recompute.js tests/js_recompute.test.mjs
git commit -m "feat(dc): recomputeFlight — re-plan a saved flight + feasibility (engine, alternate-aware)"
```

---

## Task 4: `recomputeAll` + load the module everywhere

**Files:**
- Modify: `static/recompute.js` (add `recomputeAll`)
- Modify: `tests/golden_capture.mjs` (`loadStack` loads `recompute.js`)
- Modify: `templates/index.html` (add `<script src="/static/recompute.js">` after `routing.js`)
- Test: `tests/js_recompute.test.mjs`

- [ ] **Step 1: Make `loadStack` load `recompute.js`**

In `tests/golden_capture.mjs`, find the module list (e.g. `['settings.js', 'routing.js', 'flight-model.js', 'demand.js', 'scheduler.js']`) and add `'recompute.js'` AFTER `flight-model.js` and `demand.js` (it depends on routing + flight-model + demand):

```js
  for (const f of ['settings.js', 'routing.js', 'flight-model.js', 'demand.js', 'recompute.js', 'scheduler.js']) {
```

- [ ] **Step 2: Re-run the existing tests to confirm the module loads**

Run: `node tests/js_recompute.test.mjs`
Expected: all Task 2 + Task 3 tests now pass (`S.CNSRecompute` resolves).

- [ ] **Step 3: Write the failing `recomputeAll` test**

Append to `tests/js_recompute.test.mjs`:

```js
test('recomputeAll: recomputes every trip and sets feasible on each', () => {
  S.CNSSettings.reset();
  const trips = [tripFor('EHAM', 'EHGG'), tripFor('EHAM', 'LFPG')];
  const out = S.CNSRecompute.recomputeAll(trips, ctx());
  if (out.length !== 2) throw new Error('expected 2 trips back');
  if (!out.every(t => typeof t.feasible === 'boolean')) throw new Error('every trip must get a feasible flag');
});
```

- [ ] **Step 4: Run — expect FAIL, then implement `recomputeAll`**

Run: `node tests/js_recompute.test.mjs` → FAIL `recomputeAll is not a function`.

In `static/recompute.js` add before `return`:

```js
    // The queue: recompute every trip (by value) and return the updated list. Pure —
    // the caller persists + re-renders. Any one trip that throws is marked infeasible
    // rather than aborting the whole pass.
    function recomputeAll(trips, ctx) {
        return (trips || []).map(t => {
            try { return recomputeFlight(t, ctx); }
            catch (e) { return { ...t, feasible: false, infeasibleReason: 'recompute error: ' + (e && e.message) }; }
        });
    }
```

Update export: `return { mergeManualFlags, recomputeFlight, recomputeAll };`

- [ ] **Step 5: Run — expect PASS**

Run: `node tests/js_recompute.test.mjs` → all pass.

- [ ] **Step 6: Load `recompute.js` in `index.html`**

The static JS is loaded at `index.html:2029-2031` (`demand.js`, `routing.js`, `flight-model.js`). Add `recompute.js` immediately **after** `flight-model.js` (line 2031) — it needs `CNSRouting`, `CNSFlight`, `CNSDemand` defined first:

```html
    <script src="/static/recompute.js?v={{ asset_version }}"></script>
```

- [ ] **Step 7: Commit**

```bash
git add static/recompute.js tests/golden_capture.mjs templates/index.html tests/js_recompute.test.mjs
git commit -m "feat(dc): recomputeAll queue + load recompute.js (app + test stack)"
```

---

## Task 5: Triggers + debounced orchestration (index.html)

**Files:**
- Modify: `templates/index.html` (settings subscribe ~`:4664`; modal-open; routing signature ~`:3814`)

- [ ] **Step 1: Add the debounced `recomputeAllFlights` orchestrator**

Near `renderFolder` in `index.html`, add:

```js
        // Re-plan every saved flight under current settings (preserve manual stops,
        // honour the alternate divert reserve via planChain), persist, then render.
        let _recomputeTimer = null;
        function _recomputeCtx() {
            return {
                allAirports,
                allowedTypes: _allowedTypes(),
                planeFor: (t) => ({ id: t.planeId, name: t.planeName, battery_kwh: t.battery, range_km: t.range_km, speed_kmh: t.speed_kmh, c_rate: t.c_rate }),
                availableRangeKm: (plane) => _availableRangeKm(plane),
            };
        }
        function recomputeAllFlights() {
            if (!window.CNSRecompute) { renderFolder(); return; }
            const trips = CNSDemand.loadFolder();
            if (!trips.length) { renderFolder(); return; }
            CNSDemand.saveFolder(CNSRecompute.recomputeAll(trips, _recomputeCtx()));
            renderFolder();
        }
        function recomputeAllFlightsDebounced() {
            clearTimeout(_recomputeTimer);
            _recomputeTimer = setTimeout(recomputeAllFlights, 250);
        }
```

- [ ] **Step 2: Replace the bare `renderFolder()` in the settings subscribe (≈:4669)**

In the `CNSSettings.subscribe(() => { … })` handler at ~`:4664`, change `if (typeof renderFolder === 'function') renderFolder();` to:

```js
                if (typeof recomputeAllFlightsDebounced === 'function') recomputeAllFlightsDebounced();
```

- [ ] **Step 3: Recompute on Model-settings modal open**

The Model-settings modal is `#modelSettingsModal` (`index.html:1689`; there's an existing `_msModal = document.getElementById('modelSettingsModal')` reference near `:4718`). Add a `shown.bs.modal` listener:

```js
        document.getElementById('modelSettingsModal')?.addEventListener('shown.bs.modal', () => {
            if (typeof recomputeAllFlights === 'function') recomputeAllFlights();
        });
```

- [ ] **Step 4: Add `sidStarPadding` to the planner routing signature (≈:3814)**

Change the `sig` line so a SID/STAR change also re-plans the live form:

```js
                    const sig = `${rs.landingReserve.enabled ? rs.landingReserve.minLandingSoc : '-'}|${rs.routingPadding.enabled ? rs.routingPadding.factor : '-'}|${(rs.sidStarPadding && rs.sidStarPadding.enabled) ? rs.sidStarPadding.km : '-'}|${(rs.alternateReserve && rs.alternateReserve.enabled) ? 1 : 0}`;
```

- [ ] **Step 5: Manual smoke test (browser)**

Start the server, add a one-way/retour flight to the DC at a comfortable range. Open Model settings, raise Landing reserve / drop a plane's range so a leg goes over-range. Confirm: the DC flight's route re-plans (gains a stop) or, if no route exists, the trip now carries `feasible:false` (inspect `localStorage.cns_folder`). Toggle Alternate reserve and confirm a borderline flight flips. (How it *displays* infeasible is the deferred follow-up — for now verify the stored `feasible` flag changes.)

- [ ] **Step 6: Full suite**

Run: `CNS_BASE_URL=http://127.0.0.1:5055 bash tests/run_all.sh`
Expected: `ALL LAYERS PASSED` (add `node tests/js_recompute.test.mjs` to `tests/run_all.sh` if not already in the JS-suite loop).

- [ ] **Step 7: Commit**

```bash
git add templates/index.html tests/run_all.sh
git commit -m "feat(dc): recompute all flights on settings change + modal open (debounced)"
```

---

## Task 6: Wire `js_recompute` into the suite + final verification

**Files:**
- Modify: `tests/run_all.sh`

- [ ] **Step 1: Ensure `js_recompute.test.mjs` runs in `run_all.sh`**

If the JS suite loop enumerates files, confirm `js_recompute.test.mjs` is included; otherwise add it next to the other `node tests/js_*.test.mjs` invocations.

- [ ] **Step 2: Run the full suite**

Run: `CNS_BASE_URL=http://127.0.0.1:5055 bash tests/run_all.sh`
Expected: Python 70 OK, all JS suites pass incl. `js_recompute`, goldens reproduce, sched-snapshot zero drift → `ALL LAYERS PASSED`.

- [ ] **Step 3: Commit (if run_all.sh changed)**

```bash
git add tests/run_all.sh
git commit -m "test: run js_recompute in the suite"
```

---

## Self-review notes (coverage)

- Spec §4 data model → Task 2 (`_manual`) + Task 3 (`feasible`/`infeasibleReason`). Legacy trips → Task 3 "anyTagged" fallback.
- Spec §5.1 `planChain` → Task 1.
- Spec §5.2 `recomputeFlight` incl. alternate `alternate_km` on nodes + reach+divert feasibility → Task 3.
- Spec §5.3 `recomputeAll` queue → Task 4; debounce + persist + render → Task 5.
- Spec §5.4 triggers (settings change, modal open) + adjacent `sidStarPadding` signature fix → Task 5.
- Spec §6 same-path (shared `planChain` + engine) + idempotency test → Tasks 1 & 3.
- Spec §8 testing (planChain, feasibility flip, self-heal, alternate, idempotency) → Tasks 1, 3, 4.
- Deferred (spec §9): DC display of infeasible flights; add-flow-on-engine unification — NOT in this plan.
