<!-- Status: PLAN · step 2 of docs/performance-engine.md (the IFR/VFR engine wiring + data
     adoption). Behaviour-CHANGING and golden-gated, so it must run in a session with the app
     live at http://127.0.0.1:5055. Step 1 + 1b (schema, measurements, selector, usable_range,
     runway suitability) already shipped additively; this turns them on. -->

# Performance Engine — Step 2 Execution Runbook

## Preconditions
- App running: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python app.py` → `:5055`.
- You are in the **desktop/backend** worktree (owns `sim.py`, `app.py`, `static/*.js` except mobile,
  `templates/index.html`, `tests/`). Mobile is a separate lane — see Risks.
- Step 1/1b green: `bash tests/run_all.sh` passes (97 Python + JS, validator clean).

> **⚠ Review (2026-06-30) — minors.** "97 Python" is **stale** — current `main` runs ~134 (report re-skin
> #27, build-share #28, flight-import #29 landed since); re-baseline before S0. And R11's mobile worry is
> mis-aimed: **S1** is purely additive `CNSSettings` accessors (mobile unaffected) and **S2** touches
> `CNSFlight` while mobile simulates via `sim.py` (**G3**) — so the real mobile surface is **S5/S6** (the
> `CNSRouting`/`CNSRangeGraph` gating and the Model→Route-settings rename). Aim the loud coordination there.

## The golden gate (do this every step that moves a number)
1. **Baseline first:** on the current tip, capture goldens from the running app —
   `node tests/golden_capture.mjs` (engine snapshots) and `node tests/sched_snapshot.mjs` (DES).
2. **Land the change live** (no flag — we are cutting over to the realism engine; today's flat mechanism
   is discarded). Additive-only steps (S1) move nothing; the number-moving cutover (S2+S3) is **one commit**.
3. **Eyeball the full golden diff against the baseline** — every aircraft, plus peak kW + overflow across
   the **whole seeded network** — and only then **re-bless** (regenerate goldens). A re-bless is a
   deliberate "yes, these numbers should change" act, never an automatic overwrite. With no flag the
   rollback is `git revert`, so this eyeball **is** the safety gate — do it carefully.
4. Keep each step shippable green on its own (the unified-flight-model.md migration is the template).

> **⚠ Review (2026-06-30) — #6: pin the Velis-IFR headline case.** The doc's marquee result is that a
> 45-min IFR reserve is *physically impossible* for the ~35-min-endurance Velis → negative planning range.
> Add a golden/unit test that a negative or zero `usable_range` yields a clean **infeasible** flag (not a
> crash, a NaN, or a garbage distance) — it's the sign/edge case S2/S3 are most likely to expose.

## What's already built and just needs wiring
- `plane_schema.usable_range(plane, regime, …)` / `select()` and the JS twin
  `CNSPlaneSchema.usableRange()` / `select()` — the per-regime build-down + measurement selector.
- `field_performance.airport_suitability()` / `normalize_surface()` — runway-length check.
- Catalog measurements: Beta `range_km` 630 **gross**; Vaeridion 400 km IFR@MTOW (`usable_incl_reserve`)
  + TODR 800/1000 m; Velis `ifr_capable:false` + 0.5 takeoff floor.

---

## Ship-green steps

### S0 — Baseline goldens (no code)
Capture `golden_capture` + `sched_snapshot` on the current tip. Commit the baseline so every later
diff is attributable.

### S1 — Settings: `ruleMode` + per-regime reserve (additive, default = today)
`static/settings.js`: add a `ruleMode` ('vfr' | 'ifr', default 'vfr') and the per-regime reserve
minutes to `DEFAULTS` (merged in by `loadAll`, so old stored blobs pick them up; no `KEY` bump
needed since the accessor is identity until S2 reads it). Add `ruleMode()` + `reserveMinFor(regime)`
accessors. **Verify:** `node tests/js_settings.test.mjs` (extend it); goldens unchanged (nothing
reads the new accessors yet).

### S2 — Replace the reach with the regime build-down (the only toggle is VFR/IFR, per route)
**Decision (2026-06-30): there is no "realism on/off" switch. The realism engine is always on; the one mode
toggle is VFR vs IFR, and every route carries it** — `ruleMode` is a per-route property (the global
Model-settings value is just the default a new route inherits). Today's flat `usableFraction` mechanism is
retired. Load `static/plane-schema.js` (before `flight-model.js`). In `CNSFlight.simulateTrip` **and**
`CNSRouting.planRoute`'s `maxLeg`, **replace** `availRangeKm = range × usableFraction / route` with
`CNSPlaneSchema.usableRange(plane, ruleMode, …)`, which builds the planning range down in **separate,
sequential buffers** (doc §5.2 — these are *not* the same thing):
1. **min-SoC floor** — `gross × (1 − min_soc)`: battery you never touch (health/BMS, ~20%).
2. **then the regime reserve** — `− speed × reserve_min/60` held *within* the usable battery for a
   go-around/hold (VFR 30 / IFR 45 min). **This is the IFR/VFR reserve — NOT a min-SoC reserve; it sits on
   top of the floor.**
3. **then the IFR alternate** — `− alternate ÷ routing` (IFR only).
A published incl-reserve figure (Vaeridion 400 km) skips the build-down. Per-aircraft `reserve_min` /
`min_soc` / `range_basis` refine the buffers when present; every plane has `range_km` + `speed_kmh`, so it
computes for **all** aircraft — no flat-trim fallback needed (the global slider survives only as an optional
fleet-wide what-if override).
This **moves numbers** and must land **in the same commit as S3's data** (the build-down needs the gross
figures — the new formula on the old non-gross `500` would *under*-state Beta). So **S2 + S3 are one atomic
cutover, one re-bless** (see S3). Rollback = revert the commit.

### S3 — Adopt the gross data (the data half of the S2 cutover — same commit, one re-bless)
In the **same commit as S2** (the formula needs these figures):
- Beta `range_km` 500 → **630** (gross); `tests/_helpers.py` BETA → 630.
- Vaeridion `range_km` 500 → **400** + `range_basis:"incl_reserve"` (engine reads the IFR@MTOW
  measurement directly); `speed_kmh` 400 → **435** (235 KTAS); `_helpers` VAERIDION to match.
- Re-bless `golden_capture` + `sched_snapshot` **once**; re-run `tests.test_sim_core` (the
  `TestReferenceCatalogSync` guard stays green because `_helpers` moved too).
Sanity-check the headline before re-blessing: Beta ≈ **379 km VFR / 316 IFR**, Vaeridion **400**, and the
Velis under IFR comes back **infeasible** (negative usable range → a clean infeasible flag, not garbage — #6).

> **✅ Review #1 & #3 (resolved by decision):** no flag → S2+S3 are one atomic cutover, so the gross range
> never runs on the old formula (#1) and there's no kill-switch to mis-toggle (#3). This is a deliberate
> **hard cutover to the realism engine**; rollback = revert the commit.

### S4 — Collapse Vaeridion Max/Light into one airframe
Replace the two entries with one `vaeridion` whose range is **load-selected/inferred** (4-seat range
inferred *up* from the 400 km @ MTOW point via mass). Migrate: keep `vaeridion_light` resolvable for
old saved trips (alias → the merged plane, or a one-time `_rebuildSavedTripCoords`-style backfill).
Behaviour-changing → re-bless + a saved-trip smoke.

> **⚠ Review (2026-06-30) — #2: drop the load-inference from step 2 — it needs the mass module.**
> "4-seat range inferred **up via mass** from the 400 km @ MTOW point" requires `mass_sensitivity` / the
> mass model (engine doc §6), which is roadmap **#4** — not built here. Ship the simpler collapse: one
> `vaeridion` anchored at **400 km @ MTOW IFR**, no load-variant, plus the `vaeridion_light` alias. Defer
> the payload→range curve to when §6 lands (it sharpens automatically then, per §3.5).

### S5 — Runway suitability into the planner + range graph
Port `field_performance` to JS (or expose via an endpoint) and gate `CNSRouting.planRoute`
candidates + `CNSRangeGraph` spokes on `airport_suitability` (length + surface + open). New
Map-Options toggle (off by default = today). Pre-compute per-aircraft suitable alternates to replace
the generic `alternate_km` where data exists.

> **⚠ Review (2026-06-30) — #4: S5 collides with the manual-divert feature (PR #28 / `feat/divert-edit`).**
> S5's "per-aircraft suitable alternates replacing the generic `alternate_km`" **is** the "more accurate
> divert fitting" the divert spec flags as superseding its interim paved-≥300m check. The divert feature
> ships first (interim suitability); S5 supersedes it. Coordinate: the divert module's
> `divertFor()`/`nearestSuitable` must read S5's per-aircraft suitability when it lands, and the two
> branches must not edit `airport_alternates.py` semantics independently.
>
> **⚠ Review — #5: split S5 into its own golden pass.** Porting `field_performance` to JS + gating the
> router and `CNSRangeGraph` is a big change on its own, and it owns the divert coordination above.

### S6 — IFR/VFR control in the UI
A VFR/IFR switch in **Model settings** (rename the surface to **Route settings**), disabled when
`!CNSPlaneSchema.ifrCapable(plane)`. Writes `ruleMode`; the engine (S2) already reads it.

### S7 — Per-route settings (later, its own golden pass)
Move `ruleMode` (+ factor overrides) onto each saved route in the DC; engine resolves
`route-override ?? global ?? identity` via `opts.settings` (performance-engine.md §5.6). Broadest
change — do it last, on its own baseline.

---

## Risks & lanes
- **Mobile (R11) — loud coordination.** `static/mobile.js` / `index_mobile.html` call
  `CNSSettings`, `CNSRouting`, `CNSDemand`, `CNSScheduler`. Any signature change in S1/S2 reaches the
  mobile lane — flag the mobile session (CLAUDE.md rule 2) before merging.
- **`sim.py` / `/api/simulate` (G3).** Stay as-is; mobile still uses them. New `planes.json` fields
  remain optional and ignored there. Don't retire sim.py energy in this step.
- **DES dur-drift (the standing high-risk).** `sched_snapshot.mjs` must be re-blessed in lockstep
  with S2/S3; verify peak kW + overflow across the **whole seeded network**, not one airport.
- **Saved-trip migration (S4).** Old localStorage trips referencing `vaeridion_light` must still
  resolve — keep an alias until a bake completes.
- **Kill-switch (R12 pattern).** Each number-moving step ships behind a `CNSSettings` flag so it can
  be disabled instantly if drift shows up; delete the legacy path only after a bake.

## Done when
A route can be set to VFR or IFR and the result panel / demand / scheduler all reflect the
regime-correct usable range (e.g. Beta IFR ≈ 316 km, Vaeridion IFR = 400 km @ MTOW), runway-unsuitable
airports drop out of the planner + range graph, the VFR/IFR control is gated by `ifr_capable`, and
`tests/run_all.sh` + the re-blessed goldens are green.
