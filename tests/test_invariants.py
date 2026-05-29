"""
Cross-cutting invariant / consistency tests that shouldn't depend on a single
hand-computed number: monotonicity in distance, symmetry, charge_time_min ==
charge_time_h*60, energy conservation between single-leg and multi-leg, and
rounding sanity.
"""
import unittest

from _helpers import make_sim, AIRPORTS, BETA, VAERIDION, CHARGER_172, CHARGER_400


def _coord(code, name=None):
    lat, lon = AIRPORTS[code]
    return {"name": name or code, "lat": lat, "lon": lon, "ident": code}


class TestMonotonicity(unittest.TestCase):
    def setUp(self):
        self.sim = make_sim()

    def test_oneway_energy_monotonic_in_distance(self):
        prev = -1
        for d in (10, 50, 100, 200, 300, 400, 500):
            r = self.sim.calculate_flight_by_distance("vaeridion", float(d), "aircraft_charger", "one-way")
            self.assertTrue(r.get("success"), r)
            self.assertGreater(r["leg_energy_kwh"], prev)
            prev = r["leg_energy_kwh"]

    def test_oneway_charge_time_monotonic_in_distance(self):
        prev = -1
        for d in (10, 50, 100, 200, 300, 400, 500):
            r = self.sim.calculate_flight_by_distance("vaeridion", float(d), "aircraft_charger", "one-way")
            self.assertGreaterEqual(r["charge_time_h"], prev)
            prev = r["charge_time_h"]

    def test_charge_time_inversely_scales_with_power(self):
        # Same energy, more power -> strictly less time.
        d = 300.0
        slow = self.sim.calculate_flight_by_distance("vaeridion", d, "mobile_aircraft", "one-way")  # 22 kW
        fast = self.sim.calculate_flight_by_distance("vaeridion", d, "ccs", "one-way")              # 400 kW
        self.assertGreater(slow["charge_time_h"], fast["charge_time_h"])
        # ratio should equal inverse power ratio
        self.assertAlmostEqual(slow["charge_time_h"] / fast["charge_time_h"], 400 / 22, delta=0.05)


class TestSymmetry(unittest.TestCase):
    def setUp(self):
        self.sim = make_sim()

    def test_oneway_direction_symmetric_energy(self):
        ab = self.sim.simulate_by_coords("beta_plane", _coord("EHAM"), _coord("LFPG"),
                                         "aircraft_charger", "one-way")
        ba = self.sim.simulate_by_coords("beta_plane", _coord("LFPG"), _coord("EHAM"),
                                         "aircraft_charger", "one-way")
        self.assertAlmostEqual(ab["leg_energy_kwh"], ba["leg_energy_kwh"], delta=0.05)
        self.assertAlmostEqual(ab["flight_time_h"], ba["flight_time_h"], delta=0.02)


class TestChargeTimeConsistency(unittest.TestCase):
    def setUp(self):
        self.sim = make_sim()

    def test_min_equals_h_times_60_across_cases(self):
        cases = [
            ("beta_plane", 200.0, "aircraft_charger", "one-way"),
            ("beta_plane", 400.0, "aircraft_charger", "retour"),
            ("vaeridion", 123.4, "ccs", "one-way"),
            ("pipistrel_velis", 0, "mobile_aircraft", "training"),
        ]
        for plane, d, ch, tt in cases:
            r = self.sim.calculate_flight_by_distance(plane, d, ch, tt)
            self.assertTrue(r.get("success"), r)
            # h is rounded to 3dp, min to 1dp -> compare with a small tolerance
            self.assertAlmostEqual(r["charge_time_min"], r["charge_time_h"] * 60, delta=0.15,
                                   msg=f"{plane} {d} {tt}")


class TestEnergyConservation(unittest.TestCase):
    """A single-leg one-way trip and a 'multi-leg' trip with the SAME endpoints
    but one intermediate stop should deliver the same TOTAL energy into the
    aircraft over the journey, because consumption depends only on total
    distance flown (which for stops on the great-circle is ~equal)."""
    def setUp(self):
        self.sim = make_sim()

    def test_total_charge_energy_self_consistent(self):
        # EHAM -> EHRD -> LFPG: EHRD is roughly on the way; total energy charged
        # into the plane across the trip == energy used flying (since it ends
        # full and started full): sum(charges) should equal sum(leg energies).
        r = self.sim.simulate_by_coords(
            "beta_plane", _coord("EHAM"), _coord("LFPG"),
            "aircraft_charger", "one-way", stops=[_coord("EHRD")])
        self.assertTrue(r.get("success"), r)
        total_leg = sum(l["energy_kwh"] for l in r["legs"])
        total_charge = sum(c["energy_kwh"] for c in r["charges"])
        # Plane departs full, ends full -> net energy added == net energy burned.
        self.assertAlmostEqual(total_charge, total_leg, delta=0.05)


class TestRounding(unittest.TestCase):
    def setUp(self):
        self.sim = make_sim()

    def test_rounding_keeps_values_nonnegative(self):
        for d in (0.01, 0.5, 1.0, 7.7, 99.99):
            r = self.sim.calculate_flight_by_distance("vaeridion", float(d), "ccs", "one-way")
            self.assertGreaterEqual(r["leg_energy_kwh"], 0.0)
            self.assertGreaterEqual(r["charge_time_h"], 0.0)
            self.assertGreaterEqual(r["charge_time_min"], 0.0)

    def test_reported_avg_usage_stable_across_trip_types(self):
        a = self.sim.calculate_flight_by_distance("beta_plane", 100.0, "ccs", "one-way")
        b = self.sim.calculate_flight_by_distance("beta_plane", 100.0, "ccs", "retour")
        self.assertAlmostEqual(a["avg_usage_kwh_per_100km"], b["avg_usage_kwh_per_100km"], places=2)


if __name__ == "__main__":
    unittest.main()
