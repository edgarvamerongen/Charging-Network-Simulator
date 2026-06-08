"""
Shared helpers for the Charging Network Simulator test suite.

Pure stdlib. Provides:
  - REPO_ROOT and a Simulator factory rooted there.
  - An independent reference haversine (a deliberately separate implementation
    so the tests don't just re-assert sim.py against itself).
  - Known airport coordinates (lifted from european_airports.csv) and the
    great-circle distances they imply, computed by the reference haversine.
  - Reference plane / charger dicts mirroring planes.json / chargers.json.
"""
import math
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Make `import sim` work regardless of the CWD unittest is launched from.
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)


def ref_haversine(lat1, lon1, lat2, lon2):
    """Independent great-circle distance in km (R = 6371). Structured
    differently from sim.haversine on purpose, to catch a genuine regression
    rather than tautologically agreeing with the implementation under test."""
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(a)))


# Coordinates copied verbatim from european_airports.csv (latitude_deg, longitude_deg).
AIRPORTS = {
    "EHAM": (52.308601, 4.76389),    # Amsterdam Schiphol
    "LFPG": (49.00896, 2.554117),    # Paris Charles de Gaulle
    "EGLL": (51.470748, -0.459909),  # London Heathrow
    "EHGG": (53.119107, 6.577652),   # Groningen Eelde
    "EHRD": (51.956902, 4.43722),    # Rotterdam The Hague
}


def dist(a, b):
    return ref_haversine(*AIRPORTS[a], *AIRPORTS[b])


def coord(code, name=None):
    """Build the {name, lat, lon} dict the coords API path expects."""
    lat, lon = AIRPORTS[code]
    return {"name": name or code, "lat": lat, "lon": lon}


# Reference catalog entries — an explicit mirror of planes.json. These are the
# numbers the physics assertions derive their expected values from, so they MUST
# be kept in lockstep with planes.json: when a headline number changes in the
# catalog (e.g. Beta 500 km -> 600 km, Velis training_range 70 -> 100 km), bump
# it here too. TestReferenceCatalogSync (test_sim_core.py) fails loudly if they
# drift, naming the field, so a stale constant never masquerades as a sim.py bug.
VELIS = {"id": "pipistrel_velis", "name": "Velis Electro", "seats": 2,
         "battery_kwh": 22, "range_km": 100, "speed_kmh": 150, "training_range_km": 100}
BETA = {"id": "beta_plane", "name": "Beta Alia CX300", "seats": 6, "load_kg": 500,
        "battery_kwh": 225, "range_km": 600, "speed_kmh": 250}
VAERIDION = {"id": "vaeridion", "name": "Vaeridion", "seats": 9, "load_kg": 1000,
             "battery_kwh": 600, "range_km": 600, "speed_kmh": 400}

CHARGER_172 = {"id": "aircraft_charger", "name": "Aircraft Charger", "power_kw": 172}
CHARGER_22 = {"id": "mobile_aircraft", "name": "Mobile Aircraft Charger (GB/T)", "power_kw": 22}
CHARGER_400 = {"id": "ccs", "name": "CCS", "power_kw": 400}


def make_sim():
    from sim import Simulator
    s = Simulator(base_dir=REPO_ROOT)
    # The DC-charger catalog rework (chargers.json) dropped the legacy 172 kW
    # "aircraft_charger" that these tests pin their charge-time assertions to.
    # Re-inject it as a TEST fixture so the suite stays charger-stable; the
    # production catalog is untouched.
    for ref in (CHARGER_172, CHARGER_22, CHARGER_400):
        if not any(c.get('id') == ref['id'] for c in s.chargers):
            s.chargers.append(dict(ref))
    return s
