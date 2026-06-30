# External Flight-Data Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn heterogeneous external flight histories into a CNS build-share `/s/<slug>` link via a token-gated `POST /api/import` endpoint, plus a portable `cns-import-flights` skill that interprets any source into the normalized JSON the endpoint consumes.

**Architecture:** A deterministic server core (resolve codes→coords over the global `airports.csv`, classify trip type, aggregate→frequency, assemble the build blob, store via `shares.save_state`) behind `POST /api/import`, token-authenticated. A portable skill does the source-specific interpretation and calls the endpoint. The **normalized JSON** is the seam between them. Build server-first.

**Tech Stack:** Python 3 (Flask, stdlib `csv`/`hmac`/`hashlib`/`math`/`datetime`), stdlib `unittest`, existing `shares.py` (SQLite slug store). No new pip dependencies.

## Global Constraints

- Build blob shape: `{ v:1, k:'build', fl:[...], cfg:{}, sch:{}, ms:{} }`; each `fl` entry `{ id, p, c, t, fn, fu, o, d, s? }` with points `{ i, la, lo, n }` (ident, lat, lon, name). `cfg`/`sch`/`ms` are empty on import.
- Trip types: `oneway` | `retour` | `circular`. `t='retour'` ⇒ `o=route[0]`, `d=`single far point, `s=[]`. `t='circular'` ⇒ `o=route[0]`, `d=route[0]`, `s=`distinct intermediates in order. `t='oneway'` ⇒ `o=route[0]`, `d=route[-1]`, `s=`middles.
- Code resolution uses the global `airports.csv` (85k rows; columns include `ident`, `iata_code`, `name`, `latitude_deg`, `longitude_deg`), priority ICAO `ident` → `iata_code`. Unresolved code ⇒ drop that flight, record the code.
- Frequency: default `freq_basis="actual"` ⇒ `freqUnit="week"`, `freqN = max(round(occurrences / weeks_covered, 2), 0.01)`; `freq_basis="regular"` ⇒ `freqUnit="week"`, `freqN=1` per unique route. No usable dates ⇒ `actual` falls back to `regular`. The DC only understands `freqUnit ∈ {day, week}`.
- Default plane fallback `beta_plane`; default charger fallback `dc_320`. Switchable later in the DC.
- Endpoint auth: `Authorization: Bearer <token>` compared (constant-time) to env `CNS_IMPORT_TOKEN`; separate from `CNS_APP_PASSWORD`. The endpoint's Flask function name goes in `_PUBLIC_ENDPOINTS` (bypasses the session gate; the handler enforces the token).
- Assembled blob must satisfy `shares.MAX_STATE_BYTES` (64 KB) → else `413`.
- Python tests run: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python -m unittest tests.<module> -v` (pytest is NOT installed).

---

### Task 1: Airport resolver over the global `airports.csv`

**Files:**
- Create: `airport_resolver.py`
- Test: `tests/test_airport_resolver.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `airport_resolver.resolve(code: str) -> dict | None` returning `{'ident', 'name', 'lat': float, 'lon': float}`; `airport_resolver._reset()` (clears the cached index — for tests). Reads the CSV at env `CNS_AIRPORTS_CSV` or `<repo>/airports.csv`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_airport_resolver.py`:

```python
"""Unit tests for airport_resolver — code→coords over a tiny fixture CSV."""
import csv
import os
import tempfile
import unittest

_TMP = tempfile.mkdtemp(prefix='cns_resolver_test_')
_CSV = os.path.join(_TMP, 'airports.csv')
with open(_CSV, 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f)
    w.writerow(['ident', 'type', 'name', 'latitude_deg', 'longitude_deg', 'iata_code'])
    w.writerow(['EHAM', 'large_airport', 'Amsterdam Schiphol', '52.3086', '4.7639', 'AMS'])
    w.writerow(['EDDB', 'large_airport', 'Berlin Brandenburg', '52.3617', '13.5023', 'BER'])
    w.writerow(['KJFK', 'large_airport', 'John F Kennedy Intl', '40.6394', '-73.7793', 'JFK'])
    w.writerow(['XXNO', 'small_airport', 'No Coords', '', '', 'NOC'])
os.environ['CNS_AIRPORTS_CSV'] = _CSV

import airport_resolver  # noqa: E402


