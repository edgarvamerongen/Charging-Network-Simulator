# PDF report re-skin — design spec

**Date:** 2026-06-24
**Branch:** `feat/report-reskin` (isolated worktree `../cns-report`, off `origin/main` `dfa8c27`)
**Status:** design approved; pending spec review → writing-plans

## Goal

Re-skin the PDF advisory report to the formatting of the revised front-end
rebuild (`/Users/edgar/Documents/proefje/cns new front end ideas`), while
**preserving the current report's advisory content** and the **current curated
airport-photo thumbnail**.

## Context

- "The report" = the **PDF** (`templates/report.html` + `static/report.css`,
  rendered by `report.py` via WeasyPrint). The revised folder has no
  `static/report.js`; the on-screen report is out of scope.
- The revised `report.py` (960L) and the current `report.py` (1132L) are
  **siblings** — same `generate_pdf(payload, css_url, request_root)` signature,
  same SVG builders (`_load_curve_svg`, `_donut_svg`, `_gantt_svg`), same
  `_airport_photo` pipeline, near-identical render context. So the new template
  is **nearly drop-in** on the current backend.
- The current `report.py` additionally (a) feeds a curated airport photo
  (`_airport_photo` → local curated pics / Wikidata–Wikipedia lead image / Esri
  satellite) and (b) appends the NRG2fly one-pager as closing pages. **Both are
  preserved unchanged.**

## Decisions (from clarification)

- **Scope:** new look + structure; **port** About NRG2fly, Methodology, and the
  CEO/COO contact box into the new style; **drop** the per-flight detail table;
  **keep** the per-airport verdict.
- **Thumbnail:** **contained** cover image (new treatment), fed by the current
  curated `_airport_photo` pipeline.
- **Cover title:** keep the narrative **"{Airport} as an Energy Hub"**.

## Approach — A: re-skin onto the current backend

Swap in the new `report.html` + `report.css`; **keep the current `report.py`**
(live-wired to `/report`, curated thumbnail, one-pager append, existing PDF
tests). Add only the few derived `scenario` fields the new revenue table needs.

Rejected:
- **B (wholesale-swap `report.py` too):** higher risk — the revised `report.py`
  is from a separate rebuild and may not match the live payload shape, the
  one-pager append, or the PDF tests.
- **C (diff-and-merge `report.py`):** fall back to this *per field* only if A
  hits a genuine data gap.

## The merged report (new look throughout)

| # | Section | Source | Notes |
|---|---------|--------|-------|
| — | **Cover** | new layout | "Advisory report" kicker · **"{Airport} as an Energy Hub"** title · **contained airport thumbnail** (current curated pipeline) · 5 KPI cards (Energy/day · Peak · Airports · Routes · Aircraft) |
| — | **About NRG2fly** | ported, restyled | Consulting / Hardware / CPO&MSP cards · "what this means" framing · CEO/COO contact box |
| 01 | **Executive summary** | new | lede · load-curve · donut · revenue & margin table |
| 02 | **Network** | new | map · flights-&-demand-by-airport table |
| 03 | **Airport detail** (per airport) | new + kept | KPI row · charging-equipment table · rotation gantt · **verdict line** (kept). ~~per-flight detail table~~ dropped |
| 04 | **Fleet** | new | aircraft cards (photo + spec table) |
| A | **Methodology & appendix** | merged | current Methodology prose + new appendix tables (settings · economics · charger catalogue), **deduped** so settings/economics appear once |
| — | *one-pager* | unchanged backend | still appended as closing pages |

## Files touched (3)

- **`templates/report.html`** — the new template, modified per the table:
  Energy-Hub cover title; contained thumbnail bound to current `airport_photo`;
  ported About / Methodology / contact sections in the new style; drop the
  per-flight "Contributing flights" table + its charging-legs sub-rows; keep the
  verdict block; merge the new Appendix tables with the ported Methodology.
- **`static/report.css`** — the new stylesheet + restyled rules for the ported
  sections (about columns, contact/questions box, methodology prose, verdict).
- **`report.py`** — minimal: extend `scenario` with `tariff` (= `charge_rate`),
  `daily_kwh` (= `totals.totalDailyKwh`), `annual_mwh`, `gross_rev_year`; add
  `installedKw` per airport if the new airport table needs it (else compute
  in-template from `chargers`). Curated thumbnail + one-pager untouched.

## Data reconciliation

The current `report.py` already produces: `totals` (incl.
`airportCount`/`flightCount`/`planeCount`), `airports` (`peakKw`, `dailyKwh`,
`chargerCount`, `latestEndClock`, `chargers[]`, `gantt_svg`, `overflow`),
`planes` (`image_data_uri`/`svg_data_uri`/`battery_kwh`/`range_km`/`speed_kmh`/
`seats`/`load_kg`), `load_curve_svg`, `donut_svg`, `map_data_uri`, `scenario`
(`annual_kwh`, `rev_year_low/high`, `energy_cost_year`, `margin_year_low/high`,
`procurement`, `realisation_low/high`), `model_settings`, `charge_rate`,
`generated_at`, `focus_airport`, `airport_photo` (+credit).

Gaps for the new template: the 4 derived `scenario` fields above and
`a.installedKw`. All trivial derivations — no backend logic change.

## Kept / dropped

- **Kept** (restyled to the new look): About NRG2fly (3 service cards +
  framing), Methodology prose, CEO/COO contact box, per-airport verdict,
  curated airport thumbnail, appended one-pager.
- **Dropped:** the per-airport "Contributing flights" detail table + its
  charging-legs sub-rows.

## Testing / verification

- Run the report PDF tests in `tests/` (they render the report through
  `report.py`); add field coverage if the new `scenario`/`installedKw` fields
  warrant it.
- Render a sample PDF (test harness or `/report`) and eyeball each section:
  cover (contained thumbnail + Energy-Hub title + 5 KPIs), About page, exec
  summary (charts + revenue table), network, per-airport (KPI row + equipment +
  gantt + verdict), fleet cards, methodology+appendix, **one-pager appended**.
- Confirm brand fidelity (navy `#2b2f5a` / orange) survives the new CSS.

## Out of scope

- The on-screen report panel (`static/report.js`) — unchanged.
- The revised folder's other front-end (map, planner, drawers).
- Backend simulation / scheduler logic.

## Risks

- Field-name mismatches between the new template and current data → surfaced by
  rendering; fall back to approach C per field.
- CSS brand drift (new CSS vs current palette) → verify when eyeballing the PDF.
