# PDF report redesign — "Airport as an Energy Hub" advisory

**Date:** 2026-06-09
**Owner role:** desktop / backend
**Status:** approved design, pre-implementation

## Problem

The PDF report (`report.py` → `templates/report.html` + `static/report.css`, payload
assembled by `static/report.js`, triggered from `templates/index.html`) is a
capable but unpolished *tool dump*. The reviewer marked up a generated copy
(`Eindhoven Airport as an Energy Hub`) with ten inline comments and gave four
design principles (strict grid, weaponised whitespace, typographic hierarchy,
muted-base + accent colour). The deliverable should read as a **professional
consulting advisory for aviation professionals**, in NRG2fly's house style.

A single-airport `focusAirport` mode already exists but is implicitly driven by
the Demand Calculator's `#airportFilter` dropdown — so the report silently
inherits whatever filter is set, and degenerates badly (single-bar "charts",
a meaningless "1 airport" stat) when one airport is in scope.

## Goals

1. **Airport-first by construction.** Generating a report *requires* explicitly
   picking exactly one airport. The report is that airport's advisory.
2. **Address every inline comment** (mapped in the table below).
3. **Unify the whole document on the NRG2fly house style** (the appended
   onepager is the brand reference) — navy / royal-blue / accent-orange /
   energy-green, Inter, strict grid, generous whitespace, stark hierarchy.
4. **Bonus:** auto-embed a photo of the chosen airport on the cover.

Non-goals: changing the energy/rotation model (`sim.py` / the JS engine);
multi-airport "whole network" reports (explicitly dropped this round); any
mobile-specific files (`static/mobile.*`, `templates/index_mobile.html`).

## Decisions (locked with the user)

- **Picker UX:** modal on `Generate report`; single airport; **required**; no
  whole-network option.
