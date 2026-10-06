# World map implementation plan

> For agentic workers: executed natively in one session (Edgar waived plan review; one whole-branch review at the end).

**Goal:** worldwide airports in the v2 planner and a MapLibre globe map, per `WORLD_MAP_DESIGN.md`.

**Architecture:**
- Part 1 builds a world airport set offline and serves a compact cached feed that v2 unpacks into today's airport
  records.
- Part 2 replaces Leaflet in the v2 map with MapLibre GL 5.24.0 through a small Leaflet-like drawing layer
  (`static/ui/gl.js`), so `map.js`, the waypoint drawing and the two modules shared with the classic page (range
  graph, alternates editor) keep their drawing code.

**Tech stack:** Python + pandas/numpy (build), Flask (serve), MapLibre GL JS 5.24.0 (unpkg), node:test + tests/ui
(CDP) for checks.

**Spec:** `WORLD_MAP_DESIGN.md`

## Global constraints

- Scope is v2 only (`/v2`). Classic and mobile keep Leaflet and `/api/airports` (Europe), byte-identical.
- European routing and scheduling results do not move: the golden route cases and the DES snapshot stay identical.
- Tests never read generated data: they pin fixtures (`CNS_PLANES_FILE`; airports via `CNS_AIRPORTS_FILE`).
- No em dashes in user-facing copy; professional aviation wording.
- MapLibre pinned at 5.24.0 from unpkg.

## Review focus

1. **An airport ident present in Europe but missing or renamed worldwide.** Saved networks must still resolve.
   Test: every `european_airports.csv` ident exists in the world feed.
2. **Routes and bounds across the antimeridian** (e.g. Fiji, the Aleutians). Fitting and great-circle lines must not
   wrap the long way round. Test: `fitBounds` over 179°E and 179°W frames the short side.
3. **Clicking an airport at globe zoom.** The popup opens for the right airport, and no click falls through to
   "add a waypoint". Test: a browser check clicks a dot.
4. **No WebGL.** The map area shows a message; the rail still works. Test: a stubbed `getContext` returning null.
5. **First load with a cold cache.** The world feed is gzip'd and cached by version. Test: response headers carry
   `Content-Encoding: gzip` and an `ETag`, and a repeat request answers 304.

---

## Task 1: world build (`prepare_data.py`, `airport_alternates.py`)

- **Mode:** `prepare_data.py --world` reads the OurAirports dumps (`--src DIR`).
  - Keeps small, medium and large airports with coordinates.
  - Runway columns: the existing `runway_length_columns`.
  - Alternates: a new `nearest_alternate_indexed()`, a KD-tree on unit vectors via scipy if available, else a
    1°-cell grid search. It returns the same columns as `compute_alternate_columns`.
- **Outputs:** `world_airports.csv` (same schema as `european_airports.csv`) and `static/data/airports-world.json`.
  - The JSON is columnar:
    `{v, hash, n, f:{i,n,t,la,lo,c,m,a,ak,ai,rp,rg,rv,rd,rw,ru}}`, where `t` is 0/1/2 for small/medium/large.
  - The hash is sha1 over the JSON.
- **Tests:** `tests/test_world_build.py`.
  - The indexed alternate equals brute force on a 2,000-airport sample.
  - The columnar round-trip is lossless for every field.
  - Every European ident is in the world set.
- **Commit.**

## Task 2: serve the world (`app.py`, `sim.py`)

- **New `GET /api/airports/world`:**
  - Reads the JSON once.
  - Gzips once in memory.
  - Sets `ETag` to the hash and `Cache-Control: public, max-age=31536000, immutable`.
  - Answers `If-None-Match` with 304.
  - Returns 404 with a JSON error when the file is missing.
- **`sim.py`:**
  - Airport file = `CNS_AIRPORTS_FILE`, else `world_airports.csv` if present, else `european_airports.csv`.
  - `get_airport` becomes a dict lookup.
- **`app.py`:**
  - The `/api/airports` route keeps serving the European CSV list (its own loader) for classic and mobile.
  - `resolve_airport` and the search index use dicts.
- **Test isolation:** `tests/_helpers.py` and `run_all.sh` set `CNS_AIRPORTS_FILE=european_airports.csv`, so the
  goldens see exactly today's data.
- **Tests (pytest):** gzip, ETag, 304, the Europe route unchanged, and resolution of a non-European ident (NZQN).
- **Commit.**

