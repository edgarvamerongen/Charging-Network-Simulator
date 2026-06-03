# CNS "improvements" branch — design spec

**Date:** 2026-06-03
**Branch:** `improvements` (off `main`, desktop/backend lane)
**Status:** approved (design), pending spec review → implementation plan

A batch of UX/content/model improvements for the NRG2fly Charging Network
Simulator, prepared for the client demo. Twelve work items (tasks #5–#16) plus
one cross-cutting default change.

---

## 0. Cross-cutting: the realistic model becomes the default

Today every model factor in `CNSSettings.DEFAULTS` is OFF, so the app runs the
naive physical model unless the user opts in. We flip the realistic model to be
the default.

**New defaults (`static/settings.js`):**

| factor | default | value |
|--------|---------|-------|
| `landingReserve` | **on** | `minLandingSoc: 0.30` |
| `routingPadding` | **on** | `factor: 1.05` |
| `chargeTarget` (new) | **on** | `value: 0.80` |
| `chargeTaper` | **on** | `threshold: 0.70, taperPower: 0.15, cRate: 2.0` |
| `chargerEfficiency` | off | `value: 0.88` |

**Rollout gotcha — bump the storage key.** `loadAll()` merges *saved* settings
over `DEFAULTS` (`Object.assign(out[k], stored[k])`), so any browser holding an
existing `cns_settings_v1` blob (all-off) would keep the old behaviour and never
see the new defaults. To roll the new defaults out we **rename the key
`cns_settings_v1` → `cns_settings_v2`**. Old saved toggles are discarded — this
is intended for the demo (fresh, realistic defaults for everyone).

**Consequence that drives the tour:** Beta Alia (battery 225 kWh, range 400 km)
at 30% reserve has ~280 km usable range. Lelystad→Frankfurt great-circle ~365 km
× 1.05 padding ≈ 383 km > 280 km, so the planner must insert **one charging
stop**. Charge-target and taper affect charge *time/energy*, not routing reach,
so they don't change the stop count — they make the numbers realistic.

---

## 1. Tour (`static/tour.js`)

### 1a. Welcome text
Replace the welcome popover body (~line 204) with the client copy verbatim:

> Welcome to the NRG2fly Charging Network Simulator. At NRG2fly we are rolling
> out a European charging network that makes point-to-point electric aviation
> possible. This tool helps airports and operators answer the strategic
> questions we keep coming back to: what kind of charging infrastructure and how
> much power do we need? With this Charging Network Simulator you can easily
> simulate traffic between airports with a variety of electric aircraft, and so
> explore what different situations will look like as electric aviation takes off
> between airports. The result is a defensible, client-ready sizing brief,
> exported as a PDF, rather than a back-of-envelope guess. We advise everyone to
> start with the demo tour first and then move on to running simulations
> yourself. Do you have questions? Reach out to **Merlijn van Vliet (CEO)** and
> **Jacco Bink (COO)**.

The two names render with a **dotted underline** (hover hint).

### 1b. Crew hover cards
On hover over either name, show a **fixed card panel pinned to the top** of the
screen (screenshot style): circular photo, name, role, short bio, and LinkedIn +
email links. Data + photos come from the `crew/` folder.

- Photos are committed to **`pics/crew/`** as `jacco.jpeg` and `merlijn.jpeg`
  (copied from `crew/Jacco Blink/pf_pic_jacco.jpeg` and
  `crew/Merlijn van Vliet/pf_pic_merlijn.jpeg`). Served by the existing
  `/pics/<path>` route — no new Flask route, and it sidesteps the "Jacco Blink"
  typo folder.
- Card content (from `crew/*/*.txt`):
  - **Jacco Bink — COO.** "With a background at KLM and Alliander, Jacco brings
    deep expertise in aviation and energy systems. As Consulting Director at
    NRG2fly, he leads the rollout of charging infrastructure at airports across
    the Netherlands and Europe." · LinkedIn · jacco@nrg2fly.com
  - **Merlijn van Vliet — CEO.** "Co-owner of Europe's first electric flight
    academy and board member of the Electric Flying Connection, Merlijn combines
    a background in brand strategy with a passion for electric aviation. He leads
    NRG2fly's European partnerships and ecosystem building." · LinkedIn ·
    merlijn@nrg2fly.com
- Implementation: a small absolutely-positioned card element injected into the
  tour popover DOM; CSS for the dotted-underline trigger + the top card. Pure
  hover (mouseenter/mouseleave), no dependency on Driver.js internals.

### 1c. Demo seed → Beta Alia, Lelystad → Frankfurt
`_seedDemoForm()` changes from AMS↔CDG / Pipistrel to:
- origin `EHLE` (Lelystad), destination `EDDF` (Frankfurt), trip type **retour**,
  plane **`beta_plane`** (Beta Alia CX300), a charger from the new catalog.
- "Plan with charging stops" stays OFF at seed; enabled at the suggested-route
  step (unchanged pattern) so the user sees the warning → stop progression.
- Comments referencing the Pipistrel's 100 km range are updated to the Beta /
  reserve-driven reasoning.

### 1d. Step reorder — Model settings to position 7
- Move the **Model settings** step to **immediately after "Plan with charging
  stops"** (was buried in the demand-calc section, ~line 367). New copy states
  that landing reserve, routing padding, the charging-curve taper, and the 80%
  charge target are applied to every calculation — so when the route is computed
  the user understands *why* a stop appears.
- Remove the old Model-settings step from the demand-calc sequence.
- Downstream "Suggested route" copy updated: the stop exists because reserve +
  padding push the leg past Beta's usable range (not the Pipistrel's short hop).

