"""Aircraft-catalog schema: validator + provenance-normalizer tests.

Roadmap step 1 of docs/performance-engine.md. Stdlib `unittest` so it rides the
suite's `python -m unittest discover -s tests`; conftest.py puts the repo root on
sys.path, so `import plane_schema` resolves regardless of cwd.
"""
import json
import os
import unittest

import plane_schema

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _catalog():
    with open(os.path.join(REPO, "planes.json")) as f:
        return json.load(f)


class TestProvenanceNormalizer(unittest.TestCase):
    def test_bare_scalar(self):
        p = {"battery_kwh": 22}
        self.assertEqual(plane_schema.value(p, "battery_kwh"), 22)
        prov = plane_schema.provenance(p, "battery_kwh")
        self.assertEqual(prov["value"], 22)
        self.assertEqual(prov["confidence"], "assumed")

    def test_provenance_object(self):
        p = {"mtow_kg": {"value": 80000, "source": "X", "confidence": "estimated"}}
        self.assertEqual(plane_schema.value(p, "mtow_kg"), 80000)
        prov = plane_schema.provenance(p, "mtow_kg")
        self.assertEqual(prov["value"], 80000)
        self.assertEqual(prov["confidence"], "estimated")
        self.assertEqual(prov["source"], "X")

    def test_absent(self):
        self.assertIsNone(plane_schema.value({}, "nope"))
        self.assertEqual(plane_schema.value({}, "nope", 7), 7)
        self.assertIsNone(plane_schema.provenance({}, "nope"))


class TestIfrInference(unittest.TestCase):
    def test_explicit_wins(self):
        self.assertFalse(plane_schema.ifr_capable({"class": "regional", "ifr_capable": False}))
        self.assertTrue(plane_schema.ifr_capable({"ifr_capable": {"value": True}}))

    def test_infer_from_class(self):
        self.assertFalse(plane_schema.ifr_capable({"class": "trainer"}))
        self.assertTrue(plane_schema.ifr_capable({"class": "regional"}))
        self.assertTrue(plane_schema.ifr_capable({"class": "evtol"}))

    def test_infer_from_shape(self):
        self.assertFalse(plane_schema.ifr_capable({"seats": 2, "range_km": 87.5}))
        self.assertTrue(plane_schema.ifr_capable({"seats": 9, "range_km": 500}))


class TestCatalogValidates(unittest.TestCase):
    def test_planes_json_has_no_errors(self):
        errors, _ = plane_schema.validate(_catalog())
        self.assertEqual(errors, [], f"planes.json should validate cleanly; got {errors}")

    def test_velis_is_vfr_only_with_takeoff_floor(self):
        velis = next(p for p in _catalog() if plane_schema.value(p, "id") == "pipistrel_velis")
        self.assertFalse(plane_schema.ifr_capable(velis))
        self.assertEqual(plane_schema.value(velis, "min_takeoff_soc"), 0.50)
        self.assertEqual(plane_schema.provenance(velis, "ifr_capable")["confidence"], "certified")

    def test_headline_fields_stayed_bare_scalars(self):
        # battery/range/speed must remain plain numbers (the sync test floats them).
        for p in _catalog():
            for f in ("battery_kwh", "range_km", "speed_kmh"):
                self.assertIsInstance(plane_schema.value(p, f), (int, float))
                self.assertNotIsInstance(p[f], dict, f"{f} must stay a bare scalar")


class TestValidatorCatchesBadData(unittest.TestCase):
    BASE = {"id": "x", "name": "X", "battery_kwh": 10, "range_km": 100, "speed_kmh": 200,
            "ifr_capable": True}

    def _errs(self, **extra):
        return plane_schema.validate([{**self.BASE, **extra}])[0]

    def test_incl_reserve_requires_reserve_included(self):
        self.assertTrue(any("reserve_included" in m for _, m in self._errs(range_basis="incl_reserve")))

    def test_bad_enum_class(self):
        errors = plane_schema.validate([{**self.BASE, "class": "spaceship"}])[0]
        self.assertTrue(any("class" in m for _, m in errors))

    def test_out_of_range(self):
        errors = plane_schema.validate([{**self.BASE, "battery_kwh": -5, "min_takeoff_soc": 2}])[0]
        self.assertTrue(any("battery_kwh" in m for _, m in errors))
        self.assertTrue(any("min_takeoff_soc" in m for _, m in errors))

    def test_missing_required(self):
        errors = plane_schema.validate([{"id": "x", "name": "X"}])[0]
        self.assertTrue(any("battery_kwh" in m for _, m in errors))

    def test_unknown_field_warns_not_errors(self):
        errors, warnings = plane_schema.validate([{**self.BASE, "wibble": 1}])
        self.assertEqual(errors, [])
        self.assertTrue(any("wibble" in m for _, m in warnings))

    def test_ifr_absent_warns(self):
        errors, warnings = plane_schema.validate([{"id": "x", "name": "X", "battery_kwh": 10,
                                                   "range_km": 100, "speed_kmh": 200, "class": "regional"}])
        self.assertEqual(errors, [])
        self.assertTrue(any("ifr_capable" in m for _, m in warnings))


