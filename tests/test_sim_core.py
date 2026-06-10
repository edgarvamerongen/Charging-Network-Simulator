"""
Unit tests on sim.Simulator (imported directly — no HTTP).

Covers one-way / retour / training energy, time and charge time; the retour
deficit branch (both sub-cases); the haversine; over-range rejection; and the
training-without-training_range_km error path.

All expected numbers are derived here from the documented formulas, then
compared against what the simulator returns. Where sim.py rounds to 2 dp we
assert with an absolute tolerance so rounding alone never fails a test.
"""
import math
import unittest

from _helpers import (make_sim, ref_haversine, dist, coord, AIRPORTS,
                      VELIS, BETA, VAERIDION, CHARGER_172, CHARGER_22, CHARGER_400)


class TestHaversine(unittest.TestCase):
    def test_known_city_pairs(self):
        from sim import haversine
        # AMS <-> CDG is the spec's reference (~398 km).
        d = haversine(*AIRPORTS["EHAM"], *AIRPORTS["LFPG"])
        self.assertAlmostEqual(d, dist("EHAM", "LFPG"), places=3)
        self.assertAlmostEqual(d, 398.55, delta=1.0)

    def test_symmetric(self):
        from sim import haversine
        ab = haversine(*AIRPORTS["EHAM"], *AIRPORTS["EGLL"])
        ba = haversine(*AIRPORTS["EGLL"], *AIRPORTS["EHAM"])
        self.assertAlmostEqual(ab, ba, places=9)

    def test_zero_distance(self):
        from sim import haversine
        self.assertAlmostEqual(haversine(*AIRPORTS["EHAM"], *AIRPORTS["EHAM"]), 0.0, places=9)

    def test_matches_independent_reference(self):
        from sim import haversine
        for a in AIRPORTS:
            for b in AIRPORTS:
                self.assertAlmostEqual(
                    haversine(*AIRPORTS[a], *AIRPORTS[b]),
                    ref_haversine(*AIRPORTS[a], *AIRPORTS[b]),
                    places=6, msg=f"{a}->{b}")


class TestOneWay(unittest.TestCase):
    def setUp(self):
        self.sim = make_sim()

    def test_oneway_energy_time_charge(self):
        d = 200.0
        r = self.sim.calculate_flight_by_distance("beta_plane", d, "aircraft_charger", "one-way")
        self.assertTrue(r.get("success"), r)
        avg = BETA["battery_kwh"] / BETA["range_km"] * 100          # 37.5 kWh/100km
        leg = avg * d / 100                                          # 75 kWh
        self.assertAlmostEqual(r["avg_usage_kwh_per_100km"], avg, places=2)
        self.assertAlmostEqual(r["leg_energy_kwh"], leg, places=2)
        # one-way: recharge == leg (top the leg it just flew back to full)
        self.assertAlmostEqual(r["recharge_energy_kwh"], leg, places=2)
        self.assertEqual(r["legs"], 1)
        self.assertAlmostEqual(r["total_distance_km"], d, places=2)
        self.assertAlmostEqual(r["flight_time_h"], d / BETA["speed_kmh"], places=2)
        self.assertAlmostEqual(r["charge_time_h"], leg / CHARGER_172["power_kw"], places=3)

    def test_charge_time_min_consistency(self):
        r = self.sim.calculate_flight_by_distance("beta_plane", 200.0, "aircraft_charger", "one-way")
        self.assertAlmostEqual(r["charge_time_min"], r["charge_time_h"] * 60, delta=0.1)


class TestRetourDeficitBranch(unittest.TestCase):
    """recharge = max(0, 2*leg - battery)."""
    def setUp(self):
        self.sim = make_sim()

    def test_both_legs_fit_dest_supplies_zero(self):
        # Beta: 37.5 kWh/100km, 225 kWh battery. 2*leg <= battery <=> leg <= 112.5
        # kWh <=> d <= 300 km. Use d = 200 (round trip 150 kWh < 225) -> 0.
        r = self.sim.calculate_flight_by_distance("beta_plane", 200.0, "aircraft_charger", "retour")
        self.assertTrue(r.get("success"), r)
        self.assertEqual(r["legs"], 2)
        self.assertAlmostEqual(r["recharge_energy_kwh"], 0.0, places=2)
        self.assertAlmostEqual(r["charge_time_h"], 0.0, places=3)

    def test_legs_dont_fit_dest_supplies_deficit(self):
        # d = 400 km: leg = 150 kWh, 2*leg = 300, deficit = 300 - 225 = 75 kWh.
        d = 400.0
        r = self.sim.calculate_flight_by_distance("beta_plane", d, "aircraft_charger", "retour")
        self.assertTrue(r.get("success"), r)
        avg = BETA["battery_kwh"] / BETA["range_km"] * 100
        leg = avg * d / 100
        deficit = max(0.0, 2 * leg - BETA["battery_kwh"])
        self.assertAlmostEqual(r["recharge_energy_kwh"], deficit, places=2)
        self.assertAlmostEqual(r["charge_time_h"], deficit / CHARGER_172["power_kw"], places=3)
        self.assertAlmostEqual(r["total_distance_km"], 2 * d, places=2)

    def test_boundary_exactly_full(self):
        # A retour exactly fills the battery when 2*leg == battery. leg = battery/range * d,
        # so 2 * battery/range * d == battery <=> d == range/2 — the boundary distance, derived
        # from the catalog so a range retune can't silently push d off the threshold.
        d = VAERIDION["range_km"] / 2.0
        r = self.sim.calculate_flight_by_distance("vaeridion", d, "aircraft_charger", "retour")
        self.assertTrue(r.get("success"), r)
        self.assertAlmostEqual(r["recharge_energy_kwh"], 0.0, places=2)


