# Recompute saved flights when model settings change — design

**Date:** 2026-06-09
**Scope:** backend / data-logic only. The Demand Calculator's *display* of
infeasible flights (flag, dim, remove, prompt) is **deferred** to a follow-up.

## 1. Problem

A flight added to the Demand Calculator (DC) snapshots its route — `stops`,
`charges`, `legs` — at add-time, computed under the settings in force then. When
the operator later tunes a **model setting** that shrinks usable range (landing
reserve ↑, routing padding, SID/STAR padding, a per-flight range override), a leg
of that frozen route can become over-range, i.e. the flight is no longer
feasible. But it stays in the DC unchanged.

Today `CNSSettings.subscribe` ([index.html:4664](../../../templates/index.html))
calls `renderFolder()` on every settings change, which **re-derives each flight's
energy** from the engine with current settings — but **reuses the frozen stops
chain** and **never re-plans the route or re-checks feasibility**. So energy
updates while the route silently goes stale.

## 2. Goals / non-goals

**Goals**
- On any model-settings change, re-plan every saved flight's route under the
  current settings and recompute its feasibility — where **feasibility means each
  arrival can reach the next stop/destination AND still hold its alternate-airport
  divert reserve** (when that toggle is on), not just raw range.
- Re-planning **preserves the operator's manual stops** and only re-plans the gaps
  between them (mirrors the live planner).
- The recompute follows the **same code path** as the initial route planning —
  guaranteed by *sharing the implementation*, not by two implementations agreeing.
- Stay fast and offline: **client engine, zero HTTP** (no per-flight `/api/simulate`).

**Non-goals (deferred)**
- How the DC *renders* an infeasible flight (kept-and-flagged, dimmed, removed,
  re-route prompt). The backend only **computes and stores** feasibility.
- Migrating the *add* flow's stored bytes onto the engine (optional follow-up; see §9).

## 3. Key decisions (resolved with the user)

| Decision | Choice | Why |
|----------|--------|-----|
| Re-plan vs re-validate | **Re-plan, preserving manual stops** | Self-heals (adds/adjusts auto stops); only flags infeasible when no route exists at all. |
| Re-derivation path | **Client engine (`CNSFlight`)** | No HTTP (N flights = N in-memory computations); already the source the DC + result panel *display*. |
| Same-path assurance | **Shared `planChain()` + engine + idempotency test** | One routing implementation for planner and recompute; energy from the engine the display already trusts; a test locks the no-drift guarantee. |
| Orchestration | **Debounced queue of flight IDs** | Coalesces slider drags; client-side so the whole pass is fast. |

## 4. Data-model additions

Per saved trip (in the `cns_folder` localStorage list):

- **`stops[i]._manual: boolean`** — `true` for a stop the operator added in the
  planner, `false`/absent for a planner-inserted one. The planner already tags
  manual stops `_manual: true` ([index.html:2409](../../../templates/index.html));
  today the flag is dropped on the `/api/simulate` round-trip — it will be
  **preserved through add + edit** so recompute knows which stops to keep.
- **`feasible: boolean`** (default `true`) and **`infeasibleReason: string | null`**
  — e.g. `"leg 2 (Frankfurt → …) exceeds range at the current reserve"`. The
  flight is **kept** regardless; the frontend later decides how to surface it.

**Backward compatibility:** trips saved before this change carry no `_manual`
markers. On their first recompute they are treated as an **all-manual chain**
(every existing stop preserved, never silently dropped); `feasible` defaults
`true` until the first recompute computes it.

## 5. Components

### 5.1 `planChain()` — the extracted, shared routing core
Pull the chain-build + gap-fill out of the planner's `recomputeRoute`
([index.html:2400](../../../templates/index.html)) into a pure function:

```
planChain({ origin, dest, manualStops, plane, allowedTypes, allAirports, options })
  → { stops: [ …each with _manual ], legCount, error }
```

