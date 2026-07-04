<!-- Status: DRAFT · exploration/design, 2026-06-29. NOT yet implementable — this is the
     options + architecture doc for adding IFR/VFR and other realism to CNS. Pairs with
     docs/unified-flight-model.md (engine spec) and docs/unified-flight-model-decisions.md
     (the R1–R12 / G1–G4 / D1–D6 decision log). Where this doc proposes changing a ruled
     decision (notably R8), it says so explicitly in §5.2 and §13. -->

# CNS Performance Engine — IFR/VFR and the Credibility Ladder

## 0. Intent (read this first)

Add an **IFR vs VFR** distinction to the simulator — and the other realism that
naturally rides with it (reserves, routing, runway limits, weight, weather) —
**without ever having to rewrite the model again** as new aircraft data is published.

Two findings shape the whole design:

1. **The engine you'd need mostly already exists.** `CNSFlight.simulateTrip()` is a
   single pure engine; `CNSSettings` is already a set of *toggleable, identity-when-off*
   model factors (reserve, routing padding, SID/STAR, charge taper, charger efficiency);
   `CNSRouting` is an A\* range-constrained router; `CNSRangeGraph` already draws "what's
   reachable from here". So this is an **extension pattern, not a rebuild**.
2. **The thing you asked for — "an engine / backdoor to add new data points in a
   standardised way, so we don't keep adapting the code"** — is therefore a *convention*,
   not a new subsystem. Stated once, so the rest of the doc can lean on it:

> **The standardised way to add realism:** add a `planes.json` field (with a documented
> default + provenance) and/or a `CNSSettings` factor (a toggle + an accessor that returns
> the **identity value when off or when the data is absent**), then pin it with a golden
> test. Adding data can only *improve* fidelity; it never changes existing results until a
> toggle is turned on. That is the credibility ladder (§11).

IFR/VFR is just the **first module** built on that convention. Weight, runway suitability,
wind, weather and cruise-energy are later rungs the architecture is designed to accept.

This is design-only. No code ships from this doc; §12 is the build order.

---

## 1. What already exists (extend these — do not rebuild)

| Capability | Where | Notes for this doc |
|---|---|---|
| Unified flight engine | `static/flight-model.js` → `CNSFlight.simulateTrip(plane, waypoints, opts)` | Pure (no DOM/fetch). Sole source of charge energy since Phase 2 (decisions §G). Reads the factors below live. |
| Reserve / usable battery | `CNSSettings.usableFraction(plane)` ← `landingReserve` (`minLandingSoc` default **0.20**) | **Currently GLOBAL** — per-aircraft `min_landing_soc` was deliberately dropped from the math (decision **R8**). §5.2 proposes revisiting this. |
| Divert/alternate reserve | `CNSSettings.alternateReserveEnabled()` + per-airport `alternate_km` (baked by `airport_alternates.py`); consumed in `CNSRouting` (`altReserveKm = alternate_km / routingFactor`) | Already per-airport, already avoids inflating the divert by cruise padding. §7 makes "suitable alternate" per-**aircraft**. |
| Airways routing padding | `CNSSettings.routingFactor()` ← `routingPadding` (`factor` 1.05, **off** by default) | Multiplier on great-circle. This is the IFR/VFR "route detour" knob (§5.4) — it already exists. |
| SID/STAR padding | `CNSSettings.sidStarPaddingKm()` ← `sidStarPadding` (**10 km**, on) | Fixed km added per leg. The decisions log already notes a flat % "over-pads long hops, under-pads short ones" — exactly the short-electric-leg problem (§5.4). |
| Charging curve | `CNSSettings.effectiveChargePower()` + `chargeTimeMin()` ← `chargeTaper` (CC plateau to `threshold` 0.75, then exponential CV roll-off to `taperPower` 0.30; closed-form, SoC-aware **R7**) | A real charge-curve model **already exists**. §8.4 only *refines* it (per-aircraft `max_kw`, temperature). |
| Charger efficiency | `CNSSettings.gridDemandFactor()` ← `chargerEfficiency` | Grid-kWh inflation; unchanged here. |
| Route planner | `CNSRouting.planRoute()` — A\* over a range-constrained airport graph, detour-corridor pruned; `routedKm()` applies the padding once | The "real airway graph" (§8) extends this from an *airport* graph to a *waypoint/airway* graph behind the same call. |
| Reachability overlay | `CNSRangeGraph.show(ident)` — one-hop reachable airports for the current aircraft | §7 turns this from *range-only* into *range **and** runway-suitable* = a true operable-network view. |
| Charger assignment | `static/charging.js` | Serial, power-matched. Elysian `simultaneous_charging` is scoped out (**R10**). |
| Legacy backend | `sim.py` + `/api/simulate` | Desktop uses `CNSFlight`; `sim.py`/mobile stay (**G3**). New `planes.json` fields must be **optional and safely ignored** by `sim.py`/`mobile.js` (**R11**). |

