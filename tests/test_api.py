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
import shutil
import sys
import tempfile
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _helpers import (BETA, VELIS, dist, coord)  # noqa: E402

# app.py reads its auth configuration at import time; set it the way
# test_auth.py does so it makes no difference which module imports app first.
os.environ.setdefault('CNS_APP_PASSWORD', 'test-secret-pw')
os.environ.setdefault('CNS_SECRET_KEY', 'unit-test-fixed-key')
os.environ.setdefault('CNS_INSECURE_COOKIES', '1')

import app as cns_app  # noqa: E402

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

    def test_oneway_same_origin_dest_with_stops_ok(self):
        # A reconstructed rotation returns to base: origin == destination is valid
        # for a MULTI-STOP one-way (not a degenerate zero-distance flight). The
        # stop-less A->A case is still rejected (see test_over_range/degenerate).
        st, r = _post("/api/simulate", {
            "origin": coord("EHAM"), "destination": coord("EHAM"),
            "plane_id": "beta_plane", "charger_id": LIVE_CHARGER,
            "trip_type": "oneway",
            "stops": [dict(coord("EHRD"), ident="EHRD")]})
        self.assertEqual(st, 200, r)
        self.assertTrue(r.get("success"), r)
        self.assertEqual(len(r["legs"]), 2)  # EHAM->EHRD->EHAM

    def test_oneway_same_origin_dest_no_stops_still_rejected(self):
        try:
            st, r = _post("/api/simulate", {
                "origin": coord("EHAM"), "destination": coord("EHAM"),
                "plane_id": "beta_plane", "charger_id": LIVE_CHARGER,
                "trip_type": "oneway"})
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)
            return
        self.assertEqual(st, 400, r)

    def test_retour_same_origin_dest_with_stops_is_non_degenerate(self):
        # The `not stops` guard also admits retour with origin==destination. That
        # is NOT the degenerate zero-distance case it guards against: with a stop,
        # the legs have real distance. Lock that it succeeds with non-zero km.
        st, r = _post("/api/simulate", {
            "origin": coord("EHAM"), "destination": coord("EHAM"),
            "plane_id": "beta_plane", "charger_id": LIVE_CHARGER,
            "trip_type": "retour",
            "stops": [dict(coord("EHRD"), ident="EHRD")]})
        self.assertEqual(st, 200, r)
        self.assertTrue(r.get("success"), r)
        self.assertGreater(r["total_distance_km"], 0)

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


# In-process (Flask test client, no live server, so deliberately NOT behind the
# skip gate above): /api/custom/chargers is the only caller of app._log /
# _read_list / _write_list / _custom_lock, and nothing else pins them.
class TestCustomChargers(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="cns_chargers_")
        self._saved = (cns_app.DATA_DIR, cns_app.CUSTOM_CHARGERS_FILE,
                       cns_app.CHARGERS_LOG, cns_app.AUTH_ENABLED)
        cns_app.DATA_DIR = self._tmp
        cns_app.CUSTOM_CHARGERS_FILE = os.path.join(self._tmp, "custom_chargers.json")
        cns_app.CHARGERS_LOG = os.path.join(self._tmp, "chargers_log.txt")
        cns_app.AUTH_ENABLED = False
        cns_app.app.config["TESTING"] = True
        self.client = cns_app.app.test_client()

    def tearDown(self):
        (cns_app.DATA_DIR, cns_app.CUSTOM_CHARGERS_FILE,
         cns_app.CHARGERS_LOG, cns_app.AUTH_ENABLED) = self._saved
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _add(self, name="Dock A", power=350):
        return self.client.post("/api/custom/chargers",
                                json={"name": name, "power_kw": power})

    def test_post_returns_201_and_get_lists_it(self):
        r = self._add()
        self.assertEqual(r.status_code, 201, r.data)
        saved = r.get_json()
        self.assertTrue(saved["id"])
        self.assertEqual(saved["power_kw"], 350)
        self.assertEqual(self.client.get("/api/custom/chargers").get_json(), [saved])

    def test_non_numeric_power_rejected(self):
        r = self.client.post("/api/custom/chargers",
                             json={"name": "Dock A", "power_kw": "fast"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.client.get("/api/custom/chargers").get_json(), [])

    def test_delete_removes_it_then_404s(self):
        cid = self._add().get_json()["id"]
        self.assertEqual(self.client.delete("/api/custom/chargers/" + cid).status_code, 200)
        self.assertEqual(self.client.delete("/api/custom/chargers/" + cid).status_code, 404)
        self.assertEqual(self.client.get("/api/custom/chargers").get_json(), [])

    def test_cap_at_max_customs(self):
        for i in range(cns_app.MAX_CUSTOMS):
            self.assertEqual(self._add(f"Dock {i}").status_code, 201)
        self.assertEqual(self._add("one too many").status_code, 400)

    def test_unknown_ident_photo_404(self):
        # Rejected by _airport_by_ident before any photo work — needs no network.
        self.assertEqual(self.client.get("/api/airport-photo/ZZZZ9").status_code, 404)


if __name__ == "__main__":
    unittest.main()