---

## 2. Planner form (`templates/index.html`)

### 2a. Move Aircraft below Trip type
Move the Aircraft `<div class="field">` (currently after Frequency/fleet-mode,
~line 1045) to directly **below the Trip type field** (~line 988), above "Plan
with charging stops". Charger stays where it is. JS hooks are by `id`, so the
move is markup-only.

### 2b. Aircraft spec card + per-flight override
Directly below the Aircraft dropdown, render a **spec card** for the selected
plane:
- **thumbnail** (plane image, `object-fit: cover`), **name**, **range (km)**,
  **battery (kWh)**. Visually styled (not a bare table row).
- An **"Override for this flight ▾"** expander containing the same numeric
  fields as the custom-plane modal — battery, range, cruise speed, c-rate —
  **prefilled from the catalog**. Editing any field overrides that spec **for
  this flight only**:
  - The override values are read at Simulate and baked into the previewed/saved
    flight object (each folder entry already stores `battery`, `c_rate`, etc.),
    so the DES + demand calc use them. `planes.json` is never written.
  - A **"reset to catalog"** link restores the prefilled values and clears the
    override.
  - Changing the dropdown selection re-prefills from the new plane and clears any
    active override.
- The spec card re-renders on plane change and on unit-toggle (km/nm) like other
  distance displays.
- Module boundary: a small `selectedPlaneSpec()` helper returns the effective
  spec (catalog merged with any active override); the planner's existing
  `_selectedPlane()` is updated to consult it so all downstream code (trajectory,
  routing reach, preview) sees the override through one accessor.

### 2c. Default prefill on load
On initial load with an empty planner, prefill **Lelystad (EHLE) → Frankfurt
(EDDF)**, plane **Beta Alia**, and **"Plan with charging stops" ON** (so the
route resolves with its stop immediately). The **↺ reset** button still clears to
a blank form (it does not restore this default). Tour `_resetWorld()` /
`_seedDemoForm()` are unaffected (they set their own state).

### 2d. Demand calculator close (×) button
Add a **× button** to the top-right of the demand drawer header
(`.drawer-head`), styled like the result panel's `#resultMin`. Clicking it
collapses the drawer (same effect as toggling `#drawerToggle`).

---

## 3. Catalogs

### 3a. `chargers.json` — replace with DC charger list
Replace the entire catalog with nine DC chargers (named "<n> kW DC charger" /
"<n> MW DC charger"):

| id | name | power_kw |
|----|------|----------|
| `dc_22` | 22 kW DC charger | 22 |
| `dc_40` | 40 kW DC charger | 40 |
| `dc_60` | 60 kW DC charger | 60 |
| `dc_100` | 100 kW DC charger | 100 |
| `dc_250` | 250 kW DC charger | 250 |
| `dc_400` | 400 kW DC charger | 400 |
| `dc_1000` | 1 MW DC charger | 1000 |
| `dc_2400` | 2.4 MW DC charger | 2400 |
| `dc_3750` | 3.75 MW DC charger | 3750 |

"Custom charger" remains the existing `__custom_charger__` ➕ option (not a
catalog row). **Re-point** the tour/seed charger ids that referenced the old
catalog (`dc_mobile`, `aircraft_charger`) to ids in this list (e.g. `dc_40`,
`dc_250`).

### 3b. `planes.json` — ranges, rename, Elysian
- **Velis Electro**: keep the in-progress uncommitted tweak (range 50 km,
  training_range 100 km, c_rate 0.9).
- **Beta Alia CX300**: `range_km` 500 → **400**.
- **Vaeridion**: rename `name` to **"Vaeridion Microliner"**, `range_km` 500 →
  **400**.