- **Airport photo:** curated local `pics/airports/<ICAO>.jpg` first → Wikimedia
  fallback → graceful (no photo ⇒ today's clean cover).
- **Scope:** full redesign + all comments + house-style reskin.
- **Rotation Gantt (comment "screenshot instead of SVG?"):** keep it **vector**,
  fix the clipping/truncation bug. Rationale: crisp at print DPI, lightweight,
  already cross-consistent with the on-screen scheduler via `rotationsAt()`, no
  new JS dependency; the "heavy on compute" concern is a non-issue server-side.
- **Revenue confidence + energy cost:** transparent, clearly-explained
  assumptions (see "Assumptions & scenario panel").

## Comment → resolution map

| # | Inline comment | Resolution | Page |
|---|---|---|---|
| 1 | "this field not needed when 1 airport is selected" (the `1 AIRPORT` stat) | Drop it; replace with **MWh / year** KPI | Cover |
| 2 | "also add yearly usage" | MWh/year KPI on the cover **and** annual energy + annual revenue spelled out in the summary's Assumptions & scenario panel | Cover / Summary |
| 3 | "summary ugly with only 1 airport… graph that spans the opening time… x-axis time, y-axis power draw" | **Time-of-day load curve** (07→23, MW) replacing the peak bar | Summary |
| 4 | "circle diagram, with kwh per type of aircraft" | **Energy-mix donut**, daily kWh by aircraft type, replacing the energy bar | Summary |
| 5 | "stops are not visible on map. make the route color more distinct" | Accent-orange, thicker route lines; larger outlined stop markers | Map |
| 6 | "replace symbols with pictures of the aircraft" | Use the catalog `image` field (real photos) instead of `svg` glyphs | Aircraft |
| 7 | "redundant, already on the sheet below… place it here. this will be eindhoven airport slide" (chargers) | Remove the standalone Chargers table from the Aircraft page; **place and keep it only** on the {Airport} detail page | Aircraft → Airport |
| 8 | "there should be an overview of all the model settings used. also a confidence interval / range of expected revenue. maybe also add energy costs" | **Assumptions & scenario** panel | Summary |
| 9 | "add charging legs here" (multi-leg contributing flight) | Per-leg charging breakdown in Contributing flights | Airport |
| 10 | "cant you screenshot the rotation scheduler instead of recomputing to svg? its very messy…" | Fix the vector Gantt (width/clip/label/legibility) — see Gantt fix | Airport |

## Architecture (unchanged data flow)

The browser still owns all domain computation; `report.js` assembles a
self-contained JSON payload and POSTs to `/api/report.pdf`; `report.py`
decorates it with server-rendered SVGs + the map PNG + embedded images, renders
`report.html` via Jinja, and WeasyPrint emits the PDF. Only these files change:

- `static/report.js` — picker integration, focus airport from the modal, new
  payload fields (load-curve series, energy-by-type, per-leg charge legs,
  settings/assumptions, plane `image`).
- `templates/index.html` — the airport-picker modal markup + the wiring that
  opens it before `CNSReport.generate()`.
- `report.py` — new SVG renderers (load curve, donut), map contrast, photo
  lookup (local + Wikimedia), assumptions/confidence math + copy, plane `image`
  embed, Gantt fix.
- `templates/report.html` — restructured sections.
- `static/report.css` — house-style reskin.

All five are **desktop/backend-role** files — in lane. No mobile files touched.

### New units (each independently testable)

- `report.py :: _load_curve_svg(series, …)` — step/area line chart from a
  `[{t, kw}]` series. Input: list of step points; output: SVG string.
- `report.py :: _donut_svg(slices, …)` — donut from `[(label, value, color)]`.
- `report.py :: _airport_photo_data_uri(ident, name, lat, lon)` — returns a
  `data:` URI or `''`. Tries `pics/airports/<ICAO>.{jpg,png,webp}`; else
  Wikimedia (Wikipedia REST `pageimages` by airport name, then Commons
  geosearch by lat/lon) with a short timeout; caches downloads under
  `pics/airports/_cache/` (gitignored); any failure ⇒ `''`.
- `report.js :: _loadCurveAt(ident)` — builds the absolute-minute power step
  series from `CNSScheduler.rotationsAt(ident)` phases where
  `kind === 'charge' && atX && power > 0` (same delta-sweep `summary()` uses for
  the peak, so the curve's max equals the reported peak by construction).
- `report.js :: _energyByType(contribs)` — aggregates `energyPerFlight ×
  flightsPerDay` by `planeName`.

### New payload fields (all assembled in `report.js :: buildPayload()`)

These do not exist today and must be added; the underlying data is confirmed
available (see "Data sources" cited inline):

- `focusIdent` / `focusAirport` — from the **modal** (no longer `#airportFilter`).
- `loadCurvePoints: [{ t: <minute from 00:00>, kw: <number> }]` — step series
  from `_loadCurveAt(focusIdent)` (built from `rotationsAt()` phases where
  `kind==='charge' && atX && power>0`; its max equals `summary().peakKw`).
- `energyByType: [{ planeName, dailyKwh }]` — from `_energyByType()`; colours
  assigned server-side from a fixed palette.
- per-contrib `legs: [{ toName, energyKwh, chargerName, chargeMin }]` — added in
  `_buildAirport()` for `multiLeg` trips (unpacked from the engine profile /
  `CNSScheduler.tripPhases`), rendered as a nested breakdown under the contrib.
- per-plane `image` — `_usedPlanes()` also reads the catalog `image` field;
  `report.py` embeds `pics/<image>` as `image_data_uri`.
- `modelSettings: { chargeTarget, chargeRate, routingPadding:{enabled,factor},
  sidStarPaddingKm, alternateReserve:<bool>, gridDemandFactor }` — from
  `CNSSettings` accessors, for the Assumptions panel.
- `airport_photo_data_uri` — produced server-side in `report.py` (not the
  client payload) from `_airport_photo_data_uri(ident,name,lat,lon)`.

## Page-by-page layout

Grid: single content column at ~62–66 ch for prose; charts/tables full content
width; KPI cards in a 3-up flex row; outer page margins ≈ 22–26 mm; a forced
gap (`margin-top`) before every `<h2>`/`<h3>` section.

**1 — Cover.** Logo top-left. Airport **photo band** (full-bleed-ish, fixed
height, `object-fit: cover`, subtle dark gradient overlay for text legibility);
if no photo, fall back to the current clean cover (no broken frame). Overline
`Charging Infrastructure Advisory`; H1 `{Airport}` / `as an Energy Hub`; sub.
KPI cards: **MWh / day**, **Peak MW**, **MWh / year**. Meta line: generated
date · N flight schedules · N aircraft types.

**2 — About NRG2fly.** Same copy, reskinned (navy headers, accent rule).

**3 — Executive summary.**
- Lede + revenue sentence (kept).
- **Daily load profile** — `_load_curve_svg`: x-axis = hours `07 → last
  activity` (one tick/hour, `HH` labels); y-axis = power, auto-unit kW/MW.
  Y-axis range `0 → ceil(max(peak, installed) to a "nice" step)`, with a faint
  horizontal gridline + label every step (target ~4–5 gridlines). Filled area
  under a **royal-blue (`--blue`)** step line; a **dashed `--orange`** line at
  the peak labelled `Peak X MW @ HH:MM`; installed capacity drawn as a **faint
  grey dashed horizontal line** labelled `Installed X MW` so under/over-build is
  read at a glance.
- **Energy by aircraft type** — `_donut_svg`: **daily** kWh per aircraft type
  (not annualised). One slice per type sized by kWh/day; centre label = total
  **MWh/day**; legend lists each type with its **daily kWh** and **% of daily
  total**. Single type ⇒ full ring labelled 100 %.
- **Assumptions & scenario panel** (see below) — this is also where the
  **annual** energy + revenue figures live (comment 2).

**4 — Network overview.** Map with `#F0892B` route lines at width 4–5 and
larger outlined stop/terminal markers; legend updated to match.

**5 — Aircraft in this plan.** Table with a real **photo** per aircraft
(`image` field), name, battery, range, speed, seats, payload. **No** chargers
table here.

**6 — {Airport} detail.** Header (name, ICAO, type, coords) + KPI cards
(MWh/day, peak, revenue/day). **Installed charging** table (the only charger
table). **Contributing flights** with a per-leg charge breakdown row for
multi-leg trips (origin → stop charges → terminal, each with charger + kWh +
minutes). **Rotation timeline** (fixed vector Gantt) + the verdict callout.

**7 — Methodology & assumptions.** Kept, reskinned.

**8 — NRG2fly onepager.** Appended unchanged.

## Assumptions & scenario panel (comment 8)

A bordered panel on the Executive summary, two parts:

**Model settings used** (read from `CNSSettings`): charge target (e.g. 80 %),
charging tariff (€/kWh), routing padding (on/off + factor), SID/STAR padding km,
alternate-reserve (on/off), grid-demand factor, operating window 07:00–23:00.

**Revenue & cost scenario** — with an explicit explanatory paragraph (per the
user's "give a clear explanation in that section"):

> *These figures are indicative. **Gross charging revenue** assumes every kWh
> delivered is billed at the €X.XX/kWh tariff. In practice not all available
> energy is sold at the headline price (off-peak sessions, contracted rates,
> idle capacity), so we show a **realisation band of 70–100 %** as a planning
> range. **Energy cost** assumes wholesale procurement at €0.15/kWh; the
> difference is the **gross margin** before grid fees, demand charges, and
> operating costs — which a full business case would add.*

Computed (annual = daily × 365):
- Gross revenue: `tariff × kWh/yr`
- Revenue band: `tariff × kWh/yr × {0.70, 1.00}`
- Energy cost: `0.15 × kWh/yr`
- Gross margin: `(tariff − 0.15) × kWh/yr` (+ its 0.70–1.00 band)

Constants `REALISATION_LOW = 0.70`, `REALISATION_HIGH = 1.00`,
`PROCUREMENT_EUR_PER_KWH = 0.15` live at the top of `report.py`, clearly named
and commented so they're trivially tunable.

**Panel layout.** A full-content-width bordered box, `--bg-soft` background,
~8 mm padding, hairline (`--line`) border. Two stacked sub-blocks separated by a
horizontal rule: (1) **Model settings used** as a tight 2-column definition list
(`setting name | value`); (2) **Revenue & cost scenario** — the explanatory
paragraph above, then the annual figures as a small `metric | value/range`
table. Numbers in `--ink`, labels in `--muted`.

## Rotation Gantt fix (comment 10, decision A)

Root cause: `_GANTT_W = 720` with a `_GANTT_LBL_W = 150` label gutter, but the
template scales the SVG to 100 % of a content width that, after page margins, is
narrower — and long route labels (`Lelystad Airport → Frankfurt Main Airport`)
overflow the 150 px gutter and collide with the bars; the right edge clips
because the axis runs to `last_hour` without right padding.

Fixes: widen the label gutter and **truncate route labels** to a fixed
character budget (~24 chars, ellipsis — e.g. `Lelystad Airport → Frankfurt…`),
keeping the full name in an SVG `<title>`; add right padding so the final hour
tick + any spill-past-23:00 bar isn't clipped; raise the axis/label font to a
legible size (≥10 px axis, ≥9 px sub-label); ensure the `viewBox` width matches
the drawn width so `preserveAspectRatio` doesn't distort; keep the phase
semantics but align the colours to the house palette.

## Airport photo lookup (bonus)

1. **Curated:** `pics/airports/<ICAO>.{jpg,png,webp}` (tracked). We ship a small
   set for NRG2fly's key airports (EHLE Lelystad, EHTE Teuge, EHEH Eindhoven,
   EHDL Deelen, …) as available.
2. **Wikimedia fallback** (best-effort, short timeout): Wikipedia REST
   `…/page/summary/<Airport name>` → `originalimage/thumbnail`; if absent,
   Commons geosearch by lat/lon. Download → embed as data URI → cache under
   `pics/airports/_cache/` (gitignored).
3. **Graceful:** any miss/timeout/error ⇒ `''`. When empty, the cover's photo
   band is **hidden entirely** (`display:none` — no blank frame), and the cover
   renders in today's clean no-photo layout. The fallback is easily disabled via
   a module constant (`AIRPORT_PHOTO_WIKIMEDIA = True`).

**Photo credit.** When a Wikimedia image is used, an ~8 px `--muted` caption sits
in the photo band's bottom-left: `Photo: <file/title> — Wikimedia Commons`. The
payload carries the source title + (if available) licence string so the credit
is Commons-compliant; curated local photos carry no credit.

Licensing caveat: curated local images are the safe primary for a commercial
deliverable; the Wikimedia fallback is best-effort with attribution and a kill
switch.

## House-style tokens (`report.css`)

```
--navy:   #152455;   /* hero/headers on dark */
--blue:   #2563eb;   /* primary data */
--orange: #F0892B;   /* ACCENT ONLY: rules, highlights, peak line, map routes */
--green:  #10b981;   /* energy throughput */
--ink:    #0f1729;   /* headings */
--body:   #334155;   /* body text (dark grey, not pure black) */
--muted:  #94a3b8;   /* captions */
--line:   #e2e8f0;   /* hairlines */
--bg-soft:#f1f5f9;   /* table headers / panels */
```
**Migration from current `report.css`.** Today it uses `--primary` (blue),
`--ink`, `--ink-soft`, `--warn` (`#f59e0b`) and an H2 `border-bottom` in
`--primary`. We **add** `--navy` and `--orange` (`#F0892B`, distinct from the
old `--warn`), repoint accents (incl. the H2 rule) to `--orange`, and keep
`--blue` as the primary data colour. "Royal-blue" everywhere in this spec means
`--blue #2563eb` (navy `#152455` is darker, for dark headers/hero only).

**Type.** Font stack `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI",
sans-serif`. H1 ≈ 34 px/700 `--ink`; H2 ≈ 19 px/700 `--ink` with a 2 px
`--orange` bottom rule; H3 ≈ 13 px/700 tracked caps `--ink`; body ≈ 10.5 px
`--body`; caption ≈ 8.5 px `--muted`. Orange is reserved strictly for accents.

**Whitespace & rhythm.** Base unit **4 mm**; all spacing is a multiple of it.
`@page` margin **22 mm** all edges (replacing the current asymmetric
`16/14/18/14`). Space before each `<h2>` ≈ 12 mm (3×), before `<h3>` ≈ 8 mm
(2×); paragraph gap ≈ 4 mm; list-item gap ≈ 2 mm; panel/box padding ≈ 8 mm
(2×); KPI-card gap ≈ 4 mm. A forced gap precedes every section so a new thought
visibly starts.

## Testing / verification

- Python: `report.py`'s pure helpers (`_fmt_*`, new `_load_curve_svg`,
  `_donut_svg`, the assumptions math) are unit-testable in `tests/`. Add focused
  tests for the curve series → SVG and the revenue/margin math.
- End-to-end: run local Flask, POST a representative payload (or drive the UI),
  fetch the PDF, and **Read the rendered pages** to confirm each comment is
  addressed and the layout holds (the sandbox can't render the live app, so PDF
  read-back is the verification loop — see memory `reference_preview_flask_loopback`).
- Adversarial check: every row of the comment-map table is visibly satisfied in
  the regenerated PDF; design principles (grid/whitespace/hierarchy/colour)
  hold; no regression in the existing multi-page structure.

## Risks

- Wikimedia network call at request time — mitigated by short timeout, cache,
  and graceful fallback.
- WeasyPrint SVG quirks (it rasterises some SVG features) — keep the new charts
  to basic shapes/paths/text already proven by the existing bar/Gantt SVGs.
- Donut with a single aircraft type degenerates to a full ring — still
  meaningful (shows 100 % one type); guard the label math against div-by-zero.
