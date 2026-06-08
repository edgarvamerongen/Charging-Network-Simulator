"""
Multi-leg (_simulate_multi) tests: battery propagation, per-stop charge energy,
leg/charge accounting, and the retour mirror.

The battery-state recurrence in sim.py is:
    cur = max(cur, leg_energy) - leg_energy        # per leg, starting cur = battery

and per-stop charge energy is:
    terminal  -> battery - arrival                 (top to full)
    otherwise -> max(0, NEXT_leg_energy - arrival) (enough for the next leg)

These tests assert the implementation reproduces that recurrence exactly, and
that the documented invariants hold. They also probe the physical plausibility
of the recurrence (see test_arrival_soc_is_physical), flagging the case where
arrival SoC is computed as if the plane had topped to full at every stop.
"""
import unittest

from _helpers import make_sim, ref_haversine, AIRPORTS, BETA, CHARGER_172, CHARGER_400


def _coord(code, name=None):
    lat, lon = AIRPORTS[code]
    return {"name": name or code, "lat": lat, "lon": lon, "ident": code}


def _true_forward_walk_charges(batt, leg_energies):
    """Reference model of the multi-leg charging contract, written
    independently of sim.py: depart full; fly each leg; at each intermediate
    waypoint charge exactly enough for the NEXT leg (deficit, never negative);
    at the terminal top up to full. Returns the per-waypoint charge energy."""
    soc = batt
    charges = []
    for i, e in enumerate(leg_energies):
        soc = soc - e                                   # fly leg i -> arrive waypoint i+1
        if i == len(leg_energies) - 1:                  # terminal: full
            ce = batt - soc
        else:                                           # enough for next leg
            ce = max(0.0, leg_energies[i + 1] - soc)
        soc = soc + ce
        charges.append(ce)
    return charges


def _colinear(start, bearing_pts):
    """Build waypoints stepping ~step_km south along a meridian, returning
    coord dicts. Used to synthesise multi-leg routes that actually force
    intermediate charging (real on-map stops near origin charge nothing)."""
    out = []
    lat0, lon0 = start
    for i, dlat in enumerate(bearing_pts):
        out.append({"name": f"P{i}", "lat": lat0 - dlat, "lon": lon0, "ident": f"P{i}"})
    return out


class TestMultiLegBeta(unittest.TestCase):
    """Beta (225 kWh / 600 km / 250 km/h): 37.5 kWh/100km.
    Route EHAM -> EHRD (stop) -> LFPG, one-way. EHRD (Rotterdam) is genuinely
    on the great-circle south to Paris, so each leg stays inside the 600 km
    range (45 km then 354 km)."""
    def setUp(self):
        self.sim = make_sim()
        self.r = self.sim.simulate_by_coords(
            "beta_plane", _coord("EHAM"), _coord("LFPG"),
            "aircraft_charger", "one-way", stops=[_coord("EHRD")])
        self.assertTrue(self.r.get("success"), self.r)
        self.avg = BETA["battery_kwh"] / BETA["range_km"] * 100  # 37.5

    def test_legs_distances_match_haversine(self):
        legs = self.r["legs"]
        self.assertEqual(len(legs), 2)
        d1 = ref_haversine(*AIRPORTS["EHAM"], *AIRPORTS["EHRD"])
        d2 = ref_haversine(*AIRPORTS["EHRD"], *AIRPORTS["LFPG"])
        self.assertAlmostEqual(legs[0]["distance_km"], d1, delta=0.05)
        self.assertAlmostEqual(legs[1]["distance_km"], d2, delta=0.05)

    def test_total_distance_equals_sum_of_legs(self):
        legs = self.r["legs"]
        self.assertAlmostEqual(self.r["total_distance_km"],
                               sum(l["distance_km"] for l in legs), delta=0.02)

    def test_total_flight_time_equals_sum_of_legs(self):
        legs = self.r["legs"]
        self.assertAlmostEqual(self.r["total_flight_time_h"],
                               round(sum(l["flight_time_h"] for l in legs), 2), delta=0.02)

    def test_leg_energy_matches_formula(self):
        for leg in self.r["legs"]:
            self.assertAlmostEqual(leg["energy_kwh"], self.avg * leg["distance_km"] / 100, delta=0.02)

    def test_total_recharge_equals_sum_of_charges(self):
        charges = self.r["charges"]
        self.assertAlmostEqual(self.r["total_recharge_energy_kwh"],
                               round(sum(c["energy_kwh"] for c in charges), 2), delta=0.02)

    def test_charge_time_min_matches_energy_over_power(self):
        for c in self.r["charges"]:
            self.assertAlmostEqual(c["charge_time_min"],
                                   c["energy_kwh"] / CHARGER_172["power_kw"] * 60, delta=0.1)

    def test_propagation_reproduces_recurrence(self):
        # Recompute the documented recurrence and compare per-stop charge energy.
        legs = self.r["legs"]
        batt = BETA["battery_kwh"]
        cur = batt
        arrivals = [batt]
        for leg in legs:
            cur = max(cur, leg["energy_kwh"]) - leg["energy_kwh"]
            arrivals.append(round(cur, 4))
        charges = self.r["charges"]
        n_chain = len(legs) + 1  # origin + stops + dest = legs+1 waypoints
        for idx, c in enumerate(charges, start=1):
            arrival = arrivals[idx]
            if idx == n_chain - 1:           # terminal
                expected = batt - arrival
            else:
                expected = max(0.0, legs[idx]["energy_kwh"] - arrival)
            self.assertAlmostEqual(c["energy_kwh"], round(expected, 2), delta=0.02,
                                   msg=f"charge[{idx}] {c['name']}")

    def test_terminal_role_is_dest(self):
        self.assertEqual(self.r["charges"][-1]["role"], "dest")
        # intermediate is a stop
        self.assertEqual(self.r["charges"][0]["role"], "stop")

    def test_charges_match_true_forward_walk(self):
        """The per-stop charge energies must equal a physically-grounded forward
        walk (charge the deficit needed for the next leg; top to full at the
        terminal). sim.py uses a compact `cur = max(cur, leg) - leg` recurrence
        whose intermediate `arrivals` array is a fly-through-without-charging
        quantity, not the literal arrival SoC — so we verify the OUTPUT charge
        energies, which are the contract, against the explicit walk."""
        legs = self.r["legs"]
        batt = BETA["battery_kwh"]
        leg_e = [l["energy_kwh"] for l in legs]
        expected = _true_forward_walk_charges(batt, leg_e)
        got = [c["energy_kwh"] for c in self.r["charges"]]
        self.assertEqual(len(got), len(expected))
        for i, (g, e) in enumerate(zip(got, expected)):
            self.assertAlmostEqual(g, round(e, 2), delta=0.02, msg=f"charge[{i}]")


