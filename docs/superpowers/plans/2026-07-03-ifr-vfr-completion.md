# IFR/VFR Completion (browser wiring + regime UI + per-route) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the IFR/VFR realism cutover end-to-end: make the browser actually run the regime engine (it currently falls back to the retired flat model), stop every UI/PDF surface from printing the confidential gross range, align the router/import with the regime reach, add the VFR/IFR control, and make `ruleMode` per-route.

**Architecture:** The engine cutover is already committed (`3b7f93a` on `feat/perf-engine`, worktree `../cns-perf`) — `CNSPlaneSchema.usableRange()` builds the planning range down per regime and `CNSFlight.simulateTrip` reads it. This plan (A) exposes ONE reach seam from `CNSFlight` and points every consumer (planner, router, spec card, report, import) at it, (B) adds the global VFR/IFR control, (C) moves `ruleMode` onto each route. Phases are sequential; each ends shippable-green with its own golden gate.

**Tech Stack:** Vanilla JS browser globals (IIFE modules in `static/`), Flask + Python stdlib, node `vm` test harnesses, golden tests (`tests/golden_capture.mjs`, `tests/sched_snapshot.mjs`).

## Global Constraints

- **Worktree:** all work in `/Users/edgar/Documents/NRG2FLY/cns-perf` on branch `feat/perf-engine`. Python runs via the main checkout's venv: `PYBIN="/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/venv/bin/python"`. Never touch the user's `:5055` server (it serves the MAIN checkout); the worktree test server runs on `:5082`.
- **Confidentiality (OEM rule):** the gross `range_km` figures (Beta 630, Vaeridion 700) are **internal ePerKm drivers only** — the OEM explicitly asked not to publicise undisclosed figures. **No UI/PDF surface may present a gross range figure.** Surfaces show the *planning/usable* range (regime build-down). Derived consumption (kWh/100km) stays — the rule covers presented *range* figures. `planes.json` being client-fetchable is a known, accepted residual.
- **No flag / hard cutover:** the realism engine is always on; the only mode toggle is VFR vs IFR. Rollback = `git revert`. (Supersedes the R12 ship-behind-a-flag convention for this module — recorded in Task A0.)
- **Golden gate ritual per phase:** run `node tests/golden_capture.mjs --check` + `node tests/sched_snapshot.mjs`; eyeball any drift; re-bless (`node tests/golden_capture.mjs` / `node tests/sched_snapshot.mjs --capture`) only deliberately, as its own commit-reviewed act.
- **Lanes:** do NOT edit `static/mobile.js`, `templates/index_mobile.html`, `static/mobile.css` (mobile session's lane) or retire `sim.py` energy (G3). Mobile impact is flagged in PR text (Task C6), not fixed here.
- **Reference numbers (Beta, catalog 630 gross / 225 kWh / 250 km/h / divert_km 50, defaults: floor 0.30, reserve VFR 30 / IFR 45 min, sidStar 10 km ON, routingPadding OFF):** planning range VFR **316.0** km, IFR **203.5** km (441 − 187.5 − 50); router-enforced reach VFR **316.0**, IFR **193.5** (− 10 sidStar). Velis planning range **0** (reserve exceeds endurance) — training energy is UNAFFECTED (energy floor is decoupled from the reach).
- **UI copy:** aviation-professional, terse ("Usable range", "IFR", "VFR" — no chatty phrasing).
- **Commits:** end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Tests green before every commit: JS via `node tests/<f>.test.mjs`, Python via `CNS_BASE_URL=http://localhost:5082 DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib "$PYBIN" -m unittest discover -s tests -p "test_*.py"`.

---

# Phase A — Coherence: the reach seam, browser wiring, de-leak, import

**Why first:** on the branch today the browser does NOT load `plane-schema.js`, so `_availableRangeKm` falls back to `range_km × usableFraction` = 630 × 0.7 = **441 km** — *more* optimistic than pre-cutover (400) and with zero regime reserve, while the engine says 193.5. The branch must not merge without this phase.

### Task A0: Sync the spec docs with the ruled reality (docs only)

**Files:**
- Modify: `docs/performance-engine.md`
- Modify: `docs/performance-engine-step2-plan.md`

**Interfaces:** none (prose). Later tasks cite these decisions.

- [ ] **Step 1: Update the worked examples for the 30% floor.** In `docs/performance-engine.md` §3.5 replace `Worked: **Beta @ 630 km gross, 250 km/h → 379 km VFR / 316.5 km IFR.**` with `Worked: **Beta @ 630 km gross, 250 km/h, 30% floor → 316 km VFR / 253.5 km IFR (− 50 km divert → 203.5 IFR planning).**` In §5.2 replace the sentence beginning `**Worked example — Beta @ 630 km gross, 250 km/h, 20% min-SoC:**` through `…≈ **316 km**.` with:
  `**Worked example — Beta @ 630 km gross, 250 km/h, 30% min-SoC (advised floor, ruled 2026-06-30):** usable battery = 441 km; VFR (− 125 km) = **316 km**; IFR (− 187.5 km, − 50 km divert ÷ routing) ≈ **203.5 km**.`
- [ ] **Step 2: Append the new ruled decisions to §13** (after decision 6):
  ```markdown
  7. **No realism flag — RULED (2026-06-30): hard cutover.** The regime engine is always on; the only
     mode toggle is VFR vs IFR. Today's flat `usableFraction` reach is retired; rollback = `git revert`.
     (Consciously overrides the R12 ship-behind-a-flag convention for this module.)
  8. **Usable ENERGY vs regime RESERVE — RULED: decoupled.** The min-SoC floor (30%, advised) bounds the
     usable/chargeable energy (charge targets, training caps). The regime reserve (VFR 30 / IFR 45 min)
     shortens only the cross-country REACH. Coupling them zeroes a short-endurance trainer's energy
     (Velis training bug, caught by the golden gate).
  9. **Gross figures are internal — RULED.** `range_km` now stores the gross (Beta 630, slightly above the ~336 nm demonstrated figure; Vaeridion
     700 via the operational energy-balance estimate) as the ePerKm driver. The OEMs did not publish these
     figures: no UI/PDF surface presents them; surfaces show the regime planning range. Vaeridion's live
     scalar is NOT the published 400 (setting it there would make ePerKm = batt/400 and zero the reserve
     energy); the 400 IFR@MTOW stays a measurement and IS the IFR planning range. Per-plane `divert_km`
     (Beta 50) folds the standard divert into the IFR reach; per-node alternates count only their excess.
  ```
- [ ] **Step 3: Fix the R8-bis fallback line.** In §5.2 R8-bis replace `so the change stays identity-preserving for any plane without `reserve_min` (behaves exactly as today)` with `every plane computes (all carry `range_km` + `speed_kmh`; `RESERVE_MIN` supplies regime defaults) — the flat `usableFraction` survives only as the energy floor and as the reach fallback when `plane-schema.js` is not loaded`.
- [ ] **Step 4: Correct the step-2 runbook S3.** In `docs/performance-engine-step2-plan.md` S3, replace the Vaeridion bullet (`Vaeridion `range_km` 500 → **400** …`) with: `Vaeridion `range_km` 500 → **700 gross** (energy-balance estimate: 600 kWh, 30% floor, 45-min IFR reserve @190 kt + 80 km divert, ≤40-min/800-kW turnaround); `speed_kmh` → 435. The published 400 km IFR@MTOW stays a `usable_incl_reserve` measurement (the IFR planning range). Setting the live scalar to 400 would zero the reserve energy (ePerKm = 600/400 uses the whole battery) — caught in review.` Update the S3 sanity line to `Beta ≈ 316 VFR / 253.5 IFR (203.5 with divert), Vaeridion 400 IFR, Velis IFR infeasible`.
- [ ] **Step 5: Verify nothing but docs changed and commit.**
  Run: `cd /Users/edgar/Documents/NRG2FLY/cns-perf && git diff --stat`
  Expected: only the two docs.
  ```bash
  git add docs/performance-engine.md docs/performance-engine-step2-plan.md
  git commit -m "docs(perf-engine): record ruled decisions — 30% floor, no-flag cutover, energy/reach decoupling, Vaeridion 700-gross, confidentiality"
  ```

### Task A1: The single reach seam — `CNSFlight.effectiveRegime / planningRangeKm / availableRangeKm`

**Files:**
- Modify: `static/flight-model.js` (~L69–90 `simulateTrip` head + the public-API return at the bottom of the IIFE)
- Test: `tests/js_flight_model.test.mjs` (append a block)

**Interfaces:**
- Consumes: `CNSPlaneSchema.usableRange(plane, regime, context, opts)` / `ifrCapable(plane)` (already shipped); internal `_usableRangeKm(plane, regime)` (flight-model.js:42), `_ruleMode()`, `_routingFactor()`, `_sidStarKm()`, `_usableFraction()`.
- Produces (used by A3, A4, A5, B2, C2):
  - `CNSFlight.effectiveRegime(plane, ruleMode?) → 'vfr' | 'ifr'` — plane-gated (`!ifrCapable → 'vfr'`), else `ruleMode ?? global CNSSettings.ruleMode()`.
  - `CNSFlight.planningRangeKm(plane, opts?) → number` — regime planning range (incl. IFR flat `divert_km`), BEFORE the sidStar/route carve. `opts = { ruleMode? }`. Beta: 316 VFR / 203.5 IFR.
  - `CNSFlight.availableRangeKm(plane, opts?) → number` — the router-enforced reach: `max(0, planningRange − sidStar(regime)) / route(regime)`. Beta IFR: 193.5.

- [ ] **Step 1: Write the failing test.** Append to `tests/js_flight_model.test.mjs` (before the final summary `console.log`):

```js
// ---- the single reach seam: every consumer (planner UI, router, displays) reads these ----
(function reachSeam() {
  const S = loadStack();
  const beta = PLANES['beta_plane'];          // 630 gross, 225 kWh, 250 km/h, divert_km 50, IFR-capable
  const velis = PLANES['pipistrel_velis'];    // ifr_capable false (certified)
  S.CNSSettings.reset();                      // defaults: ruleMode ifr, sidStar 10 ON, routingPadding OFF
  const eq = (a, b, t) => Math.abs(a - b) < (t || 1e-6);
  const checks = [
    [S.CNSFlight.effectiveRegime(beta) === 'ifr', `effectiveRegime(beta) defaults to global ifr`],
    [S.CNSFlight.effectiveRegime(beta, 'vfr') === 'vfr', `explicit ruleMode wins`],
    [S.CNSFlight.effectiveRegime(velis, 'ifr') === 'vfr', `VFR-only plane is forced vfr`],
    [eq(S.CNSFlight.planningRangeKm(beta), 203.5), `beta IFR planning = 441 − 187.5 − 50 (got ${S.CNSFlight.planningRangeKm(beta)})`],
    [eq(S.CNSFlight.planningRangeKm(beta, { ruleMode: 'vfr' }), 316), `beta VFR planning = 441 − 125, no divert (got ${S.CNSFlight.planningRangeKm(beta, { ruleMode: 'vfr' })})`],
    [eq(S.CNSFlight.availableRangeKm(beta), 193.5), `beta IFR reach carves the 10 km sidStar (got ${S.CNSFlight.availableRangeKm(beta)})`],
    [eq(S.CNSFlight.availableRangeKm(beta, { ruleMode: 'vfr' }), 316), `beta VFR reach: no sidStar, no routing (got ${S.CNSFlight.availableRangeKm(beta, { ruleMode: 'vfr' })})`],
    [eq(S.CNSFlight.planningRangeKm(velis), 0), `velis planning range 0 — reserve exceeds endurance`],
    // engine parity: simulateTrip's enforced reach IS the seam value
    [eq(S.CNSFlight.simulateTrip(beta, [wp('EHAM'), wp('LFPG')], { tripType: 'one-way', getChargerKw: () => 250 }).availRangeKm,
        S.CNSFlight.availableRangeKm(beta)), `simulateTrip.availRangeKm === availableRangeKm(plane)`],
  ];
  for (const [okc, msg] of checks) {
    if (okc) { pass++; console.log(`  ok    seam — ${msg}`); }
    else { fail++; console.log(`  FAIL  seam — ${msg}`); }
  }
})();
```

- [ ] **Step 2: Run to verify it fails.**
  Run: `cd /Users/edgar/Documents/NRG2FLY/cns-perf && node tests/js_flight_model.test.mjs 2>&1 | grep "seam"`
  Expected: FAILs — `effectiveRegime is not a function`.
- [ ] **Step 3: Implement.** In `static/flight-model.js`, add above `function simulateTrip` (near the `_usableRangeKm` helper at :42):

```js
    // ---- the single reach seam (P3): planner UI, router and displays all read these ----
    function effectiveRegime(plane, ruleMode) {
        return _ifrCapable(plane) ? (ruleMode || _ruleMode()) : 'vfr';
    }
    // Regime planning range (incl. the IFR flat divert), BEFORE the sidStar/route carve —
    // this is the figure surfaces DISPLAY ("usable range"); never display plane.range_km (gross).
    function planningRangeKm(plane, opts) {
        return _usableRangeKm(plane, effectiveRegime(plane, opts && opts.ruleMode));
    }
    // The reach the router ENFORCES per leg: sidStar carved out, routing factor applied (IFR only).
    function availableRangeKm(plane, opts) {
        const regime = effectiveRegime(plane, opts && opts.ruleMode);
        const route = (regime === 'ifr') ? _routingFactor() : 1.0;
        const sid = (regime === 'ifr') ? _sidStarKm() : 0;
        return (route > 0) ? Math.max(0, _usableRangeKm(plane, regime) - sid) / route : 0;
    }
```

  In `simulateTrip`, replace the line (currently :88)
  `const availRangeKm = (route > 0) ? Math.max(0, planRangeKm - sidStar) / route : 0;   // …`
  with
  `const availRangeKm = availableRangeKm(plane, { ruleMode: opts.ruleMode });   // the seam — identical math, one owner`
  and add the three functions to the public-API return object of the IIFE (alongside `simulateTrip`, `tripPlane`, `profileForTrip`, …): `effectiveRegime, planningRangeKm, availableRangeKm,`.
- [ ] **Step 4: Run tests — seam block green, everything else unmoved.**
  Run: `node tests/js_flight_model.test.mjs` → `48 pass, 0 intended delta(s), 0 fail` (39 + 9 new).
  Run: `node tests/golden_capture.mjs --check` → `all 6 cases reproduce the golden.` (pure refactor — zero drift).
- [ ] **Step 5: Commit.**
  ```bash
  git add static/flight-model.js tests/js_flight_model.test.mjs
  git commit -m "feat(perf-engine): expose the reach seam — effectiveRegime/planningRangeKm/availableRangeKm on CNSFlight"
  ```

### Task A2: Load `plane-schema.js` in the desktop page (+ catalog-refresh guard for the node loaders)

**Files:**
- Modify: `templates/index.html:2421` (script includes)
- Verify: `tests/sched_snapshot.mjs` loader parity

**Interfaces:**
- Produces: `window.CNSPlaneSchema` exists in the browser BEFORE `flight-model.js` parses (same order the golden harness uses), so the engine stops silently falling back to the flat model.

- [ ] **Step 1: Add the include.** In `templates/index.html`, directly BEFORE the `flight-model.js` line (:2421), matching its form:

```html
    <script src="/static/plane-schema.js?v={{ asset_version }}"></script>
```

- [ ] **Step 2: Check the DES snapshot loader loads the same stack.**
  Run: `grep -n "plane-schema" tests/sched_snapshot.mjs || grep -nE "loadStack|golden_capture" tests/sched_snapshot.mjs`
  Expected: it imports/reuses `loadStack` from `golden_capture.mjs` (already includes `plane-schema.js`) — nothing to do. If it has its OWN file list without `plane-schema.js`, add `'plane-schema.js'` first in that list, rerun `node tests/sched_snapshot.mjs`, and if it drifts STOP and eyeball before `--capture` re-bless (loader parity is a legitimate drift).
- [ ] **Step 3: Verify in the browser.** Start the worktree server:
  `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib PORT=5082 "$PYBIN" app.py` (background, from `/Users/edgar/Documents/NRG2FLY/cns-perf`).
  Run: `curl -s http://127.0.0.1:5082/ | grep -c "plane-schema.js"` → `1`.
- [ ] **Step 4: Commit.**
  ```bash
  git add templates/index.html
  git commit -m "feat(perf-engine): load plane-schema.js on the desktop page — the regime engine goes live in the browser"
  ```

### Task A3: Point the planner's reach + leg-distance display at the seam

**Files:**
- Modify: `templates/index.html:2829–2848` (`_availableRangeKm`, `_availRangeShownKm`), plus every `CNSRouting.routedKm(a,b) + …sidStarPaddingKm()` display site (find via grep, ~3–6 sites, e.g. :2722–2735)
- Test: browser verification (node coverage for the seam itself landed in A1)

**Interfaces:**
- Consumes: `CNSFlight.effectiveRegime(plane)`, `CNSFlight.planningRangeKm(plane)`, `CNSFlight.availableRangeKm(plane)` (A1).
- Produces: `_availableRangeKm(plane) → km|null` (router/validator reach — unchanged signature, 7 existing callers keep working); `_availRangeShownKm(plane) → km|null` (displayed planning range); `_dispLegKm(a, b, plane) → km` (regime-aware displayed leg length — replaces the raw `routedKm + sidStar` pattern).

- [ ] **Step 1: Replace the two reach functions** (index.html :2829–2848). The manual override (`_availRangeOverride`, edited via `#psoAvailRange`) keeps its meaning: it replaces the *planning range* (shown figure), and the carve still applies for the enforced reach:

```js
        function _availableRangeKm(plane) {
            const p = plane || selectedPlaneSpec();
            if (!p || !p.range_km) return null;
            if (_availRangeOverride == null) return CNSFlight.availableRangeKm(p);
            // manual override replaces the planning range; carve sidStar/route the same way the engine does
            const regime = CNSFlight.effectiveRegime(p);
            const route = (regime === 'ifr' && window.CNSSettings) ? CNSSettings.routingFactor() : 1.0;
            const sid = (regime === 'ifr' && window.CNSSettings && CNSSettings.sidStarPaddingKm) ? CNSSettings.sidStarPaddingKm() : 0;
            return (route > 0) ? Math.max(0, _availRangeOverride - sid) / route : 0;
        }
        // The available range to DISPLAY/EDIT: the regime PLANNING range (never the gross catalog km).
        // The sidStar pad shows up in the LEG distance, not here; the router uses _availableRangeKm.
        function _availRangeShownKm(plane) {
            const p = plane || selectedPlaneSpec();
            if (!p || !p.range_km) return null;
            return _availRangeOverride != null ? _availRangeOverride : CNSFlight.planningRangeKm(p);
        }
```

- [ ] **Step 2: Regime-gate the displayed leg distances.** Run `grep -n "routedKm(" templates/index.html`. Add one helper next to `_availableRangeKm` and rewrite each *display* site that computes `CNSRouting.routedKm(a, b) + CNSSettings.sidStarPaddingKm()` (leg pills, route list, hover labels) to call it — VFR legs must not show the IFR pads the engine no longer burns:

```js
        // Displayed leg length — must match the engine's per-leg distKm (regime-gated pads).
        function _dispLegKm(a, b, plane) {
            const p = plane || selectedPlaneSpec();
            const regime = (window.CNSFlight && p) ? CNSFlight.effectiveRegime(p) : 'ifr';
            const raw = CNSRouting.haversineKm(a, b);
            const route = (regime === 'ifr' && window.CNSSettings) ? CNSSettings.routingFactor() : 1.0;
            const sid = (regime === 'ifr' && window.CNSSettings && CNSSettings.sidStarPaddingKm) ? CNSSettings.sidStarPaddingKm() : 0;
            return raw * route + sid;
        }
```
  Example rewrite — a site reading `const _dispKm = CNSRouting.routedKm(wa, wb) + CNSSettings.sidStarPaddingKm();` becomes `const _dispKm = _dispLegKm(wa, wb, plane);`. Leave non-display uses of `routedKm` (if any) untouched.
- [ ] **Step 3: Browser-verify (WYSIWYG + the sidStar display-parity invariant).** Reload `http://127.0.0.1:5082/`, select Beta, plan Lelystad → Frankfurt:
  - the route auto-inserts a charging stop (342 km direct > 193.5 IFR reach) — this is the agreed demo-with-stop;
  - spec-card "available range" ≈ **204 km** (planning) and the router hint/max-leg ≈ 194;
  - browser console: `CNSFlight.availableRangeKm(PLANES_BY_ID ? undefined : null)` — instead run `CNSTour.check()`-style spot check: `CNSFlight.planningRangeKm(Object.values(window.PLANES_BY_ID || {}).find(p=>p.id==='beta_plane') || null)` → 203.5. Select Velis → training still works, no 0-energy regression.
- [ ] **Step 4: Full JS suite + goldens (no engine drift expected — display + planner only).**
  Run: `for f in tests/js_*.test.mjs; do node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done` → no output.
  Run: `node tests/golden_capture.mjs --check` → all 6 reproduce.
- [ ] **Step 5: Commit.**
  ```bash
  git add templates/index.html
  git commit -m "feat(perf-engine): planner reach + displayed leg km read the regime seam (WYSIWYG with the engine)"
  ```

### Task A4: Router — regime-aware fallback + single-count divert (excess-over-flat)

**Files:**
- Modify: `static/routing.js:73–110` (fallback reach, `altReserveKm`), export one pure helper
- Test: `tests/js_routing.test.mjs` (append)

**Interfaces:**
- Consumes: `CNSFlight.availableRangeKm(plane, {ruleMode})`, `CNSFlight.effectiveRegime(plane, ruleMode)` (A1) — guarded, since some node tests load `routing.js` without `flight-model.js`.
- Produces: `CNSRouting.divertExcessKm(nodeAltKm, flatDivertKm, routingFactor) → km` (pure, exported); `planRoute(..., options)` now honours `options.ruleMode` (threaded by C2; defaults to the global). Leg feasibility becomes `legKm + divertExcessKm(node.alternate_km, flat, route) > maxLeg` — the flat `divert_km` already lives inside the IFR reach, so per-node alternates count only their EXCESS (P3 single-count; keeps display == planner).

- [ ] **Step 1: Write the failing test.** Append to `tests/js_routing.test.mjs`:

```js
// ---- single-count divert: the flat divert_km lives in the reach; nodes add only their excess ----
test('divertExcessKm: node within the flat divert adds nothing', () => {
  assert.equal(R.divertExcessKm(30, 50, 1.0), 0);
});
test('divertExcessKm: node beyond the flat divert adds only the excess', () => {
  assert.equal(R.divertExcessKm(80, 50, 1.0), 30);
});
test('divertExcessKm: routing factor de-inflates the node alternate before comparing', () => {
  // 84 km alternate at routingFactor 1.05 → 80 great-circle-equivalent → 30 excess
  assert.ok(Math.abs(R.divertExcessKm(84, 50, 1.05) - 30) < 1e-9);
});
test('divertExcessKm: absent/zero flat behaves like today (full node reserve)', () => {
  assert.equal(R.divertExcessKm(80, 0, 1.0), 80);
});
```
  (Match the file's existing `test`/assert idiom — adapt the wrapper name if it differs.)
- [ ] **Step 2: Run to verify it fails.**
  Run: `node tests/js_routing.test.mjs 2>&1 | tail -5` → FAIL `divertExcessKm is not a function`.
- [ ] **Step 3: Implement in `static/routing.js`.**
  (a) Pure helper + export:

```js
    // Per-node divert reserve counts only the EXCESS over the flat divert_km already
    // held inside the IFR reach (single-count seam — see performance-engine.md §13.9).
    function divertExcessKm(nodeAltKm, flatDivertKm, routingFactor) {
        const alt = (Number(nodeAltKm) || 0) / (routingFactor > 0 ? routingFactor : 1);
        return Math.max(0, alt - (Number(flatDivertKm) || 0));
    }
```
  Add `divertExcessKm,` to the module's public return.
  (b) In `planRoute` (:73–80), make the reach + factors regime-aware with the seam, keeping the standalone fallback:

```js
        const regime = (window.CNSFlight && CNSFlight.effectiveRegime)
            ? CNSFlight.effectiveRegime(plane, options && options.ruleMode) : 'ifr';
        const route = (regime === 'ifr' && window.CNSSettings) ? CNSSettings.routingFactor() : 1.0;
        const flatDivertKm = (regime === 'ifr') ? (Number(plane.divert_km) || 0) : 0;
        const maxLeg = (options && options.maxLegKm != null) ? options.maxLegKm
            : (window.CNSFlight && CNSFlight.availableRangeKm)
                ? CNSFlight.availableRangeKm(plane, { ruleMode: options && options.ruleMode })
                : Math.max(0, rng * usable) / route;   // standalone fallback (no flight-model loaded)
```
  (c) Rewrite `altReserveKm` (:93) to `const altReserveKm = (n) => requireAlt && n ? divertExcessKm(n.alternate_km, flatDivertKm, route) : 0;` — the `> maxLeg` checks at :109/:152 stay untouched.
  Keep variable names consistent with the file (adapt `rng`/`usable` names to what's there; do not leave two `maxLeg` definitions).
- [ ] **Step 4: Run the suite.**
  Run: `node tests/js_routing.test.mjs` → all pass. `node tests/js_recompute.test.mjs && node tests/js_flight_adapter.test.mjs` → pass (they exercise planChain).
  Run: `node tests/golden_capture.mjs --check && node tests/sched_snapshot.mjs` → expect **sched drift is possible** (routes may gain stops under the 193.5 reach). Eyeball: every change must be explainable as "leg > 193.5 now stops"; then re-bless `node tests/sched_snapshot.mjs --capture` as its own reviewed act.
- [ ] **Step 5: Commit.**
  ```bash
  git add static/routing.js tests/js_routing.test.mjs tests/goldens/sched-snapshot.json
  git commit -m "feat(perf-engine): router reads the regime reach; per-node diverts count only the excess over the flat divert_km"
  ```

### Task A5: De-leak every display surface (tiles, spec card, reach bar, report/PDF)

**Files:**
- Modify: `templates/index.html:3494–3501` (`_planeSpecsLine`), `:3613–3621` (`_renderReachBar`), `:3665–3679` (`_refreshSpecStats`) + the `psRange` label markup (grep `psRange` in the template, ~:1781–1810)
- Modify: `static/report.js:218` + the fleet-spec consumer in `templates/report.html` (grep `range_km`)
- Test: browser + PDF render verification

**Interfaces:**
- Consumes: `CNSFlight.planningRangeKm(plane, opts?)` (A1), `_availRangeShownKm` (A3).
- Produces: no surface prints `range_km`. Report payload plane summary carries `usable_range_km` instead of `range_km`.

- [ ] **Step 1: Aircraft tiles** — replace the gross with the planning range; trainers with a zero planning range show their local/pattern figure (index.html :3494):

```js
        function _planeSpecsLine(p) {
            const bits = [];
            if (p.seats != null) bits.push(p.seats + ' seats');
            if (p.battery_kwh != null) bits.push(fmtEnergy(+p.battery_kwh));
            const planKm = (window.CNSFlight && CNSFlight.planningRangeKm) ? CNSFlight.planningRangeKm(p) : null;
            if (planKm > 0) bits.push(fmtDist(planKm));
            else if (p.training_range_km) bits.push(fmtDist(+p.training_range_km) + ' local');
            if (p.speed_kmh != null) bits.push(fmtSpeed(+p.speed_kmh));
            return bits.join(' · ');
        }
```
- [ ] **Step 2: Spec-card stat + label.** In `_refreshSpecStats` (:3667) replace the `psRange` line with:

```js
            const _plan = (window.CNSFlight && CNSFlight.planningRangeKm) ? CNSFlight.planningRangeKm(spec) : null;
            document.getElementById('psRange').textContent =
                _plan > 0 ? fmtDist(_plan) : (spec.training_range_km ? fmtDist(spec.training_range_km) + ' local' : '—');
```
  Keep the `psUsage` kWh/100km derivation as-is (consumption is presentable; the rule covers range figures). Find the `psRange` LABEL in the markup (`grep -n "psRange" templates/index.html`, label text currently `Range`) and change it to `Usable range`.
- [ ] **Step 3: Reach bar** — denominator becomes the plane's VFR ceiling, not the gross (:3613):

```js
        function _renderReachBar(spec) {
            const fill = document.getElementById('reachFill');
            if (!fill || !spec) return;
            const avail = _availRangeShownKm(spec);
            const best = (window.CNSFlight && CNSFlight.planningRangeKm) ? CNSFlight.planningRangeKm(spec, { ruleMode: 'vfr' }) : 0;
            document.getElementById('reachVal').textContent = (avail == null) ? '—' : fmtDist(avail);
            document.getElementById('reachCat').textContent = best > 0 ? fmtDist(best) : '—';
            fill.style.width = (best > 0 && avail != null ? Math.max(0, Math.min(100, avail / best * 100)) : 0) + '%';
        }
```
  Grep the bar's caption markup near `reachCat` (was "of catalog range" or similar) → relabel to `VFR max`.
- [ ] **Step 4: Report/PDF.** In `static/report.js:218` replace `range_km: (cat && cat.range_km) ?? 0,` with `usable_range_km: (window.CNSFlight && cat) ? CNSFlight.planningRangeKm(cat) : 0,`. Then `grep -n "range_km" templates/report.html report.py` — update every print site to `usable_range_km` (label `Usable range`); if none exist, done.
- [ ] **Step 5: Verify.** Browser: tiles show `194 km`-class figures (Beta), Velis shows `88 km local`, spec card `Usable range`, reach bar `… / VFR max`. Nothing on the page prints 630/700: `curl -s http://127.0.0.1:5082/ | grep -cE "630|700"` is about the static template only — the real check is visual since tiles render client-side; eyeball + screenshot. Generate a PDF (report flow) and confirm the fleet table shows the usable figure.
  Run the full JS suite + `golden_capture --check` → green/unmoved.
- [ ] **Step 6: Commit.**
  ```bash
  git add templates/index.html static/report.js templates/report.html report.py
  git commit -m "feat(perf-engine): displays show the regime usable range — the gross catalog figure is no longer presented anywhere"
  ```

### Task A6: Saved-trip physics auto-heal — catalog planes stop trusting stale trip snapshots

**Files:**
- Modify: `static/flight-model.js:228–240` (`tripPlane`)
- Test: `tests/js_flight_model.test.mjs` (append)

**Interfaces:**
- Consumes: the module's internal catalog lookup already used by `tripPlane` (`PLANES_BY_ID`-backed; see :232).
- Produces: `CNSFlight.tripPlane(trip)` prefers the CATALOG's `range_km/speed_kmh/battery_kwh` for known catalog planes; the trip snapshot's copies apply only to custom/unknown planes. Old saved flights (with `range_km: 500` baked in) heal to the new physics automatically on recompute.

- [ ] **Step 1: Failing test** (append to `tests/js_flight_model.test.mjs`):

```js
// ---- tripPlane: catalog planes ignore stale per-trip physics snapshots (auto-migration) ----
(function tripPlaneHeal() {
  const S = loadStack();
  const staleTrip = { planeId: 'beta_plane', range_km: 500, speed_kmh: 250, battery_kwh: 225 };
  const p1 = S.CNSFlight.tripPlane(staleTrip);
  const customTrip = { planeId: 'my_custom', customPlane: true, range_km: 333, speed_kmh: 200, battery_kwh: 100, name: 'X' };
  const p2 = S.CNSFlight.tripPlane(customTrip);
  const checks = [
    [p1 && p1.range_km === 630, `catalog plane heals to catalog range (got ${p1 && p1.range_km})`],
    [p1 && p1.divert_km === 50, `catalog divert_km rides along`],
    [p2 && p2.range_km === 333, `custom plane keeps its own physics (got ${p2 && p2.range_km})`],
  ];
  for (const [okc, msg] of checks) {
    if (okc) { pass++; console.log(`  ok    heal — ${msg}`); }
    else { fail++; console.log(`  FAIL  heal — ${msg}`); }
  }
})();
```
  (Adapt the custom-plane shape to how `tripPlane` detects customs — read :228–247 first; if detection is "planeId not in catalog", drop the `customPlane: true` flag and keep `planeId: 'my_custom'`.)
- [ ] **Step 2: Run — expect FAIL** (`p1.range_km === 500`).
- [ ] **Step 3: Implement.** In `tripPlane` (:232 area), for the physics trio prefer the catalog when the id resolves to a catalog entry:

```js
            const _isCat = !!cat && !trip.customPlane;   // known catalog plane → its physics are authoritative
            // …
                range_km: _isCat ? cat.range_km : (trip.range_km != null ? trip.range_km : (cat && cat.range_km)),
                speed_kmh: _isCat ? cat.speed_kmh : (trip.speed_kmh != null ? trip.speed_kmh : (cat && cat.speed_kmh)),
                battery_kwh: _isCat ? cat.battery_kwh : (trip.battery_kwh != null ? trip.battery_kwh : (cat && cat.battery_kwh)),
```
  Keep every other field's precedence exactly as-is (`training_range_km` etc.). Ensure `divert_km`, `ifr_capable`, `class`, `measurements` flow from `cat` into the returned plane (add them if `tripPlane` builds an explicit object that omits them — the schema build-down needs them).
- [ ] **Step 4: Run the suite + goldens.** `node tests/js_flight_model.test.mjs` all green; `node tests/js_recompute.test.mjs`, `node tests/js_flight_adapter.test.mjs`, `node tests/js_flight_entry.test.mjs` green (their fixtures use catalog-consistent trips); `golden_capture --check` + `sched_snapshot` unmoved (goldens already match the catalog).
- [ ] **Step 5: Commit.**
  ```bash
  git add static/flight-model.js tests/js_flight_model.test.mjs
  git commit -m "fix(perf-engine): tripPlane treats catalog physics as authoritative — stale saved-trip snapshots auto-heal"
  ```

### Task A7: Import feasibility uses the regime reach

**Files:**
- Modify: `flight_import.py` (the `longest > plane_range` check, ~:151, and wherever `plane_range` is assigned — `grep -n "plane_range" flight_import.py`)
- Test: `tests/test_import_route.py:60`

**Interfaces:**
- Consumes: `plane_schema.usable_range(plane, regime, alternate_km=…)` + `plane_schema.ifr_capable(plane)` (both exist in `plane_schema.py`).
- Produces: `infeasible_for_default` counts legs longer than the DEFAULT-REGIME usable range (not the gross). Report semantics unchanged (it's a flag, rows still import).

- [ ] **Step 1: Update the test to the honest expectation.** In `tests/test_import_route.py` replace the `infeasible_for_default` assertion + comment with:

```python
        # Regime reach (Beta IFR ≈ 203.5 km usable): AMS-JFK (~5847), AMS-BER (~593) AND
        # AMS-EDDL (~200 direct legs) all exceed it → 3. The flag means "needs stops/replan",
        # rows still import. (Was 1 while the check compared against the gross range_km.)
        self.assertEqual(data['report']['infeasible_for_default'], 3)
```
- [ ] **Step 2: Run — expect FAIL** (`1 != 3`):
  `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib "$PYBIN" -m unittest discover -s tests -p "test_import_route.py" -v`
- [ ] **Step 3: Implement.** In `flight_import.py`, where `plane_range` is derived from the default plane's `range_km`, replace with:

```python
from plane_schema import usable_range, ifr_capable
# …
    regime = 'ifr' if ifr_capable(default_plane) else 'vfr'
    plane_range = usable_range(default_plane, regime,
                               alternate_km=(default_plane.get('divert_km') or 0))
```
  (`default_plane` = the dict the current code reads `range_km` from; keep its actual variable name. Import at module top, matching the file's import style.)
- [ ] **Step 4: Run — PASS**, then the whole Python suite:
  `CNS_BASE_URL=http://localhost:5082 DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib "$PYBIN" -m unittest discover -s tests -p "test_*.py"` → `OK` (231).
- [ ] **Step 5: Commit.**
  ```bash
  git add flight_import.py tests/test_import_route.py
  git commit -m "feat(perf-engine): import feasibility checks the regime usable range, not the gross catalog km"
  ```

### Task A8: Phase-A gate — full suite, goldens, browser proof

**Files:** none new (verification only; re-bless artifacts if step 2 demands).

- [ ] **Step 1: Full suite.**
  `bash tests/run_all.sh` with the server up on :5082 and `CNS_BASE_URL=http://localhost:5082` exported → `ALL LAYERS PASSED`.
- [ ] **Step 2: Golden ritual.** `node tests/golden_capture.mjs --check` (expect: reproduce — Phase A moved no engine numbers after A4's one re-bless) + `node tests/sched_snapshot.mjs` (expect: identical to the A4-blessed baseline).
- [ ] **Step 3: Browser proof for the user.** With :5082 up: Beta Lelystad→Frankfurt shows the stop + red-free legs; Velis trains normally; spec card shows `Usable range 204 km` / reach bar `… / 316 km VFR max`; no visible 630/700 anywhere. Screenshot for the PR.
- [ ] **Step 4: Commit anything outstanding; push the branch.**
  ```bash
  git push -u origin feat/perf-engine
  ```

---

# Phase B — S6: the global VFR/IFR control

### Task B0: VFR add-back for incl-reserve planes + fleet reach invariants (ruled §13.3 — GATES B1)

**Why:** discovered in critique review — Vaeridion VFR currently computes 700×0.7 − 217.5 = **272.5 km**, LESS than its IFR 400 (the incl-reserve measurement only matches IFR context, so VFR falls through to the gross build-down). Flipping B1's switch to VFR would *shrink* the range on screen — physically impossible. The spec RULED the fix (§5.3 / §13.3): a VFR flight on an `incl_reserve(ifr)` figure drops the IFR diversion and the loiter delta, extrapolating the won range back in: `vfr = value + diversion_km + (loiter_min − 30)/60 × speed`, floored at `value`. Vaeridion: 400 + 80 + 0 = **480**.

**Files:**
- Modify: `static/plane-schema.js` (`usableRange`, ~:109), `plane_schema.py` (`usable_range`, ~:142), `planes.json` (vaeridion `reserve_included`)
- Test: `tests/js_plane_schema.test.mjs`, `tests/test_plane_schema.py`

**Interfaces:**
- Consumes: the existing `usable_incl_reserve` measurement selection.
- Produces: `usableRange(plane, 'vfr')` ≥ `usableRange(plane, 'ifr')` for every catalog plane (fleet invariant, both languages); `reserve_included = { "regime": "ifr", "diversion_km": 80, "loiter_min": 30 }` on the vaeridion entry (§5.3's exact published decomposition).

- [ ] **Step 1: Failing tests.** JS (`tests/js_plane_schema.test.mjs`):

```js
test('VFR add-back: incl_reserve(ifr) plane extrapolates the diversion back in (§13.3)', () => {
  const planes = JSON.parse(fs.readFileSync(path.join(REPO, 'planes.json'), 'utf8'));
  const v = planes.find(p => S.value(p, 'id') === 'vaeridion');
  assert.equal(S.usableRange(v, 'ifr', { load: 'mtow' }), 400);
  assert.equal(S.usableRange(v, 'vfr'), 480);   // 400 + 80 diversion + (30−30) loiter delta
});
test('fleet invariant: 0 <= usableRange(ifr) <= usableRange(vfr) for every catalog plane', () => {
  const planes = JSON.parse(fs.readFileSync(path.join(REPO, 'planes.json'), 'utf8'));
  for (const p of planes) {
    const ifr = S.usableRange(p, 'ifr'), vfr = S.usableRange(p, 'vfr');
    assert.ok(ifr >= 0, `${S.value(p, 'id')} ifr ${ifr} >= 0`);
    assert.ok(vfr >= ifr, `${S.value(p, 'id')} vfr ${vfr} >= ifr ${ifr}`);
  }
});
```
  Python (`tests/test_plane_schema.py`, in `TestUsableRange`): mirror both — `usable_range(v, "vfr") == 480` (load the real catalog like `test_catalog_beta_gross_630` does) and a loop asserting `0 <= usable_range(p, "ifr") <= usable_range(p, "vfr")` over `_catalog()`.
- [ ] **Step 2: Run both — expect FAIL** (vfr 272.5, and the invariant loop names vaeridion).
- [ ] **Step 3: Data.** In `planes.json` vaeridion entry add, next to `mtow_kg`:

```jsonc
"reserve_included": { "regime": "ifr", "diversion_km": 80, "loiter_min": 30 },
```
- [ ] **Step 4: Implement — JS** (`usableRange`, before the gross build-down): when the requested regime is NOT ifr, look for the ifr-conditioned incl-reserve measurement and add back:

```js
        if (regime !== 'ifr') {
            const mi = selectMeasurement(plane, 'range_km', Object.assign({}, context, { regime: 'ifr' }));
            const ri = value(plane, 'reserve_included');
            if (mi && mi.basis === 'usable_incl_reserve' && ri && ri.regime === 'ifr') {
                const spd0 = value(plane, 'speed_kmh') || 0;
                const vfrMin = RESERVE_MIN[regime] != null ? RESERVE_MIN[regime] : 30;
                const addback = mi.value + (ri.diversion_km || 0)
                    + Math.max(0, ((ri.loiter_min || 0) - vfrMin) / 60) * spd0;
                return Math.max(mi.value, addback);
            }
        }
```
  Mirror in `plane_schema.py` `usable_range` with the same guard order and the same floor (`max(m_value, addback)`).
- [ ] **Step 5: Run** both plane-schema suites + `validate_planes.py` (schema must accept `reserve_included` — if `planes.schema.json` rejects it, add the property with the three fields, types number/number/string-enum) + `golden_capture --check` (no drift — nothing reads VFR for vaeridion in the goldens yet; if B4 already landed its `vfr` variant, expect ONLY vaeridion `[vfr]` rows to move and re-bless deliberately).
- [ ] **Step 6: Commit.**
  ```bash
  git add static/plane-schema.js plane_schema.py planes.json planes.schema.json tests/js_plane_schema.test.mjs tests/test_plane_schema.py
  git commit -m "fix(perf-engine): VFR add-back for incl-reserve planes (§13.3) — Vaeridion VFR 480, fleet reach invariants"
  ```

### Task B1: Model-settings VFR/IFR switch (writes `ruleMode`, recompute cascades)

**Files:**
- Modify: `templates/index.html` — the Model-settings drawer (locate: `grep -n "landingReserve\|Model settings" templates/index.html`), following the existing toggle-row markup pattern
- Test: browser + existing `tests/js_settings.test.mjs` (accessors already covered)

**Interfaces:**
- Consumes: `CNSSettings.ruleMode()` / `CNSSettings.save({ ruleMode: { value } })` (shipped in S1); the existing settings-change → `CNSRecompute.recomputeAll` trigger.
- Produces: a two-button segmented control (`VFR` / `IFR`, default IFR) at the top of Model settings; changing it recomputes all saved flights (existing trigger fires on `save`).

- [ ] **Step 1: Read the drawer's row pattern** (`grep -n "landingReserve" templates/index.html` → the render + save wiring). Insert a row ABOVE the reserve row, reusing the drawer's row classes:

```html
<div class="ms-row" id="msRuleMode">
    <div class="ms-row-label">Flight rules<div class="ms-row-sub">Default regime for new routes</div></div>
    <div class="btn-group btn-group-sm" role="group">
        <button type="button" class="btn btn-outline-secondary" data-rm="vfr">VFR</button>
        <button type="button" class="btn btn-outline-secondary" data-rm="ifr">IFR</button>
    </div>
</div>
```
  and wire it where the drawer syncs/saves (same place the other toggles bind):

```js
        (function () {
            const row = document.getElementById('msRuleMode');
            if (!row) return;
            const sync = () => {
                const cur = CNSSettings.ruleMode();
                row.querySelectorAll('[data-rm]').forEach(b => b.classList.toggle('active', b.dataset.rm === cur));
            };
            row.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
                if (b.dataset.rm === CNSSettings.ruleMode()) return;
                CNSSettings.save({ ruleMode: { value: b.dataset.rm } });   // fires the existing recomputeAll trigger
                sync(); renderPlaneSpecCard(); smartReplan(); drawLiveRoute();
            }));
            sync();
        })();
```
  Match the drawer's actual class names/markup — the snippet's intent (segmented, synced, save+replan) is the contract; cosmetics follow the file.
- [ ] **Step 2: Browser-verify.** Toggle IFR→VFR: Beta's usable range jumps 204 → 316, the Lelystad→Frankfurt demo loses its stop (342 < VFR 316? **no** — 342 > 316: the stop stays; verify the leg math updates and the spec card reads 316). Toggle back → stop layout returns; saved DC flights visibly recompute.
- [ ] **Step 3: Commit.**
  ```bash
  git add templates/index.html
  git commit -m "feat(perf-engine): VFR/IFR flight-rules control in Model settings (global default)"
  ```

### Task B2: Spec card regime awareness — `VFR only` badge

**Files:**
- Modify: `templates/index.html` (`renderPlaneSpecCard` :3646 + card markup near `psName` :1781–1800)

**Interfaces:**
- Consumes: `CNSPlaneSchema.ifrCapable(plane)`.
- Produces: a terse `VFR only` chip beside the plane name whenever `!ifrCapable(spec)`; nothing for capable planes.

- [ ] **Step 1: Markup** — beside `psName` add `<span id="psVfrOnly" class="badge text-bg-secondary d-none">VFR only</span>` (reuse the card's existing badge styling if one exists).
- [ ] **Step 2: Wire in `renderPlaneSpecCard`:**

```js
            const vfrOnly = document.getElementById('psVfrOnly');
            if (vfrOnly) vfrOnly.classList.toggle('d-none',
                !(window.CNSPlaneSchema && spec && !CNSPlaneSchema.ifrCapable(spec)));
```
- [ ] **Step 3: Verify + commit.** Velis shows the chip; Beta doesn't. IFR global + Velis selected → planner behaves VFR (engine gate; reach = training/local figure per A5).
  ```bash
  git add templates/index.html
  git commit -m "feat(perf-engine): spec card flags VFR-only aircraft"
  ```

### Task B3: Catalog — explicit `ifr_capable` for the IFR fleet

**Files:**
- Modify: `planes.json` (beta_plane, vaeridion, vaeridion_light, elysian_e9x)
- Test: `"$PYBIN" validate_planes.py`

**Interfaces:** consumed by the §5.1 gate everywhere; kills the validator's inferred-value warnings.

- [ ] **Step 1: Add to each of the four entries** (Velis already carries its certified `false`):

```jsonc
"ifr_capable": { "value": true, "source": "design intent — commuter/regional IFR ops; confirm vs type certificate when published", "confidence": "estimated" },
```
- [ ] **Step 2: Validate + full quick pass.** `"$PYBIN" validate_planes.py` → `OK — catalog valid` with NO `ifr_capable absent` warnings. `node tests/js_plane_schema.test.mjs` + `"$PYBIN" -m unittest discover -s tests -p "test_plane_schema.py"` → green. Goldens unmoved (`golden_capture --check`).
- [ ] **Step 3: Commit.**
  ```bash
  git add planes.json
  git commit -m "data(perf-engine): explicit ifr_capable for Beta/Vaeridion/Elysian (validator warnings cleared)"
  ```

### Task B4: Pin the VFR regime in the goldens

**Files:**
- Modify: `tests/golden_capture.mjs` (SETTINGS variants, ~:56)
- Re-bless: `tests/goldens/flight-current.golden.json`

**Interfaces:** golden coverage for BOTH regimes from here on.

- [ ] **Step 1: Add a variant** to the `SETTINGS` map in `tests/golden_capture.mjs`:

```js
  vfr:       (S) => { S.reset(); S.save({ ruleMode: { value: 'vfr' } }); },
```
- [ ] **Step 2: Re-bless once (additive rows) + check.**
  `node tests/golden_capture.mjs` (writes the new `[vfr]` rows) then `node tests/golden_capture.mjs --check` → all reproduce. Eyeball the new rows: Beta `[vfr]` energy < `[default]` (no sidStar burn), Velis rows identical across regimes (forced VFR).
- [ ] **Step 3: Commit.**
  ```bash
  git add tests/golden_capture.mjs tests/goldens/flight-current.golden.json
  git commit -m "test(perf-engine): golden variant pins the VFR regime alongside IFR defaults"
  ```

---

# Phase C — S7: per-route `ruleMode` (own golden pass)

### Task C1: Per-route control in the planner + edit modal

**Files:**
- Modify: `templates/index.html` — planner form near the trip-type segmented control (:3622–3644 pattern) + the edit-flight modal; state var beside `_availRangeOverride` (:2808)

**Interfaces:**
- Produces: `_ruleModeOverride` (`'vfr' | 'ifr' | null`; null = inherit global) in the planner; the current trip object carries `rm` when overridden (absent = global). Segmented `Rules: Auto/VFR/IFR` control, disabled to VFR for `!ifrCapable` planes.

- [ ] **Step 1: State + control.** Beside `_availRangeOverride` add `let _ruleModeOverride = null;`. Add a three-button segmented row under the trip-type control (reuse `.trip-seg-btn` styling): `Auto` (null — "uses the global default"), `VFR`, `IFR`; clicking sets `_ruleModeOverride`, then `renderPlaneSpecCard(); smartReplan(); drawLiveRoute();`. When `!CNSPlaneSchema.ifrCapable(selectedPlaneSpec())`, force-render `VFR` active + disable the other two (title `VFR only — type certificate`).
- [ ] **Step 2: Thread locally.** Every planner-side call that resolves the regime uses the override: `_availableRangeKm`/`_availRangeShownKm`/`_dispLegKm` (A3) pass `{ ruleMode: _ruleModeOverride || undefined }` into the seam functions; the planner's `simulateTrip` call site adds `ruleMode: _ruleModeOverride || undefined` to its opts; `recomputeRoute`'s `planChain` options gain `ruleMode: _ruleModeOverride || undefined` (A4 made `planRoute` honour it).
- [ ] **Step 3: Persist on the trip.** Where the planner builds the saved-trip object (the same place `tripType` lands), add `if (_ruleModeOverride) t.rm = _ruleModeOverride;`. Edit-flight modal: render the same segmented control from `t.rm || null`, write back on save. Plane-change listener (:3486): if the new plane is `!ifrCapable`, clear `_ruleModeOverride` to null.
- [ ] **Step 4: Browser-verify:** Beta route set to VFR shows 316-km reach + no stop-on-316-fitting-legs; flip to IFR → 194 + stop; saved flight remembers; Velis control pinned to VFR. Commit.
  ```bash
  git add templates/index.html
  git commit -m "feat(perf-engine): per-route VFR/IFR control — route override, global default, VFR-only gating"
  ```

### Task C2: Thread `rm` through every simulate consumer

**Files:**
- Modify: `static/flight-model.js` (`profileForTrip`/`tripBreakdown` opts passthrough), `static/recompute.js`, `static/scheduler.js`, `static/report.js` — every `simulateTrip`/`profileForTrip` call site (find: `grep -n "simulateTrip(\|profileForTrip(" static/*.js templates/index.html`)
- Test: `tests/js_recompute.test.mjs` (append)

**Interfaces:**
- Consumes: `opts.ruleMode` (already read by `simulateTrip` :76).
- Produces: every consumer passes `ruleMode: trip.rm || undefined`; `profileForTrip(trip, opts)` forwards `ruleMode: trip.rm` into its internal `simulateTrip` opts so DES/report inherit it with NO caller changes where they already pass the trip.

- [ ] **Step 1: Failing test** (append to `tests/js_recompute.test.mjs`, matching its harness idiom): build the standard two-leg Beta fixture twice — `t1 = {…}` and `t2 = {…, rm: 'vfr'}` — run the file's existing recompute/flight-sim helper on both and assert `energy(t2) < energy(t1)` (VFR drops the 10-km sidStar burn per leg) and that `t2.rm` survives the recompute round-trip unchanged.
- [ ] **Step 2: Run — FAIL** (energies equal; `rm` possibly dropped).
- [ ] **Step 3: Implement.** (a) `flight-model.js`: in `profileForTrip`/`tripBreakdown`, where internal opts are assembled from the trip, add `ruleMode: trip.rm || undefined,`. (b) `grep` every direct `simulateTrip(` call site in `recompute.js` / `scheduler.js` / `report.js` / `index.html` that has the trip in scope → add `ruleMode: t.rm || undefined` to its opts object. (c) `recompute.js`: where preserved per-trip fields are listed (the `_manual` precedent), carry `rm` across the rebuild.
- [ ] **Step 4: Run** `node tests/js_recompute.test.mjs` → pass; full JS loop green; `sched_snapshot` unmoved (no seeded trip carries `rm`).
- [ ] **Step 5: Commit.**
  ```bash
  git add static/flight-model.js static/recompute.js static/scheduler.js static/report.js templates/index.html tests/js_recompute.test.mjs
  git commit -m "feat(perf-engine): per-route ruleMode threads through profile/DES/recompute/report"
  ```

### Task C3: Persistence — share links, DC folder, saved-route restore

**Files:**
- Modify: `static/share.js` (schema encode/decode), `static/buildshare.js` (if it snapshots trips), the DC folder flight builder + saved-route restore in `templates/index.html` (grep `divertOverride`-style threading or `tripType` persistence sites)
- Test: `tests/js_share.test.mjs`, `tests/js_buildshare.test.mjs` (append round-trip cases)

**Interfaces:**
- Produces: `rm` is one optional field on the shared/saved trip; absent decodes fine (old links unaffected).

- [ ] **Step 1: Failing tests.** In `tests/js_share.test.mjs`: encode a state whose flight has `rm: 'vfr'` → decode → assert `rm === 'vfr'`; decode a legacy blob WITHOUT `rm` → assert `rm` is absent/undefined (no default injected). Mirror in `tests/js_buildshare.test.mjs` if build blobs snapshot flights.
- [ ] **Step 2: Run — FAIL** (field dropped by the schema whitelist).
- [ ] **Step 3: Implement:** add `rm` to the share schema's per-flight field list (encode + decode, absent-safe — exactly how `tripType` rides), to the DC folder flight builder, and to the saved-route restore path.
- [ ] **Step 4: Run** share/buildshare/recompute tests + full JS loop → green.
- [ ] **Step 5: Commit.**
  ```bash
  git add static/share.js static/buildshare.js templates/index.html tests/js_share.test.mjs tests/js_buildshare.test.mjs
  git commit -m "feat(perf-engine): ruleMode persists through share links, DC folder and saved-route restore"
  ```

### Task C4: Regime chip in the route list + result panel; rename the surface

**Files:**
- Modify: `templates/index.html` — route-list row renderer + result panel header; the Model-settings drawer heading

**Interfaces:** display only.

- [ ] **Step 1: Chip.** In the route list row (beside the `.alt-hint` badge slot) and the result-panel header, render `<span class="badge text-bg-light rm-chip">IFR</span>` with the trip's EFFECTIVE regime (`CNSFlight.effectiveRegime(tripPlane, t.rm)`) — terse, uppercase, no prose. Show it always (IFR default = still information).
- [ ] **Step 2: Rename** the drawer heading `Model settings` → `Route settings` (§13.5: the global value is the default a new route inherits). Grep `Model settings` across `templates/index.html` AND `static/tour.js` — if a tour step anchors to the drawer or names it, update the step copy/anchor and note `/update-tour` in the commit body.
- [ ] **Step 3: Browser-verify + commit.**
  ```bash
  git add templates/index.html static/tour.js
  git commit -m "feat(perf-engine): regime chips on routes; Model settings becomes Route settings"
  ```

### Task C5: Phase-C gate — goldens, full suite, PR

- [ ] **Step 1:** `bash tests/run_all.sh` (server on :5082, `CNS_BASE_URL` exported) → `ALL LAYERS PASSED`.
- [ ] **Step 2:** Golden ritual — `golden_capture --check` + `sched_snapshot`; expect NO drift (per-route defaults to global; seeded network carries no `rm`). Any drift = a threading bug, fix before proceeding.
- [ ] **Step 3:** Browser sweep: share-link round-trip keeps the regime; DC recompute honours per-route `rm`; PDF renders.
- [ ] **Step 4:** Push + open the PR (gh account `edgarvamerongen` — `gh auth switch` first if needed). PR body MUST include: the golden re-bless rationale (A4), the confidentiality rule, and a **loud mobile-lane flag**: `static/mobile.js` still reads raw `range_km` (range ring + over-range checks) → now optimistic AND displays the gross; recommend the mobile session consume `CNSFlight.availableRangeKm` / `planningRangeKm`. End the body with the standard Claude Code attribution line.

---

## Out of scope (deliberately)

- **S4** Vaeridion Max/Light collapse (own pass; no mass inference per review #2).
- **S5** runway suitability → planner/range-graph (own golden pass; MUST coordinate with the divert-edit feature, PR #28 — shared `airport_alternates.py` semantics and the `divertFor()` resolver).
- **§9 spec sheet** + payload–range diagram; wind/weather/mass modules.
- Anything in the mobile lane (flagged in C5's PR body instead).

## Risks

- **sched_snapshot drift at A4** is expected and must be eyeballed leg-by-leg (only "new stop under the 193.5 reach" explanations are acceptable) before the one re-bless.
- **Tour anchors**: A5/B1/C4 touch planner/settings markup — run `CNSTour.check()` in the console after each phase; broken anchors → fix or note `/update-tour`.
- **Preview harness**: the session's preview tools serve the MAIN checkout; verify this branch on the worktree server `:5082` (Bash background + user's browser / curl), not via `preview_start`.
- **`plane_schema.usable_range(routing_factor=…)`** divides the whole remaining range; `CNSFlight.availableRangeKm` applies `route` itself — never pass `routingFactor` from the JS seam or the factor double-counts. The seam owns the carve; the schema call takes `alternateKm` only (current `_usableRangeKm` behavior — keep it).
