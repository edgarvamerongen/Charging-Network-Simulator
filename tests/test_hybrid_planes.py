"""Hybrid aircraft: battery_kwh is OPTIONAL — absent means non-charging.

notion_sync may emit planes without a battery (propulsion contains 'hybrid');
the engine treats them as zero charging demand: the flight itself runs on
range_km/speed_kmh, every charge figure is 0 and avg_usage is null (fuel does
the work — we don't model it). These tests pin that contract on the Python
side (sim.py); the JS twin lives in js_flight_model.test.mjs.
"""
import json
import os
import tempfile
import unittest

from _helpers import make_sim, coord

# What a synced no-battery hybrid looks like in data/planes.generated.json:
# no battery_kwh KEY at all (never null) — see notion_sync.build_entries.
HYBRID = {"id": "hyb_test", "name": "HyBird 9", "seats": 9,
          "range_km": 800, "speed_kmh": 500, "propulsion": "hybrid electric"}


class NonChargingHybridSimTest(unittest.TestCase):
    def setUp(self):
        self.sim = make_sim()
        self.sim.planes.append(dict(HYBRID))

    def test_one_way_draws_nothing(self):
        r = self.sim.simulate_by_coords("hyb_test", coord("EHAM"), coord("EHRD"),
                                        "aircraft_charger")
        self.assertTrue(r.get("success"), r)
        self.assertEqual(r["recharge_energy_kwh"], 0)
        self.assertEqual(r["charge_time_min"], 0)
        self.assertIsNone(r["avg_usage_kwh_per_100km"])
        self.assertIsNone(r["plane"]["battery_kwh"])
        self.assertGreater(r["flight_time_h"], 0)          # the flight itself is real

    def test_retour_draws_nothing(self):
        r = self.sim.simulate_by_coords("hyb_test", coord("EHAM"), coord("EHRD"),
                                        "aircraft_charger", trip_type="retour")
        self.assertTrue(r.get("success"), r)
        self.assertEqual(r["recharge_energy_kwh"], 0)
        self.assertEqual(r["charge_time_min"], 0)

    def test_multi_leg_all_charges_zero(self):
        r = self.sim.simulate_by_coords("hyb_test", coord("EHAM"), coord("EGLL"),
                                        "aircraft_charger", stops=[coord("EHRD")])
        self.assertTrue(r.get("success"), r)
        self.assertEqual(r["total_recharge_energy_kwh"], 0)
        self.assertEqual(r["total_charge_time_min"], 0)
        self.assertTrue(all(c["energy_kwh"] == 0 for c in r["charges"]))
        self.assertIsNone(r["avg_usage_kwh_per_100km"])

    def test_range_still_gates_legs(self):
        # No battery does NOT mean infinite reach — range_km still applies.
        far = {"name": "Far South", "lat": 30.0, "lon": 4.76}   # ~2,500 km from EHAM
        r = self.sim.simulate_by_coords("hyb_test", coord("EHAM"), far,
                                        "aircraft_charger")
        self.assertIn("error", r)
        self.assertIn("exceeds", r["error"])


class FleetOrderTest(unittest.TestCase):
    def test_no_battery_planes_sort_last(self):
        # Battery-ascending fleet order, but battery-LESS planes go last: for a
        # charging tool they are the least relevant, and `or 0` would wrongly
        # rank them before the smallest real pack.
        s = make_sim()
        cat = [
            {"id": "hyb",   "name": "H", "range_km": 800,  "speed_kmh": 500},
            {"id": "big",   "name": "B", "battery_kwh": 14000, "range_km": 1000, "speed_kmh": 700},
            {"id": "small", "name": "S", "battery_kwh": 22,    "range_km": 87,   "speed_kmh": 148},
        ]
        with tempfile.TemporaryDirectory() as td:
            p = os.path.join(td, "planes.generated.json")
            with open(p, "w", encoding="utf-8") as f:
                json.dump(cat, f)
            s._generated_planes_path = p
            data = s._read_generated()
        self.assertIsNotNone(data, "battery-less plane must not invalidate the catalog shape")
        self.assertEqual([x["id"] for x in data], ["small", "big", "hyb"])


if __name__ == "__main__":
    unittest.main()