**Conventions to honour:** padding applied once, on the flown length (**D1**); origin departs
100% / terminus fills to 100% (**D6**); over-range = padded leg energy > usable (**R5**);
goldens captured from code on disk, never from prose (**G2**); migrations ship green behind a
flag (**R12**); mobile is a separate lane (**G3/R11**); `max_kw` is already a planned field
(BACKLOG).

---

## 2. Design principles (the "stable program" contract)

- **P1 — Data-driven.** Every behaviour keys off `planes.json` fields and `CNSSettings`,
  never off a hardcoded tail number or `if (plane.id === …)`. New aircraft = new data only.
- **P2 — Identity when off / graceful degradation.** Each factor returns its identity value
  (×1.0, no-op, "feasible") when its toggle is off **or its data is absent**. So a half-filled
  aircraft is never *broken*, only *less precise* — and filling a field can only move fidelity
  up. This is the load-bearing principle behind "we don't keep adapting the code."
- **P3 — Single-count seams.** One place computes each effect (extends **D1**). Reserves,
  routing padding and divert reserve must compose without double-counting (the engine and
  `CNSRouting` already take care here — e.g. divert distance is divided by `routingFactor`).
- **P4 — Provenance.** Every *published* number carries `{ value, basis, source, confidence }`
  (§3.3). The tool can then show certified vs estimated, and visibly firm up as data matures.
- **P5 — Golden-pinned.** Every aircraft and every factor has a regression test; a data edit
  that changes a pinned, published figure fails CI (extends **G2** and the existing
  `tests/sched_snapshot.mjs` / `js_flight_model` parity gates). §10.
- **P6 — Cross-lane safe.** New `planes.json` fields are optional; `sim.py`/`mobile.js` must
  ignore unknown keys. Any shared `settings.js` signature change is coordinated with the
  mobile lane (**R11**).

---

## 3. The aircraft data schema (versioned, with provenance)

### 3.1 Today's fields (`planes.json`)
`id, name, seats, battery_kwh, range_km, speed_kmh, load_kg?, training_range_km?,
image, svg, default_charger_id?, simultaneous_charging?` — and a retired `c_rate`
(replaced by the planned `max_kw`, BACKLOG). `min_landing_soc` may appear but is
**documentation-only** today (**R8**).

### 3.2 Proposed new fields, grouped by the module that consumes them
Each is **optional**; the "Default when absent" column is what keeps P2 true.

