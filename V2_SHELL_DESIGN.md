# CNS v2 shell — design spec

Status: approved direction (Edgar, 2026-09-03: "build the /v2"). Repo-root file
because `docs/` is gitignored. Companion plan: `V2_SHELL_PLAN.md`.

## 1. Decision

Build a **new desktop shell at `/v2`** from the design-A "Instrument" prototype
(`static/proto/instrument.html`), reusing every existing engine module
unchanged, while `/` keeps serving the current `templates/index.html` untouched.
Both versions run side by side on the same server and the same localStorage, so
reviewers can compare them and give feedback without the old one moving. When
`/v2` reaches parity it takes over `/`, the old template is deleted, and the
guided tour is re-authored against the new anchors.

Rejected: re-skinning `index.html` in place (the July 2026 approach — 4,240
lines of inline JS with ~60 load-bearing ids; the new layout is not a skin).

## 2. Non-goals

- Mobile (`/m/`, `index_mobile.html`, `mobile.js`, `mobile.css`) — untouched.
- The embed/timeline page (`templates/embed.html`) — untouched.
- `sim.py`, `app.py` beyond one new route, the PDF/XLSX renderers — untouched.
- Dark theme — after the swap.
- The news ticker — dropped in v2 (was already off by default in the July branch).

## 3. Architecture

| piece | file | notes |
|---|---|---|
| route | `app.py` `GET /v2` → `render_template('desktop.html', …)` | same context as `/`: `planes`, `chargers`, `asset_version`, `carto_key_qs`; `share_state` when reached via `/v2/s/<slug>` (added with share parity in phase 4). Auth-gated like `/`. |
| template | `templates/desktop.html` | markup only: topbar, one rail, timeline drawer, map, palette, modals, SVG icon sprite. No inline CSS, no inline JS beyond the Jinja→JSON bridge (`window.CNS_DATA = {planes, chargers, cartoKeyQs, shareState}`). |
| styles | `static/desktop.css` | the prototype's token layer + components, verbatim, extended as parity needs. One radius token (3 px), one accent, no gradients/blur/glow, Inter only. |
| UI layer | `static/ui/app.js` (state, boot, event bus), `ui/map.js`, `ui/plan.js` (form + planner + result), `ui/network.js` (ledger), `ui/timeline.js` (drawer), `ui/palette.js`, `ui/modals.js`, `ui/scenarios.js` | plain scripts, one `window.CNSUI` namespace, loaded after the engines. Rendering by template strings + event delegation, as in the prototype. |
| engines reused unchanged | `state.js units.js settings.js chargers.js demand.js routing.js flight-model.js recompute.js charging.js scheduler.js animation.js report.js spreadsheet.js flight-entry.js share.js buildshare.js range-graph.js runway.js divert-edit.js` | loaded in the same order as `index.html:2436–2457`. |
| tour | `static/tour.js` | re-authored in phase 4 against v2 anchors; until then v2 has no tour button. |

**Page-global adapter.** Several modules read page-scoped names off `window`
or via `typeof` from the inline script (`escHtml`, `CHARGERS_BY_ID`,
`PLANES_BY_ID`, `setOrigin/setDest/setStop`, `_cnsAltPick/_cnsRetryPlan/
_cnsAltReset`, and for `share.js`/`buildshare.js`: `selected`, `plannedStops`,
`airportByIdent`, `pickAirport`, `setStop`, `smartReplan`, `drawLiveRoute`,
`renderPlaneSpecCard`, `renderFolder`). `ui/app.js` exports every one of them on
`window` with the same names and semantics. This also fixes the two dangling
references in the old shell (`window.airportByIdent` for `report.js`,
`window.folderMap` for `tour.js`).

