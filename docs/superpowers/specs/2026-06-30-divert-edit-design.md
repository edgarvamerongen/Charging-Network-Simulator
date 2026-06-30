# Manual divert editing (drag + ALT) — design spec

**Date:** 2026-06-30
**Branch:** `feat/divert-edit` (isolated worktree `../cns-divert`, off `origin/main` `2451218`)
**Status:** design approved; pending spec review → writing-plans

## Goal

Let operators **manually adjust a route's diverts** (the alternate airport reserved at each arrival node): drag the divert marker on the map, or use a purple **ALT** button (type an ident / click an airport on the map). While dragging, distances recompute live and the affected route leg turns red when the range can't absorb the new reserve. The chosen divert **persists** on the trip. **v1 ships diverts only**; origin/destination/stops dragging is a thin follow-up on the same mechanism.

## Context — how it works today

(Verified via codebase exploration; `file:line` are anchors, not contracts — re-check at build time.)

- **Diverts are auto + not editable.** Each airport's nearest suitable alternate is pre-baked into the catalog as `alternate_ident` + `alternate_km` (`airport_alternates.py`: `nearest_alternate()` L54, `suitable_alternate_idents()` L42 — paved runway ≥ `MIN_RUNWAY_M` 300m, open). The reserve is held at every **arrival** node (stops + destination); the origin departs full and has none.
- **Divert overlay:** `drawAlternates(chain)` (`templates/index.html` ~L2514) draws a purple (`#7c3aed`) dashed line + circle marker + distance label from each routed airport to `airportByIdent[alternate_ident]`; `clearAlternates()` ~L2505, `refreshAlternates()` ~L2549 (gated by the `#fAlternates` Map-Options checkbox ~L1715). A purple `.alt-hint` badge sits in the route list (~L1639, hover "Divert → IDENT · km").
- **Range + feasibility:** `haversineKm()` (`static/routing.js` L30, pure). `_availableRangeKm(plane)` (index.html ~L2829) = effective great-circle reach. Leg feasibility (incl. divert reserve): `legDist + altReserveKm(arrivalNode) > maxLeg` ⇒ infeasible — in `routing.js` A* (L152) and in `validateRoute()` (index.html ~L2882, pushes to `plannedLegIssues`).
- **Red legs already exist:** `drawLiveRoute()` (~L4472) / `drawRoute()` (~L4350) color over-range legs **red-dashed** (`'6 4'`) via `legIssues`/`plannedLegIssues`. Multi-leg draws one polyline per leg, so per-leg recolor is already possible.
- **Markers:** route endpoints are blue dots (`_routeBlueDot` ~L4280) + optional teardrops, rebuilt from `_routeEndpoints` by `setRoute()`/`refreshRouteEndpoints()` (~L4319-4349). **None are draggable today.**
- **Data model:** `selected = {origin, destination}` (each carries `alternate_km`, ident, lat/lon); `plannedStops = [{ident,name,lat,lon,type,_manual?,_auto?}]` (~L2757). Edits flow `refreshAfterEdit()` → `smartReplan()` → `recomputeRoute()` (~L2899) → `CNSRouting.planChain` → `validateRoute` → `renderStops` → `drawLiveRoute`. `recompute.js` preserves only `_manual` stops across replans.
- **"ALT" button** exists under 'charging stops' toggle, right next to stops.

## Decisions (from clarification)

