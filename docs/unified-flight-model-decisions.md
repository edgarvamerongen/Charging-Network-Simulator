<!-- Living decision log for the unified flight engine. Pairs with docs/unified-flight-model.md
     (the spec, which is STALE and must be rewritten per G1 before any engine code). -->

# Unified Flight Engine — Decisions & Open Questions

**Status:** pre-build. Spec (`unified-flight-model.md`) is stale and not yet implementable.
Gates below are ruled on; blockers + open questions are NOT — nothing gets built until they are.
**Workspace:** worktree `../cns-engine`, branch `engine`, off the arrival-fix anchor `7af3d97`.

---

## A. Locked gate decisions (ruled on)

| # | Decision | Rationale |
|---|----------|-----------|
| **G1** | **Engine follows SHIPPED PR#3, not the spec's D6.** Origin/base departs at **100%**; the terminus (one-way dest, retour home, training origin) always recharges to **100%**; the charge **target** governs **only** away-from-base **intermediate** stops (+ the retour DEST turnaround). The spec's §1 D6, §4 steps 3 & 5, and the §4 invariants get **rewritten** to this before any code. | Building to the spec's prose would regress PR#3 and re-break bug #32. The arrival fix on disk depends on shipped semantics. |
| **G2** | **Goldens are captured from the code on disk, never from spec prose.** The arrival-charge fix is committed first (`7af3d97`) so the baseline is known-good. | The spec's invariants encode the pre-PR#3 model; deriving "expected" numbers from it would validate the engine against wrong values. |
| **G3** | **`sim.py` + `/api/simulate` stay.** The engine lands desktop-only. Migration **steps 7–8** (cut `/api/simulate`, delete `sim.py` energy) are a **separate, mobile-gated phase.** | `mobile.js` calls `/api/simulate`, reads raw fields, and does its own SoC math; `index_mobile.html` never loads `flight-model.js`. Cross-lane — not ours to cut unilaterally. |
| **G4** | **Engine reproduces today's numbers exactly** (pure structural refactor, golden-verifiable). The four genuine *behavior* changes are deferred, separately-signed-off follow-ups: (a) training energy +5% padding, (b) single-leg retour home-charge cap, (c) training "usable" basis, (d) stricter over-range threshold. | De-risks: correctness becomes a golden diff, not a judgment call. Model improvements ride separately. |

**Anchor committed:** `7af3d97` "Planner: arrival SoC from the forward walk, not the charge target" (display-only; arrival = full − terminalKwh; "Charge to" re-derived). Proven across all trip types by the 7-agent adversarial workflow.

---

## B. Routing-padding model (resolved this session)

Padding (×1.05) is the **flown path** overhead. It must be applied **exactly once** (spec D1).
**Decision: pad ENERGY + TIME (flown); keep DISTANCE geographic.** No double-count.

- **Distance** = great-circle (matches the map line *and* the available-range reach check). NOT padded.
- **Energy / time** = ×routingFactor (the plane flies ~5% farther → more energy + time). Matches charges + headline.
- **Available range** stays `range × usable ÷ route` (geographic reach); over-range check compares geographic km vs it — **single-count**.

| Surface | State |
|---|---|
| Result-panel leg rows, map leg labels, `_legEst` | ✅ done in worktree (energy/time padded, distance geographic) |
| Trajectory pill + Suggested-route distances | geographic already + single-counts vs range → **no change needed** (verify) |
| "Show calculation" breakdown | ⏳ **TODO** — weave the ×1.05 step into the formula so the padded energy is *explained* (raw → flown) |
| Training legs | left raw — that's deferred change **G4(a)** |

---

## C. Blockers — must resolve before ANY engine code

1. **Rewrite the stale spec to G1 semantics** (§1 D6, §4 steps 3/5, invariants) — otherwise the engine is built to the wrong algorithm.
2. **Build the parity harness first.** `tests/js_flight_model.test.mjs` + `flight-model.js` don't exist; capture goldens by *executing* current `demand.js`/`scheduler.js`/`sim.py`, then diff the engine against them.
3. **DES dur-drift (spec's own "highest risk") has no gate.** Engine `chargeMin` must match `chargeTimeMin` bit-for-bit (drop `demand.js:311` `toFixed(2)`; emit full-precision energy) or every downstream arrival/peak/overflow shifts network-wide. Hold #35 (`max_kw`) until after the engine ships.
4. **The four G4 behavior changes must each be pinned** with an explicit golden delta, not a silent ride-along.
5. **Saved-trip rebuild:** the engine must rebuild geometry from `stops`/coords, never from persisted `*_energy_kwh` (those are raw — re-padding them is the current class of bug). Confirm old localStorage trips still render.

---

## D. Open questions — to resolve before/inside the build (from the 7-facet audit)

~33 questions across 8 themes. The load-bearing ones per theme:

1. **Forward-SoC model** — origin ALWAYS 100% vs `min(batt, max(target·batt, leg0+reserve))` when a *base* carries a local <100% target? (rec: always 100%, match shipped.)
2. **Reserve / usable / charge-power basis** — unify three sources (`min_landing_soc` in sim.py vs the global slider vs per-trip); each unification moves a saved number → needs a golden.
3. **Raw-vs-padded fork** — now resolved for the leg display (§B); confirm the engine exposes one padded `energyKwh` + one geographic `rawKm` so no view re-forks.
4. **Over-range + same-origin guards** moving into the engine — ownership + threshold (hard-abort → soft-flag) is a real behavior change (G4d); keep `sim.py`'s guard alive for mobile (G3).
5. **DES / charge-time** — does the engine own charge *time* or only energy (DES re-sizes per claimed charger)? rounding parity (blocker 3).
6. **Schema / waypoint expansion / saved-trip rebuild** — who expands retour-mirror + training-loop (caller vs engine)? per-node `chargerKw`/`targetSoc` contract. (blocker 5.)
7. **Tests / goldens / migration mechanics** — golden set to snapshot, per-step rollback, ship-green ordering.
8. **Cross-lane (mobile)** — beyond steps 7–8: any shared lib (`settings.js`/`routing.js`) change the engine makes that mobile reads.

> Full per-item detail (severity, code refs, options, recommendation) is in the audit output:
> `…/tasks/wcb8jxg6z.output`. This log is the index; we resolve each before it becomes code.

---

## E. De-risked build sequence

0. ✅ Commit arrival anchor (`7af3d97`).
1. **Rewrite the spec** to G1 + mark every D-item `OPEN`. *(you review)*
2. Resolve the open decisions (D) with you.
3. Capture goldens from disk (G2) + build `tests/js_flight_model.test.mjs`.
4. Land `flight-model.js` **dark**; prove parity vs goldens (no view changes yet).
5. Migrate views to read the engine, one green step at a time (map labels → trajectory/over-range → tripPhases/tripBreakdown + result rows → demand drawer + report.js).
6. *(Deferred, separate sign-off each)* the four G4 behavior changes; then the mobile-gated steps 7–8.
