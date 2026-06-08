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

## B. Routing-padding model (REVISED — "pad the route length")

Padding (×1.05) is the **flown-path** overhead from SID/STAR procedures + airways routing:
the aircraft flies a longer PATH than the great-circle line. Applied **exactly once** (D1).

**Decision (revised): pad the route LENGTH (`distKm`); energy, time and reach all DERIVE
from the routed length.** Single-count. This **supersedes** the earlier "pad energy + time,
keep distance geographic" call — rationale below.

- **`distKm` = routed length** = `rawKm × routingFactor` — what every view shows.
- **`rawKm` = great-circle** (geographic) is retained per leg/total for the map arc.
- **Energy / time derive:** `energyKwh = ePerKm × distKm`, `flightMin = distKm ÷ speed`. So per
  leg the three numbers RECONCILE. (The old model showed a geographic distance that silently
  disagreed with the padded energy/time — the recurring "why don't these add up?" confusion.)
- **Available range / over-range UNCHANGED:** still `range × usable ÷ route` (geographic reach)
  and `padded energy > usable` — algebraically identical to "routed length > range". Moving the
  padding to the display did not touch reachability or routing.

**Why revised:** padding is *physically* a route-length effect; modelling it on the length (and
deriving energy/time) is the faithful, internally-consistent choice. It is a pure PRESENTATION
change — energy, time, charges, reachability are byte-identical; only the shown distance grows
~5%. Engine: `static/flight-model.js` (behind R12). Verified: `tests/js_flight_padding.test.mjs`.

| Surface | State |
|---|---|
| Engine `distKm` (legs + totals) | ✅ routed (`rawKm × pad`); energy/time derive; `rawKm` kept geographic |
| Map leg labels, result-panel rows | read engine `distKm` → routed (flag-on) |
| Map ARC (drawn line) | great-circle (no procedure tracks) → ~5% shorter than the label → **signpost TBD** |
| Available-range / over-range / routing | unchanged (energy-based, single-count) |
| Training legs | left raw (`distKm == rawKm`) — deferred change **G4(a)** |

**Deferred nuance:** the flat 5% is crude. Real padding ≈ a *fixed* terminal add (SID+STAR, per
airport) **plus** an *airways* % — a flat % over-pads long hops, under-pads short ones. Orthogonal
to *where* the padding lands; revisit if more fidelity is wanted.

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

---

## F. Resolved decisions (the engine is built to these) — ruled 2026-06-07

**Interface (the engine's API/shape):**
- **R1 · Waypoint expansion → engine owns it.** Caller passes `origin + stops + dest` only (NEVER pre-mirrored); engine derives the retour return + the training loop from `tripType`. Kills mirror drift; one expander.
- **R2 · Per-node targets → resolver callback `getTargetSoc(ident)`** (mirrors `recomputeMultiLegCharges`; keys by ident so a twice-visited retour stop resolves correctly). The ONLY preview-vs-demand difference.
- **R3 · Charge time → two-layer.** Engine emits energy + a preview/**template** charge time; the DES re-sizes per the charger actually claimed. Lowest dur-drift risk; the scheduler/report views are NOT math-free and the spec must say so.
- **R4 · Saved trips → persist the full effective plane spec on save.** So a custom-plane trip rebuilds from coords even if that plane is later deleted / opened on another device. Additive `addFolder` schema change (range/speed/etc.). *(Catalog planes were never at risk; the per-flight range override never needed persisting — it only steers routing, not energy.)*

**Behavior / thresholds (each can move a number → each ruled explicitly):**
- **R5 · Over-range test → padded leg energy > usable battery.** One canonical definition (unifies the map's red leg with the walk's flag). Slightly STRICTER than `sim.py`'s raw-distance test → a few routes that simulate today may newly flag. Add the boundary golden.
- **R6 · Over-range savability → flag only; the app still blocks saving.** Engine REPRESENTS over-range (arrival clamps to 0, `overRange` set) but Simulate/Add-to-demand still refuses to save one, matching today. "Can represent" ≠ "can save."
- **R7 · Charge-time taper positioning → keep today's approximation.** Engine reproduces current charge times exactly; correct-SoC taper placement is a separate, signed-off follow-up. G4-consistent.
- **R8 · Reserve basis → global `usableFraction` slider only.** Drop the dead per-aircraft `min_landing_soc` from the schema + fix the contradictory `settings.js` comments.

**Confirmations:**
- **R9 · Charge energy → NO `charge ≤ prev leg` clamp.** A charge exceeding its prior leg ("+13 after a 9 kWh leg") is correct physics (depart full + carry a deficit forward). Rewrite the spec's §6 wording that implies it's a bug. The engine fixes the raw-vs-padded display fork + missing SoC, not this energy.
- **R10 · Elysian `simultaneous_charging` → scoped OUT.** Engine charges serially → Elysian times come out **known-pessimistic**; add a spec note + a backlog item. Wiring it is a separate project.
- **R11 · Mobile → OK to break.** ⚠️ The engine may change the shared public signatures freely; the **mobile session must do a migration pass afterward.** `index_mobile.html` loads `settings/routing/demand/scheduler/charging.js` and `mobile.js` calls `CNSDemand.{computeAirports,loadFolder,loadCfg,saveFolder}`, `CNSScheduler.{summary,init}`, `CNSSettings.{loadAll,save,subscribe,reset}`, `CNSRouting.{planRoute,haversineKm}` — **these WILL break when the engine lands.** Flag the mobile session loudly (CLAUDE.md rule 2). *(This relaxes only the JS-compat half; `sim.py`/`/api/simulate` retention is still G3 unless separately revisited.)*
- **R12 · Safety net → runtime kill-switch flag per step + bake period.** Each migration step ships behind a `CNSSettings` flag (instant disable on drift); legacy engines (`sim.py` energy, `_legEst`, the demand walks) are deleted in a FINAL PR after a bake, not eagerly.

**Implementation details (applied per the audit — no further decision):** `phases[]` is a **superset** of today's phase objects (leg/at/atIdx/power/energy); `charges[]` is **position-indexed by `atIndex`** (never keyed by ident); the calc-panel "show your work" math STAYS (step 8's "zero math in index.html" excludes that transparency block); the origin node is **inert `billable:false` metadata** for #33 (charges[] stays billable-only); #33/#34/#35 stay OUT of the engine PRs; re-derive every consumer by **function name**, not the spec's drifted line numbers.