Logic (unchanged from today's planner): `chain = [origin, …manualStops, dest]`;
for each adjacent gap run `CNSRouting.planRoute` to auto-fill; concatenate the
manual stops (flagged) with the freshly auto-inserted ones; return `error` when
any gap has no route within range. **Both** the live planner (refactored to call
it) and `recomputeFlight` use this one function.

### 5.2 `recomputeFlight(trip) → updatedTrip`
1. **Training** (A→A loop): no routing; feasibility = training range valid. Return.
2. Build inputs from the trip: origin/dest coords, `manualStops = stops.filter(_manual)`
   (or all stops for a legacy trip), stored plane spec, allowed airport types. **Each
   chain node — origin, dest, every stop — carries its `alternate_km`** (looked up from
   the airport DB by ident, exactly as the planner's `_terminus()` and manual-stop push
   do). `planRoute` excludes chain endpoints from its candidate pool, so without this the
   divert reserve at the destination silently falls back to 0.
3. `planChain(...)` with **current** settings. Feasibility here is **reach AND the
   alternate divert reserve**: `planRoute` already requires every *arrival* node (each
   stop + the destination) to land holding enough charge to divert to its nearest
   airport (`alternate_km / routingFactor`) when the **Alternate reserve** toggle is on
   ([routing.js:89,105,145](../../../static/routing.js)). No new code — the recompute
   inherits it because it routes through the same `planRoute`. So toggling Alternate
   reserve on (or any range setting) can correctly flip a flight to infeasible because
   the arrival can no longer cover *both* the next leg and its divert.
4. **No route** (`error`): `feasible = false`, `infeasibleReason = error` (which already
   distinguishes "leg exceeds range" from "can't also reach the alternate"); keep the
   prior stops so nothing is lost. Return.
5. **Route found**: `CNSFlight.simulateTrip(chain, currentOpts)` → profile. Map the
   profile back onto the trip: `stops` (with `_manual` flags), `charges` (engine →
   the `{ident,name,lat,lon,role,at_index,energy_kwh}` shape `computeAirports` reads),
   `legs`, `legEnergy`, totals. `feasible = true`.
6. Secondary guard: if the profile still marks a leg `overRange` (a gap the planner
   could not split), set `feasible = false` with the offending leg in the reason.

### 5.3 `recomputeAllFlights()` — the queue
- **Debounced ~250 ms** and coalesced (a change mid-pass re-queues, never overlaps).
- `ids = loadFolder().map(t => t.id)` — the queue of flight IDs.
- Recompute each → collect updated trips → **`saveFolder` once** → `renderFolder()`.
- Pure client-side; for realistic folder sizes the pass is a few ms. If a folder
  ever grows large enough to jank the main thread, process the queue in chunks
  (one `requestAnimationFrame` slice each) — interface unchanged.

### 5.4 Triggers
- **Settings change (any setting):** the `CNSSettings.subscribe` handler
  ([index.html:4664](../../../templates/index.html)) calls `recomputeAllFlights()`
  (debounced) instead of the bare `renderFolder()` it does today — recompute, then
  render. It fires on *any* setting per the user's "after changing any setting";
  re-planning is cheap and idempotent, so re-planning on a non-range setting (charge
  target, taper) is simply a no-op rather than something to gate.
- **Model-settings modal open:** recompute once on `show` so drift from a prior
  session is reconciled before the operator touches a slider.

**Related planner fix (adjacent, not the DC recompute):** the *live* planner form
has its own routing-signature gate ([index.html:3814](../../../templates/index.html))
that decides whether to re-plan the in-progress route; it omits `sidStarPadding`, so
the active form doesn't re-plan when that slider moves (a gap left by the SID/STAR
work). Add `sidStarPadding` to that signature in the same pass — it's the same
"re-plan when reach changes" concern, one layer up from the saved flights.

## 6. Same-path assurance

1. **Routing is the same code.** `planChain` is the *only* chain-build/gap-fill
   implementation; the planner (which feeds "Add to demand") and the recompute both
   call it with the same `CNSRouting.planRoute`. There is no second routing path to
   drift from.
2. **Energy is already unified on the engine.** The DC and result panel derive
   displayed energy from `CNSFlight`, not from the Python `/api/simulate` charges
   stored at add-time. A recomputed flight and a freshly-added flight therefore
   render through the *same* engine and show the *same* numbers.
3. **Idempotency test** (the lock): recompute a flight with *unchanged* settings and
   assert the route + energy are identical (a no-op); and assert "build at X" ==
   "build at Y then recompute to X". Fails loudly if the paths ever diverge.

## 7. Feasibility model

`feasible` + `infeasibleReason` are computed and stored; the flight is **kept**.
That is the entire backend contract. The DC frontend (deferred) reads these to
decide presentation.

## 8. Testing

A node harness (extend `js_routing` or add `js_recompute`):
- `planChain`: preserves manual stops; re-plans the gaps; returns `error` when a
  gap has no route within range; identical output to the planner for the same input.
- `recomputeFlight`: a flight feasible at range R flips to `infeasible` when range
  is cut below a leg; **self-heals** (gains an auto stop) when a stop airport is
  reachable; training/direct flights resolve without routing.
- **Alternate reserve:** a flight that fits with the Alternate reserve **off** flips
  to `infeasible` when it's toggled **on** and the destination's arrival can't cover
  *both* the final leg and its `alternate_km` divert — and self-heals if a stop makes
  room; `infeasibleReason` names the alternate. (Carries the regression that chain
  endpoints get their `alternate_km` — the bug from §5.2 step 2 if it's ever dropped.)
- **Idempotency**: recompute at unchanged settings is a no-op; build-at-X equals
  build-at-Y-then-recompute-to-X.

## 9. Out of scope / follow-ups

- **DC frontend** for infeasible flights — separate task.
- **Add-flow unification (optional):** route "Add to demand" through the same
  client-engine build so even the *stored* `charges` come from the engine (today
  they come from Python sim but are overridden by the engine for every on-screen
  value). Not required for same-path-on-screen; a tidy follow-up that removes the
  last vestigial Python-vs-engine difference in stored data.
