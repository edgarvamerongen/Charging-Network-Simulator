"""Runway suitability tests (docs/performance-engine.md §7). Stdlib unittest."""
import json
import os
import unittest

import field_performance as fp
import plane_schema

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Vaeridion-like aircraft: TODR 800 m paved / 1000 m grass, paved+grass ok.
VAERIDION = {
    "id": "v", "name": "V", "battery_kwh": 600, "range_km": 500, "speed_kmh": 400,
    "surfaces_ok": ["paved", "grass"],
    "measurements": [
        {"quantity": "takeoff_distance_m", "value": 800, "conditions": {"surface": "paved"}},
        {"quantity": "takeoff_distance_m", "value": 1000, "conditions": {"surface": "grass"}},
    ],
}


def rwy(length_ft, surface, closed="0"):
    return {"length_ft": length_ft, "surface": surface, "closed": closed}


class TestNormalizeSurface(unittest.TestCase):
    def test_categories(self):
        for raw in ("ASP", "ASPH", "CONC", "CON", "PEM", "ASPH-G"):
            self.assertEqual(fp.normalize_surface(raw), "paved", raw)
        for raw in ("TURF", "GRS", "Grass", "GRASS", "TURF-G"):
            self.assertEqual(fp.normalize_surface(raw), "grass", raw)
        self.assertEqual(fp.normalize_surface("GVL"), "gravel")
        self.assertEqual(fp.normalize_surface("DIRT"), "dirt")
        self.assertEqual(fp.normalize_surface("WATER"), "water")
        for raw in ("UNK", "X", "", None):
            self.assertEqual(fp.normalize_surface(raw), "unknown", repr(raw))


class TestAirportSuitability(unittest.TestCase):
    def test_long_paved_ok(self):
        r = fp.airport_suitability(VAERIDION, rwy(3281, "ASP"))  # ~1000 m, need 800*1.15=920
        self.assertTrue(r["operable"])
        self.assertEqual(r["surface"], "paved")

    def test_short_paved_too_short(self):
        r = fp.airport_suitability(VAERIDION, rwy(2625, "ASP"))  # ~800 m < 920
        self.assertFalse(r["operable"])
        self.assertEqual(r["limiting_factor"], "too_short")

    def test_grass_needs_more(self):
        r = fp.airport_suitability(VAERIDION, rwy(3281, "TURF"))  # ~1000 m, grass needs 1000*1.15=1150
        self.assertFalse(r["operable"])
        self.assertEqual(r["limiting_factor"], "too_short")

    def test_wrong_surface(self):
        r = fp.airport_suitability(VAERIDION, rwy(5000, "GVL"))
        self.assertFalse(r["operable"])
        self.assertEqual(r["limiting_factor"], "wrong_surface")

    def test_closed(self):
        r = fp.airport_suitability(VAERIDION, rwy(5000, "ASP", closed="1"))
        self.assertFalse(r["operable"])
        self.assertEqual(r["limiting_factor"], "closed")

    def test_no_distance_data_is_unknown(self):
        velis = {"id": "p", "name": "P", "battery_kwh": 22, "range_km": 87.5, "speed_kmh": 150,
                 "surfaces_ok": ["paved", "grass"]}
        r = fp.airport_suitability(velis, rwy(3281, "ASP"))
        self.assertIsNone(r["operable"])
        self.assertEqual(r["limiting_factor"], "no_distance_data")

    def test_reads_real_catalog_plane(self):
        with open(os.path.join(REPO, "planes.json")) as f:
            planes = json.load(f)
        vaer = next(p for p in planes if plane_schema.value(p, "id") == "vaeridion")
        self.assertTrue(fp.airport_suitability(vaer, rwy(4000, "ASP"))["operable"])


if __name__ == "__main__":
    unittest.main()
