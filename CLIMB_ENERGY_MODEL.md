# Climb-energy model — from linear ePerKm to a phase-aware Rung 1

Research memo, 2026-07-27. Status: **parameters ruled — build not yet approved.**
Rulings (Edgar, 2026-07-27): `climb_overhead_pct` = **10%**, interpreted as the
NET climb-minus-descent overhead (§2.1); saturation distance is **inferred per
aircraft as 15% of catalog range** (`climb_sat_frac`), not a fixed km value and
not a data column (§3.1). Open: training-block treatment (§5). Build is a
separate, later approval.

## 1. Problem

Every kWh in CNS derives from one scalar:

```js
ePerKm = battery_kwh / range_km          // static/flight-model.js:77
energyKwh = ePerKm * distKm              // static/flight-model.js:141
```

That linearity assumes cruise-only physics. In reality climb draws roughly
**2× cruise power** (Velis Electro: 46 kW climb vs 25 kW standard cruise), so
the energy of a leg has a distance-independent component the linear model
smears across the aircraft's whole catalog range. Consequences today:

- **Short flights are over-credited.** A 50 km Beta Alia hop is charged 22.5 kWh;
  a phase-aware estimate is ~35 kWh (+57%, §4). Charging demand at short-haul
  airports — CNS's core sizing question — is understated by the same margin.
- **Charging stops look free.** Every extra stop in a multi-leg route restarts
  a climb, but the router only discourages stops with a soft 25 km penalty. The
  energy books never see the cost (§4, the 5-stop chain pays 5.4 climbs).
- The linear constant lives in four places that must move together:
  `flight-model.js:141` (engine), plus three copies in `templates/index.html` —
  `_legEst` (~:4380), the spec-card usage tile (~:3858), and the calc-audit
  panel (~:4933–4963) which prints the formula as user-facing text.

`docs/performance-engine.md` §8.3 already reserves this seam
(`cruise_energy()` — "replace the constant with a performance curve") and its
credibility ladder has no rung between "constant ePerKm" (today) and "full
performance curve" (needs data nobody publishes). This memo defines that
missing **Rung 1**.

## 2. The model — ramp-saturation affine

```
E(leg) = ePerKm_cruise × d  +  E_max × min(1, d / d_sat)
d_sat  = climb_sat_frac × range_km          (per aircraft, inferred)
```

Two global knobs (Model settings; per-aircraft refinement is a later step):