class AirportResolverTest(unittest.TestCase):
    def setUp(self):
        os.environ['CNS_AIRPORTS_CSV'] = _CSV
        airport_resolver._reset()

    def test_resolves_iata(self):
        r = airport_resolver.resolve('AMS')
        self.assertEqual(r['ident'], 'EHAM')
        self.assertAlmostEqual(r['lat'], 52.3086, places=3)
        self.assertAlmostEqual(r['lon'], 4.7639, places=3)
        self.assertEqual(r['name'], 'Amsterdam Schiphol')

    def test_resolves_icao_passthrough(self):
        self.assertEqual(airport_resolver.resolve('EHAM')['ident'], 'EHAM')

    def test_case_insensitive(self):
        self.assertEqual(airport_resolver.resolve('ams')['ident'], 'EHAM')

    def test_intercontinental_iata(self):
        self.assertEqual(airport_resolver.resolve('JFK')['ident'], 'KJFK')

    def test_unknown_returns_none(self):
        self.assertIsNone(airport_resolver.resolve('ZZZ'))

    def test_blank_returns_none(self):
        self.assertIsNone(airport_resolver.resolve(''))
        self.assertIsNone(airport_resolver.resolve('   '))

    def test_row_without_coords_is_skipped(self):
        self.assertIsNone(airport_resolver.resolve('NOC'))


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python -m unittest tests.test_airport_resolver -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'airport_resolver'`.

- [ ] **Step 3: Create the module**

Create `airport_resolver.py`:

```python
"""
airport_resolver — resolve an airport code (ICAO or IATA) to coordinates,
against the full global airports.csv (the OurAirports dataset shipped in the
repo). Unlike sim.py (which loads the Europe-only catalog), this resolves any
airport worldwide, so imported flights to non-European destinations still carry
real coordinates into the build blob.

The 85k-row CSV is indexed once into in-memory dicts (ICAO ident + IATA),
lazily on first resolve(). Override the CSV path with CNS_AIRPORTS_CSV (tests
point it at a small fixture). _reset() drops the cache so a test can swap files.
"""
import csv
import os
import threading

_lock = threading.Lock()
_by_icao = None
_by_iata = None


def _csv_path():
    return os.environ.get('CNS_AIRPORTS_CSV') or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), 'airports.csv')


def _reset():
    global _by_icao, _by_iata
    _by_icao = None
    _by_iata = None


