# Map Hierarchy + WYSIWYG Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The live planner routes through exactly what the map shows (sizes ∪ network sites); saved DC flights recompute against the full catalog (model settings only); declutter hides everything except the route; leg labels renamed and drawn under markers.

**Architecture:** One new pool primitive — `allowedIdents` (a Set) alongside `allowedTypes` in `CNSRouting.planRoute`/`planChain` — threaded to the live-planner callers from the map state, and to the DC recompute as the full catalog. Declutter extends the existing `_applyAirportVisibility` pattern to the network layer. Leg labels move to a dedicated pane below the route panes.

**Tech Stack:** vanilla JS (browser globals), Leaflet panes, node test harnesses (`tests/js_*.test.mjs`), Flask app on :5055 for the API/golden layers.

**Spec:** `docs/superpowers/specs/2026-06-10-map-hierarchy-wysiwyg-planning-design.md`

**Conventions (read first):**
- Run everything from the repo root. Server: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python app.py` → :5055. Template edits need a server restart; `static/*.js` edits need only a browser reload.
- Full gate: `CNS_BASE_URL=http://127.0.0.1:5055 bash tests/run_all.sh` → must end `ALL LAYERS PASSED`.
- Every commit message ends with `Co-Authored-By:` the session trailer used by this repo (see `git log`).
- Another session works in this checkout: before each commit run `git status --short` and stage ONLY the files this plan names.

---

### Task 1: `allowedIdents` in CNSRouting (pool primitive)

**Files:**
- Modify: `static/routing.js` (planRoute candidate filter + planChain pass-through)
- Test: `tests/js_routing.test.mjs`

- [ ] **Step 1: Write the failing tests** — append before the final `console.log` summary in `tests/js_routing.test.mjs`:

```js
// WYSIWYG pool: allowedIdents admits a candidate whose TYPE is filtered off —
// the live planner passes the NRG2fly charger idents here, so a network site is
// routable whenever it is shown, regardless of its size class.
test('allowedIdents admits an ident whose type is not in allowedTypes', () => {
  const O = node('O', 0), D = node('D', 3);                       // 333.6 km, reach 200 → needs a stop
  const S = apT('S', 1.5, 'small_airport');                       // the only bridge, small type
  const res = loadRouting({ usable: 1.0, route: 1.0 }).planRoute({
    origin: O, destination: D, plane: PLANE(200),
    allowedTypes: ['medium_airport'],                              // small NOT allowed by type…
    allowedIdents: new Set(['S']),                                 // …but shown as a network site
    allAirports: [S], options: { maxLegKm: 200 },
  });
  assert.ok(!res.error, 'network ident must be routable: ' + res.error);
  assert.equal(res.stops.map(s => s.ident).join(','), 'S');
});

test('without allowedIdents the same small-type bridge is rejected (regression)', () => {
  const res = loadRouting({ usable: 1.0, route: 1.0 }).planRoute({
    origin: node('O', 0), destination: node('D', 3), plane: PLANE(200),
    allowedTypes: ['medium_airport'], allAirports: [apT('S', 1.5, 'small_airport')],
    options: { maxLegKm: 200 },
  });
  assert.ok(res.error, 'expected no-route without the ident pool');
});
```

(`apT`, `node`, `PLANE`, `loadRouting` already exist in this file — `apT` was added by the soft-preference tests.)

- [ ] **Step 2: Run to verify both fail**

Run: `node tests/js_routing.test.mjs`
Expected: first new test FAILs (`network ident must be routable`); second passes (it pins today's behavior). 1 failure total.

- [ ] **Step 3: Implement in `static/routing.js`**

In `planRoute`, after `const allowedSet = new Set(opts.allowedTypes || []);` add:

```js
        // WYSIWYG pool: idents admitted regardless of type — the live planner passes
        // the shown NRG2fly charger sites; the DC recompute passes the full network.
        const allowedIdents = opts.allowedIdents instanceof Set
            ? opts.allowedIdents : new Set(opts.allowedIdents || []);
```

In `candidates(cap)`, replace the type gate:

```js
                if (!allowedSet.has(a.type) && !allowedIdents.has(a.ident)) continue;
```

In `planChain`, pass it through — in the `planRoute({...})` call inside the gap loop add one line after `allowedTypes,`:

```js
                allowedTypes, allowedIdents: opts.allowedIdents,
```

- [ ] **Step 4: Run tests**

Run: `node tests/js_routing.test.mjs`
Expected: all pass (23).

- [ ] **Step 5: Commit**

```bash
git add static/routing.js tests/js_routing.test.mjs
git commit -m "feat(routing): allowedIdents pool — idents routable regardless of type class"
```

---

### Task 2: DC recompute pool = full catalog

**Files:**
- Modify: `static/recompute.js` (forward `ctx.allowedIdents`)
- Modify: `templates/index.html` (`_recomputeCtx()` — stop reading map filters)
- Test: `tests/js_recompute.test.mjs`

- [ ] **Step 1: Write the failing tests** — append before the final summary in `tests/js_recompute.test.mjs`:

```js
test('recomputeFlight forwards ctx.allowedIdents (network site routable despite type filter)', () => {
  S.CNSSettings.reset();
  // EHAM→EGLL at reach 350 needs the EHRD bridge. EHRD is presented as a
  // small_airport with only medium/large allowed by type — feasible ONLY when
  // ctx.allowedIdents admits it (the DC passes the full network here).
  const pool = [ap('EHAM'), ap('EHRD', 'small_airport'), ap('EGLL')];
  const base = { ...ctx(), allAirports: pool, allowedTypes: ['medium_airport', 'large_airport'],
    availableRangeKm: () => 350 };
  if (S.CNSRecompute.recomputeFlight(tripFor('EHAM', 'EGLL'), base).feasible !== false)
    throw new Error('control: small-type bridge must be rejected without the ident pool');
  const out = S.CNSRecompute.recomputeFlight(tripFor('EHAM', 'EGLL'),
    { ...base, allowedIdents: new Set(['EHRD']) });
  if (out.feasible !== true) throw new Error('ctx.allowedIdents must admit EHRD: ' + out.infeasibleReason);
});

test('index.html: _recomputeCtx is map-filter independent (full catalog, settings-only)', () => {
  const fs2 = require('node:fs');
  const html = fs2.readFileSync(new URL('../templates/index.html', import.meta.url), 'utf8');
  const m = html.match(/function _recomputeCtx\(\) \{([\s\S]*?)\n        \}/);
  if (!m) throw new Error('_recomputeCtx not found');
  if (m[1].includes('_allowedTypes()'))
    throw new Error('_recomputeCtx must NOT read the map filters — saved flights react to model settings only');
  for (const must of ['small_airport', 'medium_airport', 'large_airport', 'allowedIdents'])
    if (!m[1].includes(must)) throw new Error(`_recomputeCtx missing ${must} (full-catalog pool)`);
});
```

NOTE: this file is ESM — `require` is unavailable. Use the existing import style instead: add `import fs from 'node:fs';` is already present at the top (verify; if absent, add it) and write the second test with `fs.readFileSync(path.join(REPO, 'templates', 'index.html'), 'utf8')` — `REPO` and `path` already exist in this file. Do NOT ship the `require` form above; it is shown only to convey intent.

- [ ] **Step 2: Run to verify failure**

Run: `node tests/js_recompute.test.mjs`
Expected: both new tests FAIL (forwarding missing; ctx still reads `_allowedTypes()`).

- [ ] **Step 3: Implement**

`static/recompute.js` — in `recomputeFlight`'s `planChain` call add the forward:

```js
        const chain = window.CNSRouting.planChain({
            origin, dest, manualStops, plane,
            allowedTypes: ctx.allowedTypes, allAirports: ctx.allAirports,
            allowedIdents: ctx.allowedIdents,
```

(keep the existing comment + `maxLegKm`/`options` lines as they are).

`templates/index.html` — replace the body of `_recomputeCtx()`:

```js
        function _recomputeCtx() {
            // Saved flights are immune to MAP options: the recompute pool is the FULL
            // catalog (every size class + every network site). Feasibility is a pure
            // physics verdict driven by Model settings — the map filters are a view
            // lens for the live planner only (see the 2026-06-10 hierarchy spec).
            return {
                allAirports,
                allowedTypes: ['small_airport', 'medium_airport', 'large_airport'],
                allowedIdents: new Set(Object.keys(nrgChargerDb || {})),
                planeFor: (t) => ({ id: t.planeId, name: t.planeName, battery_kwh: t.battery, range_km: t.range_km, speed_kmh: t.speed_kmh, c_rate: t.c_rate }),
                availableRangeKm: (plane) => _availableRangeKm(plane),
                routingOptions: _routingOptions(),   // soft Prefer bias — stop choice, never feasibility
            };
        }
```

- [ ] **Step 4: Run tests**

Run: `node tests/js_recompute.test.mjs`
Expected: all pass (14).

- [ ] **Step 5: Commit**

```bash
git add static/recompute.js tests/js_recompute.test.mjs templates/index.html
git commit -m "feat(dc): recompute pool = full catalog — saved flights immune to map options"
```

(`git status --short` first; if another session has unstaged hunks in `templates/index.html`, stage selectively with a single-hunk patch via `git diff` + `git apply --cached` as done for cf029e2/03c5247.)

---

### Task 3: Live planner WYSIWYG pool

**Files:**
- Modify: `templates/index.html` (`_plannerAllowedIdents()` helper; thread into `recomputeRoute` + `_couldEnablingTypesRoute`; no-route message hint)

- [ ] **Step 1: Add the helper** next to `_allowedTypes()`:

```js
        // The live planner's WYSIWYG ident pool: NRG2fly charger sites are routable
        // whenever the network layer is SHOWN, regardless of their size class.
        // (Declutter is view-only and does not affect this set.)
        function _plannerAllowedIdents() {
            const t = document.getElementById('nrgChargerToggle');
            const netOn = !t || t.checked;
            return netOn ? new Set(Object.keys(nrgChargerDb || {})) : new Set();
        }
```

- [ ] **Step 2: Enumerate the live-planner call sites**

Run: `grep -n "CNSRouting.planChain(\|CNSRouting.planRoute(\|planRoute({" templates/index.html`
Expected call sites (verify — add `allowedIdents: _plannerAllowedIdents(),` after each `allowedTypes:` line):
- `recomputeRoute()` → the `CNSRouting.planChain({...})` call
- `_couldEnablingTypesRoute()` → the `CNSRouting.planRoute({...})` probe
If the grep shows additional planner-side call sites (e.g. an edit-modal replan), thread the same line there too. Do NOT touch `static/recompute.js` (Task 2 owns it via ctx).

- [ ] **Step 3: Make the no-route message network-aware** — in `renderStops()`'s `plannedError` branch, the `else` message currently reads "even with every airport type…". Replace that string with:

```js
                    hintEl.innerHTML = `<span class="stops-error-inline">No route within range — even with every airport type and the NRG2fly network, this aircraft can't bridge a leg to the destination at the current reserves. Use a longer-range aircraft, or lower the landing reserve, SID/STAR or alternate reserve.</span>`;
```

and make `_couldEnablingTypesRoute()`'s probe use the full ident pool regardless of the toggle (so the probe asks "would showing everything route it?"):

```js
                const r = CNSRouting.planRoute({
                    origin: a, destination: b, plane,
                    allAirports: filtered, allowedTypes: allowed,
                    allowedIdents: new Set(Object.keys(nrgChargerDb || {})),
                    options: { ..._routingOptions(), maxLegKm: maxLeg },
                });
```

- [ ] **Step 4: Verify in browser** (template change → restart server)

Restart :5055. In the planner pick a Velis and a route bridgeable ONLY via a network charger site whose size class is unchecked (e.g. uncheck Small, plan across a small-airfield network site). Expected: the Suggested route uses the network site. Toggle "Show charger sites" off → re-plan → site no longer used (or no-route).

- [ ] **Step 5: Run the full suite + commit**

Run: `CNS_BASE_URL=http://127.0.0.1:5055 bash tests/run_all.sh` → `ALL LAYERS PASSED`

```bash
git add templates/index.html
git commit -m "feat(planner): WYSIWYG pool — shown network sites are routable, hidden ones are not"
```

---

### Task 4: True declutter

**Files:**
- Modify: `templates/index.html` (network layer respects the hide flag; checkbox relabeled + moved to ROUTE group)

- [ ] **Step 1: Hide the network layer when decluttered** — in `refreshNrgChargerLayer()`, right after `nrgChargerLayer.clearLayers();` add:

```js
            // Declutter: with a route on screen and the toggle set, the network layer
            // hides like the size clusters — the route keeps its own blue teardrops.
            // View-only: the planner pool reads the FILTER state, never this.
            if (_hideAirportsOnRoute && _routeEndpoints.length > 0) return;
```

- [ ] **Step 2: Re-render the network layer when the toggle flips** — the `hideAirportsOnRoute` change handler currently calls only `_applyAirportVisibility()`; extend it:

```js
        if (_hideApToggle) _hideApToggle.addEventListener('change', (e) => {
            _hideAirportsOnRoute = e.target.checked;
            _applyAirportVisibility();
            refreshNrgChargerLayer();
        });
```

Also verify `setRoute()` already calls `refreshNrgChargerLayer()` (it does — route changes re-render the layer; no extra wiring).

- [ ] **Step 3: Relabel + move the checkbox** — in the options menu markup, delete the `hideAirportsOnRoute` label row from the AIRPORTS group and insert it in the ROUTE group after the Alternates row:

```html
                        <label class="opt-check"><input type="checkbox" id="hideAirportsOnRoute"><span>Declutter when route is planned</span></label>
```

- [ ] **Step 4: Browser verify** — restart, plan a route, tick Declutter: ALL orange dots **and** network teardrops vanish; only the route (line, blue dots/teardrops, leg labels) remains. Untick → layers return. Planner re-plan while decluttered still uses the filters' pool.

- [ ] **Step 5: Commit**

```bash
git add templates/index.html
git commit -m "feat(map): true declutter — network layer hides with the size clusters (view-only)"
```

---

### Task 5: Leg labels — rename + under-marker pane + lift off the line

**Files:**
- Modify: `templates/index.html` (strings, pane, CSS)

- [ ] **Step 1: User-facing strings only** (the `flightLabel*` JS identifiers were just renamed by another session — leave them):
- Options menu: `<span>Show flight labels</span>` → `<span>Leg labels</span>` (the Expand row stays "Expand labels").
- Check tour copy: `grep -n "flight label" static/tour.js` — if a popover description says "flight labels", update the words to "leg labels" (anchors unchanged).

- [ ] **Step 2: Dedicated pane below the route panes** — where panes are created (`map.createPane('routePane')` block) add:

```js
        map.createPane('legLabelPane');                 // leg pins: above airports, below route markers
        map.getPane('legLabelPane').style.zIndex = 640; // markerPane 600 < this < routePane 650 < teardropPane 660
```

and in the leg-pin `L.marker(...)` creation add `pane: 'legLabelPane',` to its options (keep `riseOnHover`).

- [ ] **Step 3: Lift the pill off the line** — in the `.flight-pin` CSS rule add:

```css
            transform: translateY(-130%);   /* float above the leg line so the pill never sits on the route or its markers */