| knob | meaning | **ruled value** | slider range |
|---|---|---|---|
| `climb_overhead_pct` | NET climb-minus-descent overhead, as % of battery: `E_max = pct × battery_kwh` (§2.1) | **10%** | 0–20% (0% = today's linear model, exact) |
| `climb_sat_frac` | saturation distance as a fraction of catalog range: `d_sat = frac × range_km` (§3.1) | **15%** | 5–30% |

**Why this shape.**
- Below `d_sat`, climb cost scales with distance: a 20 km hop cruises low and
  pays only a fraction of a full climb (short flights climb less — the ruled
  requirement). Above `d_sat`, each leg pays exactly one full climb.
- `d_sat` scales with the aircraft (a Velis saturates at ~13 km, an E9X at
  ~150 km) with zero new data, because catalog range proxies aircraft scale —
  see §3.1 for why this beats both a fixed km value and a data column.
- **Calibration anchor:** since `d_sat < range` always,
  `ePerKm_cruise = (battery − E_max) / range` exactly — a full-catalog-range
  mission consumes exactly one battery. Catalog ranges and the CE Delft-derived
  anchors (Elysian 800 km IFR-effective, etc.) stay true by construction —
  nothing silently loses headline range.

### 2.1 Descent & landing (why there is no third term)

Descent is close to free for fixed wings: the aircraft spends the potential
energy banked in climb, at near-idle power (systems only). A Velis gliding from
3,000 ft at ~15:1 covers ~13 km for ~0.3 kWh where cruise would charge ~2.3 kWh.
Structurally this needs **no extra term**: a descent credit would enter as
`− E_desc × min(1, d/d_sat)` — the altitude you descend from is the altitude
you climbed to — which is algebraically identical to lowering `E_max`. Hence
the ruling: **`E_max` is the NET climb-minus-descent overhead.**

The refund is never full, which is why `E_max` stays well above zero: climb is
flown at Vy off the best-range speed at high power; real descents are
constrained (ATC steps, pattern work, speed limits, spoilers/flaps burn energy
as drag); and the final approach is flown *with* power in a draggy
configuration. Gross climb estimates of 8–11% of battery (§3) net out to
roughly 5–8% with realistic recovery — keeping the knob at 10% is a deliberate
conservative bias, appropriate for an infrastructure-sizing tool where
undersizing chargers is the expensive error (and the anchor guarantees the
conservatism never inflates full-range missions).

Two boundaries:
- **Approach/landing maneuvering is already modeled elsewhere** — the engine
  charges `sidStarPaddingKm` (default 10 km) per leg for terminal work. The
  climb knob must not include it (single-count doctrine, performance-engine.md).
- **eVTOL exception:** rotorcraft descent/hover-landing is NOT cheap (hover is
  a peak-power phase). eHang-style aircraft need a per-aircraft `E_max`
  override in the later refinement; the global net knob is a fixed-wing story.

**Rejected forms.**
- *"X% of battery in the first Y% of the flight"* (the original strawman):
  makes climb cost grow with trip length and battery size — a climb to 2,000 ft
  costs the same whether you then fly 30 km or 300 km, and doubling a battery
  doesn't double the energy to lift the same airframe.
- *Pure affine (fixed E_climb per leg)*: right for long sectors, wrong for
  short hops, which genuinely climb to lower altitudes.
- *Full phase curve (P_climb·t_climb + P_cruise·t_cruise + …)*: the honest
  Rung 3, but it needs per-aircraft climb rate, cruise altitude and power
  curves. Only the Velis has published figures; everything else would be
  invented. Rung 1 gets the shape right with two auditable knobs.

**Structural properties** (why this form is cheap to build later):
- `E(d)` is piecewise-linear and strictly increasing → `maxLegKm` inverts in
  closed form → the A* router keeps its single scalar edge cap (routing.js:132).
- Per-km usage is flat at `ePerKm_cruise + E_max/d_sat` below `d_sat`, then
  decays toward `ePerKm_cruise` — reproducing the observed "short flights are
  less efficient per km".
- At `pct = 0` the model reduces exactly to today's engine — a clean default-off
  toggle and golden-neutrality gate for the build.

## 3. Grounding — where 10% and the 15%-of-range inference come from

Three independent estimates of the full-climb overhead converge on ~8–11% of
battery (computed by the scratch script, §6). These are GROSS climb figures;
netted against descent give-back they land at ~5–8%, so the ruled 10% carries
a deliberate sizing-side margin (§2.1):

| method | aircraft class | overhead | % of battery | confidence |
|---|---|---|---|---|
| POH power delta: (46−25 kW) × 4.6 min climb to 3,000 ft at 647 fpm | Velis Electro (22 kWh) | 1.6 kWh | **7.4%** | manufacturer-stated |
| Potential energy m·g·h/η (600 kg, 3,000 ft, η=0.85) | Velis Electro | 1.8 kWh | **8.0%** | estimated |
| Potential energy (3,175 kg, 8,000 ft) | Beta Alia-class (225 kWh) | 24.8 kWh | **11.0%** | estimated |
| Potential energy (76 t, ~6 km cruise) | E9X-class (14 MWh) | 1,462 kWh | **10.4%** | estimated |

Sources:
- Velis Electro climb/cruise power and endurance: [FLYER flight test](https://flyer.co.uk/feature/pipistrel-velis-electro/)
  (climb 46 kW at 70–75 kt, standard cruise 25 kW, E-811 rated 65 kW/90 s and
  49.2 kW continuous), [Pipistrel product page](https://www.pipistrel-aircraft.com/products/velis-electro/),
  [AOPA guide](https://www.aopa.org/go-fly/aircraft-and-ownership/aircraft-guide/aircraft/pipistrel-velis-electro).
  The only EASA type-certified electric aircraft with public figures — our
  strongest data point.
- Phase-energy structure of regional electric aircraft: [ICCT white paper,
  "Performance analysis of regional electric aircraft" (2022)](https://theicct.org/wp-content/uploads/2022/07/global-aviation-performance-analysis-regional-electric-aircraft-jul22-1.pdf-1.pdf)
  — cruise consumes roughly half the battery on design missions; climb and
  reserves dominate the rest, and short missions carry a disproportionate
  climb share. [ERAU, Introduction to Aerospace Flight Vehicles — Electric
  Aircraft](https://eaglepubs.erau.edu/introductiontoaerospaceflightvehicles/chapter/electric-aircraft/)
  gives the same qualitative split.
- E9X class parameters: CE Delft (Jan 2025), "Climate Change Impact Analysis of
  Electric Aviation", citing de Vries et al. 2024 AIAA SciTech "Conceptual
  Design of a 90-Seater" — already the provenance of our Elysian 800 km
  IFR-effective range (cns-perf planes.json); [Elysian public specs](https://newatlas.com/aircraft/elysian-electric-airliner/)
  (800–1,000 km design missions, batteries-in-wing, turbine reserve system).

### 3.1 Why `d_sat` is inferred from range (ruled), not a fixed km or a column

Saturation distance is strongly aircraft-dependent — climb distance to optimal
altitude plus the descent back down:

| aircraft class | optimal altitude | true d_sat ≈ | fixed 60 km error | `0.15 × range` gives |
|---|---|---|---|---|
| Velis Electro (87.5 km) | ~3,000 ft | ~23 km | 2.6× too long | 13 km |
| Beta Alia-class (500 km) | ~8,000 ft | ~65 km | about right | 75 km |
| E9X-class (1,000 km) | ~FL200 | ~200 km | 3.3× too short | 150 km |

A fixed distance fits only the middle class: it under-charges Velis circuit
hops (which genuinely pay a near-full climb by 20 km) and over-charges E9X
mid-sectors (billed a full FL200 climb they never make). The inference
`d_sat = 15% × range_km` works physically, not just conveniently: bigger,
faster, longer-range aircraft cruise higher, and climb+descent track distance
scales with that altitude times speed-over-climb-rate — all of which grow with
aircraft scale, which catalog range proxies. Every class lands within ~1.5× of
its true value, with zero new data entry.

A per-aircraft Notion column was considered and deferred: no published source
exists to fill it, so today it would be invented row by row — the scaling law
invents more consistently. The standard refinement path stays open: inferred
default now, optional `climb_sat_km` override column later where a real figure
is learned (the eHang will need one anyway, §2.1).

## 4. Worked examples (ruled: pct = 10%, d_sat = 15% of range)

Scratch script output — anchor `E(range) = battery` holds exactly in each case.

**Velis Electro** (22 kWh, 87.5 km): linear 0.2514 kWh/km → cruise 0.2263 + 2.2 kWh climb cap, d_sat 13.1 km

| leg | linear | new | Δ |
|---|---|---|---|
| 20 km | 5.03 kWh | 6.73 kWh | **+33.8%** |
| 40 km | 10.06 kWh | 11.25 kWh | **+11.9%** |
| 87.5 km (full range) | 22.00 kWh | 22.00 kWh | 0% |

A 20 km circuit hop now pays a full (netted) climb — consistent with what
flight schools actually see, and with the POH endurance spread.

**Beta Alia** (225 kWh, 500 km): linear 0.4500 kWh/km → cruise 0.4050 + 22.5 kWh climb cap, d_sat 75 km

| leg | linear | new | Δ |
|---|---|---|---|
| 50 km | 22.5 kWh | 35.3 kWh | **+57%** |
| 150 km | 67.5 kWh | 83.3 kWh | **+23%** |
| 400 km | 180.0 kWh | 184.5 kWh | +2.5% |
| 500 km (full range) | 225.0 kWh | 225.0 kWh | 0% |

The long-range aircraft on short hops is where the linear model is most wrong —
exactly the regional-feeder missions CNS models most.

**Multi-stop cost becomes real** — Beta Alia, Lelystad → Frankfurt
(direct 343 km vs the 5-stop chain EHDL·EHVK·EDLN·ETNN·ETSB, 401 km flown):

| route | linear | new | climbs paid |
|---|---|---|---|
| direct | 154 kWh | 161 kWh | 1.00 |
| 5-stop chain | 181 kWh | **272 kWh** | 4.86 |

Under the linear model the chain costs +17% over direct; phase-aware it costs
+69% — each stop's climb finally lands on the energy books, which feeds
straight into charging demand and dwell times at the stop airports.

**Reach impact** (usable = 70% of battery, i.e. min-SoC 30): max leg shrinks
modestly — Velis 61.2 → 58.3 km (−4.8%), Beta 350.0 → 333.3 km (−4.8%).
Full-battery range is unchanged by the anchor; only reserve-limited legs
shorten, because the climb overhead can't be diluted below `d_sat`… honest
physics, small enough not to upend existing routes.

## 5. Edge cases & doctrine

- **Training flights**: apply the same formula to the block distance
  (`E = c·trainKm + E_max·min(1, trainKm/d_sat)`) — circuits climb
  continuously but low, so one ramped climb per block is a fair Rung-1
  treatment. Alternative (one full climb per block) over-charges pattern work.
  **To settle in review.**
- **Battery-less hybrids**: not applicable — the engine already short-circuits
  them to zero charge energy; `E_max = pct × battery` is naturally 0.
- **sim.py stays linear.** The backend is the intentionally-raw physics
  baseline (sim.py:245–250 doctrine); this model lives in the JS engine like
  reserves and padding do. The JS/Python divergence widens and is documented,
  never reconciled.
- **`avgUsageKwhPer100km` becomes trip-dependent** (it is tautologically
  `ePerKm×100` today). The spec-card tile should show the cruise figure with
  the climb cap alongside; the PDF's per-flight number becomes the honest
  trip-specific value.
- **`climb_overhead_pct = 0` must reproduce today's numbers bit-for-bit** —
  that is the build's golden-neutrality gate (same pattern as routing padding
  default-off, PR #10).

## 6. Reproducibility

All numbers in §3–§4 are produced by a ~70-line script (session scratchpad,
`climb_model.py`) that asserts the calibration anchor and reads leg distances
from `european_airports.csv`. Re-run with different knob values to test
sensitivity; the model is two lines of arithmetic.

## 7. Implementation appendix (for the later build — NOT this effort)

1. **Engine seam** — replace flight-model.js:141 with the two-term formula
   behind `CNSSettings.climbOverheadPct()` / `climbSatFrac()` (new knobs,
   settings-key bump; scheduler cache stamp `_settingsStamp` at
   scheduler.js:110 must include them or DES goes stale). `d_sat` computes
   per plane inside the engine as `climbSatFrac() × plane.range_km`.
2. **Duplicate formula sites** — `_legEst` (index.html ~:4380), spec-card
   usage tile (~:3858), calc-audit copy (~:4933–4963; user-facing formula text
   needs a rewrite, not a patch).
3. **Reach** — `availRangeKm` (flight-model.js:79, index.html:2833) and
   `maxLegKm` (routing.js:132) switch to the closed-form piecewise inverse;
   router structure unchanged.
4. **Blast radius** — 24 golden flight snapshots + the DES snapshot regen
   (with the pct=0 neutrality check first); `js_flight_padding.test.mjs` and
   `js_flight_model.test.mjs:85` assert linearity as a contract and must be
   re-authored, not re-blessed; `js_charging`, `js_demand`, conservation and
   routing tests survive untouched.
5. **PR #30 overlap** — same file as the perf-engine reach seam; whichever
   lands second rebases. The anchor keeps `planningRangeKm` semantics intact.
6. **Mobile** — adopts automatically wherever it uses the shared engine;
   its sim.py-fed displays stay raw-linear until the mobile lane picks up the
   seam (same situation as PR #30).
7. **Later refinement path** — optional per-aircraft OVERRIDES of the inferred
   defaults (`climb_overhead_kwh`, `climb_sat_km`) via Notion columns where a
   real figure is learned — the eHang's hover-landing economics first (§2.1) —
   or as `measurements[]` entries under PR #30's schema (the `altitude_ft`
   condition key already exists for exactly this).