def _load():
    global _by_icao, _by_iata
    if _by_icao is not None:
        return
    with _lock:
        if _by_icao is not None:
            return
        icao, iata = {}, {}
        with open(_csv_path(), newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                lat, lon = row.get('latitude_deg'), row.get('longitude_deg')
                if not lat or not lon:
                    continue
                try:
                    rec = {
                        'ident': row['ident'],
                        'name': row.get('name') or row['ident'],
                        'lat': float(lat),
                        'lon': float(lon),
                    }
                except (KeyError, ValueError):
                    continue
                ident = (row.get('ident') or '').strip().upper()
                if ident and ident not in icao:
                    icao[ident] = rec
                code = (row.get('iata_code') or '').strip().upper()
                if code and code not in iata:
                    iata[code] = rec
        _by_icao, _by_iata = icao, iata


def resolve(code):
    """Resolve an ICAO or IATA code to {ident,name,lat,lon}, or None.
    ICAO (ident) is tried before IATA, per spec."""
    if not code or not str(code).strip():
        return None
    _load()
    q = str(code).strip().upper()
    return _by_icao.get(q) or _by_iata.get(q)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python -m unittest tests.test_airport_resolver -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add airport_resolver.py tests/test_airport_resolver.py
git commit -m "feat(import): airport_resolver — code→coords over global airports.csv"
```

---

### Task 2: Trip-type classification

**Files:**
- Create: `flight_import.py`
- Test: `tests/test_flight_import.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `flight_import.classify_trip(idents: list[str]) -> dict` returning `{'t', 'o', 'd', 's'}` where `t ∈ {'oneway','retour','circular'}`, `o`/`d` are idents, `s` is a list of idents.

- [ ] **Step 1: Write the failing test**

Create `tests/test_flight_import.py`:

```python
"""Unit tests for flight_import — classification, aggregation, blob assembly."""
import unittest

import flight_import


class ClassifyTripTest(unittest.TestCase):
    def test_oneway(self):
        self.assertEqual(
            flight_import.classify_trip(['EHAM', 'EDDB']),
            {'t': 'oneway', 'o': 'EHAM', 'd': 'EDDB', 's': []})

    def test_oneway_with_stops(self):
        self.assertEqual(
            flight_import.classify_trip(['EHAM', 'EDDP', 'LKPD']),
            {'t': 'oneway', 'o': 'EHAM', 'd': 'LKPD', 's': ['EDDP']})

    def test_retour_single_far_point(self):
        self.assertEqual(
            flight_import.classify_trip(['EHAM', 'EDDB', 'EHAM']),
            {'t': 'retour', 'o': 'EHAM', 'd': 'EDDB', 's': []})

    def test_circular_multiple_stops(self):
        self.assertEqual(
            flight_import.classify_trip(['EHAM', 'EPWA', 'EYVI', 'EHAM']),
            {'t': 'circular', 'o': 'EHAM', 'd': 'EHAM', 's': ['EPWA', 'EYVI']})

    def test_circular_dedupes_repeat_waypoints(self):
        # AMS-LUN-WKF-CPT-WKF-NBO-AMS → distinct intermediates, order preserved
        out = flight_import.classify_trip(['E1', 'A', 'B', 'C', 'B', 'D', 'E1'])
        self.assertEqual(out['t'], 'circular')
        self.assertEqual(out['o'], 'E1')
        self.assertEqual(out['d'], 'E1')
        self.assertEqual(out['s'], ['A', 'B', 'C', 'D'])


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python -m unittest tests.test_flight_import.ClassifyTripTest -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'flight_import'`.

- [ ] **Step 3: Create the module with `classify_trip`**

Create `flight_import.py`:

```python
"""
flight_import — deterministic conversion of a normalized flight payload into a
CNS build blob + a structured report. Pure functions (resolution is injected),
so they unit-test without Flask or the airport CSV.

Pipeline (build_blob): validate → resolve codes → classify trip type →
aggregate identical routes into frequencies → assemble the build blob.
"""


def classify_trip(idents):
    """Classify an ordered list of resolved airport idents into a CNS trip.

    route[0]==route[-1] (round trip):
      - exactly one distinct intermediate -> 'retour' (o=start, d=far point)
      - multiple distinct intermediates   -> 'circular' (o=d=start, s=stops)
    otherwise -> 'oneway' (o=first, d=last, s=middles).
    """
    o = idents[0]
    last = idents[-1]
    if o == last:
        seen, mids = set(), []
        for x in idents[1:-1]:
            if x not in seen:
                seen.add(x)
                mids.append(x)
        if len(mids) == 1:
            return {'t': 'retour', 'o': o, 'd': mids[0], 's': []}
        return {'t': 'circular', 'o': o, 'd': o, 's': mids}
    return {'t': 'oneway', 'o': o, 'd': last, 's': list(idents[1:-1])}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python -m unittest tests.test_flight_import.ClassifyTripTest -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add flight_import.py tests/test_flight_import.py
git commit -m "feat(import): classify_trip — oneway/retour/circular from a route"
```

---

### Task 3: Validation, aggregation, and build-blob assembly

**Files:**
- Modify: `flight_import.py` (add `validate_normalized`, `_haversine_km`, `build_blob`)
- Test: `tests/test_flight_import.py` (add `ValidateTest`, `BuildBlobTest`)

**Interfaces:**
- Consumes: `classify_trip` (Task 2); an injected `resolve(code) -> dict|None` (Task 1's `airport_resolver.resolve`).
- Produces:
  - `flight_import.validate_normalized(payload: dict) -> None` (raises `ValueError` with a message on bad input).
  - `flight_import.build_blob(payload: dict, resolve, planes_by_id: dict) -> tuple[dict, dict]` returning `(blob, report)`. `planes_by_id` maps `plane_id -> {'range_km': float, ...}`. `blob` is the `{v,k:'build',fl,cfg,sch,ms}` dict; `report` is `{flights_in, routes_out, dropped, unresolved_codes, infeasible_for_default, freq_basis_used}`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_flight_import.py`:

```python
class ValidateTest(unittest.TestCase):
    def test_ok(self):
        flight_import.validate_normalized(
            {'source': 's', 'flights': [{'route': ['AMS', 'BER']}]})  # no raise

    def test_missing_flights(self):
        with self.assertRaises(ValueError):
            flight_import.validate_normalized({'source': 's'})

    def test_empty_flights(self):
        with self.assertRaises(ValueError):
            flight_import.validate_normalized({'flights': []})

    def test_route_too_short(self):
        with self.assertRaises(ValueError):
            flight_import.validate_normalized({'flights': [{'route': ['AMS']}]})

    def test_bad_freq_basis(self):
        with self.assertRaises(ValueError):
            flight_import.validate_normalized(
                {'flights': [{'route': ['A', 'B']}], 'defaults': {'freq_basis': 'monthly'}})


# Minimal fake resolver: 5-letter idents are returned verbatim with dummy coords.
_FAKE = {
    'AMS': {'ident': 'EHAM', 'name': 'Schiphol', 'lat': 52.31, 'lon': 4.76},
    'BER': {'ident': 'EDDB', 'name': 'Berlin', 'lat': 52.36, 'lon': 13.50},
    'JFK': {'ident': 'KJFK', 'name': 'JFK', 'lat': 40.64, 'lon': -73.78},
}
def _resolve(code):
    return _FAKE.get(str(code).strip().upper())

_PLANES = {'beta_plane': {'range_km': 500}, 'vaeridion': {'range_km': 500}}


class BuildBlobTest(unittest.TestCase):
    def test_assembles_blob_and_report(self):
        payload = {'source': 'demo', 'flights': [
            {'route': ['AMS', 'BER', 'AMS'], 'date': '2022-01-01'},
            {'route': ['AMS', 'BER', 'AMS'], 'date': '2022-01-15'},
        ]}
        blob, report = flight_import.build_blob(payload, _resolve, _PLANES)
        self.assertEqual(blob['v'], 1)
        self.assertEqual(blob['k'], 'build')
        self.assertEqual(blob['cfg'], {})
        self.assertEqual(report['flights_in'], 2)
        self.assertEqual(report['routes_out'], 1)        # both rows aggregate
        self.assertEqual(len(blob['fl']), 1)
        f = blob['fl'][0]
        self.assertEqual(f['t'], 'retour')
        self.assertEqual(f['o']['i'], 'EHAM')
        self.assertEqual(f['d']['i'], 'EDDB')
        self.assertEqual(f['p'], 'beta_plane')
        self.assertEqual(f['c'], 'dc_320')
        self.assertEqual(f['fu'], 'week')

    def test_actual_frequency_is_rate_over_span(self):
        # 2 flights, 14 days apart -> span 2 weeks -> 1.0/week
        payload = {'flights': [
            {'route': ['AMS', 'BER'], 'date': '2022-01-01'},
            {'route': ['AMS', 'BER'], 'date': '2022-01-15'},
        ]}
        blob, _ = flight_import.build_blob(payload, _resolve, _PLANES)
        self.assertEqual(blob['fl'][0]['fn'], 1.0)

    def test_regular_frequency_is_one(self):
        payload = {'defaults': {'freq_basis': 'regular'}, 'flights': [
            {'route': ['AMS', 'BER'], 'date': '2022-01-01'},
            {'route': ['AMS', 'BER'], 'date': '2022-06-01'},
        ]}
        blob, report = flight_import.build_blob(payload, _resolve, _PLANES)
        self.assertEqual(blob['fl'][0]['fn'], 1)
        self.assertEqual(report['freq_basis_used'], 'regular')

    def test_no_dates_falls_back_to_regular(self):
        payload = {'defaults': {'freq_basis': 'actual'},
                   'flights': [{'route': ['AMS', 'BER']}, {'route': ['AMS', 'BER']}]}
        blob, report = flight_import.build_blob(payload, _resolve, _PLANES)
        self.assertEqual(report['freq_basis_used'], 'regular')
        self.assertEqual(blob['fl'][0]['fn'], 1)

    def test_unresolved_code_drops_flight(self):
        payload = {'flights': [
            {'route': ['AMS', 'BER']},
            {'route': ['AMS', 'ZZZ']},   # ZZZ unresolved
        ]}
        blob, report = flight_import.build_blob(payload, _resolve, _PLANES)
        self.assertEqual(report['routes_out'], 1)
        self.assertEqual(report['dropped'], 1)
        self.assertEqual(report['unresolved_codes'], ['ZZZ'])

    def test_long_haul_counts_as_infeasible_for_default(self):
        payload = {'flights': [{'route': ['AMS', 'JFK']}]}   # ~5800 km >> 500
        _blob, report = flight_import.build_blob(payload, _resolve, _PLANES)
        self.assertEqual(report['infeasible_for_default'], 1)

    def test_unknown_default_plane_falls_back_to_beta(self):
        payload = {'defaults': {'plane': 'nope'}, 'flights': [{'route': ['AMS', 'BER']}]}
        blob, _ = flight_import.build_blob(payload, _resolve, _PLANES)
        self.assertEqual(blob['fl'][0]['p'], 'beta_plane')
```

- [ ] **Step 2: Run them to verify they fail**

Run: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python -m unittest tests.test_flight_import.ValidateTest tests.test_flight_import.BuildBlobTest -v`
Expected: FAIL — `AttributeError: module 'flight_import' has no attribute 'validate_normalized'`.

- [ ] **Step 3: Implement validation, haversine, and `build_blob`**

Append to `flight_import.py`:

```python
import hashlib
import math
from datetime import datetime

_DEFAULT_PLANE = 'beta_plane'
_DEFAULT_CHARGER = 'dc_320'
_VALID_BASIS = ('actual', 'regular')


def validate_normalized(payload):
    """Raise ValueError if the normalized payload is structurally invalid."""
    if not isinstance(payload, dict):
        raise ValueError('payload must be an object')
    flights = payload.get('flights')
    if not isinstance(flights, list) or not flights:
        raise ValueError('payload.flights must be a non-empty array')
    for i, fl in enumerate(flights):
        if not isinstance(fl, dict):
            raise ValueError('flights[%d] must be an object' % i)
        route = fl.get('route')
        if not isinstance(route, list) or len(route) < 2:
            raise ValueError('flights[%d].route must have >= 2 codes' % i)
        if not all(isinstance(c, str) and c.strip() for c in route):
            raise ValueError('flights[%d].route codes must be non-empty strings' % i)
    defaults = payload.get('defaults') or {}
    basis = defaults.get('freq_basis')
    if basis is not None and basis not in _VALID_BASIS:
        raise ValueError('defaults.freq_basis must be one of %s' % (_VALID_BASIS,))


def _haversine_km(a, b):
    R = 6371.0
    lat1, lon1, lat2, lon2 = map(math.radians, (a['lat'], a['lon'], b['lat'], b['lon']))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def _parse_date(s):
    if not s or not isinstance(s, str):
        return None
    try:
        return datetime.strptime(s.strip()[:10], '%Y-%m-%d')
    except ValueError:
        return None


def _pt(rec):
    return {'i': rec['ident'], 'la': rec['lat'], 'lo': rec['lon'], 'n': rec['name']}


def build_blob(payload, resolve, planes_by_id):
    """Convert a validated-or-raw normalized payload into (blob, report)."""
    validate_normalized(payload)
    flights = payload['flights']
    defaults = payload.get('defaults') or {}

    plane = defaults.get('plane')
    if plane not in planes_by_id:
        plane = _DEFAULT_PLANE
    charger = defaults.get('charger') or _DEFAULT_CHARGER
    plane_range = (planes_by_id.get(plane) or {}).get('range_km') or 0

    # 1. Resolve + classify each flight; group by route signature.
    groups = {}          # signature -> {'trip','recs','count','dates'}
    order = []           # preserve first-seen order
    dropped = 0
    unresolved = set()
    for fl in flights:
        recs = [resolve(c) for c in fl['route']]
        bad = [c for c, r in zip(fl['route'], recs) if r is None]
        if bad:
            for c in bad:
                unresolved.add(str(c).strip().upper())
            dropped += 1
            continue
        idents = [r['ident'] for r in recs]
        trip = classify_trip(idents)
        sig = trip['t'] + '|' + '>'.join(idents)
        if sig not in groups:
            groups[sig] = {'trip': trip, 'recs': recs, 'count': 0, 'dates': []}
            order.append(sig)
        g = groups[sig]
        g['count'] += 1
        d = _parse_date(fl.get('date'))
        if d:
            g['dates'].append(d)

    # 2. Frequency basis: 'actual' needs a datable span across the whole dataset.
    basis = defaults.get('freq_basis') or 'actual'
    all_dates = [d for g in groups.values() for d in g['dates']]
    if basis == 'actual' and len(all_dates) < 2:
        basis = 'regular'
    weeks = 1.0
    if basis == 'actual':
        weeks = max((max(all_dates) - min(all_dates)).days / 7.0, 1.0)

    # 3. Assemble fl[] and the feasibility estimate.
    fl_out = []
    infeasible = 0
    for sig in order:
        g = groups[sig]
        trip, recs = g['trip'], g['recs']
        by_ident = {r['ident']: r for r in recs}
        if basis == 'regular':
            fn = 1
        else:
            fn = max(round(g['count'] / weeks, 2), 0.01)
        entry = {
            'id': 'imp_' + hashlib.sha1(sig.encode('utf-8')).hexdigest()[:10],
            'p': plane, 'c': charger, 't': trip['t'], 'fn': fn, 'fu': 'week',
            'o': _pt(by_ident[trip['o']]),
            'd': _pt(by_ident[trip['d']]),
        }
        if trip['s']:
            entry['s'] = [_pt(by_ident[i]) for i in trip['s']]
        fl_out.append(entry)
        # longest consecutive leg vs default plane range
        longest = max(_haversine_km(recs[i], recs[i + 1]) for i in range(len(recs) - 1))
        if plane_range and longest > plane_range:
            infeasible += 1

    blob = {'v': 1, 'k': 'build', 'fl': fl_out, 'cfg': {}, 'sch': {}, 'ms': {}}
    report = {
        'flights_in': len(flights),
        'routes_out': len(fl_out),
        'dropped': dropped,
        'unresolved_codes': sorted(unresolved),
        'infeasible_for_default': infeasible,
        'freq_basis_used': basis,
    }
    return blob, report
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python -m unittest tests.test_flight_import -v`
Expected: PASS (all `ClassifyTripTest`, `ValidateTest`, `BuildBlobTest`).

- [ ] **Step 5: Commit**

```bash
git add flight_import.py tests/test_flight_import.py
git commit -m "feat(import): validate + aggregate + assemble build blob with report"
```

---

### Task 4: The `POST /api/import` endpoint

**Files:**
- Modify: `app.py` (add `_IMPORT_TOKEN`; add `'api_import'` to `_PUBLIC_ENDPOINTS`; add the route + its imports)
- Test: `tests/test_import_route.py`

**Interfaces:**
- Consumes: `airport_resolver.resolve` (Task 1); `flight_import.validate_normalized` + `build_blob` (Tasks 2–3); `shares.save_state` + `shares.MAX_STATE_BYTES` (existing); `simulator.planes` (existing).
- Produces: `POST /api/import` → `200 {url, slug, report}` | `400` | `401` | `413`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_import_route.py`:

```python
"""In-process tests for POST /api/import using Flask's test client."""
import os
import tempfile
import unittest

os.environ.setdefault('CNS_APP_PASSWORD', 'test-secret-pw')
os.environ.setdefault('CNS_SECRET_KEY', 'unit-test-fixed-key')
os.environ.setdefault('CNS_INSECURE_COOKIES', '1')
os.environ['CNS_IMPORT_TOKEN'] = 'test-import-token'
_DB = os.path.join(tempfile.mkdtemp(prefix='cns_import_route_'), 'shares.db')
os.environ['CNS_SHARES_DB'] = _DB

import app as cns_app  # noqa: E402
import shares          # noqa: E402

_AUTH = {'Authorization': 'Bearer test-import-token'}


class ImportRouteTest(unittest.TestCase):
    def setUp(self):
        os.environ['CNS_SHARES_DB'] = _DB
        cns_app.app.config['TESTING'] = True
        self.client = cns_app.app.test_client()
        shares.init_db()

    def test_requires_token(self):
        r = self.client.post('/api/import', json={'flights': [{'route': ['AMS', 'BER']}]})
        self.assertEqual(r.status_code, 401)

    def test_rejects_wrong_token(self):
        r = self.client.post('/api/import', headers={'Authorization': 'Bearer nope'},
                             json={'flights': [{'route': ['AMS', 'BER']}]})
        self.assertEqual(r.status_code, 401)

    def test_rejects_malformed_body(self):
        r = self.client.post('/api/import', headers=_AUTH, json={'nope': 1})
        self.assertEqual(r.status_code, 400)

    def test_happy_path_returns_link_and_report(self):
        body = {'source': 'PH-GOV', 'flights': [
            {'route': ['AMS', 'BER', 'AMS'], 'date': '2022-01-01'},
            {'route': ['AMS', 'JFK', 'AMS'], 'date': '2022-02-01'},
        ]}
        r = self.client.post('/api/import', headers=_AUTH, json=body)
        self.assertEqual(r.status_code, 200, r.data)
        data = r.get_json()
        self.assertTrue(data['url'].endswith('/s/' + data['slug']))
        self.assertEqual(data['report']['flights_in'], 2)
        self.assertEqual(data['report']['routes_out'], 2)
        self.assertEqual(data['report']['infeasible_for_default'], 1)   # the JFK leg
        # the stored blob is a build blob and reloads verbatim
        self.assertEqual(shares.load_state(data['slug'])['k'], 'build')


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: Run them to verify they fail**

Run: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python -m unittest tests.test_import_route -v`
Expected: FAIL — `404` (route not defined) on every test.

- [ ] **Step 3: Add the token constant and public-endpoint entry**

In `app.py`, after the `_PASSWORD_PLAIN = ...` line (~line 69), add:

```python
_IMPORT_TOKEN = os.environ.get('CNS_IMPORT_TOKEN') or ''
```

In `app.py`, change the `_PUBLIC_ENDPOINTS` set (~line 94) from:

```python
_PUBLIC_ENDPOINTS = {'login', 'logout', 'healthz', 'static', 'pics', 'embed'}
```

to:

```python
_PUBLIC_ENDPOINTS = {'login', 'logout', 'healthz', 'static', 'pics', 'embed', 'api_import'}
```

- [ ] **Step 4: Add the imports and the route**

In `app.py`, with the other module imports (after `import shares`, ~line 29), add:

```python
import airport_resolver
import flight_import
```

In `app.py`, immediately after the `api_share_create` function (the `/api/share` route, ends ~line 903), add:

```python
@app.route('/api/import', methods=['POST'])
def api_import():
    """Token-gated import: a normalized flight payload in, a build-share link out.
    Public endpoint (bypasses the session gate) but enforces a bearer token so a
    portable skill can post without the interactive login. Stores the assembled
    build blob in the shares DB and returns the /s/<slug> link + a report."""
    auth = request.headers.get('Authorization', '')
    token = auth[7:] if auth.startswith('Bearer ') else ''
    if not _IMPORT_TOKEN or not hmac.compare_digest(token, _IMPORT_TOKEN):
        return jsonify({'error': 'Invalid or missing import token.'}), 401

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'Expected a JSON object body.'}), 400
    try:
        flight_import.validate_normalized(payload)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400

    planes_by_id = {p['id']: p for p in simulator.planes}
    blob, report = flight_import.build_blob(payload, airport_resolver.resolve, planes_by_id)

    if len(json.dumps(blob).encode('utf-8')) > shares.MAX_STATE_BYTES:
        return jsonify({'error': 'Imported build is too large to share.'}), 413
    try:
        slug = shares.save_state(blob)
    except Exception:
        app.logger.exception('Import share save failed')
        return jsonify({'error': 'Could not create import link.'}), 500

    url = request.host_url.rstrip('/') + '/s/' + slug
    return jsonify({'url': url, 'slug': slug, 'report': report})
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python -m unittest tests.test_import_route -v`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the full share + import suite (no regressions)**

Run: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python -m unittest tests.test_shares tests.test_share_routes tests.test_airport_resolver tests.test_flight_import tests.test_import_route -v`
Expected: PASS all.

