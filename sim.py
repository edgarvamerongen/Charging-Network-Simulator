import math
import json
import re
import csv
import sys
import os
import threading

# ICAO codes are 4 alphanumerics (e.g. EHAM, LFPG); IATA codes are 3 letters
# (e.g. CDG, AMS). When the user types one we want an exact ident match, not
# a substring search against airport names — otherwise "EHAM" matches
# "MariEHAMn Airport" before it matches Schiphol.
_AIRPORT_CODE_RE = re.compile(r'^[A-Za-z0-9]{3,4}$')

# Airport CSV columns consumers do arithmetic on; every other column stays the
# string the file holds. An empty cell stays "" in both cases.
_AIRPORT_FLOAT_COLS = frozenset((
    'latitude_deg', 'longitude_deg', 'alternate_km',
    'rwy_paved_m', 'rwy_grass_m', 'rwy_gravel_m',
    'rwy_dirt_m', 'rwy_water_m', 'rwy_unknown_m'))

def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0  # Earth radius in kilometers
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

def _plane_summary(plane, avg_usage, training_range_km=None):
    """The "plane" block every simulate response carries — identical keys for
    training, single-leg and multi-leg."""
    out = {
        "id": plane.get('id'),
        "name": plane.get('name'),
        "seats": plane.get('seats'),
        "load_kg": plane.get('load_kg'),
        "battery_kwh": plane.get('battery_kwh'),
        "range_km": plane['range_km'],
        "speed_kmh": plane['speed_kmh'],
        "avg_usage_kwh_per_100km": round(avg_usage, 2) if avg_usage is not None else None,
        "min_landing_soc": plane.get('min_landing_soc'),     # used by CNSSettings.usableFraction (per-aircraft override)
    }
    if training_range_km is not None:
        out["training_range_km"] = training_range_km
    out["image"] = plane.get('image')
    out["svg"] = plane.get('svg')
    return out

def _charger_summary(charger):
    return {"id": charger.get('id'), "name": charger.get('name'), "power_kw": charger['power_kw']}