| Field | Unit | Default when absent | Consumed by | Example |
|---|---|---|---|---|
| `class` | enum `trainer`\|`commuter`\|`regional`\|`evtol` | infer from seats/range | §5.1 (drives the `ifr_capable` default) | Velis `trainer`; Elysian `regional` |
| `ifr_capable` | bool | **inferred from `class`** (`trainer`→`false`, else `true`); explicit value overrides; validator warns when inferred | §5.1 capability gate | Velis `false`; Elysian `true` |
| `night_capable` | bool | `false` | §8.2 (future) | — |
| `range_basis` | enum `gross`\|`incl_reserve` | `gross` (= today's behaviour) | §5.3 | Vaeridion `incl_reserve` |
| `reserve_included` | `{regime, diversion_km, loiter_min}` | none | §5.3 | Vaeridion `{ifr, 80, 30}` |
| `min_takeoff_soc` | 0..1 | `0` | §5.2 | **Velis `0.50`** (POH: no takeoff < 50%) |
| `reserve_min` | `{vfr_day, vfr_night, ifr}` (minutes) | fall back to global slider | §5.2 | `{30, 45, 45}` |
| `mtow_kg`, `oew_kg`, `ref_payload_kg` | kg | none → mass checks no-op | §6 | Elysian `mtow_kg` > 80 000 |
| `mass_sensitivity` | Δrange %/100 kg (or an energy model) | none → range fixed | §6 (later rung) | — |
| `takeoff_distance_m`, `landing_distance_m` | m (ref: MTOW, ISA, SL, dry paved) | none → runway check no-op | §7 | — |
| `surfaces_ok` | list | `["paved"]` | §7 | Velis `["paved","grass"]` |
| `max_kw` | kW | none → use charger kW (taper still applies) | §8.4 (already in BACKLOG) | — |

### 3.3 Provenance wrapper
A field may be a bare scalar **or** an object carrying provenance — both accepted, so
migration is incremental:

```jsonc
"range_km": 400,                              // bare → treated as { value:400, confidence:"assumed" }
"range_km": {                                 // rich → drives the spec-sheet confidence badge
  "value": 400, "unit": "km",
  "basis": "incl_reserve",                    // pairs with range_basis
  "source": "Vaeridion public spec, 2024",
  "confidence": "manufacturer-stated"         // certified | manufacturer-stated | estimated | assumed
}
```

A loader normalises bare scalars to `{ value, confidence:"assumed" }` so the rest of the
engine reads `.value` uniformly. `confidence` never changes the math — it only drives display
(§9) and validator warnings (§10).

### 3.4 Versioning
`planes.json` is a top-level array and must stay one (`sim.py` and the frontend iterate it), so the
schema version lives in **`planes.schema.json`** (`schema_version`), not in the catalog. Bumping it
+ a short migration note is how a *breaking* field change is handled; additive fields don't bump it.

### 3.5 Measurements, selection & inference
One value per field isn't enough: an aircraft legitimately has *several* readings of the same
quantity — range at MTOW under IFR vs a lighter VFR range; take-off distance on paved vs grass. So
any quantity may carry a list of **measurements**, each tagged with the `conditions` it was taken
under and its own provenance (the scalar stays as the back-compat default pick):

```jsonc
"range_km": 500,                       // scalar = default pick (existing readers unaffected)
"measurements": [
  { "quantity":"range_km", "value":400, "conditions":{ "regime":"ifr", "load":"mtow" },
    "basis":"usable_incl_reserve", "source":"Vaeridion 2026", "confidence":"manufacturer-stated" },
  { "quantity":"takeoff_distance_m", "value":800,  "conditions":{ "surface":"paved" } },
  { "quantity":"takeoff_distance_m", "value":1000, "conditions":{ "surface":"grass" } }
]
```

- **Selection** (`select(plane, quantity, context)`): pick the measurement whose `conditions` best
  match the flight context (regime, load, surface…), excluding any that *conflict*; ties break by
  confidence (certified > manufacturer-stated > estimated > assumed). A conditioned point only wins
  when the context matches ≥1 of its conditions, so a context-free read falls back to the scalar.
- **Derivation** turns the gross (full-battery) range into a usable planning range per regime
  (`usable_range`, pure + tested): `gross × (1 − min_soc) − reserve(regime)`, and for IFR also
  `− alternate ÷ routing`. Min-SoC is the unusable floor; the final reserve is held *within* the
  usable battery (two separate, sequential buffers). A published *with-reserves* figure (basis
  `usable_incl_reserve`, e.g. Vaeridion 400 km @ MTOW IFR) wins outright and skips the build-down.
  Worked: **Beta @ 630 km gross, 250 km/h, 30% floor → 316 km VFR / 253.5 km IFR (− 50 km divert → 203.5 IFR planning).**
  - **Partial-load range from full-load** (planned): scale the MTOW range up as payload drops via
    mass — this replaces the old inferred 687 km "Light" figure once Max/Light collapse into one.
- This is why **separate catalog entries for one airframe go away**: Vaeridion Max/Light become one
  aircraft whose range is *selected/inferred* by load, anchored on the authoritative 400 km @ MTOW +
  IFR point.

Implemented in `plane_schema.py` + the JS twin `static/plane-schema.js`, validated and golden-tested.
Wiring the selector into `CNSFlight` (so the engine reads the right point per route) is
behaviour-changing and lands with the IFR/VFR module behind goldens.

---

## 4. Engine seams (extend `CNSFlight`)

A "seam" is the single function that owns one effect. Most already exist; the new modules add
two and leave a placeholder for the rest. IFR/VFR is **not** a seam — it's a *profile* that sets
several seams' parameters at once (§5).

| Seam | Today | Extension |
|---|---|---|
| `route_distance(a, b, rules)` | `CNSRouting.routedKm` = `haversineKm × routingFactor`, then `+ sidStarPaddingKm` per leg | Body swappable for a waypoint/airway graph later (§8) — callers never change. |
| `usable_energy(plane, rules)` | `CNSSettings.usableFraction(plane)` (global) + `alternateReserveEnabled` | Per-aircraft, regime-aware reserve (§5.2); `range_basis` short-circuit (§5.3). |
| `charge_power/time(...)` | `effectiveChargePower` + `chargeTimeMin` (taper) | Per-aircraft `max_kw` (§8.4); temperature later. |
| `mass_feasibility(plane, load)` | — | **NEW** (§6): payload check now; energy-vs-mass later. |
| `airport_suitability(plane, airport)` | partially, via generic `alternate_km` suitability in `airport_alternates.py` | **NEW** (§7): per-aircraft runway check; feeds `CNSRangeGraph`. |
| `dispatch_check(plane, wx)` | — | **NEW placeholder** (§8.2): returns "dispatchable" until weather data exists. |
| `cruise_energy(plane, leg, atmos)` | constant `ePerKm = battery/range` | **FUTURE** (§8.3): performance curve replaces the constant. |

**Composition + single-count.** The forward-SoC walk consumes `route_distance` → leg energy,
checks it against `usable_energy`, and books charge via `charge_power/time`. `mass_feasibility`
and `airport_suitability` are **gates** (they flag/forbid, they don't alter energy) so they can't
double-count. The existing care — divert reserve divided by `routingFactor` so a near-direct
diversion isn't inflated by cruise padding — is the template for keeping effects orthogonal.

---

## 5. Module — IFR / VFR (the first concrete module)

IFR/VFR is a **profile** layered over existing knobs plus two new per-aircraft facts. Turning the
profile to "IFR" sets the reserve regime, the routing padding and the alternate requirement to
IFR values **only for aircraft that may fly IFR**.

### 5.1 Capability gate — `ifr_capable`
Not every airframe may fly IFR. The **Pipistrel Velis Electro is type-certified day-VFR only**
(EASA TC, 10 Jun 2020), so IFR must be unavailable for it. A single per-aircraft boolean gates
the whole module: when `ifr_capable` is false, the UI hides/disables the IFR option and the engine
refuses an IFR profile for that plane.

*Missing-data rule — infer from class (decided).* When `ifr_capable` is absent, derive it from the
aircraft `class`: `trainer` → VFR-only (`false`); `commuter` / `regional` / `evtol` → IFR-capable
(`true`). If `class` is also absent, infer from shape (≤2 seats **and** short range → VFR-only;
otherwise IFR-capable). An explicit `ifr_capable` always wins, and the validator (§10) warns whenever
the value was inferred, so it gets confirmed against the type certificate.

### 5.2 Reserves — per-aircraft, regime-aware
Regulatory baselines (EASA NCO / FAA 91.151, see §14):

| Regime | Final reserve | Alternate |
|---|---|---|
| VFR day | 30 min at cruise | not required |
| VFR night | 45 min at cruise | not required |
| IFR | 45 min at cruise | to alternate unless destination weather/runways exempt it |

A reserve defined in **minutes** converts to a **different fraction of battery for each aircraft**,
because endurance differs. That is the crux of "aircraft-specific":

```
usable_battery_km = gross_range × (1 − min_soc)            // min-SoC = unusable floor (battery health)
reserve_km        = (speed_kmh / 60) × reserve_min(regime) // final reserve, held WITHIN the usable battery
planning_range_km = usable_battery_km − reserve_km         // VFR / IFR planning range
                    − alternate_km, ÷ routing_factor       //   (IFR only)
```

Min-SoC and the final reserve are **separate, sequential** buffers: the min-SoC slice is battery you
never touch (BMS/health); the reserve is energy held *within* the usable part for a go-around or
hold. `min_takeoff_soc` is a third, distinct *dispatch* gate (you may not launch below it). **Worked example — Beta @ 630 km gross, 250 km/h, 30% min-SoC (advised floor, ruled 2026-06-30):** usable battery = 441 km; VFR (− 125 km) = **316 km**; IFR (− 187.5 km, − 50 km divert ÷ routing) ≈ **203.5 km**. A published with-reserves
figure (e.g. Vaeridion's 400 km @ MTOW IFR) is used as-is instead of this build-down.

Worked across the fleet (30-min VFR / 45-min IFR final reserve, catalog figures; illustrative):

| Aircraft | Endurance ≈ range/speed | 30-min reserve | 45-min reserve |
|---|---|---|---|
| Velis Electro | 87.5 km / 150 ≈ **35 min** | ~86% of battery | **exceeds endurance** → infeasible |
| Beta Alia CX300 | 500 / 250 = 120 min | ~25% | ~37% |
| Vaeridion (Max) | 500 / 400 = 75 min | ~40% | ~60% |
| Elysian E9X | 1000 / 720 ≈ 83 min | ~36% | ~54% |

The Velis row is the headline: a 45-min reserve is **physically impossible** for a ~35-min-endurance
aircraft, and even a 30-min VFR reserve is why it only flies circuits. A single global reserve
fraction (today's model) cannot represent a fleet this wide.

**R8-bis (RULED — supersedes R8).** R8 deliberately made the reserve a **global** `usableFraction`
slider and dropped per-aircraft values. That generalization is **retired**: per-aircraft, regime-aware
reserves are now the model. The global slider survives only as a fleet-wide what-if **override** and
as the **fallback** when an aircraft carries no reserve data — every plane computes (all carry `range_km` + `speed_kmh`; `RESERVE_MIN` supplies regime defaults) — the flat `usableFraction` survives only as the energy floor and as the reach fallback when `plane-schema.js` is not loaded. Real precedent that per-aircraft floors
exist in the wild: the **Velis POH forbids takeoff below 50% SoC** — a hard `min_takeoff_soc = 0.50`
that no global slider captures.

*Direction of travel (informs the default, §8.4):* EASA is moving **away** from time-based reserves
for electric/VTOL toward an *energy-to-go-around-and-land* basis (SC-VTOL MoC; SC E-19 for the
battery), precisely because fixed minutes punish short-endurance electric aircraft. So the reserve
should be a **selectable framework** (§8.4), not a hardcoded "minutes" rule.

### 5.3 Range basis — don't double-count published reserves
Some OEMs publish range **with reserves already inside it**. The clearest example is **Vaeridion's
400 km**, quoted as "400 km **plus** IFR reserves" in one place and "400 km **including** an 80 km
diversion and 30-min loiter" in another — the exact ambiguity that makes `range_basis` + provenance
mandatory rather than nice-to-have.

- `range_basis = gross` (default): the reserve module applies normally (§5.2).
- `range_basis = incl_reserve`: the published `range_km` **already nets out** the named reserve, so
  the reserve module is a **no-op for the matching regime** (applying it again would double-count).
  `reserve_included = {regime, diversion_km, loiter_min}` records what's baked in.
- *VFR on an `incl_reserve(ifr)` aircraft (RULED — add the range back):* a VFR flight drops the IFR
  alternate/diversion and uses the smaller VFR final reserve, so the range won is **extrapolated back
  in**. From `reserve_included = {diversion_km, loiter_min}`: baked-in IFR reserve ≈
  `diversion_km + loiter_min/60 × speed`; VFR day reserve ≈ `30/60 × speed`; so
  `vfr_usable_range = range_km + diversion_km + (loiter_min − 30)/60 × speed` (floored at `range_km`).
  For Vaeridion (80 km diversion + 30-min loiter), the loiter terms cancel and VFR adds back ≈ **+80 km**
  (the diversion allowance).

The current catalog has Vaeridion at **500 km** while the published planning figure is **400 km incl.
reserves** — a real reconciliation (§12), to be fixed with `basis` + `source` + a golden, **not** a
silent edit.

### 5.4 Routing — IFR vs VFR detour
IFR follows airways + SID/STAR (a longer flown path); VFR is nearer the great-circle. This maps onto
**existing** knobs:

- En-route airways extension is **small**: Eurocontrol reports ~1.6% (2025), historically up to ~3.6%.
  So the IFR `routingFactor` is ≈ **1.02–1.05**, VFR ≈ **1.00**.
- The **dominant** penalty on short electric legs is **terminal** (SID/STAR), which is a *fixed km*
  per leg, not a percentage — exactly the existing `sidStarPaddingKm` (10 km default). IFR keeps it;
  VFR sets it low or zero. (The decisions log already flags that a flat % "over-pads long hops,
  under-pads short ones" — this is the resolution.)
- *VFR is the harder one to model "properly"* — it's not airways but staying clear of controlled
  airspace and terrain, which needs airspace polygons + terrain. So keep VFR as a light factor even
  after IFR gets a real graph (§8).

### 5.5 Profile defaults

| Knob (existing `CNSSettings`) | VFR (day) | IFR |
|---|---|---|
| reserve regime (§5.2) | 30 min | 45 min |
| `alternateReserve` | off (unless filed) | on |
| `routingFactor` | 1.00 | 1.02–1.05 |
| `sidStarPaddingKm` | 0–5 km | 10–15 km |

### 5.6 Hook points
- `planes.json`: add `class`, `ifr_capable`, `range_basis` (+ `reserve_included`, `min_takeoff_soc`).
- **Settings scope — global today, per-route tomorrow (RULED).** Today the VFR/IFR `ruleMode` lives in
  **Model settings** (the global `CNSSettings` blob). The plan is to rename that surface to **Route
  settings** and make it **per-route**: each saved route in the DC carries its own `ruleMode` (and any
  overridden factors) instead of one global value. Mechanically, `ruleMode` becomes a property persisted
  on the saved trip (like `tripType`), and the engine resolves each factor as
  **route-override ?? global ?? identity** — i.e. `CNSFlight.simulateTrip` reads an `opts.settings`
  context rather than only the global accessors. Back-compatible: no per-route override → global →
  identity, exactly as today.
- `static/settings.js`: add the `ruleMode` resolution + a preset mapping `vfr`/`ifr` onto the existing
  `routingFactor` / `sidStarPadding` / reserve values, preserving identity-when-off.
- UI: a VFR/IFR switch (per route once Route settings lands), disabled when `!ifr_capable`.
- `sim.py` / `mobile.js`: ignore the new fields (**G3/R11**).

---

## 6. Module — Weight / load (groundwork now, physics later)

Battery-electric is *cleaner* than fuel here: the pack doesn't burn off, so mass is ~constant
through the flight and **payload is the only real variable** (no Breguet term).

- **Now (cheap, high value):** schema `mtow_kg`, `oew_kg`, `ref_payload_kg`, and a
  `mass_feasibility()` gate — requested `(pax × pax_weight + cargo)` ≤ payload capacity. You already
  have `seats` and `load_kg`, so a basic feasibility flag (mirroring the `overRange` flag) is nearly
  free and immediately raises credibility. Elysian's **>80 t MTOW** (Apr 2026) shows why the absolute
  numbers matter.
- **Later rungs (data-gated):** energy-vs-mass scaling (range shrinks with payload) via
  `mass_sensitivity` or a drag/energy model; climb energy; and the **IFR-equipment payload penalty**
  — which is *not* a separate effort, just a fixed mass term added inside this module when the IFR
  profile is active.

---

## 7. Module — Airport / runway suitability (groundwork now)

Answers "**which airports can this plane actually use?**" — the highest-leverage planning question,
because runway limits define an aircraft's whole reachable network.

**Data — `runways.csv` (47,951 rows), real columns:** `length_ft`, `width_ft`, `surface`,
`closed`, `lighted`, per-end `*_elevation_ft`, `*_displaced_threshold_ft`, headings. Three realities
to design around:
- **Length is feet** → convert to metres to compare with `takeoff_distance_m` / `landing_distance_m`.
- **`surface` is messy free text** (`ASP`, `ASPH`, `CON`, `CONC`, `TURF`, `GRS`, `Grass`, `GVL`,
  `WATER`, `DIRT`, … 25+ variants) → needs a **normalization map** to categories
  (paved / grass / gravel / dirt / water / unknown). `airport_alternates.py` already does
  surface+length+open filtering — reuse and generalise it.
- **No declared distances** (TORA/TODA/ASDA/LDA) — only physical length. Approximate LDA/TODA with
  physical length (minus displaced threshold for landing) and note the caveat. Per-end
  `elevation_ft` is a free input for the future density-altitude correction.

**Schema:** `takeoff_distance_m`, `landing_distance_m` (ref: MTOW, ISA, SL, dry paved), `surfaces_ok`.

**Seam:** `airport_suitability(plane, airport) → { operable, limiting_factor, margin }` where
`limiting_factor ∈ {too_short, wrong_surface, closed}`.

- **Now (implemented — `field_performance.py`, pure + tested):** `normalize_surface()` maps the
  messy `surface` codes; `airport_suitability(plane, runway)` selects TODR by surface and checks
  `length_ft→m ≥ TODR × margin`, `surface ∈ surfaces_ok`, `closed == 0`, returning
  operable / too_short / wrong_surface / closed (or `operable: null` when the aircraft has no
  distance data). Not yet wired into the planner/overlay. Real data is in the catalog: Vaeridion
  TODR 800 m paved / 1000 m grass.
- **Later rungs:** weight / density-altitude / slope / contamination corrections (ties to §6 and the
  per-end elevation); declared distances; displaced thresholds.

**Ties (why it's worth doing early):**
- Turns the generic `alternate_km` into a **per-aircraft** suitable-alternate (generalise
  `airport_alternates.py`).
- Filters the `CNSRouting.planRoute` candidate set to airports the plane can actually use.
- **Feeds `CNSRangeGraph`:** today the reach overlay is *range-only*; gating spokes by
  `airport_suitability` makes it a true **operable-network** view. Worked example: a Velis
  (short field, grass-capable) reaches far more fields than a 90-seat Elysian (long paved only) —
  visible directly on the map.

---

## 8. Future modules (designs, data-gated)

Each is specified now so the schema + seams anticipate it; each stays a no-op (P2) until its data
exists.

### 8.1 Wind (head/tailwind)
Everything is still-air today. On a 150 km/h aircraft a 20–30 kt wind swings effective range and
energy enormously — the single biggest realism gap for short legs. Ground speed = TAS ± wind
component; the leg's energy and time derive from the air distance vs ground distance. Seam: a wind
term on `cruise_energy`/`flightMin`. Data: a wind field (METAR/TAF or a GFS slice) or a scenario
headwind. Eurocontrol's own note that "the wind-optimum route is not the shortest" is the reason this
is orthogonal to §5.4 routing.

### 8.2 Weather / dispatch availability
`dispatch_check(plane, wx) → { dispatchable, alternate_required }`. VFR can't launch in IMC; an
`ifr_capable` plane can. Alternate-required follows destination weather vs minima. This affects
**network availability / utilisation**, not a single leg's energy, so it belongs to an operations
layer over the scheduler. EASA's go-around-energy reserve basis (§5.2) is defined here for electric.

### 8.3 Cruise altitude / speed energy
Replace the constant `ePerKm = battery/range` with a performance curve (altitude/speed → power), so
IFR's higher cruise and VFR's lower cruise burn correctly. Seam: `cruise_energy()`. Data: per-aircraft
power curves (rare today → stays constant until published).

### 8.4 Charging-curve refinements
The CC→CV taper already exists (`chargeTaper`). Refinements: per-aircraft **`max_kw`** (already a
BACKLOG item — replaces the retired `c_rate`), capping accepted power at `min(charger_kw, max_kw)`;
then temperature derating and state-of-health (SoH) capacity fade as later rungs. Also fold in the
**selectable reserve framework** from §5.2: `time-based` (FAA-style minutes) | `energy-go-around`
(EASA SC-VTOL direction) | `pct-soc` — a strategy switch inside the reserve accessor, so the model
stays valid as electric-specific rules land instead of needing a rewrite.

### 8.5 Anticipated-only (reserve a schema slot, don't build)
Battery **temperature** (cold cuts range and charge rate) and **state-of-health** (capacity fades
over the airframe's life) — name them now so adding them later is a field, not a refactor.

---

## 9. Spec sheet (design only)

A per-aircraft data sheet — the human-readable face of the schema — opened from the plane card.
Reads `PLANES_BY_ID` + the provenance wrapper; computes nothing the engine can't.

**Sections:** identity (seats, MTOW/OEW); energy (battery, usable, reserve — *for the selected
VFR/IFR profile*); performance (range **with a basis badge** `gross`/`incl-reserve`, speed, derived
`kWh/100km`, endurance, and usable range under **both** VFR and IFR); field (TODR/LDR, `surfaces_ok`);
charging (`max_kw`, the taper curve, a sample charge time); capability (`ifr_capable`, night);
**reach** (count of operable airports via §7). Every field shows a **confidence badge** from its
provenance — certified vs estimated — so the sheet *is* the credibility display.

**Payload–range diagram.** The single most useful planning visual: a curve trading payload against
range per aircraft. Near-term it's a 2-point sketch (max payload @ ref range, zero payload @ max
range) with a "needs `mass_sensitivity` for the true curve" note; it sharpens automatically as §6
data lands. Reuse the `range-graph.js` / charting patterns already in the app.

---

## 10. Data governance & testing (the stability backbone)

This is the concrete mechanism behind "standardised way" + "stable program."

- **Schema validator** (on load + in CI): required fields present, units/ranges sane, `range_basis`
  and `confidence` are valid enums, `incl_reserve` implies `reserve_included`, `ifr_capable` present
  (warn if missing → defaults VFR), provenance present (warn on `confidence:"assumed"`). Bad data is
  caught at the door, not in a wrong simulation.
- **Per-aircraft golden tests:** pin published figures so a data edit can't silently erode
  credibility — e.g. Velis day-VFR-only + 50% takeoff floor + ~35–50 min endurance; Vaeridion
  400 km `incl_reserve`; Elysian MTOW > 80 t. Extends **G2** and the existing
  `tests/sched_snapshot.mjs` + `js_flight_model` parity gates.
- **Per-factor goldens:** each new `CNSSettings` factor ships with off=identity and on=expected
  snapshots, exactly like the current `settings` test suite.
- **Versioned schema + migration notes** (§3.4).

---

## 11. Credibility ladder (data-completeness → fidelity)

The architecture's promise: fidelity rises **monotonically** with data, no code change. Per module:

| Module | Rung 0 (no data) | Rung 1 | Rung 2 | Rung 3 |
|---|---|---|---|---|
| Reserves | global slider (today) | per-aircraft minutes | selectable framework | energy/go-around (EASA) |
| Routing | flat factor + SID/STAR (today) | rule-aware factor | airway graph (IFR) | + airspace/terrain (VFR) |
| Charging | CC→CV taper (today) | per-aircraft `max_kw` | temperature | + SoH fade |
| Weight | range fixed (today) | payload feasibility | energy-vs-mass | drag polar + climb |
| Runway | none (today) | length+surface+open | + weight/density alt | declared distances |
| Cruise | constant `ePerKm` (today) | — | — | performance curve |

Rung 0 is current behaviour in every row — so shipping the framework changes nothing until data
or a toggle says so.

---

## 12. Phased roadmap & migration

1. **Schema + provenance + validator** (§3, §10) — additive, no behaviour change. **Shipped**, and
   extended with the measurements model + selector + the usable-range build-down (§3.5) and the
   runway-suitability helper (§7) — all additive, tested, not yet engine-wired. Authoritative data
   points live as measurements (Vaeridion 400 km IFR@MTOW + TODR; Beta 630 km gross); the live scalar
   swaps (Vaeridion 500→400, Beta 500→630), speed updates, Max/Light collapse, and wiring the selector
   into `CNSFlight` all move engine numbers → step 2, behind a golden re-bless.
2. **IFR/VFR module** (§5): `class`/`ifr_capable` gate, `range_basis` + VFR add-back, the VFR/IFR
   profile over the existing `routingFactor`/`sidStarPadding`/reserve knobs (R8-bis ruled — per-aircraft
   reserves). Ships global-scoped, then moves `ruleMode` **per-route** (Model settings → Route settings, §5.6).
3. **Runway suitability** (§7) + feed `CNSRangeGraph`.
4. **Weight feasibility** (§6).
5. **Spec sheet + payload–range** (§9).
6. **Future modules** (§8) as data lands.

**The one structural addition** is a thin profile/preset layer mapping `ruleMode → CNSSettings`
values; everything else is new optional fields + new gates. Back-compat: all factors identity-when-off,
saved plans unchanged (**R12** discipline), `sim.py`/mobile ignore new fields (**G3/R11**), coordinate
any `settings.js` signature change with the mobile lane. **Data reconciliation:** Vaeridion 500 →
400 `incl_reserve` with provenance + golden. **Explain-first** (per BACKLOG convention) for anything
that moves a saved number — chiefly R8-bis.

---

## 13. Decisions (ruled 2026-06-30)

1. **R8-bis — RULED: per-aircraft reserves; the global generalization is retired.** The global
   `usableFraction` slider stays only as a fleet-wide override / fallback when an aircraft has no
   reserve data (§5.2).
2. **`ifr_capable` default — RULED: infer from `class`** (`trainer` → VFR-only, else IFR-capable);
   explicit value overrides; validator warns when inferred (§5.1).
3. **VFR on an `incl_reserve(ifr)` aircraft — RULED: add the range back.** Drop the IFR diversion, use
   the smaller VFR final reserve, extrapolate the won range in (≈ +80 km for Vaeridion) (§5.3).
4. **Reserve framework default — RULED: ship `time-based` minutes, keep it selectable** toward the
   energy/go-around basis EASA is adopting for electric (§8.4).
5. **Where IFR/VFR lives — RULED: in settings, scoped per-route.** Lives in Model settings now; that
   surface becomes **Route settings** and `ruleMode` moves onto each individual route in the DC rather
   than staying global (§5.6).
6. **Provenance granularity — RULED: per-field** (richer spec sheet) (§3.3).
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

**Still open / deferred:** the `class` taxonomy values; the pax-weight assumption for
`mass_feasibility` (§6); data sources for wind/weather (§8); and the per-route settings migration,
which is its own design pass (it changes how every factor is resolved, so it deserves the same
golden-gated treatment the engine itself got).

---

## 14. Sources

Regulatory / reserves:
- EASA AMC & GM to Part-NCO (reserve policy): https://www.easa.europa.eu/sites/default/files/dfu/amc_gm_to_part-nco_-_issue_2_amendment_12.pdf
- FAA 14 CFR §91.151 (VFR fuel: 30 min day / 45 min night): https://www.ecfr.gov/current/title-14/chapter-I/subchapter-F/part-91/subpart-B/subject-group-ECFR4d5279ba676bedc/section-91.151
- EASA MoC SC-VTOL (energy / go-around reserve direction for electric): https://www.easa.europa.eu/sites/default/files/dfu/MOC-3_SC-VTOL_-_Issue_2_-_21_Jun_2023_-_FINAL.pdf
- EASA SC E-19 (propulsion batteries): https://www.batterydesign.net/legislation-rules-and-regulations/easa-sc-e-19/
- "Revisiting Energy Reserve Requirements for Battery-Electric VTOL Aircraft" (AIAA 2024): https://arc.aiaa.org/doi/10.2514/6.2024-3904

Routing efficiency:
- Eurocontrol Horizontal Flight Efficiency (en-route extension vs great-circle): https://ansperformance.eu/efficiency/hfe/

Aircraft (fleet):
- Pipistrel Velis Electro (day-VFR TC; endurance; 50% takeoff SoC): https://en.wikipedia.org/wiki/Pipistrel_Velis_Electro
- Vaeridion Microliner (400 km + IFR reserves; 9 seats): https://vaeridion.com/the-microliner/
- Elysian E9X (90 seats; range; >80 t MTOW, Apr 2026): https://www.flightglobal.com/air-transport/2026/04/elysian-tweaks-e9x-design-boosting-weight-and-wingspan-of-battery-powered-aircraft/