- [ ] **Step 7: Commit**

```bash
git add app.py tests/test_import_route.py
git commit -m "feat(import): POST /api/import — token-gated normalized-data → share link"
```

---

### Task 5: The portable `cns-import-flights` skill

**Files:**
- Create: `skills/cns-import-flights/SKILL.md`
- Create: `skills/cns-import-flights/schema.json`
- Create: `skills/cns-import-flights/examples/ph-gov-xlsx.md`
- Create: `skills/cns-import-flights/examples/ph-gov-pdf.md`
- Create: `skills/cns-import-flights/README.md`
- Test: `tests/test_skill_examples.py` (the bundled example normalized JSON must pass the server's `validate_normalized` + `build_blob`)

**Interfaces:**
- Consumes: the live `POST /api/import` contract (Task 4); `flight_import.validate_normalized` + `build_blob` (Tasks 2–3) for the example test.
- Produces: the installable skill directory.

- [ ] **Step 1: Write the failing test (the examples must satisfy the server contract)**

Create `tests/test_skill_examples.py`:

```python
"""The skill's bundled example normalized JSON must satisfy the server contract,
so the few-shot guidance can never drift from what /api/import accepts."""
import json
import os
import re
import unittest

import flight_import

_HERE = os.path.dirname(os.path.abspath(__file__))
_SKILL = os.path.join(_HERE, '..', 'skills', 'cns-import-flights')
_FAKE = {'AMS': {'ident': 'EHAM', 'name': 'Schiphol', 'lat': 52.31, 'lon': 4.76},
         'BER': {'ident': 'EDDB', 'name': 'Berlin', 'lat': 52.36, 'lon': 13.50},
         'LUZ': {'ident': 'EPLB', 'name': 'Lublin', 'lat': 51.24, 'lon': 22.71},
         'KIV': {'ident': 'LUKK', 'name': 'Chisinau', 'lat': 46.93, 'lon': 28.93}}


def _normalized_blocks(md_path):
    with open(md_path, encoding='utf-8') as f:
        text = f.read()
    return re.findall(r'```json\n(.*?)\n```', text, re.DOTALL)


class SkillExamplesTest(unittest.TestCase):
    def test_examples_are_valid_normalized(self):
        for name in ('ph-gov-xlsx.md', 'ph-gov-pdf.md'):
            for block in _normalized_blocks(os.path.join(_SKILL, 'examples', name)):
                payload = json.loads(block)
                if 'flights' not in payload:
                    continue
                flight_import.validate_normalized(payload)
                blob, report = flight_import.build_blob(
                    payload, lambda c: _FAKE.get(str(c).strip().upper()),
                    {'beta_plane': {'range_km': 500}})
                self.assertEqual(blob['k'], 'build')
                self.assertGreaterEqual(report['routes_out'], 1)

    def test_schema_file_is_valid_json(self):
        with open(os.path.join(_SKILL, 'schema.json'), encoding='utf-8') as f:
            json.load(f)


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python -m unittest tests.test_skill_examples -v`
Expected: FAIL — `FileNotFoundError` (skill files don't exist).

- [ ] **Step 3: Create the JSON schema**

Create `skills/cns-import-flights/schema.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "CNS normalized flights",
  "type": "object",
  "required": ["flights"],
  "properties": {
    "source": { "type": "string" },
    "defaults": {
      "type": "object",
      "properties": {
        "plane": { "type": "string" },
        "charger": { "type": "string" },
        "freq_basis": { "enum": ["actual", "regular"] }
      }
    },
    "flights": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["route"],
        "properties": {
          "route": { "type": "array", "minItems": 2, "items": { "type": "string" } },
          "date": { "type": "string", "description": "ISO YYYY-MM-DD" },
          "positioning": { "type": "array", "items": { "type": "boolean" } },
          "pax": { "type": "integer" },
          "operator": { "type": "string" },
          "note": { "type": "string" }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Create the xlsx example**

Create `skills/cns-import-flights/examples/ph-gov-xlsx.md`:

````markdown
# Example: PH-GOV usage spreadsheet (column-per-stop)

Source columns: `Datum | Van | Stop 1..6 | Naar | Passagiers | Aanvrager | Kwartaal | Opmerking`.
Codes are IATA. A trip is `Van → Stop… → Naar` (often a round trip back to AMS).
Dates may be ranges ("20-21 jan 2022") — take the start date, keep the original in `note`.

Sample rows:

| Datum | Van | Stop 1 | Stop 2 | Naar | Passagiers | Aanvrager |
|-------|-----|--------|--------|------|-----------|-----------|
| 13 jan 2022 | AMS | BER | | AMS | 8 | AZ |
| 1-2 feb 2022 | AMS | KBP | KIV | AMS | 16 | AZ |

Normalized output:

```json
{
  "source": "PH-GOV vluchten (xlsx)",
  "defaults": { "freq_basis": "actual" },
  "flights": [
    { "route": ["AMS", "BER", "AMS"], "date": "2022-01-13", "pax": 8, "operator": "AZ" },
    { "route": ["AMS", "KIV", "AMS"], "date": "2022-02-01", "pax": 16, "operator": "AZ",
      "note": "1-2 feb 2022; via KBP" }
  ]
}
```
````

- [ ] **Step 5: Create the PDF example**

Create `skills/cns-import-flights/examples/ph-gov-pdf.md`:

````markdown
# Example: PH-GOV quarterly PDF (dash-joined route string)

The `Bestemming/Route` column is one string: `AMS-LUZ-AMS`,
`AMS-LUN-WKF-(CPT)-WKF-CPT-NBO-AMS`. Parentheses `(XXX)` mark an empty
positioning leg. Passengers are per-leg ("19 heen / 18 tussen / 13 retour").
Split the route on `-`; a parenthesised code is still a visited airport — list
it and mark it in `positioning`.

Sample rows:

| Datum | Bestemming/Route | Aantal passagiers | Aanvrager |
|-------|------------------|-------------------|-----------|
| 1 - 3 oktober 2023 | AMS-LUZ-AMS | 4 | BuZa |
| 13 oktober 2023 | (AMS)-KIV-AMS | 0 heen / 7 retour | AZ |

Normalized output:

```json
{
  "source": "PH-GOV overzicht Q4 2023 (pdf)",
  "defaults": { "freq_basis": "actual" },
  "flights": [
    { "route": ["AMS", "LUZ", "AMS"], "date": "2023-10-01", "operator": "BuZa",
      "note": "1 - 3 oktober 2023" },
    { "route": ["AMS", "KIV", "AMS"], "date": "2023-10-13", "operator": "AZ",
      "positioning": [true, false, false], "note": "(AMS) outbound was positioning" }
  ]
}
```
````

- [ ] **Step 6: Create the SKILL.md**

Create `skills/cns-import-flights/SKILL.md`:

```markdown
---
name: cns-import-flights
description: Use when a user wants to import an external flight history (xlsx, PDF, CSV, or pasted text) into the NRG2fly Charging Network Simulator. Interprets the source into normalized JSON, posts it to the CNS import API, and returns a shareable /s/<slug> link that opens the routes in the Demand Calculator.
---

# CNS Flight-Data Import

Turn any provider's flight history into a CNS build-share link.

## Step 1 — Clarify first (before reading anything)

Do NOT parse the file yet. Ask the user only the questions you cannot infer from
their request, then wait for answers. This avoids wasting tokens parsing the
wrong thing:

- Which file(s)? For a multi-sheet workbook or multi-table PDF, which sheet/section holds the flights?
- Default electric aircraft + charger to assign? (Default `beta_plane`; the viewer can change it in the DC.)
- Frequency basis: `actual` (real average rate — default) or `regular` (1 flight/week per route)?
- Keep positioning / empty ferry legs as waypoints, or drop them?
- Any rows to exclude (e.g. technical or positioning-only flights)?
- Scope — everything, or a specific quarter/year?
- The CNS base URL + import token, if not already configured.

## Step 2 — Interpret the source → normalized JSON

Read the file and produce JSON matching `schema.json` (bundled here). Codes stay
verbatim (IATA/ICAO/military) — the server resolves coordinates, so never invent
lat/lon. One entry per real flight; do NOT aggregate (the server does). See
`examples/ph-gov-xlsx.md` and `examples/ph-gov-pdf.md` for the two common shapes.
Validate your JSON against `schema.json` before posting.

## Step 3 — Post to the import API

```
POST {base_url}/api/import
Authorization: Bearer {import_token}
Content-Type: application/json

{ ...the normalized JSON... }
```

`base_url` defaults to `https://cns.nrg2fly.nl`. The token is a shared secret the
user provides once.

## Step 4 — Report back

On `200`, return the `url` and translate the `report` into plain language, e.g.:
"Imported 53 routes from 216 flights. 9 dropped (7 codes unresolved: ADW, ZZA…).
31 legs are infeasible for the Beta default — switch the aircraft in the DC to
test electrifying them. Open: <url>".

Handle errors: `401` = bad/missing token; `400` = the JSON didn't match the
schema (fix and retry); `413` = too many routes to share in one link.
```

- [ ] **Step 7: Create the README (install + distribution)**

Create `skills/cns-import-flights/README.md`:

```markdown
# cns-import-flights

A portable Claude skill that imports external flight histories into the NRG2fly
Charging Network Simulator and returns a shareable Demand-Calculator link.

## Install

Copy this `cns-import-flights/` directory into your Claude skills location (e.g.
a plugin's `skills/`, or `~/.claude/skills/`), or package it as a plugin and
install that. No access to the CNS codebase is required.

## Configure (once)

Provide the skill with:
- `base_url` — defaults to `https://cns.nrg2fly.nl`.
- `import_token` — the shared `CNS_IMPORT_TOKEN` secret (ask the CNS admin).

## Use

Point Claude at a flight file ("import these PH-GOV flights into the DC"). The
skill asks a few clarifying questions, interprets the file, posts it, and hands
back the `/s/<slug>` link.

## Contract

The skill's only output is normalized JSON (`schema.json`); the CNS server does
all resolution, trip-typing, aggregation and link creation. A new provider only
exercises this skill — never the server.
```

- [ ] **Step 8: Run the example test to verify it passes**

Run: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python -m unittest tests.test_skill_examples -v`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add skills/cns-import-flights tests/test_skill_examples.py
git commit -m "feat(import): portable cns-import-flights skill + schema + examples"
```

---

## Self-Review

**1. Spec coverage:**
- Normalized schema (spec Component 1) → `schema.json` (Task 5) + `validate_normalized` (Task 3). ✅
- Code→coords via global airports.csv (Component 2.1) → Task 1. ✅
- Trip classification (2.2) → Task 2. ✅
- Aggregation + frequency `actual`/`regular` + no-date fallback (2.3) → Task 3 (`BuildBlobTest`). ✅
- Default plane/charger fallback (2.4) → Task 3 (`test_unknown_default_plane…`). ✅
- Blob assembly + `MAX_STATE_BYTES` (2.5, Component 3) → Task 3 + Task 4 (413). ✅
- Endpoint + Bearer token + `_PUBLIC_ENDPOINTS` (Component 3) → Task 4. ✅
- Report incl. `infeasible_for_default` range pre-check (Report) → Task 3 + Task 4. ✅
- Portable skill: clarify-first, interpret, post, report; bundled schema + two examples (Component 4) → Task 5. ✅
- Testing (server unittest + skill sample-driven) → Tasks 1–5; the example test binds skill output to the server contract. ✅

**2. Placeholder scan:** Every code step shows complete code; every test step has the command + expected result. No TBD/TODO. ✅

**3. Type consistency:**
- `resolve(code) -> {'ident','name','lat','lon'}` — produced in Task 1, consumed identically in Task 3 (`_pt` reads `ident/name/lat/lon`) and Task 4. ✅
- `classify_trip -> {'t','o','d','s'}` — Task 2, consumed in Task 3's `build_blob`. ✅
- `build_blob(payload, resolve, planes_by_id) -> (blob, report)` — Task 3, called identically in Task 4 and Task 5's test. ✅
- Blob point shape `{i,la,lo,n}` and entry `{id,p,c,t,fn,fu,o,d,s?}` match the Global Constraints and the build-share format. ✅
- `report` keys (`flights_in, routes_out, dropped, unresolved_codes, infeasible_for_default, freq_basis_used`) identical in Task 3 producer and Task 4 test assertions. ✅

No gaps found.
