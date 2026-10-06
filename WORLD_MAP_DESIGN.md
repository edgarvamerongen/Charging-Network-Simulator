# World map: worldwide airports and a globe (design)

Status: approved direction, 2026-10-06. Scope: the v2 desktop shell (`/v2`). The classic (`/`) and mobile (`/m/`)
views are out of scope and keep Leaflet + the European dataset.

## Intent

CNS must be usable anywhere in the world, by anyone, as a demonstration of where electric flight fits: island
groups, archipelagos, mountain regions. Every region gets the fidelity Europe has today (runway data, divert
alternates, routing). Routes and networks may cross regions freely (Gibraltar, Iceland to Greenland, Singapore to
Indonesia). Zoomed out, the map is a globe.

Constraints: a first visit must not feel noticeably slower than today; Europe stays the default view; saved networks
and share links keep working; European routing and scheduling results do not change.

## Part 1: worldwide airport data

### Build (offline, `prepare_data.py`)

- Source: the OurAirports dumps `airports.csv` + `runways.csv` (gitignored inputs, as today).
- A world mode drops the European-country filter: every `small_airport`, `medium_airport`, `large_airport` with
  coordinates, about 50,000 rows (Europe today: 7,796). Seaplane bases and heliports stay excluded.
- Runway columns `rwy_paved_m … rwy_unknown_m`: the same rules as today (`airport_alternates.runway_length_columns`).
- Divert alternates `alternate_km`, `alternate_ident`: the same suitability rule (open, paved, at least 300 m), but
  the nearest-alternate search runs worldwide with a spatial index (a 3D unit-vector KD-tree or a lat/lon grid),
  not the chunked brute force, which is quadratic and sized for 7.8k points. Searching worldwide is what lets an
  airport divert across a region boundary.
- Outputs:
  - `world_airports.csv`: the full columns, same schema as `european_airports.csv`. It is what `sim.py` loads.
  - `static/data/airports-world.json`: the compact browser feed, columnar (one array per field, short keys, type as
    a small enum, coordinates rounded to 5 decimals, runway metres as integers). Target about 4 MB raw, about
    1 MB gzipped. It carries a content hash used as the cache version.
- `european_airports.csv` keeps being produced for the classic/mobile `/api/airports`.

### Serve (`app.py`, `sim.py`)

- New `GET /api/airports/world`: the compact feed, gzip-compressed, with `ETag` = the content hash and a long
  `Cache-Control`. The v2 page references it with the hash in its URL so a new build invalidates the cache.
- `GET /api/airports` is unchanged (Europe) for the classic and mobile views.
- `sim.py` loads `world_airports.csv` (falling back to `european_airports.csv` when it is absent, so tests and old
  checkouts keep working). Lookups by ident become a dict; `resolve_airport`, the public search index and `/embed`
  stop scanning linearly.
- Test isolation: tests keep pinning their own fixtures and never read the generated world file (the same rule as
  `CNS_PLANES_FILE`).

### Browser (`static/ui/app.js`)

- v2 loads `/api/airports/world` and unpacks the columns into the airport records the engines already use
  (`ident, name, type, latitude_deg, longitude_deg, iso_country, alternate_km, alternate_ident, rwy_*_m, …`), so
  `routing.js`, `range-graph.js`, `recompute.js` and search work unchanged.
- Search shows the country code with each result ("NZQN · Queenstown · NZ").
- Saved networks and share links address airports by ICAO ident; the world set contains every current European
  ident, so they resolve unchanged.
- Small fields without runway data behave as today: shown, but not used as a stop by an aircraft whose plan needs
  a runway check (the `hasData` + `fits` gates).

## Part 2: the globe (v2 map on MapLibre GL)

### Library and view

- MapLibre GL JS v5, pinned, from a CDN on the allowed list. Projection `globe`: a globe when zoomed out, flattening
  into Web Mercator as it zooms in. North up; rotation and pitch are off.
- Opening view unchanged: Europe at today's centre and zoom.
- Basemaps: the same three as raster sources (Esri World Light Gray, Carto Voyager with the env-only key, Esri World
  Imagery).
- Map menu: "Globe when zoomed out", default on; off = Mercator at every zoom.
- No WebGL: a clear message in place of the map, not a broken page.

### `UI.map` keeps its interface

`static/ui/map.js` is rewritten inside, but its public functions (`drawNet`, `drawRoute`, `fitNet`,
`highlightAirports`, `ensureRouteVisible`, `routeInView`, `arcPath`, …) keep their signatures, so `plan.js`,
`network.js`, `timeline.js`, `planner.js` and `palette.js` don't change, apart from any direct Leaflet calls,
which move behind `UI.map`.

### What is drawn (GeoJSON sources + GPU layers)

| Today (Leaflet) | MapLibre |
|---|---|
| one `circleMarker` per airport on a canvas renderer; small fields hidden below zoom 7.5 | one `circle` layer; data-driven colour and size by type and state (network, selected, greyed); a zoom filter for small fields |
| hand-placed labels that avoid one another | a `symbol` layer with collision detection |
| network polylines, width by traffic, faded when not lit | a `line` layer with data-driven width and opacity |
| planned route, arrow markers on one-way legs, optional °T track labels, alternates | `line` + `symbol` layers (arrows along the line, track labels) |
| range graph polygon and spokes | `fill` + `line` layers |
| waypoint diamonds, draggable | HTML `Marker`s, draggable |
| popups, click to add a stop | MapLibre `Popup`; `queryRenderedFeatures` hit-testing |

Lines are already densified great-circle arcs (`arcPath`), so they lie correctly on the globe.

### Shared with the classic view

`static/range-graph.js` and `static/animation.js` are also used by the Leaflet classic page. Their geometry stays
shared; each gets a renderer seam with a Leaflet drawer (classic) and a MapLibre drawer (v2).

### Unchanged

- The wind animation stays a screen-space canvas overlay on top of the map.

## Copy

- "Europe" leaves the user-facing copy: the og/twitter descriptions, the welcome and tour text, and the PDF report's
  "airports across Europe".
- The new wording is neutral, e.g. "airports worldwide".

## Verification

- **Data**
  - Unit tests for the world build. A known field's runway lengths and nearest alternate match OurAirports.
  - The spatial-index alternate search equals brute force on a sample.
- **Engines**
  - The golden route cases and the DES snapshot (`tests/run_all.sh`) stay identical: European results do not move.
- **Browser**
  - The tests/ui scenarios pass on the new map.
  - Scenarios that read Leaflet internals (map, network, planner, timeline, palette, shell, settings, airports,
    trip-freq-charger, smoke) move to a test hook on `UI.map` that lists what is drawn.
- **Performance**, measured before and after:
  - first load (download + parse);
  - a pan and zoom with all airports loaded;
  - planning a route across a region boundary (Spain → Morocco).
  - Targets: first load within about 1 s of today on a normal connection, a smooth pan, and route planning under
    100 ms.
- **Real use:** plan routes in Norway, the Caribbean and New Zealand.

## Rollout

- Built on a branch.
- Edgar reviews it live before anything merges.
- Part 1 (data) and Part 2 (map) can merge separately, data first.

## Out of scope

- The classic and mobile views.
- Seaplane bases and heliports.
- New example scenarios outside Europe.
- Region-chunked loading. That is the fallback only if the single worldwide feed measures too slow.