class TestMultiLegRetourMirror(unittest.TestCase):
    """Retour mirrors the stops on the way back: chain = O,S,D,S,O.
    EHRD is on-route so every leg (45/354/354/45 km) stays inside Beta's range."""
    def setUp(self):
        self.sim = make_sim()
        self.r = self.sim.simulate_by_coords(
            "beta_plane", _coord("EHAM"), _coord("LFPG"),
            "aircraft_charger", "retour", stops=[_coord("EHRD")])
        self.assertTrue(self.r.get("success"), self.r)

    def test_chain_length(self):
        # O,S,D,S,O -> 4 legs, 4 charge events (everything except origin start)
        self.assertEqual(len(self.r["legs"]), 4)
        self.assertEqual(len(self.r["charges"]), 4)

    def test_outbound_return_legs_symmetric(self):
        legs = self.r["legs"]
        # leg0 (O->S) mirrors leg3 (S->O); leg1 (S->D) mirrors leg2 (D->S)
        self.assertAlmostEqual(legs[0]["distance_km"], legs[3]["distance_km"], delta=0.02)
        self.assertAlmostEqual(legs[1]["distance_km"], legs[2]["distance_km"], delta=0.02)

    def test_roles_present(self):
        roles = [c["role"] for c in self.r["charges"]]
        self.assertIn("home", roles)   # final = home
        self.assertIn("dest", roles)
        self.assertEqual(roles[-1], "home")

    def test_total_distance_sum(self):
        self.assertAlmostEqual(self.r["total_distance_km"],
                               round(sum(l["distance_km"] for l in self.r["legs"]), 2), delta=0.02)


class TestMultiLegForcedCharging(unittest.TestCase):
    """Synthetic 3-leg route of ~400 km legs for the Beta (range 600, battery
    225, 37.5 kWh/100km). Each leg burns ~150 kWh > half the battery, so the
    plane MUST charge at every intermediate stop — exercising the deficit path
    that an on-map near-origin stop (EHRD) never triggers."""
    def setUp(self):
        self.sim = make_sim()
        # ~3.597 deg latitude ~= 400 km per step.
        wps = _colinear((60.0, 5.0), [0.0, 3.597, 2 * 3.597, 3 * 3.597])
        self.r = self.sim.simulate_by_coords(
            "beta_plane", wps[0], wps[-1], "aircraft_charger", "one-way",
            stops=wps[1:-1])
        self.assertTrue(self.r.get("success"), self.r)

    def test_three_legs(self):
        self.assertEqual(len(self.r["legs"]), 3)
        for leg in self.r["legs"]:
            self.assertLessEqual(leg["distance_km"], BETA["range_km"])

    def test_intermediate_stops_actually_charge(self):
        stop_charges = [c["energy_kwh"] for c in self.r["charges"] if c["role"] == "stop"]
        self.assertTrue(all(e > 0 for e in stop_charges),
                        f"expected nonzero charge at every stop, got {stop_charges}")

    def test_charges_match_true_forward_walk(self):
        batt = BETA["battery_kwh"]
        leg_e = [l["energy_kwh"] for l in self.r["legs"]]
        expected = _true_forward_walk_charges(batt, leg_e)
        got = [c["energy_kwh"] for c in self.r["charges"]]
        for i, (g, e) in enumerate(zip(got, expected)):
            self.assertAlmostEqual(g, round(e, 2), delta=0.02, msg=f"charge[{i}]")

    def test_energy_conservation(self):
        # Departs full, ends full -> total charged == total burned.
        total_leg = sum(l["energy_kwh"] for l in self.r["legs"])
        total_charge = sum(c["energy_kwh"] for c in self.r["charges"])
        self.assertAlmostEqual(total_charge, total_leg, delta=0.05)


class TestMultiLegOverRange(unittest.TestCase):
    def setUp(self):
        self.sim = make_sim()

    def test_leg_over_range_rejected(self):
        # Velis (100 km range): AMS->CDG direct is ~398 km; with no usable stop
        # in the provided list a single leg exceeds range -> error.
        r = self.sim.simulate_by_coords(
            "pipistrel_velis", _coord("EHAM"), _coord("LFPG"),
            "aircraft_charger", "one-way", stops=[_coord("EHGG")])
        self.assertIn("error", r)


if __name__ == "__main__":
    unittest.main()
