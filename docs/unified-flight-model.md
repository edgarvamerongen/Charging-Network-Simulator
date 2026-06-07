<!-- Status: DRAFT · reconciled to shipped PR#3 on 2026-06-07 (D6 CORRECTED — see G1). NOT yet
     implementable: gates G1–G4, the 5 blockers, and ~33 open decisions live in
     docs/unified-flight-model-decisions.md — resolve those before any engine code.
     Items tagged [CORRECTED]/[OPEN]/[STALE] below are reconciled or still unsettled. -->

# CNS Flight Engine — `simulateTrip()` Spec

## 1. Problem & locked decisions

The same flight numbers (leg distance, leg/charge energy, SoC, flight/charge time) are computed in **four** independent sites — `sim.py` (raw great-circle, depart-full, linear charge), `scheduler.js`+`demand.js` (padded, SoC-walk, taper), `index.html` `_legEst` (own padded formula), and `report.js` (a duplicate demand walk) — with divergent conventions, so views disagree (a map label reads 41 km while the breakdown reads 39; a stop charges +13 kWh after a 9 kWh leg). Replace all four with one pure engine.

**Locked decisions:** **D1** routing padding applied exactly **once**, at the engine, and only to the **flown path** — TIME + ENERGY (×routingFactor); geographic **DISTANCE** is never padded (it matches the map line and the available-range reach check — padding both double-counts). **D2** one engine in `static/flight-model.js`, layered on `settings.js`+`routing.js` (not in `index.html`). **D3** every view only reads engine output — zero energy/distance/SoC/time math in `index.html`. **D4** planner preview and demand calculator invoke the same function. **D5** *(deferred — G3)* retiring `sim.py` energy math is a later, **mobile-gated** phase; `sim.py` + `/api/simulate` stay until mobile migrates. **D6 [CORRECTED — was inverted]** a base/one-way **origin departs at 100% SoC**, and the **terminus** (one-way destination, retour home, training origin) always recharges to **100%**, both **ignoring** the charge target; the target governs **only** away-from-base **intermediate** stops (+ the retour DEST turnaround). This is the shipped PR#3 model; the old D6 ("departs at target") would regress bug #32.

## 2. Engine API

```js
// static/flight-model.js  →  window.CNSFlight.simulateTrip
simulateTrip(plane, waypoints, opts) → FlightProfile
```
Pure: no DOM, `localStorage`, or `fetch`. Loaded after `settings.js`+`routing.js`, before `scheduler.js`/`demand.js`. Reads global factors live from `CNSSettings` (`routingFactor`, `usableFraction`, `chargeTargetDefault`, `effectiveChargePower`, `chargeTimeMin`, `gridDemandFactor` — all identity-when-off) and `CNSRouting.haversineKm`.

- **`plane`**: `{ battery_kwh, range_km, speed_kmh, c_rate?, min_landing_soc? }` (effective spec from `selectedPlaneSpec()`).
- **`waypoints`**: ordered `[{ ident, name, lat, lon, role?, chargerKw?, targetSoc? }]`, origin-first, **already expanded** (origin→stops→dest, and for retour the mirrored return appended). Per-node `chargerKw`/`targetSoc` are the **only** difference between preview (constant) and demand (per-airport) callers (D4).
- **`opts`**: `{ tripType: 'one-way'|'retour'|'training', trainingRangeKm? }`.

The engine **rebuilds geometry from coords only** — it ignores any persisted `*_energy_kwh`/`charges[]` on saved trips (those are raw; re-padding them is the current bug). It also owns the **over-range** and **same-origin** guards (moved from `sim.py`/`app.py`).

## 3. FlightProfile schema (units explicit)