class TestMeasurementsSelection(unittest.TestCase):
    PLANE = {
        "id": "t", "name": "T", "battery_kwh": 600, "range_km": 500, "speed_kmh": 400,
        "measurements": [
            {"quantity": "range_km", "value": 400, "conditions": {"regime": "ifr", "load": "mtow"}, "confidence": "manufacturer-stated"},
            {"quantity": "takeoff_distance_m", "value": 800, "conditions": {"surface": "paved"}},
            {"quantity": "takeoff_distance_m", "value": 1000, "conditions": {"surface": "grass"}},
        ],
    }

    def test_match_by_context(self):
        self.assertEqual(plane_schema.select(self.PLANE, "range_km", {"regime": "ifr"}), 400)
        self.assertEqual(plane_schema.select(self.PLANE, "takeoff_distance_m", {"surface": "grass"}), 1000)
        self.assertEqual(plane_schema.select(self.PLANE, "takeoff_distance_m", {"surface": "paved"}), 800)

    def test_conflict_falls_to_scalar(self):
        self.assertEqual(plane_schema.select(self.PLANE, "range_km", {"regime": "vfr"}), 500)

    def test_no_context_returns_scalar_default(self):
        # a conditioned measurement must NOT hijack a context-free lookup
        self.assertEqual(plane_schema.select(self.PLANE, "range_km"), 500)

    def test_case_insensitive(self):
        self.assertEqual(plane_schema.select(self.PLANE, "range_km", {"regime": "IFR"}), 400)

    def test_confidence_tiebreak(self):
        plane = {"id": "t", "name": "T", "battery_kwh": 1, "range_km": 100, "speed_kmh": 100,
                 "measurements": [
                     {"quantity": "range_km", "value": 110, "conditions": {"regime": "ifr"}, "confidence": "estimated"},
                     {"quantity": "range_km", "value": 120, "conditions": {"regime": "ifr"}, "confidence": "certified"}]}
        self.assertEqual(plane_schema.select(plane, "range_km", {"regime": "ifr"}), 120)


class TestUsableRange(unittest.TestCase):
    BETA = {"id": "b", "name": "B", "battery_kwh": 225, "range_km": 630, "speed_kmh": 250}

    def test_vfr_build_down(self):
        # 630 gross ×0.7 (30% min-SoC floor) = 441, − 125 (30 min @ 250) = 316
        self.assertAlmostEqual(plane_schema.usable_range(self.BETA, "vfr"), 316.0, places=1)

    def test_ifr_build_down(self):
        # 441 − 187.5 (45 min @ 250) = 253.5
        self.assertAlmostEqual(plane_schema.usable_range(self.BETA, "ifr"), 253.5, places=1)

    def test_ifr_alternate_and_routing_trim_further(self):
        self.assertLess(plane_schema.usable_range(self.BETA, "ifr", alternate_km=50, routing_factor=1.05), 253.5)

    def test_min_soc_override(self):
        # min_soc 0 → base = gross → vfr = 630 − 125 = 505
        self.assertAlmostEqual(plane_schema.usable_range(self.BETA, "vfr", min_soc=0), 505.0, places=1)

    def test_explicit_usable_measurement_wins(self):
        v = {"id": "v", "name": "V", "battery_kwh": 600, "range_km": 500, "speed_kmh": 400,
             "measurements": [{"quantity": "range_km", "value": 400,
                               "conditions": {"regime": "ifr", "load": "mtow"},
                               "basis": "usable_incl_reserve"}]}
        self.assertEqual(plane_schema.usable_range(v, "ifr", {"load": "mtow"}), 400)

    def test_catalog_beta_gross_630(self):
        beta = next(p for p in _catalog() if plane_schema.value(p, "id") == "beta_plane")
        # live scalar swapped to the 630 gross in the S2+S3 cutover (ePerKm = batt/range_km must match it)
        self.assertEqual(plane_schema.value(beta, "range_km"), 630)
        gross = plane_schema.select_measurement(beta, "range_km", {})
        self.assertEqual(gross["value"], 630)
        self.assertEqual(gross["basis"], "gross")
        self.assertAlmostEqual(plane_schema.usable_range(beta, "vfr"), 316.0, places=1)   # 630×0.7 − 125
        self.assertAlmostEqual(plane_schema.usable_range(beta, "ifr"), 253.5, places=1)   # 441 − 187.5


class TestMeasurementsValidation(unittest.TestCase):
    BASE = {"id": "x", "name": "X", "battery_kwh": 10, "range_km": 100, "speed_kmh": 200, "ifr_capable": True}

    def _errs(self, meas):
        return plane_schema.validate([{**self.BASE, "measurements": meas}])[0]

    def test_unknown_quantity(self):
        self.assertTrue(any("wibble" in m for _, m in self._errs([{"quantity": "wibble", "value": 1}])))

    def test_value_type_checked_against_quantity(self):
        self.assertTrue(any("range_km" in m for _, m in self._errs([{"quantity": "range_km", "value": "lots"}])))

    def test_bad_confidence(self):
        self.assertTrue(any("confidence" in m for _, m in
                            self._errs([{"quantity": "range_km", "value": 100, "confidence": "vibes"}])))

    def test_catalog_vaeridion_has_ifr_range(self):
        v = next(p for p in _catalog() if plane_schema.value(p, "id") == "vaeridion")
        self.assertEqual(plane_schema.select(v, "range_km", {"regime": "ifr", "load": "mtow"}), 400)
        self.assertEqual(plane_schema.select(v, "takeoff_distance_m", {"surface": "grass"}), 1000)


if __name__ == "__main__":
    unittest.main()
