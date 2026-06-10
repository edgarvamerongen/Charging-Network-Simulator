# Spreadsheet export — standardised, responsive XLSX of the Demand Calculator

**Date:** 2026-06-09
**Owner role:** desktop / backend
**Status:** approved design, pre-implementation

## Problem & goals

Airport users want the plan's data in a spreadsheet they can read, sort, and
tweak — not only as a fixed PDF. Build an **XLSX export covering the whole
Demand Calculator** (every flight, aircraft, charger, setting and per-airport
result), mirroring the PDF's figures (load curve, energy mix, per-airport
stats), with:

1. **Responsive** figures — native Excel formulas (recompute on edit) and native
   charts bound to cell ranges, where tractable.
2. A **standardised, versioned format** that exports now and is **future-proof
   for a later import** (import is NOT built now).
3. A **separate builder class** that only **reads** existing code — `report.py`,
   `report.js`, `sim.py` and the JS engine are left untouched.

Non-goals: the import feature; changing the energy/rotation model; any mobile files.

## Decisions (locked with the user)

- **Structure:** Overview + input tabs (Flights / Aircraft / Chargers / Settings)
  + one detail tab per airport.
- **Responsiveness:** formulas where tractable + native charts; the load curve,
  rotation timing and peak kW are scheduler-derived → exported as **values +
  chart** (cannot be cell formulas).
- **Trigger:** a separate **"Export spreadsheet"** button (whole DC, no airport
  picker).

## The format: inputs (round-trippable) vs outputs (computed)

The workbook is split so a future importer has a clean, stable surface:

- **Input tabs** are the canonical schema — fixed headers, Excel **Tables** and
  **named ranges**, versioned. A future importer reads ONLY these to rebuild a
  plan.
- **Output tabs** are computed (formulas + charts). The `About` sheet states
  they are regenerated and not read on import.

`About!Version = "CNS Workbook v1"` is the schema anchor an importer validates.

## Architecture (read-only, separate units)

- **`spreadsheet.py` :: `SpreadsheetBuilder(payload).build() -> bytes`** — new
  module, openpyxl. Reads the same payload shape `report.py` consumes (plus a
  richer `flightsFull`, below). One method per sheet; small, independently
  testable helpers (`_table`, `_named`, `_line_chart`, `_bar_chart`,
  `_donut_chart`).
- **`app.py`** — new `POST /api/report.xlsx`: 400 on empty payload, else
  `SpreadsheetBuilder(payload).build()` → `send` with the
  `…spreadsheetml.sheet` mimetype, filename `nrg2fly-charging-plan-<date>.xlsx`.
- **`static/spreadsheet.js` :: `CNSSpreadsheet.export(btn)`** — assembles the
  spreadsheet payload **by reading existing modules only**:
  `base = CNSReport.buildPayload(null)` (whole DC: all airports, each with
  `loadCurvePoints`; planes; chargers; modelSettings; totals) **plus**
  `flightsFull = CNSDemand.loadFolder().map(...)` (the full canonical flight
  records — origin/dest ICAO+coords, stops, planeId, chargerId/power, freq, trip
  type). POSTs to `/api/report.xlsx`, downloads the blob. (The existing
  `payload.flights` is too thin for the input schema; `loadFolder()` is the
  read source. No existing function is modified.)
- **`templates/index.html`** — an "Export spreadsheet" button beside
  `#generateReport`, wired to `CNSSpreadsheet.export`.
- **`requirements.txt`** — add `openpyxl`; install into the venv.

All touched files are desktop/backend-lane. No mobile files.

## Responsiveness — what is a formula vs a value

The engine's **per-flight charge energy** is SoC-aware (charge target, deficit,
reserve, cross-airport) and the **peak / load curve / rotation timing** come
from the scheduler's queue logic — none are expressible as cell formulas. They
are the **measured inputs** (values). Everything arithmetic on top is **live**:

| Quantity | Form | Recomputes when you edit |
|---|---|---|
| Per-flight charge energy (kWh) | value | — (re-run the simulator) |
| Peak kW, load-curve series, rotation timing | value (+ chart) | chart redraws if series edited |
| Flights/day | formula `=N / IF(unit="week",7,1)` | frequency |
| Daily energy (kWh) | formula `=energy × flights/day` | frequency |
| Revenue/day (€) | formula `=daily × Settings_tariff` | tariff, frequency |
| Installed power (kW) | formula `=Σ count × power` | charger count/power |
| Airport daily total | formula `=Σ` its flights' daily | any of the above |
| Energy by aircraft type | formula `=SUMIF(aircraft, type, daily)` | the above |
| % of mix | formula `=type ÷ airport total` | the above |
| Network totals, annual (×365), revenue band | formulas | tariff, realisation, freq |

Cross-sheet formulas resolve aircraft/charger/tariff via **named ranges +
`INDEX/MATCH`** (stable under row edits), not hard cell coords. An in-sheet note
states aircraft-spec edits don't recompute engine energy.

## Sheets & schema

**About** — `Format`, `Version` ("CNS Workbook v1"), `Generated`, sheet index,
"inputs are round-trippable; computed sheets are regenerated on import", and the
engine-derived-values caveat.

**Flights** (`tblFlights`) — `Flight ID, Aircraft ID, Aircraft, Origin ICAO,
Origin, Origin Lat, Origin Lon, Dest ICAO, Dest, Dest Lat, Dest Lon, Stops
(ICAO;…), Trip type, Multi-leg, Charger ID, Charger, Freq N, Freq unit`.

**Aircraft** (`tblAircraft`) — `Aircraft ID, Name, Battery (kWh), Range (km),
Speed (km/h), Seats, Payload (kg)`. Named: `Aircraft_id, Aircraft_battery,
Aircraft_range`.