```js
{ tripType, multiLeg, training,
  battery_kwh, usable_kwh, reserve_kwh, availRangeKm,   // availRangeKm = range·usable/route
  routingFactor, gridDemandFactor,

  nodes: [{ ident, name, lat, lon, role, departSocFrac, billable }], // role 'origin' billable:false

  legs: [{ fromIdent,fromName,toIdent,toName,
    rawKm, distKm,          // km; distKm = rawKm·routingFactor (the ONE distance views read)
    flightMin,              // distKm/speed·60
    energyKwh,              // (battery/range)·distKm
    socStartFrac, socEndFrac, overRange, legIndex }],

  charges: [{ atIndex, ident,name,lat,lon, role,direction, // role dest|home|stop|training; dir out|back
    arrivalSocFrac, targetSocFrac, departSocFrac,
    energyKwh, gridKwh,      // gridKwh = energyKwh·gridDemandFactor
    powerKw, chargeMin,      // powerKw = effectiveChargePower(...); chargeMin = chargeTimeMin(...) taper
    isTerminal }],

  phases: [{ kind:'fly'|'charge', legIndex?,chargeIndex?, start,dur, ident?,label }], // min; queue-free template

  totals: { rawKm, distKm, flightMin, chargeMin, enRouteMin, terminalMin,
            travelMin,                    // flightMin + enRouteMin (terminal top-up excluded)
            energyUsedKwh, gridKwh, avgUsageKwhPer100km },
  terminal: { name,ident,arrivalSocFrac,targetSocFrac,energyKwh,chargeMin },
  energyAt(ident)→kWh, errors:[] }
```

## 4. Forward-SoC walk (one algorithm, all trip types)

Track SoC in kWh; `batt=battery_kwh`, `usable=batt·usableFraction(plane)`, `reserve=batt−usable`, `route=routingFactor()`, `ePerKm=batt/range_km`.