class Simulator:
    def __init__(self, base_dir="."):
        self.base_dir = base_dir
        chargers_file = os.path.join(base_dir, "chargers.json")
        # Airports: the world set (prepare_world.py) when it is there, else the European one. The
        # European file also stays loaded on its own: /api/airports serves it to the classic and
        # mobile views, which are Europe-only. CNS_AIRPORTS_FILE pins one file for both (the tests
        # pin european_airports.csv, so a world rebuild can't move them).
        self._europe_file = os.path.join(base_dir, "european_airports.csv")
        world_file = os.path.join(base_dir, "world_airports.csv")
        airports_file = (os.environ.get("CNS_AIRPORTS_FILE")
                         or (world_file if os.path.exists(world_file) else self._europe_file))

        # Aircraft catalog: the Notion-synced data/planes.generated.json is the
        # single source of truth (see NOTION_CATALOG_PLAN.md). There is no
        # planes.json fallback — a missing catalog fails fast with an actionable
        # error rather than silently serving stale data. CNS_PLANES_FILE points it
        # elsewhere: the test suite pins tests/fixtures/planes.fixture.json this way.
        self._generated_planes_path = (os.environ.get("CNS_PLANES_FILE")
                                       or os.path.join(base_dir, "data", "planes.generated.json"))
        self._planes_lock = threading.Lock()
        self._gen_seen_mtime = None
        self.planes = self._load_planes()

        with open(chargers_file, 'r') as f:
            self.chargers = json.load(f)

        self.airports = self._read_airports(airports_file)
        self._europe = (self.airports if os.path.abspath(airports_file) == os.path.abspath(self._europe_file)
                        else None)   # read on first /api/airports
        # ident / iata -> record: lookups are dict hits, not scans over ~48,000 rows
        self._by_ident = {r['ident'].upper(): r for r in self.airports if r.get('ident')}
        self._by_iata = {}
        for r in self.airports:
            if r.get('iata_code'):
                self._by_iata.setdefault(r['iata_code'].upper(), r)

    # The columns anything reads (lookups, /api/simulate, the map lists, the report): the full OurAirports row
    # held for ~48,000 airports cost ~90 MB per worker.
    _AIRPORT_KEEP = frozenset((
        'ident', 'name', 'municipality', 'iata_code', 'icao_code', 'gps_code', 'type', 'latitude_deg', 'longitude_deg',
        'elevation_ft', 'continent', 'iso_country', 'iso_region', 'alternate_km', 'alternate_ident',
        'rwy_paved_m', 'rwy_grass_m', 'rwy_gravel_m', 'rwy_dirt_m', 'rwy_water_m', 'rwy_unknown_m'))

    @classmethod
    def _read_airports(cls, path):
        # Empty cells stay "" so JSON serialization doesn't fail
        with open(path, newline='', encoding='utf-8') as f:
            return [
                {k: (float(v) if v and k in _AIRPORT_FLOAT_COLS else sys.intern(v) if k in ('type', 'continent', 'iso_country') else v)
                 for k, v in row.items() if k in cls._AIRPORT_KEEP}
                for row in csv.DictReader(f, restval="")
            ]

    # -- aircraft catalog loading -------------------------------------------
    # battery_kwh is deliberately NOT required: hybrids may omit it entirely,
    # which every consumer reads as "non-charging aircraft" (0 kWh demand).
    _REQUIRED_PLANE_KEYS = ("id", "name", "range_km", "speed_kmh")

    @classmethod
    def _valid_planes(cls, data):
        """A usable catalog is a non-empty list of dicts that each carry the
        three fields the engine divides/multiplies on (plus id/name)."""
        return isinstance(data, list) and len(data) > 0 and all(
            isinstance(p, dict) and all(k in p for k in cls._REQUIRED_PLANE_KEYS)
            for p in data)

    def _read_generated(self):
        """Parsed generated catalog if present and shape-valid, else None."""
        try:
            with open(self._generated_planes_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return None
        if not self._valid_planes(data):
            return None
        # Fleet display order = battery capacity, smallest first. This is the
        # single source of truth for plane order across desktop, mobile and the
        # API (the picker carousel/strip and #plane select all follow this list).
        # Stable sort, so equal-capacity aircraft keep their Notion creation order.
        # No-battery hybrids (non-charging) sort LAST — least relevant to a
        # charging-demand tool, and 0 would wrongly rank them before the Velis.
        data.sort(key=lambda p: (p.get("battery_kwh") is None,
                                 float(p.get("battery_kwh") or 0)))
        return data

    def _load_planes(self):
        gen = self._read_generated()
        if gen is None:
            raise RuntimeError(
                f"No aircraft catalog at {self._generated_planes_path}. Run "
                f"notion_sync.py to generate it (or restore data/snapshots/…); "
                f"see CLAUDE.md > Data for the local sync. Without Notion access: "
                f"CNS_PLANES_FILE=tests/fixtures/planes.fixture.json")
        try:
            self._gen_seen_mtime = os.path.getmtime(self._generated_planes_path)
        except OSError:
            self._gen_seen_mtime = None
        return gen

    def maybe_reload_planes(self):
        """Cheap per-request refresh: when data/planes.generated.json changes
        (an out-of-band notion_sync.py run), swap the in-memory catalog.

        gunicorn runs multiple workers, so a sync can't reach into each worker —
        instead every worker notices the new mtime on its next request. A stat is
        ~microseconds, so the load-once/no-per-request-IO property effectively
        survives. Never raises; keeps the current catalog on any error.
        """
        try:
            mtime = os.path.getmtime(self._generated_planes_path)
        except OSError:
            return  # no generated file yet — stay on the current catalog
        if mtime == self._gen_seen_mtime:
            return
        with self._planes_lock:
            if mtime == self._gen_seen_mtime:  # re-check under lock
                return
            # Mark this mtime examined (even if it turns out invalid) so we don't
            # re-read an unchanged bad file on every subsequent request.
            self._gen_seen_mtime = mtime
            data = self._read_generated()
            if data is not None:
                self.planes = data

    def get_all_airports(self, world=False):
        """The airport list for the map + autocomplete. Europe by default (/api/airports: the classic and
        mobile views); world=True is the full set sim.py plans with (None of the European file
        when the world set is loaded)."""
        rows = self.airports if world else self._europe_rows()
        # We'll return just enough data for the map + autocomplete to reduce payload size.
        # rwy_*_m = longest OPEN runway per surface category (airport-card display);
        # selected defensively so an older CSV without them can't 500 the endpoint.
        wanted = ['ident', 'name', 'municipality', 'iata_code', 'type',
                  'latitude_deg', 'longitude_deg', 'iso_country',
                  'alternate_km', 'alternate_ident',
                  'rwy_paved_m', 'rwy_grass_m', 'rwy_gravel_m',
                  'rwy_dirt_m', 'rwy_water_m', 'rwy_unknown_m']
        return [{k: r[k] for k in wanted if k in r} for r in rows]

    def _europe_rows(self):
        if self._europe is None:
            self._europe = self._read_airports(self._europe_file)
        return self._europe

    def get_airport(self, code_or_name):
        q = (code_or_name or "").strip()
        if not q:
            return None
        # If the query looks like an ICAO/IATA code, try an exact ident match
        # first (then iata_code). Falling back to substring would otherwise
        # land on whichever airport happens to contain those letters in its
        # name — see _AIRPORT_CODE_RE doc.
        if _AIRPORT_CODE_RE.match(q):
            q_upper = q.upper()
            hit = self._by_ident.get(q_upper) or self._by_iata.get(q_upper)
            if hit is not None:
                return hit
        # Fall back to the original name / municipality substring search: the European set first, in its own
        # order (the answer it always gave: "Hamburg" is EDDH), then the world's matches, largest field first
        # (else a digit-led US strip sorts ahead of the city's airport).
        q_lower = q.lower()
        hit = lambda r: q_lower in r['name'].lower() or q_lower in r['municipality'].lower()
        eu = next((r for r in self._europe_rows() if hit(r)), None)
        if eu is not None:
            return self._by_ident.get(eu['ident'].upper(), eu)
        rank = {'large_airport': 0, 'medium_airport': 1, 'small_airport': 2}
        return min((r for r in self.airports if hit(r)), key=lambda r: rank.get(r.get('type'), 3), default=None)

    def calculate_flight_by_distance(self, plane_id, distance_km, charger_id, trip_type="one-way", plane_obj=None, charger_obj=None):
        plane = plane_obj if plane_obj else next((p for p in self.planes if p['id'] == plane_id), None)
        charger = charger_obj if charger_obj else next((c for c in self.chargers if c['id'] == charger_id), None)

        if not plane:
            return {"error": f"Plane {plane_id} not found"}
        if not charger:
            return {"error": f"Charger {charger_id} not found"}

        if plane_obj:
            # A user-supplied custom aircraft: validate the numbers we divide by.
            try:
                plane = {**plane,
                         "battery_kwh": float(plane["battery_kwh"]),
                         "range_km": float(plane["range_km"]),
                         "speed_kmh": float(plane["speed_kmh"])}
            except (KeyError, TypeError, ValueError):
                return {"error": "Custom plane needs numeric battery, range and speed."}
            if not (plane["battery_kwh"] > 0 and plane["range_km"] > 0 and plane["speed_kmh"] > 0):
                return {"error": "Custom plane battery, range and speed must be positive."}
            # Defense in depth: app.py's add_custom_plane rejects non-finite
            # and out-of-range values, but a stale data/custom_planes.json from
            # before that check could still reach us. Bail out cleanly rather
            # than overflow downstream (recharge_energy = max(0, 2*leg-batt)
            # blows up for inf and OverflowError leaks to the route).
            if not all(math.isfinite(plane[k]) for k in ("battery_kwh", "range_km", "speed_kmh")):
                return {"error": "Custom plane values must be finite."}

        if charger_obj:
            try:
                charger = {**charger, "power_kw": float(charger["power_kw"])}
            except (KeyError, TypeError, ValueError):
                return {"error": "Custom charger needs a numeric power."}
            if not (charger["power_kw"] > 0):
                return {"error": "Custom charger power must be positive."}

        # Training flights are a closed loop around the origin — they don't have
        # a destination, just a "training_range_km" published per aircraft (e.g.
        # Pipistrel Velis Electro: 112.5 km ≈ 45 min at 150 km/h cruise).
        # Energy delivered is capped at the usable battery (operator-modelled
        # min_landing_soc), since you can't physically extract more than that
        # in a single session.
        if trip_type == "training":
            training_range = plane.get('training_range_km')
            if not training_range or float(training_range) <= 0:
                return {"error": f"{plane.get('name', 'This aircraft')} doesn't have a published training_range_km — training mode unavailable for it."}
            training_range = float(training_range)
            batt = float(plane.get('battery_kwh') or 0)   # absent battery => non-charging hybrid
            if batt > 0:
                avg_usage = batt / plane['range_km'] * 100
                raw_energy = avg_usage * training_range / 100           # what the pattern would cost at cruise
                min_landing_soc = float(plane.get('min_landing_soc') or 0)
                usable = batt * (1.0 - min_landing_soc)                 # the most the plane can use in one session
                recharge_energy = min(raw_energy, usable)
            else:
                avg_usage = None                                        # electric consumption undefined — fuel does the work
                raw_energy = 0.0
                recharge_energy = 0.0
            flight_time_h = training_range / plane['speed_kmh']
            charge_time_h = recharge_energy / charger['power_kw']
            return {
                "success": True,
                "trip_type": "training",
                "legs": 1,
                "leg_distance_km": round(training_range, 2),
                "total_distance_km": round(training_range, 2),
                "training_range_km": round(training_range, 2),
                "avg_usage_kwh_per_100km": round(avg_usage, 2) if avg_usage is not None else None,
                "leg_energy_kwh": round(recharge_energy, 2),
                "recharge_energy_kwh": round(recharge_energy, 2),
                "raw_pattern_energy_kwh": round(raw_energy, 2),         # uncapped, for transparency
                "flight_time_h": round(flight_time_h, 2),
                "charge_time_h": round(charge_time_h, 3),
                "charge_time_min": round(charge_time_h * 60, 1),
                "plane": _plane_summary(plane, avg_usage, training_range_km=training_range),
                "charger": _charger_summary(charger),
            }

        # DELIBERATE: this is the raw catalog range, with no landing reserve /
        # SID-STAR / routing padding applied. Reserves are a frontend "Model
        # settings" concern — the browser re-validates each leg against the
        # padded usable range (static/flight-model.js) BEFORE calling this API
        # and blocks the request if it fails. The backend stays the pure-physics
        # baseline so the two layers never double-count a reserve.
        if distance_km > plane['range_km']:
            return {"error": f"Leg distance {distance_km:.1f}km exceeds plane range {plane['range_km']}km"}

        legs = 2 if trip_type == "retour" else 1

        # Average ELECTRIC consumption per 100 km. A plane without a battery
        # (non-charging hybrid) draws nothing from the network: energy figures
        # are 0 and avg_usage is null — range/speed still drive the flight.
        batt = float(plane.get('battery_kwh') or 0)
        if batt > 0:
            avg_usage = batt / plane['range_km'] * 100              # kWh / 100km
            leg_energy = avg_usage * distance_km / 100              # energy used on one leg
            # Energy the destination charger must deliver per flight:
            #  - one-way:    plane ends its journey here, so recharge the leg it just flew (back to full).
            #  - round-trip: plane departs home at 100%. If the battery covers both legs it returns on
            #                its remaining charge and recharges at home, so the destination supplies
            #                nothing. Otherwise the destination supplies only the deficit to get back.
            if trip_type == "retour":
                recharge_energy = max(0.0, 2 * leg_energy - batt)
            else:
                recharge_energy = leg_energy
        else:
            avg_usage = None
            leg_energy = 0.0
            recharge_energy = 0.0

        total_distance = distance_km * legs
        flight_time_h = total_distance / plane['speed_kmh']
        charge_time_h = recharge_energy / charger['power_kw']

        return {
            "success": True,
            "trip_type": trip_type,
            "legs": legs,
            "leg_distance_km": round(distance_km, 2),
            "total_distance_km": round(total_distance, 2),
            "avg_usage_kwh_per_100km": round(avg_usage, 2) if avg_usage is not None else None,
            "leg_energy_kwh": round(leg_energy, 2),
            "recharge_energy_kwh": round(recharge_energy, 2),
            "flight_time_h": round(flight_time_h, 2),
            "charge_time_h": round(charge_time_h, 3),
            "charge_time_min": round(charge_time_h * 60, 1),
            "plane": _plane_summary(plane, avg_usage),
            "charger": _charger_summary(charger)
        }

    def simulate_by_coords(self, plane_id, origin, destination, charger_id, trip_type="one-way", plane_obj=None, charger_obj=None, stops=None):
        if stops:
            return self._simulate_multi(plane_id, origin, destination, charger_id, trip_type, plane_obj, charger_obj, stops)
        if trip_type == 'circular':
            # Without this guard a stop-less circular would fall through to
            # the single-leg path and silently compute a one-way A→B.
            return {"error": "A circular trip needs at least one intermediate stop. "
                             "For a there-and-back flight, use trip_type='retour'."}
        dist_km = haversine(
            origin['lat'], origin['lon'],
            destination['lat'], destination['lon']
        )

        result = self.calculate_flight_by_distance(plane_id, dist_km, charger_id, trip_type, plane_obj, charger_obj)
        if "error" in result:
            return result

        result.update({
            "origin": {"name": origin['name'], "lat": origin['lat'], "lon": origin['lon']},
            "destination": {"name": destination['name'], "lat": destination['lat'], "lon": destination['lon']}
        })
        return result

    # -----------------------------------------------------------------
    # Multi-leg trip with intermediate charging stops.
    # ─ Walk the waypoint chain, propagating battery state.
    # ─ At each waypoint (except start), charge just enough for the next leg
    #   (i.e. the deficit), unless it's the terminal waypoint where the plane
    #   tops up to full (one-way dest, or retour home).
    # ─ Retour mirrors the stops on the return leg (caller's choice).
    # -----------------------------------------------------------------
    def _simulate_multi(self, plane_id, origin, destination, charger_id, trip_type, plane_obj, charger_obj, stops):
        plane = plane_obj if plane_obj else next((p for p in self.planes if p['id'] == plane_id), None)
        charger = charger_obj if charger_obj else next((c for c in self.chargers if c['id'] == charger_id), None)
        if not plane:   return {"error": f"Plane {plane_id} not found"}
        if not charger: return {"error": f"Charger {charger_id} not found"}

        try:
            # Absent battery = non-charging hybrid: legs fly on range/speed, every
            # charge event computes to 0 (the propagation math below is 0-safe).
            batt  = float(plane.get('battery_kwh') or 0)
            rng   = float(plane['range_km'])
            spd   = float(plane['speed_kmh'])
            power = float(charger['power_kw'])
        except (KeyError, TypeError, ValueError):
            return {"error": "Plane/charger needs numeric battery, range, speed and power."}
        if not (batt >= 0 and rng > 0 and spd > 0 and power > 0):
            return {"error": "Plane/charger values must be positive."}
        # Same defense-in-depth as calculate_flight_by_distance: stop inf/NaN
        # before it reaches the leg-accumulation math below.
        if not all(math.isfinite(v) for v in (batt, rng, spd, power)):
            return {"error": "Plane/charger values must be finite."}

        # Build waypoint chain (caller passes stops in OUTBOUND order)
        outbound = [origin] + list(stops) + [destination]
        if trip_type == 'retour':
            chain = outbound + list(reversed(stops)) + [origin]
        elif trip_type == 'circular':
            chain = outbound + [origin]          # close the ring: O, S1..Sk, D, O
        else:
            chain = outbound

        # Compute legs
        legs = []
        for i in range(len(chain) - 1):
            a, b = chain[i], chain[i + 1]
            d = haversine(a['lat'], a['lon'], b['lat'], b['lon'])
            # Raw catalog range, no reserves — same deliberate split as
            # calculate_flight_by_distance (frontend enforces Model settings).
            if d > rng:
                return {"error": f"Leg {a['name']} → {b['name']} is {d:.0f} km, exceeds range {rng:.0f} km."}
            legs.append({
                "from": {"name": a['name'], "lat": a['lat'], "lon": a['lon']},
                "to":   {"name": b['name'], "lat": b['lat'], "lon": b['lon']},
                "distance_km": round(d, 2),
                "flight_time_h": round(d / spd, 3),
                "energy_kwh": round(batt / rng * d, 2)        # avg_usage × d
            })

        # Propagate battery state through the chain
        arrivals = [batt]
        cur = batt
        for leg in legs:
            cur = max(cur, leg['energy_kwh']) - leg['energy_kwh']
            arrivals.append(round(cur, 4))

        # Per-waypoint charge events (excluding origin)
        n = len(chain)
        if trip_type == 'retour':
            dest_idx = (n - 1) // 2
        elif trip_type == 'circular':
            dest_idx = n - 2                     # last ring node, just before the closing origin
        else:
            dest_idx = n - 1
        charges = []
        for i in range(1, n):
            arrival = arrivals[i]
            is_terminal_final = (i == n - 1)
            if is_terminal_final:
                charge_e = batt - arrival                                # top to full
            else:
                charge_e = max(0.0, legs[i]['energy_kwh'] - arrival)     # enough for next leg
            if trip_type in ('retour', 'circular'):
                role = 'home' if is_terminal_final else ('dest' if i == dest_idx else 'stop')
            else:
                role = 'dest' if is_terminal_final else 'stop'
            charges.append({
                "at_index": i,
                "name": chain[i]['name'],
                "lat":  chain[i]['lat'],
                "lon":  chain[i]['lon'],
                "ident": chain[i].get('ident'),
                "role": role,
                "energy_kwh": round(charge_e, 2),
                "charge_time_h": round(charge_e / power, 3),
                "charge_time_min": round(charge_e / power * 60, 1),
            })

        total_distance  = sum(l['distance_km']    for l in legs)
        total_flight_h  = sum(l['flight_time_h']  for l in legs)
        total_charge_e  = sum(c['energy_kwh']     for c in charges)
        total_charge_m  = sum(c['charge_time_min'] for c in charges)
        avg_usage       = (batt / rng * 100) if batt > 0 else None      # null for non-charging hybrids
        leg_out_energy  = legs[0]['energy_kwh']                          # the original A→B leg, before stops collapse it

        return {
            "success": True,
            "trip_type": trip_type,
            "multi_leg": True,
            "legs": legs,
            "charges": charges,
            "stops": [{"name": s['name'], "lat": s['lat'], "lon": s['lon'], "ident": s.get('ident'), "type": s.get('type')} for s in stops],
            "total_distance_km": round(total_distance, 2),
            "total_flight_time_h": round(total_flight_h, 2),
            "total_charge_time_min": round(total_charge_m, 1),
            "total_recharge_energy_kwh": round(total_charge_e, 2),
            "avg_usage_kwh_per_100km": round(avg_usage, 2) if avg_usage is not None else None,
            "leg_energy_kwh": round(leg_out_energy, 2),
            "legs_count": len(legs),
            "origin": {"name": origin['name'], "lat": origin['lat'], "lon": origin['lon']},
            "destination": {"name": destination['name'], "lat": destination['lat'], "lon": destination['lon']},
            "plane": _plane_summary(plane, avg_usage),
            "charger": _charger_summary(charger),
        }

    def simulate(self, plane_id, origin, destination, charger_id, trip_type="one-way", plane_obj=None, charger_obj=None):
        ap1 = self.get_airport(origin)
        ap2 = self.get_airport(destination)

        if ap1 is None:
            return {"error": f"Origin airport '{origin}' not found."}
        if ap2 is None:
            return {"error": f"Destination airport '{destination}' not found."}

        dist_km = haversine(
            ap1['latitude_deg'], ap1['longitude_deg'],
            ap2['latitude_deg'], ap2['longitude_deg']
        )

        result = self.calculate_flight_by_distance(plane_id, dist_km, charger_id, trip_type, plane_obj, charger_obj)
        if "error" in result:
            return result

        result.update({
            "origin": {
                "name": ap1['name'],
                "lat": ap1['latitude_deg'],
                "lon": ap1['longitude_deg']
            },
            "destination": {
                "name": ap2['name'],
                "lat": ap2['latitude_deg'],
                "lon": ap2['longitude_deg']
            }
        })
        return result