## Task 3: v2 loads the world (`static/ui/app.js`, `templates/desktop.html`)

- Fetch `/api/airports/world?v=<hash>` (the hash comes from the template context).
- Unpack the columns into records: `ident, name, type, latitude_deg, longitude_deg, iso_country, municipality,
  alternate_km, alternate_ident, rwy_*_m, iata_code`.
- Fall back to `/api/airports` on error.
- Search results show the country code.
- Copy loses "Europe" (desktop meta, tour text, `report.html`).
- **Checks:** the browser smoke check; search "NZQN" finds Queenstown; plan LEMD → GMMN (Spain → Morocco); measure
  the load and planning times.
- **Commit.** Part 1 is mergeable here.

## Task 4: the drawing layer (`static/ui/gl.js`)

- `CNSGL.map(el, opts)` wraps a MapLibre map with the subset of Leaflet these modules use:
  - Views: `setView`, `getZoom`, `getBounds().pad/contains/isValid`, `fitBounds(b, {paddingTopLeft,
    paddingBottomRight, maxZoom, animate})`, `panTo`, `flyTo`.
  - Geometry: `latLngToContainerPoint`, `getSize`, `invalidateSize`.
  - Events: `on/off` for `click` (`e.latlng`), `moveend` and `zoomend`.
  - Layers: `createPane/getPane` (z-order), `addLayer`, `removeLayer`, `hasLayer`, `closePopup`.
- `CNSGL.L` provides the shapes and helpers:
  - Shapes: `polyline`, `polygon`, `circle` (geodesic), `circleMarker`, and `marker` with `divIcon` (an HTML
    marker; `draggable`, `dragend`, `getLatLng`).
  - Groups and helpers: `layerGroup`, `popup`, `latLng`, `latLngBounds`.
  - Layer methods: `bindPopup`, `bindTooltip`, `on('click')`, `addTo`, `remove`, `getLatLngs`, `options`.
  - The polyline option `arrowEnd`: an arrow symbol at the end of the line, rotated along it.
- **Rendering:** each pane has one GeoJSON source per kind (line, fill, circle). Feature properties carry the
  style; paint is data-driven. Rebuilds are batched with `requestAnimationFrame`. Pane order follows the zIndex.
- **Basemaps:** raster sources. Carto `{s}` expands to a, b, c and `{r}` to empty.
- **Projection:** `setGlobe(on)`.
- **No WebGL:** a message element.
- **Test:** `tests/js_gl_bounds.test.mjs` covers the antimeridian bounds and `pad`/`contains` maths (the pure parts).
- **Commit.**

## Task 5: the v2 map on MapLibre (`static/ui/map.js`, `waypoints.js`, `planner.js`, shared modules)

- **`map.js`:**
  - Build the map with `CNSGL`.
  - Airport dots move to a dedicated GPU circle layer: radius by type and zoom, a filter by allowed types, small
    fields from zoom 7.5. A click opens `popupHtml` in a MapLibre popup.
  - Everything else keeps its drawing code with `L` → `CNSGL.L`.
  - The arrow hack (`marker-end`) is replaced by `arrowEnd`.
- **`waypoints.js`:** `L` → `CNSGL.L`; the map click goes through the wrapper.
- **Shared modules** (`range-graph.js`, `divert-edit.js`):
  - Use an injected `L` (`deps.L || window.L`). The classic passes nothing, so it is unchanged.
  - `planner.js` passes `CNSGL.L` and the wrapper.
- **Map menu:** "Globe when zoomed out" (`S.globe`, default on, stored like the other map options).
- **Test hook:** `UI.map.drawn()` lists `{pane, kind, latlngs, opacity, weight}` for the tests/ui scenarios.
- **Tests:** tests/ui scenarios that read Leaflet internals move to `UI.map.drawn()` and the dot-layer queries.
  Every tests/ui component must pass (excluding the known pre-existing failures).
- **Commit.**

## Task 6: verify and review

- **Performance**, before and after: load, pan, and route planning.
- **Real routes:** Norway coast, Caribbean, New Zealand, Spain → Morocco, and Fiji across the antimeridian.
- **Screenshots:** the globe zoomed out, Europe at the default view, a network with an isolated airport, and the
  range graph.
- **Tests:** the full `tests/run_all.sh` passes and the goldens are identical.
- **Whole-branch review** by a fresh reviewer.
- Hand to Edgar for the live review.