```

- [ ] **Step 4: Browser verify** — restart; plan a multi-stop route: pills float just above each leg, route markers/teardrops always render on top of any overlapping pill; hover still expands; "Expand labels" still opens all.

- [ ] **Step 5: Commit**

```bash
git add templates/index.html static/tour.js
git commit -m "ux(map): leg labels — rename, dedicated pane under route markers, lifted off the line"
```

(Drop `static/tour.js` from the add if Step 1's grep found nothing to change.)

---

### Task 6: Menu regroup + final gate

**Files:**
- Modify: `templates/index.html` (group labels)
- Verify: tour anchors, full suite

- [ ] **Step 1: Regroup labels** in the options menu:
- `<div class="opt-label">Airports shown on map</div>` → `<div class="opt-label">Airports (planning)</div>`
- `<div class="opt-label">NRG2fly network</div>` → `<div class="opt-label">NRG2fly network (planning)</div>`
(ROUTE and BASEMAP labels unchanged; Task 4 already moved Declutter into ROUTE.)

- [ ] **Step 2: Tour anchor check** — restart :5055, open the browser console, run `CNSTour.check()`. Expected: every step resolves (the `#folder …` anchors may read missing pre-drawer — that's documented as expected). If an options-menu step anchors to the moved checkbox row, update its selector in `static/tour.js` (anchor by `#hideAirportsOnRoute`, which is unchanged, so likely no-op).

- [ ] **Step 3: Full suite**

Run: `CNS_BASE_URL=http://127.0.0.1:5055 bash tests/run_all.sh`
Expected: `ALL LAYERS PASSED` (goldens/sched untouched — no model change in this feature).

- [ ] **Step 4: Commit**

```bash
git add templates/index.html static/tour.js
git commit -m "ux(map): options menu reads as the layer hierarchy — (planning) groups + ROUTE"
```

- [ ] **Step 5: Hold for review** — present on :5055; push only on Edgar's word.

---

## Self-review (done at write time)
- **Spec coverage:** C1→T1+T3, C2→T2, C3→T4, C4→T5, C5→T6; edge cases: manual-stop exemption untouched (planChain semantics unchanged), Enable-all-types probe in T3, tour in T5/T6, view-only declutter asserted in T4 comment + spec.
- **Placeholders:** none; the one intent-vs-final code note (Task 2 ESM `require`) is explicit with the correct alternative spelled out.
- **Type consistency:** `allowedIdents` is a `Set` end-to-end (routing accepts Set-or-iterable defensively); ctx key names match between recompute.js and `_recomputeCtx`.