class TestTraining(unittest.TestCase):
    def setUp(self):
        self.sim = make_sim()

    def test_training_velis(self):
        r = self.sim.calculate_flight_by_distance("pipistrel_velis", 0, "aircraft_charger", "training")
        self.assertTrue(r.get("success"), r)
        avg = VELIS["battery_kwh"] / VELIS["range_km"] * 100         # 22 kWh/100km
        raw = avg * VELIS["training_range_km"] / 100                 # 22.0 kWh (training_range 100)
        # min_landing_soc absent -> 0 -> usable == full battery -> recharge == raw
        self.assertAlmostEqual(r["raw_pattern_energy_kwh"], raw, places=2)
        self.assertAlmostEqual(r["recharge_energy_kwh"], raw, places=2)
        self.assertAlmostEqual(r["leg_energy_kwh"], raw, places=2)
        self.assertEqual(r["legs"], 1)
        self.assertAlmostEqual(r["training_range_km"], VELIS["training_range_km"], places=2)
        self.assertAlmostEqual(r["flight_time_h"], VELIS["training_range_km"] / VELIS["speed_kmh"], places=2)
        self.assertAlmostEqual(r["charge_time_h"], raw / CHARGER_172["power_kw"], places=3)

    def test_training_capped_at_usable_battery(self):
        # Custom plane whose pattern would cost MORE than the battery -> capped.
        # battery 10 kWh, range 100 -> 10 kWh/100km. training_range 200 -> raw 20
        # kWh, but usable (no min_landing_soc) == 10 -> recharge capped at 10.
        plane = {"id": "tiny", "name": "Tiny", "battery_kwh": 10, "range_km": 100,
                 "speed_kmh": 100, "training_range_km": 200}
        r = self.sim.calculate_flight_by_distance(None, 0, None, "training",
                                                  plane_obj=plane, charger_obj=CHARGER_172)
        self.assertTrue(r.get("success"), r)
        self.assertAlmostEqual(r["raw_pattern_energy_kwh"], 20.0, places=2)
        self.assertAlmostEqual(r["recharge_energy_kwh"], 10.0, places=2)

    def test_training_with_min_landing_soc(self):
        plane = {"id": "v2", "name": "V2", "battery_kwh": 100, "range_km": 100,
                 "speed_kmh": 100, "training_range_km": 100, "min_landing_soc": 0.30}
        r = self.sim.calculate_flight_by_distance(None, 0, None, "training",
                                                  plane_obj=plane, charger_obj=CHARGER_172)
        self.assertTrue(r.get("success"), r)
        # raw = 100 kWh, usable = 100*(1-0.3)=70 -> capped at 70.
        self.assertAlmostEqual(r["raw_pattern_energy_kwh"], 100.0, places=2)
        self.assertAlmostEqual(r["recharge_energy_kwh"], 70.0, places=2)

    def test_training_without_range_rejected(self):
        # Beta has no training_range_km -> error.
        r = self.sim.calculate_flight_by_distance("beta_plane", 0, "aircraft_charger", "training")
        self.assertIn("error", r)


