# CNS Backlog & Rollout Roadmap

A 14-task backlog rolled out over time as **orthogonal cluster branches** — one
branch per cluster, fast-forward-merged to `main` (like the `tour` branch). This
file is the shared index every session can read; full per-cluster design +
verification lives in the approved rollout plan.

**Two standing decisions:** F2 (a backend taper model / `/charging-curve` endpoint)
is **dropped**. The tapering is realised as **F9** — a client-side interactive
curve in Model Settings, built on the existing `chargeTaper` model in
`static/settings.js`.

## Rollout phases

| Phase | Branch | Tasks | Gate |
|-------|--------|-------|------|
| 1 | `branding` | B1 OG meta · B2 logo link · B3 ticker · B4 buttons · F4 favicon | direct |
| 1 | `units` | F3 kW→MW / kWh→MWh | direct — land before display work |
| 1 | `airport-data` | A1 Step 1 (airport_chargers.json + GET endpoints) | direct |
| 2 | `result-panel` | F6 specs→card · F7 restructure · C1b revenue row | needs `units` |
| 2 | `model-settings` | F8 compact/[?] · C1a €/kWh + accessor · F9 taper curve | F9 after F8 |
| 2 | `pdf` | P2 advisory reframe · P1 visual + onepager append | onepager file + pypdf |
| 2 | `map-labels` | F5 per-leg labels | direct |
| 3 | `training-range` | F1 training range | **explain-first** |
| 4 | `airport-db` | A1 Steps 2–4 (map layer · sim override · demand) | **explain-first**, needs Step 1 |

Phase-1 branches are fully parallel. Phase-2 branches are parallel too, with two
soft rules: land `units` before `result-panel`/`model-settings`; merge `map-labels`
before `airport-db`'s map layer.

## Orthogonality rules
1. **C1 (revenue) is the only cross-cutting task** — split it: the settings
   accessor + €/kWh field land in `model-settings` (C1a); the result row (C1b) and
   any scheduler total just *read* `CNSSettings.chargeRate()`. No file collision.
2. **`units` first**, so the display clusters build on `fmtPower`/`fmtEnergy`.
3. **F9 after F8** (it draws into the restructured taper section).
4. **`map-labels` vs `airport-db` map layer** — different functions, both in the map
   JS; merge `map-labels` first if run together.
5. **Shared assets** — a square NRG2fly logo (F4 favicon + airport-db markers) and
   the onepager PDF (`static/NRG2fly_onepager.pdf`: B4 button + P1 append). Prep once.

## Lanes & gates
- `static/mobile.js` / `index_mobile.html` are the **mobile** role's lane (CLAUDE.md).
  Only F3 reaches mobile.js — coordinate that part with the mobile session.
- **Explain-first** (write approach → get user approval → code): **F1**, and **A1
  Steps 2–4**.

## Task index (14)
- **Branding:** B1 OG/Twitter cards · B2 logo→nrg2fly.com · B3 news ticker · B4 onepager + back-to-platform buttons
- **Units:** F3 kW→MW / kWh→MWh display
- **Calculator:** C1 potential revenue (€/kWh, default 0.60)
- **PDF:** P1 visual upgrade + onepager append · P2 advisory reframe
- **Features:** F1 training range · F4 favicon · F5 leg labels · F6 specs→card · F7 result restructure · F8 model-settings compact · F9 tapering curve (revised — replaces F2)
- **Airport DB:** A1 real-charger DB — Step 1 data/endpoint (now); Steps 2–4 map/override/demand (explain-first)

## Added during rollout
- **Charging model — charge-to-reach option (raised 2026-06-04, result-panel review):**
  today every stop (intermediate *and* termini) charges to the global SoC target, so a
  quick mid-route stop tops up to e.g. 80% even when the next leg needs little. Option:
  intermediate/en-route stops charge **only enough for the next leg + landing reserve**;
  **only the destination/home hit the target**. More realistic, less dwell. Model-wide:
  `scheduler.js recomputeMultiLegCharges` (forward walk) + `demand.js deliveredEnergy`;
  cascades to DES + demand calculator + PDF. Prefer a **Model-settings toggle**
  (charge-to-target vs charge-to-reach) over replacing current behaviour outright.