- **Add Elysian E9X** (sensible public-figure specs; user can correct):
  ```json
  {
    "id": "elysian_e9x",
    "name": "Elysian E9X",
    "seats": 90,
    "load_kg": 9000,
    "battery_kwh": 14000,
    "range_km": 800,
    "speed_kmh": 720,
    "c_rate": 1.0,
    "image": "elysian.png",
    "svg": "vaeridion.svg",
    "simultaneous_charging": { "enabled": true, "max": 2 }
  }
  ```
  `c_rate 1.0` → 14 MW acceptance cap, so even a single 3.75 MW charger tops it
  slowly — which motivates the multi-charger feature. `simultaneous_charging` is
  a **stub** (read by nothing yet); the multi-charger implementation comes later.
  `svg` reuses `vaeridion.svg` as a placeholder map glyph until a dedicated one
  exists.

---

## 4. Global charge target (`settings.js`, `demand.js`, `scheduler.js`, report)

New model factor that sets the **default SoC every aircraft charges to**, with
per-airport override.

- **`settings.js`**: add `chargeTarget: { enabled: true, value: 0.80 }` to
  DEFAULTS; add an accessor `chargeTargetDefault()` returning `value` when
  enabled, else `null` (= deficit/old behaviour). Add to `activeFlags()`.
- **Semantics (LOCAL > GLOBAL):**
  - When the factor is **off** → pure deficit charging everywhere (today's
    behaviour).
  - When **on** → every terminus charges to `value` (default 0.80) unless a
    per-airport target overrides it.
  - Per-airport target in the demand calc: **"Auto" now means "inherit global
    default"**; an explicit % (including 100% = recharge-to-full) overrides.
- **Wiring:** the resolver used by `targetAt(id)` becomes
  `perAirportTarget(id) ?? chargeTargetDefault()`:
  - `demand.js` `deliveredEnergy` / `recomputeMultiLegCharges` consume it.
  - `scheduler.js` `_desContext.targetAt` already reads per-airport `targetSoc`;
    extend it to fall back to the global default.
  - **Planner preview** (`scheduler.js` `tripBreakdown`) currently passes
    `targetAt: () => null`; change to pass the global default so the result
    panel's arrival-SoC / charge-time match the DES.
- **Model settings modal (`index.html`)**: add a 5th `.rs-row` — toggle +
  "Default charge target <value>%" slider (e.g. 50–100%), wired in the settings
  modal JS alongside the existing four.
- **Report (`report.html` / `report.py`)**: the methodology already documents
  deficit + recharge-to-full; add a sentence noting the global default target
  when active. No structural change.

---

## 5. Images (`pics/`)

The new photos are **already dropped** in `pics/` (messy names):
`Plane_1_pipistrel.jpg`, `Vaeridion.jpeg`, `Elysian .jpg`.

- **Normalize** to repo-consistent names and reference them from `planes.json`:
  - `Plane_1_pipistrel.jpg` → `pipistrel.png` (replace the old render) — or keep
    as `.jpg` and update the `image` field; final extension decided at
    implementation, but the filename will be clean (no spaces).
  - `Vaeridion.jpeg` → `vaeridion.png`/`.jpeg` (clean).
  - `Elysian .jpg` → `elysian.png`/`.jpg` (clean, no trailing space).
  - Beta keeps `beta.png`.
- **White-border fix**: the demand-calc plane thumbnail currently letterboxes the
  image; switch its CSS to `object-fit: cover` (+ fixed aspect frame) so the
  photo fills the window. Apply the same to the new spec-card thumbnail (2b).

---

## 6. Git / housekeeping

- All work on **`improvements`** (already cut). Every touched file is in the
  desktop/backend lane (`tour.js`, `index.html`, `settings.js`, `demand.js`,
  `scheduler.js`, `planes.json`, `chargers.json`, `report.*`, `app.py` if a route
  is ever needed, `pics/`). No mobile files.
- **Commit `pics/crew/`** photos (needed to serve in prod). Normalized plane
  images committed too.
- **Leave `airports/plan.txt` untouched** — it's a separate initiative
  (real-world airport charger data), not part of this batch.
- Per standing instruction: **no commits without explicit user approval**; the
  user tests each change themselves.

---

## Open assumptions (user can veto)

1. Vaeridion renamed to "Vaeridion Microliner".
2. Elysian c_rate ~1.0, 90 seats, 720 km/h, 9 t payload, `simultaneous_charging
   max 2`, placeholder `vaeridion.svg` glyph.
3. ↺ reset clears to a blank form (not back to the Lelystad→Frankfurt default).
4. Enabling `chargeTaper` by default applies the C-rate cap + taper everywhere;
   combined with bumping the settings key to v2, all users get the realistic
   model on next load.
5. Crew card is pinned at the top of the viewport on hover (vs. a tooltip beside
   the name).
