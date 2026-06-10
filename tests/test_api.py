"""
End-to-end API tests against the running server (http://localhost:5055),
using only stdlib urllib. If the server is unreachable, every test in here
is skipped (not failed) so the offline Python suite still gives a clean run.

These verify the HTTP layer reproduces the same physics as the in-process
Simulator, and that the documented request shapes (ICAO strings, inline
plane/charger objects, stops, trip_type) round-trip correctly.
"""
import json
import os
import unittest
import urllib.error
import urllib.request

from _helpers import (AIRPORTS, BETA, VELIS, CHARGER_172, dist, coord)

BASE = os.environ.get("CNS_BASE_URL", "http://localhost:5055")

# The legacy 172 kW "aircraft_charger" was dropped from chargers.json in the
# DC-charger rework. The in-process suite re-injects it as a fixture, but these
# tests hit the LIVE server's catalog, so they post a real charger id. None of
# the assertions below pin an absolute charge TIME, so any valid DC charger
# works — dc_400 just needs to exist in chargers.json.
LIVE_CHARGER = "dc_400"


def _post(path, payload, timeout=10):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def _server_up():
    try:
        req = urllib.request.Request(BASE + "/", method="GET")
        with urllib.request.urlopen(req, timeout=3) as resp:
            return resp.status == 200
    except Exception:
        return False