1. **Training** (closed loop, no chain): `legE = min(ePerKm·trainingRangeKm·route, usable)` **[OPEN — G4(a)]** — shipped code does NOT pad training energy; the `·route` here adds ~5%. Reproduce today's (unpadded) number unless padding is adopted as a signed-off change. Emit one charge at origin, `role:'training'`, `isTerminal:true`. Return.
2. **Build chain** from `waypoints` (one-way/retour already expanded). Per leg `i`: `rawKm=haversine(i,i+1)`, `distKm=rawKm·route` (**padding once, D1**), `energyKwh=ePerKm·distKm`, `flightMin=distKm/speed·60`. Flag `overRange` when `energyKwh>usable`; push to `errors[]` (don't absorb).
3. **Origin departure [CORRECTED]:** the base always departs **full** — `socKwh = batt` — ignoring any (even per-airport) target. Record on `nodes[0]` (`role:'origin'`, `billable:false`). Multi-leg one-way bills **no** origin charge. *(Training origin recharges exactly what the session used, `min(legE,usable)`, which also leaves it full.)*
4. **Walk** `i=0..n−1`: `arrival = max(0, socKwh − legs[i])` (**clamp to 0, not reserve** — reserve-floor would silently change billed energy).
5. **Departure / charge rule [CORRECTED]:** terminal (one-way dest, retour home, training origin) → **`batt`** (always full, ignores target); intermediate → `target!=null ? max(target·batt, legs[i+1]+reserve) : legs[i+1]+reserve` — the charge target applies **only here** (the #34 charge-to-reach toggle lives here later; default reach-floored-target). Then `depart=min(depart,batt)`, `chargeE=max(0, depart−arrival)`, `socKwh=arrival+chargeE`.
6. **Charge time:** `powerKw=effectiveChargePower(node.chargerKw,batt,cRate)` **[STALE]** — per-aircraft `c_rate` is retired (catalog field gone; the hook is a non-binding global 5C); #35 replaces it with `max_kw`, held until **after** the engine ships. `chargeMin=chargeTimeMin(chargeE,powerKw,batt)` (taper, in `settings.js`) **must match the DES bit-for-bit** (blocker 3 — drop the `toFixed(2)`). DES re-sizes per claimed charger later.

**Invariants [CORRECTED]:** `Σ legs.energyKwh == Σ charges.energyKwh` (origin starts full, terminal ends full → closed walk). One-way terminal recharge `== leg` **always** (both ends fill to 100%, target-independent). Retour home arrival **does** depend on the target — correctly, via the target-governed DEST turnaround. **Arrival SoC is a forward-walk fact, never `target − topup`:** `arrival = batt − terminalKwh` exactly (already shipped as the committed arrival fix `7af3d97`). *(The old "origin inits at target, terminal tops to target" line is deleted — it encoded the inverted D6.)*

## 5. Consumer → reads map (no view computes)

| Consumer | File:line | Reads |
|---|---|---|
| Map leg label `addLegLabel` | index.html 2689–2718 | `legs[i].{distKm,flightMin,energyKwh}` (delete `_legEst`+raw fallback) |
| Trajectory pill `updateTrajectory` | 1838–1851 | `totals.distKm`, `availRangeKm` |
| Over-range `validateRoute`/`drawLiveRoute` | 1953–1959, 2929–2941 | `legs[].overRange`, `availRangeKm` |
| Result headline `renderResult` | 2982–2995 | `totals.{energyUsedKwh,travelMin,chargeMin,gridKwh}` |
| Route-step rows | 3033–3071 | `legs[]`+non-terminal `charges[]` (stop reading raw `data.leg_*`) |
| Charging section | 3076–3090 | `terminal.*`, `totals.gridKwh` |
| Demand drawer | 3346–3399 + demand.js 64–144 | `energyAt(ident)`, `charges[].{energyKwh,gridKwh,powerKw,chargeMin,role,direction}` |
| Scheduler `tripPhases`/`tripBreakdown` | scheduler.js 173–299 | thin wrappers → `profile.phases`/`totals` |
| DES `runGlobal` | scheduler.js 367–499 | `phases[]` template; keeps queueing/peak/power-rebind |
| Animation | animation.js 123–161 | `phases[]`, `charges[].atIndex`, `legs[].socEndFrac` |
| PDF `report.js` | 53–94 | `energyAt(ident)`, `charges[]` (migrate **in lockstep** with drawer) |

## 6. How each inconsistency dies

- **41 vs 39 km** — label and breakdown both read `legs[].distKm`; the raw-vs-padded fork in `addLegLabel` (data-presence-dependent, 2702–2704) is deleted.
- **Headline ≠ leg rows** — both read `legs[].energyKwh`/`totals.energyUsedKwh`; raw `data.leg_*` reads removed.
- **+13 after 9 kWh leg** — one walk produces arrival, departure, and charge from the same SoC; no second engine's state is ever consulted (kills `sim.py:276` inflation).

## 7. Migration (each step ships green, browser-verifiable at :5055)

0. **Goldens:** snapshot current outputs for {one-way, retour-covers, retour-deficit, **retour with `usable<2·leg<batt`**, training, 2-stop one-way, 2-stop retour} × {off, on, 80% target}, **plus the live-preview-vs-post-simulate label case**.
1. **Land `flight-model.js` dark** + `availRangeKm`; console-verify parity vs goldens (`Σleg==Σcharge`, retour `2·leg`, one-way terminal, training cap).
2. **Map labels** → `legs[i]`; delete `_legEst`+fallback. *Fixes 41-vs-39; verify before AND after a Simulate click.*
3. **Trajectory/over-range** → `totals.distKm`/`overRange`/`availRangeKm`.
4. **`tripPhases`/`tripBreakdown` → engine** (thin wrappers; DES `runGlobal` unchanged, same `dur` semantics so cumShift diff holds). **Same PR:** migrate result route rows (step 6) to avoid a harder-diverged intermediate.
5. **Demand drawer + `report.js` together** → `energyAt`/`charges`.
6. *(folded into 4)* route rows read `legs[]`/`totals`.
7. **Cut `/api/simulate`:** build profile client-side; `addFolder` reads engine output (saved-trip schema unchanged). **Precondition:** over-range + same-origin guards already in engine.
8. **Retire `sim.py` energy (D5):** delete `calculate_flight_by_distance` energy block + `_simulate_multi`; keep `get_airport`/`haversine`/static. Verify full flow reproduces goldens; `git grep` shows zero energy/SoC/time math in `index.html`.

## 8. Risks / open questions

- **DES `dur` drift (highest risk):** `runGlobal` diffs `dur − L.ph[ci].dur`; engine charge times must match `chargeTimeMin` to the same rounding or every downstream arrival shifts. Verify peak kW + overflow across the **full seeded network**, not one airport.
- **Saved-trip double-pad:** engine must rebuild chain from `stops`/coords, never from persisted `*_energy_kwh`.
- **Task #34** (intermediate charge-to-reach vs -to-target) is a future engine settings-flag; default = reach-floored-target. Do not relitigate now.
- **`energyAt` raw-vs-usable cap** (demand.js:56 legacy path caps home at `2·leg` vs `batt`, not `usable`) — the `usable<2·leg<batt` golden catches any change when that path retires.
- **Origin node** carried as `billable:false` for open task #33 (list one-way origin with 0 charging) without emitting demand.
