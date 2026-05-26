import math
import json
import pandas as pd
import argparse
import os

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
                               'latitude_deg', 'longitude_deg', 'iso_country']]
        # Convert to list of dicts
        return df.to_dict('records')

    def get_airport(self, code_or_name):
        matches = self.airports_df[
            self.airports_df['name'].str.contains(code_or_name, case=False, na=False) |
            self.airports_df['municipality'].str.contains(code_or_name, case=False, na=False)
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

        if charger_obj:
            try:
                charger = {**charger, "power_kw": float(charger["power_kw"])}
            except (KeyError, TypeError, ValueError):
                return {"error": "Custom charger needs a numeric power."}
            if not (charger["power_kw"] > 0):
                return {"error": "Custom charger power must be positive."}

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
                "id": plane['id'],
                "name": plane['name'],
                "seats": plane.get('seats'),
                "load_kg": plane.get('load_kg'),
                "battery_kwh": plane['battery_kwh'],
                "range_km": plane['range_km'],
                "speed_kmh": plane['speed_kmh'],
                "avg_usage_kwh_per_100km": round(avg_usage, 2),
                "image": plane.get('image'),
                "svg": plane.get('svg')
            },
            "charger": {
                "id": charger['id'],
                "name": charger['name'],
                "power_kw": charger['power_kw']
            }
        }

    def simulate_by_coords(self, plane_id, origin, destination, charger_id, trip_type="one-way", plane_obj=None, charger_obj=None):
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