@unittest.skipUnless(_server_up(), f"server at {BASE} not reachable")
class TestSimulateAPI(unittest.TestCase):
    def test_oneway_icao_strings(self):
        st, r = _post("/api/simulate", {
            "origin": "EHAM", "destination": "LFPG",
            "plane_id": "beta_plane", "charger_id": LIVE_CHARGER,
            "trip_type": "one-way"})
        self.assertEqual(st, 200, r)
        self.assertTrue(r.get("success"), r)
        d = dist("EHAM", "LFPG")
        avg = BETA["battery_kwh"] / BETA["range_km"] * 100
        self.assertAlmostEqual(r["leg_distance_km"], d, delta=0.6)  # CSV vs lib coords
        self.assertAlmostEqual(r["leg_energy_kwh"], avg * r["leg_distance_km"] / 100, delta=0.05)

    def test_oneway_coords_match_inprocess(self):
        st, r = _post("/api/simulate", {
            "origin": coord("EHAM"), "destination": coord("LFPG"),
            "plane_id": "beta_plane", "charger_id": LIVE_CHARGER,
            "trip_type": "one-way"})
        self.assertEqual(st, 200, r)
        d = dist("EHAM", "LFPG")
        self.assertAlmostEqual(r["leg_distance_km"], d, delta=0.05)

    def test_retour_deficit_branch(self):
        st, r = _post("/api/simulate", {
            "origin": coord("EHAM"), "destination": coord("LFPG"),
            "plane_id": "beta_plane", "charger_id": LIVE_CHARGER,
            "trip_type": "retour"})
        self.assertEqual(st, 200, r)
        d = r["leg_distance_km"]
        avg = BETA["battery_kwh"] / BETA["range_km"] * 100
        leg = avg * d / 100
        deficit = max(0.0, 2 * leg - BETA["battery_kwh"])
        self.assertAlmostEqual(r["recharge_energy_kwh"], deficit, delta=0.05)

    def test_charge_time_min_consistency(self):
        st, r = _post("/api/simulate", {
            "origin": coord("EHAM"), "destination": coord("LFPG"),
            "plane_id": "beta_plane", "charger_id": LIVE_CHARGER,
            "trip_type": "one-way"})
        self.assertAlmostEqual(r["charge_time_min"], r["charge_time_h"] * 60, delta=0.15)

    def test_inline_plane_and_charger_with_id(self):
        st, r = _post("/api/simulate", {
            "origin": coord("EHAM"), "destination": coord("LFPG"),
            "plane": {"id": "c1", "name": "Custom", "battery_kwh": 300, "range_km": 600, "speed_kmh": 300},
            "charger": {"id": "ch1", "name": "C", "power_kw": 250},
            "trip_type": "one-way"})
        self.assertEqual(st, 200, r)
        self.assertTrue(r.get("success"), r)
        avg = 300 / 600 * 100  # 50 kWh/100km
        self.assertAlmostEqual(r["avg_usage_kwh_per_100km"], avg, places=2)

    def test_inline_plane_without_id_no_html_500(self):
        """BUG GUARD: the API documents an inline `plane`/`charger` object, but
        if it lacks an `id`, calculate_flight_by_distance crashes on
        plane['id'] with a KeyError that app.py does NOT catch (it only catches
        OverflowError/ValueError/ZeroDivisionError), surfacing a raw HTML 500
        that breaks the browser's JSON parser. A correct API returns either a
        success body or a JSON {"error": ...} — never a 500."""
        try:
            st, r = _post("/api/simulate", {
                "origin": coord("EHAM"), "destination": coord("LFPG"),
                "plane": {"name": "Custom", "battery_kwh": 300, "range_km": 600, "speed_kmh": 300},
                "charger": {"name": "C", "power_kw": 250},
                "trip_type": "one-way"})
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            self.fail(f"inline plane without id returned HTTP {e.code} "
                      f"(expected JSON success or error, not a crash). Body starts: {body[:80]!r}")
        # If we got here the server responded without raising; accept 200 or a
        # 4xx JSON error, but the body must be JSON-parseable (it already is,
        # since _post json-decodes it).
        self.assertIn(st, (200, 400, 422), r)

    def test_training_via_api(self):
        st, r = _post("/api/simulate", {
            "origin": coord("EHAM", "Base"), "destination": coord("EHAM", "Base"),
            "plane_id": "pipistrel_velis", "charger_id": LIVE_CHARGER,
            "trip_type": "training"})
        self.assertEqual(st, 200, r)
        self.assertTrue(r.get("success"), r)
        avg = VELIS["battery_kwh"] / VELIS["range_km"] * 100
        self.assertAlmostEqual(
            r["raw_pattern_energy_kwh"],
            avg * VELIS["training_range_km"] / 100, delta=0.05)

    def test_multileg_via_api(self):
        st, r = _post("/api/simulate", {
            "origin": coord("EHAM"), "destination": coord("LFPG"),
            "plane_id": "beta_plane", "charger_id": LIVE_CHARGER,
            "trip_type": "one-way",
            "stops": [dict(coord("EHRD"), ident="EHRD")]})
        self.assertEqual(st, 200, r)
        self.assertTrue(r.get("success"), r)
        self.assertTrue(r.get("multi_leg"))
        self.assertEqual(len(r["legs"]), 2)
        # invariant: total distance == sum of legs
        self.assertAlmostEqual(r["total_distance_km"],
                               round(sum(l["distance_km"] for l in r["legs"]), 2), delta=0.02)

    def test_over_range_rejected(self):
        st, r = _post("/api/simulate", {
            "origin": coord("EHAM"), "destination": coord("LFPG"),
            "plane_id": "pipistrel_velis", "charger_id": LIVE_CHARGER,
            "trip_type": "one-way"})
        # sim returns {"error": ...} with HTTP 200 (no exception raised)
        self.assertIn("error", r)

    def test_circular_via_api(self):
        st, r = _post("/api/simulate", {
            "origin": coord("EHAM"), "destination": coord("LFPG"),
            "plane_id": "beta_plane", "charger_id": LIVE_CHARGER,
            "trip_type": "circular",
            "stops": [dict(coord("EHRD"), ident="EHRD")]})
        self.assertEqual(st, 200, r)
        self.assertTrue(r.get("success"), r)
        self.assertTrue(r.get("multi_leg"))
        # O,S,D,O -> stops+2 = 3 legs; the closing leg returns to the origin
        self.assertEqual(len(r["legs"]), 3)
        self.assertEqual(r["legs"][-1]["to"]["name"], r["origin"]["name"])
        self.assertEqual(r["charges"][-1]["role"], "home")
        self.assertAlmostEqual(r["total_distance_km"],
                               round(sum(l["distance_km"] for l in r["legs"]), 2), delta=0.02)

    def test_circular_zero_stops_rejected(self):
        try:
            st, r = _post("/api/simulate", {
                "origin": coord("EHAM"), "destination": coord("LFPG"),
                "plane_id": "beta_plane", "charger_id": LIVE_CHARGER,
                "trip_type": "circular"})
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)
            return
        self.assertEqual(st, 400, r)

    def test_circular_closing_leg_over_range_rejected(self):
        # Velis (100 km): EHAM -> EHRD is in range, but the dest leg/closing
        # legs are far over -> per-leg range check fires (JSON error, HTTP 200).
        st, r = _post("/api/simulate", {
            "origin": coord("EHAM"), "destination": coord("LFPG"),
            "plane_id": "pipistrel_velis", "charger_id": LIVE_CHARGER,
            "trip_type": "circular",
            "stops": [dict(coord("EHRD"), ident="EHRD")]})
        self.assertEqual(st, 200, r)
        self.assertIn("error", r)
        self.assertIn("exceeds range", r["error"])

    def test_same_origin_dest_rejected_for_oneway(self):
        try:
            st, r = _post("/api/simulate", {
                "origin": "EHAM", "destination": "EHAM",
                "plane_id": "beta_plane", "charger_id": LIVE_CHARGER,
                "trip_type": "one-way"})
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)
            return
        self.assertEqual(st, 400, r)

    def test_missing_params_400(self):
        try:
            st, r = _post("/api/simulate", {"origin": "EHAM"})
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)
            return
        self.assertEqual(st, 400, r)


if __name__ == "__main__":
    unittest.main()