**Chargers** (`tblChargers`) — `Charger ID, Name, Power (kW)`. Named:
`Charger_id, Charger_power`.

**Settings** (`tblSettings`, `Setting | Value`) — charge target, tariff €/kWh,
routing padding (on/factor), SID/STAR km, alternate reserve, grid factor, day
start/end, realisation low/high, procurement €/kWh. Named cells:
`Settings_tariff, Settings_chargeTarget, Settings_realisationLow,
Settings_realisationHigh, Settings_procurement, …`.

**Overview** — network KPIs (`=SUM`/`=MAX` over `tblAirports`; annual = ×365;
revenue band = tariff × annual × realisation; energy cost; gross margin) + a
**BarChart** of daily energy per airport and a **BarChart** of peak per airport
(both bound to `tblAirports`).

**Airports** (`tblAirports`) — `Airport, ICAO, Lat, Lon, Daily energy (kWh)
[formula], Peak (kW) [value], Installed (kW) [formula], Revenue/day (€)
[formula]`. One row/airport; Overview charts bind here.

**Per-airport tabs** (one per airport, tab named by sanitised ICAO, deduped,
≤31 chars):
- KPI header — name, ICAO, coords; daily (formula), peak (value), revenue (formula).
- **Installed charging** table — Charger, Count, Power each, Total (`=count×power`);
  total installed (`=SUM`).
- **Contributing flights** table — Route (role + other), Aircraft, Trip, Freq,
  Energy/flight (kWh) [value], Flights/day [formula], Daily total [formula],
  Charge time (min) [value]; multi-leg `legs` listed as indented sub-rows
  (airport · energy · time/power, values).
- **Load curve** block — Time (HH:MM), Power (kW) [values] + a **LineChart**.
- **Energy by type** block — Aircraft, Daily kWh [`SUMIF`], % [formula] +
  a **DoughnutChart**.

## Charts (native, range-bound; redraw on cell edit)

`LineChart` (load curve: time × kW), `DoughnutChart` (energy-by-type),
`BarChart` (per-airport energy & peak), each via `openpyxl…Reference`. Skipped
gracefully when their source range is empty.

## Edge cases

Empty plan → 400. Airport with no curve → keep sheet, omit the LineChart. Tab
names sanitised/deduped (31-char limit, strip `[]:*?/\`). Charts skip on empty
ranges. `flightsFull` missing fields tolerated (blank cells). openpyxl absent →
clear RuntimeError at request time (mirrors WeasyPrint handling in `report.py`).

## Testing / verification

Generate from a multi-airport payload (extend the PDF stress payload to several
airports + `flightsFull`). Re-open with openpyxl and assert: all sheets present;
`tblFlights/Aircraft/Chargers/Settings/Airports` defined with expected headers;
named ranges resolve; key cells contain **formula strings** (`=…`) not values;
charts attached with valid `Reference` ranges; `About!Version == "CNS Workbook
v1"`. openpyxl does not evaluate formulas — note that full recompute needs
Excel/LibreOffice; spot-check a few formula strings by hand. Confirm the file
opens (zip integrity) and the download round-trips through `/api/report.xlsx`.

## Risks

- Formula web across sheets is the main complexity — contained to per-airport
  contributing-flights rows + the airport/overview aggregations; INDEX/MATCH +
  named ranges keep it robust.
- openpyxl chart styling is coarser than the PDF SVGs — acceptable; these are
  native, editable charts by design.
- Large plans → many tabs; tab-name dedupe must be solid.

---

## v2 revision (2026-06-10) — "CNS Workbook v2"

User review of a real 16-airport export found a chart-overlap defect and an
unappealing default look. Decisions locked with the user: all airport tabs stay
(+ a hyperlinked index), full brand restyle, About merges into Data.

**Structure** — sheets collapse from `About + Overview + Airports + 4 input
tabs + N airports` to **`Overview | Data | N airport tabs`**:
- `Data` opens with the About block (format / version / generated / scope /
  how-to-read) and then stacks ALL five tables: `tblAirports` (computed,
  tagged), `tblFlights`, `tblAircraft`, `tblChargers`, `tblSettings`. Tables
  are addressed by NAME, so the import contract is placement-independent;
  the version anchor is the defined name **`CNS_Version`** → `Data!$B$3`.
- **Breaking:** `tblSettings` becomes a SINGLE-ROW table (one column per
  setting) instead of key/value rows — hence the version bump to **v2**.
- Airports sort busiest-first everywhere (tab order, index, charts, tables).

**Overview** — navy KPI cards (daily energy, peak, energy/yr, gross
margin/yr), live scenario lines (gross revenue, realisation band, energy
cost), a **hyperlinked airport index** (click a name → its tab), and two
**horizontal** brand-blue bar charts over the Data Airports table.

**Defect fixes & chart restyle**
- Airport-tab charts anchor at **column K** — clear of the A–I tables they
  previously overlapped.
- All charts: `varyColors` off, single house-palette colours (donut slices use
  the PDF palette), donut `holeSize` 55.
- The load curve is now a **true step on a time-proportional axis**: doubled
  points (t, prev)+(t, new) charted as a straight-line scatter over Excel-time
  x values (`t/1440`, `hh:mm` format) — replacing the misleading diagonal
  category line chart.
- Tab colours group the workbook: Overview navy, Data spreadsheet-green,
  airport tabs light blue.

**Verification (v2)** — structural asserts (sheet order; five tables on Data;
single-row `tblSettings`; chart anchors ≥ col K; hyperlinks resolve), chart-XML
asserts (brand fill present, `varyColors val="0"`, `smooth val="0"`,
`holeSize 55`), step-series shape check, and an independent formula evaluation:
**0 errors across 363 cells**, network totals correct.