class TestRejections(unittest.TestCase):
    def setUp(self):
        self.sim = make_sim()

    def test_over_range_rejected(self):
        # Velis range 100 km; 150 km leg must be rejected.
        r = self.sim.calculate_flight_by_distance("pipistrel_velis", 150.0, "aircraft_charger", "one-way")
        self.assertIn("error", r)

    def test_at_range_boundary_accepted(self):
        # Exactly range_km is allowed (strict >).
        r = self.sim.calculate_flight_by_distance("pipistrel_velis", VELIS["range_km"], "aircraft_charger", "one-way")
        self.assertTrue(r.get("success"), r)

    def test_unknown_plane(self):
        r = self.sim.calculate_flight_by_distance("nope", 10.0, "aircraft_charger", "one-way")
        self.assertIn("error", r)

    def test_unknown_charger(self):
        r = self.sim.calculate_flight_by_distance("beta_plane", 10.0, "nope", "one-way")
        self.assertIn("error", r)

    def test_custom_plane_nonpositive_rejected(self):
        plane = {"id": "x", "name": "X", "battery_kwh": 0, "range_km": 100, "speed_kmh": 100}
        r = self.sim.calculate_flight_by_distance(None, 10.0, None, "one-way",
                                                  plane_obj=plane, charger_obj=CHARGER_172)
        self.assertIn("error", r)

    def test_custom_plane_nonfinite_rejected(self):
        plane = {"id": "x", "name": "X", "battery_kwh": float("inf"),
                 "range_km": 100, "speed_kmh": 100}
        r = self.sim.calculate_flight_by_distance(None, 10.0, None, "one-way",
                                                  plane_obj=plane, charger_obj=CHARGER_172)
        self.assertIn("error", r)

    def test_inline_plane_without_id_does_not_crash(self):
        """BUG: an inline plane that passes validation but has no `id` reaches
        the response builder, which does plane['id'] (not .get) and raises
        KeyError. app.py doesn't catch KeyError -> HTTP 500 with HTML body.
        A robust simulator should return a dict (success or error), never raise.
        """
        plane = {"name": "NoId", "battery_kwh": 300, "range_km": 600, "speed_kmh": 300}
        try:
            r = self.sim.calculate_flight_by_distance(None, 200.0, None, "one-way",
                                                      plane_obj=plane, charger_obj=CHARGER_172)
        except KeyError as e:
            self.fail(f"calculate_flight_by_distance raised KeyError({e}) for an "
                      f"id-less inline plane instead of returning a result/error dict")
        self.assertIsInstance(r, dict)

    def test_inline_charger_without_id_does_not_crash(self):
        charger = {"name": "NoId", "power_kw": 250}
        try:
            r = self.sim.calculate_flight_by_distance("beta_plane", 200.0, None, "one-way",
                                                      charger_obj=charger)
        except KeyError as e:
            self.fail(f"calculate_flight_by_distance raised KeyError({e}) for an "
                      f"id-less inline charger")
        self.assertIsInstance(r, dict)


class TestSimulateByCoords(unittest.TestCase):
    def setUp(self):
        self.sim = make_sim()

    def test_coords_oneway_matches_distance_call(self):
        r = self.sim.simulate_by_coords("beta_plane", coord("EHAM"), coord("LFPG"),
                                        "aircraft_charger", "one-way")
        self.assertTrue(r.get("success"), r)
        d = dist("EHAM", "LFPG")
        avg = BETA["battery_kwh"] / BETA["range_km"] * 100
        self.assertAlmostEqual(r["leg_distance_km"], d, delta=0.05)
        self.assertAlmostEqual(r["leg_energy_kwh"], avg * d / 100, delta=0.05)


class TestReferenceCatalogSync(unittest.TestCase):
    """Guard against the drift that silently broke this suite once: the _helpers
    reference constants are an explicit mirror of planes.json, and the physics
    assertions derive their expected numbers from them. When a headline catalog
    number changes (Beta 500->600 km, Velis training_range 70->100 km) but the
    constant is not bumped, the energy assertions fail with cryptic '37.5 != 45'
    deltas that LOOK like a sim.py regression. This test fails first and names
    the exact field/plane, so the next drift is diagnosed in seconds."""
    def setUp(self):
        self.catalog = {p["id"]: p for p in make_sim().planes}

    def _assert_in_sync(self, ref, fields):
        live = self.catalog.get(ref["id"])
        self.assertIsNotNone(live, f"planes.json has no plane id {ref['id']!r}")
        for f in fields:
            self.assertAlmostEqual(
                float(ref[f]), float(live[f]), places=6,
                msg=(f"_helpers {ref['id']}.{f}={ref[f]} drifted from planes.json "
                     f"{f}={live[f]} — update tests/_helpers.py to match the catalog"))

    def test_velis_in_sync(self):
        self._assert_in_sync(VELIS, ("battery_kwh", "range_km", "speed_kmh", "training_range_km"))

    def test_beta_in_sync(self):
        self._assert_in_sync(BETA, ("battery_kwh", "range_km", "speed_kmh"))

    def test_vaeridion_in_sync(self):
        self._assert_in_sync(VAERIDION, ("battery_kwh", "range_km", "speed_kmh"))


if __name__ == "__main__":
    unittest.main()