1. **Persisted per-node override** — a manual divert replaces the auto one for that arrival node, stored on the trip (survives recompute + save/share + the saved-route overlay), with **reset-to-auto**. Reserve + feasibility recompute against the chosen airport.
2. **Suitable airports only** — manual divert targets are restricted to the same landable bar as the auto-divert (paved ≥300m, open). Drag snaps to the nearest **suitable** airport; the ALT typeahead is filtered to suitable. (This method of checking for suitable airports will soon be replaced by a more accurate divert fitting).
3. **Red signal = the inbound route leg** — a farther divert needs more reserve, so the leg *into* that node turns red when `legDist + reserve > range` (consistent with today's over-range styling).
4. **Architecture = Approach A** — a self-contained `static/divert-edit.js` module; diverts in v1, route nodes a thin v2 add.
5. **Resolver-centric, store the ident** — one `divertFor()` resolver (manual ident → live nearest-suitable → baked DB) replaces every direct read of `alternate_ident`; the manual choice is stored as a resolved **ident** (not a point), so it stays put and is trivial to persist/render.

## Data model — one resolver, one stored field

The heart of the feature is a **single resolver** that every consumer (overlay,
reserve, feasibility) calls instead of reading `alternate_ident` directly:

```
divertFor(node) =  airportByIdent[node.divertOverride]                    // 1. manual choice (stored ident)
               ??  nearestSuitable(node, allAirports, suitableIdents)     // 2. actively computed, client-side
               ??  airportByIdent[node.alternate_ident]                   // 3. the baked DB value
divertReserveKm(node) = node ? haversineKm(node, divertFor(node)) : 0     // 0 if none resolves
```

- **Tier 1 is the only stored state:** `divertOverride` — a **suitable** airport
  ident — on each **arrival** node (`selected.destination`, each `plannedStops[i]`,
  and `closingStops[i]` for circular). Drag/ALT writes the resolved ident here;
  `↺` clears it. The origin departs full → never carries one.
- **Tier 2 ("wants to find an alternate")** computes the nearest suitable airport
  client-side. This also **fixes a current gap**: airports with a blank baked
  `alternate_ident` get no divert reserve today; now they get a live-computed one.
- **Tier 3** is the existing baked value, used only if the client pool can't
  resolve one.

**Persistence is one optional field, not a wide surface.** `divertOverride` rides
on the node objects, so it persists by: preserving it across `recomputeRoute()`
(one line, like `_manual`); one optional ident in the `CNSShare` schema (absent →
decodes fine, so old links still work); and the same field carried through the
saved-route restore + demand-folder flight. One field, threaded; each touch trivial.

## The module — `static/divert-edit.js` (`CNSDivertEdit`)

Self-contained IIFE mirroring `range-graph.js`/`share.js`: own Leaflet layer/markers, deps injected once, mutates nothing else directly (it asks the host to recompute via a callback).

```
CNSDivertEdit.init({
  map,                       // Leaflet map
  getChain,                  // () => current arrival-node chain (stops + dest, with coords + alternate_ident)
  airportByIdent,            // ident -> airport
  haversineKm,               // (a,b) -> km   (CNSRouting.haversineKm)
  availableRangeKm,          // () -> effective reach for the current plane (_availableRangeKm)
  suitableIdents,            // Set of suitable-alternate idents (built once from the catalog)
  onChange,                  // (nodeKey, ident|null) => host sets node.divertOverride then recomputes
})
```
Public API: `render(chain)` (draw draggable diverts for the current route, honoring overrides), `startAltPick(nodeKey)` (enter ALT mode: typeahead/map-click), `setOverride(nodeKey, ident)`, `resetOverride(nodeKey)`, `clear()`.
Pure, **unit-testable** core (no Leaflet/DOM): the `divertFor(node)` resolver, `nearestSuitable(point, airports, suitableIdents)`, `divertReserveKm(node)`, and the predicate `legInfeasible(legKm, reserveKm, rangeKm)`.

`drawAlternates()` delegates marker creation to `CNSDivertEdit.render(chain)` when divert editing is active (Alternates toggle on), so the existing overlay becomes the draggable surface rather than a parallel one.

## Drag mechanics

- The divert marker becomes a **draggable `L.marker`** with a purple divIcon (`#7c3aed`) — Leaflet circleMarkers aren't draggable.
- **On `drag`** (continuous, client-side only — no backend): `reserve = haversineKm(node, markerLatLng)`; recolor the **inbound** leg red via the existing over-range style when `inboundLegKm + reserve > availableRangeKm()`; update the divert line + distance label live; highlight the **nearest suitable** airport as a snap preview.
- **On `dragend`**: snap to `nearestSuitable(dropPoint)` → `onChange(nodeKey, airport.ident)` → host sets `node.divertOverride` and calls `recomputeRoute()` (re-validates **all** legs — a reserve change can cascade). If no suitable airport is within a sane radius, revert to the prior marker position (no-op).

## The purple ALT button

- A small purple **`ALT`** control per arrival node — in the route list beside the `.alt-hint` badge; clicking the divert **marker** on the map triggers the same action.
- Click → ALT mode for that node: **(a)** a typeahead filtered to **suitable** airports (enter an ident), or **(b)** "click an airport on the map" — the next click on a suitable airport sets it (a one-shot map-pick mode with an escape).
- A `↺` **reset-to-auto** beside it clears `divertOverride`.

## Live feedback

Inbound-leg red reuses the existing over-range red-dashed style (no new color). The divert distance label updates as the marker moves. On commit, the full `recomputeRoute()` re-colors every leg, since a reserve change at one node can flip feasibility elsewhere.

## Plumbing the override through

- `recomputeRoute()` (index.html): preserve `divertOverride` per node across replans.
- `routing.js` `altReserveKm` + `validateRoute()`: use `divertReserveKm(node)` (override-aware) instead of the raw baked `alternate_km`.
- `drawAlternates()`: render the override (line/label/marker point at the chosen airport).
- `CNSShare` schema + saved-route restore + demand-folder flight: persist + restore the field.

## Phasing

- **v1 — diverts:** module + draggable divert markers + ALT button + override data model + live red-inbound-leg feedback + full persistence + node tests.
- **v2 (follow-up) — route nodes:** make origin/dest/stop markers draggable using the same drag/snap/feedback core → snap to nearest airport → update `selected`/`plannedStops` → `recomputeRoute()`. No new persistence (those already persist).

## Testing

- **Node** (à la `tests/js_range_graph.test.mjs`, realm-safe): `nearestSuitable` (returns the closest **suitable** airport, excludes unsuitable/self/malformed), `divertReserveKm` (override-aware), `legInfeasible(legKm, reserveKm, rangeKm)`.
- **Browser** (preview): drag a divert farther → inbound leg goes red → drop → snaps to a suitable airport → override persists across recompute → `↺` resets to auto; ALT typeahead (suitable-only) + map-click pick; share/restore round-trip keeps the override; Alternates-toggle off hides the editing surface.

## Out of scope (v1)

- Origin/destination/stop dragging (v2).
- Editing the *suitability* rule or per-aircraft alternate policy.
- Multiple alternates per node (one divert per arrival node, as today).

## Risks

- **Persistence touches several stores** (`recompute` + `CNSShare` + saved-route + demand folder) — but it's the *same* one optional field in each, so the mitigation is just the single `divertFor()` resolver + an absent-safe schema field. Not a complexity risk; just don't forget a store.
- **Drag vs map pan/click** conflict on the divert marker — use Leaflet marker `draggable` (which suppresses map drag) and a one-shot map-pick mode for ALT, with an explicit escape (Esc / click-away).
- **Circular trips** also reserve on the closing-leg arrival nodes (`closingStops`) — the override must apply there too.
