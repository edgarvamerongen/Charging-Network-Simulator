import math
import json
import re
import pandas as pd
import argparse
import os

# ICAO codes are 4 alphanumerics (e.g. EHAM, LFPG); IATA codes are 3 letters
# (e.g. CDG, AMS). When the user types one we want an exact ident match, not
# a substring search against airport names — otherwise "EHAM" matches
# "MariEHAMn Airport" before it matches Schiphol.
_AIRPORT_CODE_RE = re.compile(r'^[A-Za-z0-9]{3,4}$')

def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0  # Earth radius in kilometers
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

class Simulator:
    def __init__(self, base_dir="."):
        planes_file = os.path.join(base_dir, "planes.json")
        chargers_file = os.path.join(base_dir, "chargers.json")
        airports_file = os.path.join(base_dir, "european_airports.csv")
        
        with open(planes_file, 'r') as f:
            self.planes = json.load(f)
        with open(chargers_file, 'r') as f:
            self.chargers = json.load(f)
        
        # Replace NaNs with empty string so JSON serialization doesn't fail
        self.airports_df = pd.read_csv(airports_file).fillna("")

    def get_all_airports(self):
        # We'll return just enough data for the map + autocomplete to reduce payload size
        df = self.airports_df[['ident', 'name', 'municipality', 'iata_code', 'type',
                               'latitude_deg', 'longitude_deg', 'iso_country',
                               'alternate_km', 'alternate_ident']]
        # Convert to list of dicts
        return df.to_dict('records')

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
            exact = self.airports_df[self.airports_df['ident'].str.upper() == q_upper]
            if not exact.empty:
                return exact.iloc[0]
            iata = self.airports_df[self.airports_df['iata_code'].str.upper() == q_upper]
            if not iata.empty:
                return iata.iloc[0]
        # Fall back to the original name / municipality substring search.
        matches = self.airports_df[
            self.airports_df['name'].str.contains(q, case=False, na=False) |
            self.airports_df['municipality'].str.contains(q, case=False, na=False)
        ]
        if matches.empty:
            return None
        return matches.iloc[0]

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
            avg_usage = plane['battery_kwh'] / plane['range_km'] * 100
            raw_energy = avg_usage * training_range / 100               # what the pattern would cost at cruise
            min_landing_soc = float(plane.get('min_landing_soc') or 0)
            usable = plane['battery_kwh'] * (1.0 - min_landing_soc)     # the most the plane can use in one session
            recharge_energy = min(raw_energy, usable)
            flight_time_h = training_range / plane['speed_kmh']
            charge_time_h = recharge_energy / charger['power_kw']
            return {
                "success": True,
                "trip_type": "training",
                "legs": 1,
                "leg_distance_km": round(training_range, 2),
                "total_distance_km": round(training_range, 2),
                "training_range_km": round(training_range, 2),
                "avg_usage_kwh_per_100km": round(avg_usage, 2),
                "leg_energy_kwh": round(recharge_energy, 2),
                "recharge_energy_kwh": round(recharge_energy, 2),
                "raw_pattern_energy_kwh": round(raw_energy, 2),         # uncapped, for transparency
                "flight_time_h": round(flight_time_h, 2),
                "charge_time_h": round(charge_time_h, 3),
                "charge_time_min": round(charge_time_h * 60, 1),
                "plane": {
                    "id": plane.get('id'), "name": plane.get('name'),
                    "seats": plane.get('seats'), "load_kg": plane.get('load_kg'),
                    "battery_kwh": plane['battery_kwh'], "range_km": plane['range_km'], "speed_kmh": plane['speed_kmh'],
                    "avg_usage_kwh_per_100km": round(avg_usage, 2),
                    "min_landing_soc": plane.get('min_landing_soc'),
                    "c_rate": plane.get('c_rate'),                       # battery charge C-rate (charging-curve model factor)
                    "training_range_km": training_range,
                    "image": plane.get('image'), "svg": plane.get('svg'),
                },
                "charger": {
                    "id": charger.get('id'), "name": charger.get('name'), "power_kw": charger['power_kw'],
                }
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

        # Average consumption expressed per 100 km of flight.
        avg_usage = plane['battery_kwh'] / plane['range_km'] * 100  # kWh / 100km
        leg_energy = avg_usage * distance_km / 100                  # energy used on one leg

        # Energy the destination charger must deliver per flight:
        #  - one-way:    plane ends its journey here, so recharge the leg it just flew (back to full).
        #  - round-trip: plane departs home at 100%. If the battery covers both legs it returns on
        #                its remaining charge and recharges at home, so the destination supplies
        #                nothing. Otherwise the destination supplies only the deficit to get back.
        if trip_type == "retour":
            recharge_energy = max(0.0, 2 * leg_energy - plane['battery_kwh'])
        else:
            recharge_energy = leg_energy

        total_distance = distance_km * legs
        flight_time_h = total_distance / plane['speed_kmh']
        charge_time_h = recharge_energy / charger['power_kw']

        return {
            "success": True,
            "trip_type": trip_type,
            "legs": legs,
            "leg_distance_km": round(distance_km, 2),
            "total_distance_km": round(total_distance, 2),
            "avg_usage_kwh_per_100km": round(avg_usage, 2),
            "leg_energy_kwh": round(leg_energy, 2),
            "recharge_energy_kwh": round(recharge_energy, 2),
            "flight_time_h": round(flight_time_h, 2),
            "charge_time_h": round(charge_time_h, 3),
            "charge_time_min": round(charge_time_h * 60, 1),
            "plane": {
                "id": plane.get('id'),
                "name": plane.get('name'),
                "seats": plane.get('seats'),
                "load_kg": plane.get('load_kg'),
                "battery_kwh": plane['battery_kwh'],
                "range_km": plane['range_km'],
                "speed_kmh": plane['speed_kmh'],
                "avg_usage_kwh_per_100km": round(avg_usage, 2),
                "min_landing_soc": plane.get('min_landing_soc'),     # used by CNSSettings.usableFraction (per-aircraft override)
                "c_rate": plane.get('c_rate'),                       # battery charge C-rate (charging-curve model factor)
                "image": plane.get('image'),
                "svg": plane.get('svg')
            },
            "charger": {
                "id": charger.get('id'),
                "name": charger.get('name'),
                "power_kw": charger['power_kw']
            }
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
            batt  = float(plane['battery_kwh'])
            rng   = float(plane['range_km'])
            spd   = float(plane['speed_kmh'])
            power = float(charger['power_kw'])
        except (KeyError, TypeError, ValueError):
            return {"error": "Plane/charger needs numeric battery, range, speed and power."}
        if not (batt > 0 and rng > 0 and spd > 0 and power > 0):
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
        avg_usage       = batt / rng * 100
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
            "avg_usage_kwh_per_100km": round(avg_usage, 2),
            "leg_energy_kwh": round(leg_out_energy, 2),
            "legs_count": len(legs),
            "origin": {"name": origin['name'], "lat": origin['lat'], "lon": origin['lon']},
            "destination": {"name": destination['name'], "lat": destination['lat'], "lon": destination['lon']},
            "plane": {
                "id": plane.get('id'), "name": plane.get('name'),
                "seats": plane.get('seats'), "load_kg": plane.get('load_kg'),
                "battery_kwh": plane['battery_kwh'], "range_km": plane['range_km'], "speed_kmh": plane['speed_kmh'],
                "avg_usage_kwh_per_100km": round(avg_usage, 2),
                "min_landing_soc": plane.get('min_landing_soc'),     # for CNSSettings per-aircraft override
                "c_rate": plane.get('c_rate'),                       # battery charge C-rate (charging-curve model factor)
                "image": plane.get('image'), "svg": plane.get('svg')
            },
            "charger": {"id": charger.get('id'), "name": charger.get('name'), "power_kw": charger['power_kw']},
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

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Charging Network Simulator")
    parser.add_argument("--plane", type=str, required=True, help="Plane ID")
    parser.add_argument("--origin", type=str, required=True, help="Origin Airport Name/City")
    parser.add_argument("--dest", type=str, required=True, help="Destination Airport Name/City")
    parser.add_argument("--charger", type=str, required=True, help="Charger ID")
    parser.add_argument("--trip", type=str, default="one-way", choices=["one-way", "retour"])
    args = parser.parse_args()

    sim = Simulator()
    res = sim.simulate(args.plane, args.origin, args.dest, args.charger, args.trip)
    import pprint
    pprint.pprint(res)