**Scheduler rendering.** `CNSScheduler` keeps owning the day model
(`runGlobal`, `rotationsAt`, `tripPhases`, `summary`, drag-reschedule state in
`cns_schedule`). `ui/timeline.js` renders those rotations in the prototype's
language instead of `CNSScheduler.renderInto`. Airport lanes = rotations
grouped by the charger slot they claim at that airport; fleet lanes = the
scheduler's aircraft lanes. Waiting = `wait` phases, overflow = `summary().
overflow`. Drag-to-reschedule is kept (pointer events on `.blk`, writing
through the scheduler's existing API).

## 4. State

One `S` object in `ui/app.js` (mirrors the prototype): `mode` plan|network,
`rail` form|result, `planeId`, `chargerId`, `origin`, `dest`, `stops[]`
(manual, with `_manual`/`_auto` flags as `recompute.js` expects), `trip`,
`freq`, `per`, `result` (the `/api/simulate` response + `_origin/_dest/
_chargerId/_freqN/_freqUnit` decorations exactly as `index.html:5292` sets
them, so `flight-entry.js` and `buildshare.js` keep working), `filter`
(isolated airport), `lanes` airports|fleet, `showDep`, `units` via `CNSUnits`.
Persistent state stays where the engines keep it: folder/cfg/schedule/settings/
units/map-options in their existing localStorage keys — **shared with `/`**, so a
network built in one shell shows in the other.

## 5. Numbers

- Every displayed figure comes from `CNSFlight.simulateTrip` / `profileForTrip`
  (FlightProfile: legs with `socStartFrac/socEndFrac`, charges, phases,
  totals), exactly as `renderResult` does today. `/api/simulate` is still
  called (plane/charger objects, audit text, `flight-entry` shape).
- Battery profile: nodes from `profile.legs[].socStartFrac/socEndFrac` and
  `profile.charges[].departSocFrac`; the three-stage draw inside a leg uses
  `CNSFlight.climbParams(plane)` (climb over `0.6·min(d, d_sat)` at the climb
  rate, cruise, descent at 0.2× cruise) and always sums to `leg.energyKwh`.
  Reserve line from `CNSSettings.usableFraction`.
- Network figures (peak kW, energy, revenue, charge minutes, overflow) come
  from `CNSDemand.computeAirports` + `CNSCharging.planCharging` +
  `CNSScheduler.summary`, as `renderFolder` computes them today.

## 6. UI

- **Topbar (44 px):** logo, title, `Plan | Network` switch with the route
  count, airport search with `⌘K` hint, Map menu (Light / Street / Satellite,
  small airfields, NRG2FLY chargers, saved routes, alternates, flight labels,
  reach graph), units `km | NM`, Export menu (PDF, XLSX, share link, build
  link, one-pager), Tour (phase 4), model-settings sliders icon with the
  active-flags badge.
- **Rail — Plan / form:** Aircraft (thumb, name, meta, reach bar, `Change` →
  grouped picker with knobs and the range override), Route (departure,
  destination, manual stops with drag-reorder and remove, `+ Add stop`,
  suggested-route block with the planner's stops, bias select, network-pool
  buttons, retry, per-leg divert edit via the map), Trip type, Frequency,
  Charger (shortlist + `All chargers` + `Add custom charger`), Simulate/Reset.
- **Rail — Plan / result:** header `A → B → C` + Edit, stats (energy, travel,
  charge), cost/day, fly/charge split, battery profile, Route table, Charging
  table with the terminal top-up and target SoC, Calculation audit, `Add to
  network`, share.
- **Rail — Network:** header + tiles (airports, flights, energy, peak load) or,
  isolated, the airport's tiles (sessions, energy, peak, max wait); Show
  select; per-airport rows (ident, name, charges/day, kWh/day, peak kW) that
  expand to flights (role tags, pin, infeasible, freq edit, edit, remove),
  the charger stepper (bays = `cfg.chargers`), charge-target control,
  overflow alert, replay-map link; toolbar Share build / PDF (airport picker) /
  XLSX / Clear.
- **Timeline drawer:** beside the rail, grows with rows to 60 vh; `Airports |
  Fleet` lanes, departures toggle, isolated-airport chip, network-load row
  (concurrent kW per 15 min from the scheduler's rotations), per-charger lanes
  with waiting lane, drag-to-reschedule.
- **Map:** Esri light-grey default, Voyager (keyed) and imagery; airport dots
  by type with clustering as today, NRG2FLY squares, coral route with white
  casing, leg labels, endpoints, divert connectors (`CNSDivertEdit`), saved
  routes (dimmed outside the isolated airport), reach-graph overlay
  (`CNSRangeGraph`), airport popup with departure/destination/stop actions.
- **Palette (⌘K):** airports (fly to / departure / destination / stop /
  isolate), aircraft, chargers, actions (simulate, add, mode, lanes,
  departures, scenarios, basemap, units, exports, reset, clear).
- **Scenarios:** empty-network cards (Hub base, Regional network, Training
  school) loading through the real simulate + folder path.
- **Modals (v2 language, no Bootstrap):** edit flight, model settings (all
  `rs*` controls + taper curve), custom charger, report airport picker,
  welcome, flights replay (`CNSAnimation`).

## 7. Parity checklist → phases

1. **Shell** — route, template, CSS, engines loaded, `CNS_DATA` bridge, map +
   airports + NRG layer + search, palette scaffold, units, map options
   persisted, empty rail states.
2. **Plan** — aircraft picker/override/reach bar, autocomplete, manual stops,
   planner (`validateRoute/recomputeRoute/smartReplan` ported), divert editing,
   trip types incl. training/circular, frequency, chargers + custom chargers,
   Simulate → engine profile, result card + battery profile + audit, route
   drawing + labels + alternates, share link `/v2/s/<slug>` restore.
3. **Network** — folder/cfg via `CNSDemand`, ledger, charger stepper + SoC
   target, timeline from `CNSScheduler`, isolation, edit-flight modal,
   remove/freq edit, replay map, overflow, build share + restore, scenarios.
4. **Rest** — PDF picker + generate, XLSX, model-settings modal, welcome,
   tour re-authored (`CNSTour.check()` 100 %), one-pager, `/s/<slug>` parity.
5. **Swap** — `/` serves `desktop.html`, `/v2` redirects to `/`, old template
   and Bootstrap removed, July branches archived (`archive/…`) and PR #57
   closed, one PR.

Each phase ends with a live review by Edgar on `/v2` before the next starts.

## 8. Verification

- `node --check` on every `static/ui/*.js`; the Flask app boots; `/` unchanged
  (byte-identical template).
- Headless captures of the deep-link states (`#result #multi #network #big
  #hub #hub::fleet #training #empty #palette`, kept from the prototype) plus
  scripted DOM/state checks through the page's `S`.
- Numbers cross-checked against `/` for the same route (energy, charge min,
  peak kW, revenue) — must match to the rounding.
- Existing Python tests (`tests/`) untouched and green.
- Phase 4: `CNSTour.check()` resolves every anchor.

## 9. Risks

- Scope: the planner + divert editing (`index.html:2809–3608`) is the densest
  port; it moves as a block with its function names kept.
- `share.js`/`buildshare.js` global coupling — covered by the adapter; verified
  by round-tripping a link between `/` and `/v2`.
- Two shells for a few weeks: any engine change must be checked on both.
