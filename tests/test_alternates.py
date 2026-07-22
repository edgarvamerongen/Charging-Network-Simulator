"""Tests for the pre-baked nearest-alternate columns (airport_alternates.py)
and their passthrough into the /api/airports payload."""
import unittest

from _helpers import REPO_ROOT  # noqa: F401  (ensures repo root is importable)
from airport_alternates import (nearest_alternate, nearest_alternate_km,
                                suitable_alternate_idents)


class TestNearestAlternate(unittest.TestCase):
    def test_two_near_one_far(self):
        # Points 0 and 1 are ~1 deg of longitude apart on the equator
        # (~111.19 km); point 2 is in central Asia, far from both.
        lats = [0.0, 0.0, 50.0]
        lons = [0.0, 1.0, 50.0]
        km = nearest_alternate_km(lats, lons)
        self.assertAlmostEqual(km[0], 111.19, delta=1.0)
        self.assertAlmostEqual(km[1], 111.19, delta=1.0)
        self.assertGreater(km[2], 5000.0)  # remote -> nearest is far

    def test_returns_index_of_nearest(self):
        lats = [0.0, 0.0, 50.0]
        lons = [0.0, 1.0, 50.0]
        km, idx = nearest_alternate(lats, lons)
        self.assertEqual(int(idx[0]), 1)   # point 0's nearest is point 1
        self.assertEqual(int(idx[1]), 0)   # and vice-versa
        self.assertAlmostEqual(km[0], 111.19, delta=1.0)

    def test_excludes_self(self):
        # Two airports at the SAME coordinate: each one's nearest *other*
        # airport is the duplicate at 0 km. The point must never match itself.
        km = nearest_alternate_km([10.0, 10.0], [10.0, 10.0])
        self.assertAlmostEqual(km[0], 0.0, places=6)
        self.assertAlmostEqual(km[1], 0.0, places=6)

    def test_matches_independent_haversine(self):
        # Cross-check every point against sim.haversine (a separate impl).
        from sim import haversine
        lats = [52.0, 48.0, 51.5, 45.0]
        lons = [5.0, 8.0, 0.0, 12.0]
        km = nearest_alternate_km(lats, lons)
        for i in range(len(lats)):
            ref = min(haversine(lats[i], lons[i], lats[j], lons[j])
                      for j in range(len(lats)) if j != i)
            self.assertAlmostEqual(km[i], ref, delta=0.5)

    def test_candidate_mask_restricts_targets(self):
        # Equator points at lon 0,1,2,3; only points 0 and 3 are eligible
        # alternates. Each point must resolve to the nearest *eligible* point,
        # never itself.
        km, idx = nearest_alternate([0, 0, 0, 0], [0, 1, 2, 3],
                                    candidate_mask=[True, False, False, True])
        self.assertEqual(list(idx), [3, 0, 3, 0])   # 0->3, 1->0, 2->3, 3->0
        self.assertAlmostEqual(km[1], 111.19, delta=1.0)   # lon1 -> lon0
        self.assertAlmostEqual(km[0], 333.58, delta=1.5)   # lon0 -> lon3 (self excluded)


class TestSuitability(unittest.TestCase):
    def test_is_paved(self):
        from airport_alternates import _is_paved
        for s in ["ASP", "ASPH", "ASPHALT", "CON", "CONC", "CONCRETE", "ASPH/ CONC", "BIT"]:
            self.assertTrue(_is_paved(s), s)
        for s in ["TURF", "GRS", "GRASS", "GRE", "GVL", "GRAVEL", "DIRT", "WATER", "UNK", "", None]:
            self.assertFalse(_is_paved(s), repr(s))

    def test_suitable_requires_open_paved_min_length(self):
        import pandas as pd
        rw = pd.DataFrame([
            {"airport_ident": "PAVED_LONG",   "length_ft": "3000", "surface": "ASP",   "closed": "0"},
            {"airport_ident": "GRASS_LONG",   "length_ft": "3000", "surface": "GRASS", "closed": "0"},
            {"airport_ident": "PAVED_SHORT",  "length_ft": "500",  "surface": "CON",   "closed": "0"},  # ~152 m
            {"airport_ident": "PAVED_CLOSED", "length_ft": "4000", "surface": "ASPH",  "closed": "1"},
            {"airport_ident": "NODATA",       "length_ft": "",     "surface": "",      "closed": "0"},
        ])
        # Only the open, paved, >=300 m runway qualifies.
        self.assertEqual(suitable_alternate_idents(rw), {"PAVED_LONG"})


class TestApiPassthrough(unittest.TestCase):
    def test_get_all_airports_includes_alternate_columns(self):
        from _helpers import make_sim
        rows = make_sim().get_all_airports()
        self.assertTrue(rows, "expected at least one airport row")
        self.assertIn("alternate_km", rows[0])
        self.assertIn("alternate_ident", rows[0])
        self.assertIsInstance(rows[0]["alternate_km"], (int, float))


class TestRunwayColumns(unittest.TestCase):
    """runway_length_columns: longest OPEN runway per surface category, meters."""

    def _df(self):
        import pandas as pd
        return pd.DataFrame({
            "airport_ident": ["X1", "X1", "X1", "X1", "X2", "X3"],
            "length_ft":     ["6562", "9843", "2625", "3281", "1509", "abc"],
            "surface":       ["ASPH", "CON",  "TURF", "grass", "GVL", "ASP"],
            "closed":        ["0",    "",     "0",    "1",     "0",   "0"],
        })

    def test_longest_open_per_category(self):
        from airport_alternates import runway_length_columns
        out = runway_length_columns(self._df())
        x1 = out.loc["X1"]
        self.assertEqual(int(x1["rwy_paved_m"]), 3000)   # 9843 ft CON beats 6562 ft ASPH
        self.assertEqual(int(x1["rwy_grass_m"]), 800)    # 2625 ft TURF; the 3281 ft grass row is CLOSED
        self.assertEqual(int(out.loc["X2", "rwy_gravel_m"]), 460)
        self.assertNotIn("X3", out.index)                # unparseable length -> no open runway rows at all

    def test_normalize_surface_tokens(self):
        from airport_alternates import normalize_surface
        for raw, want in (("ASPH", "paved"), ("Concrete", "paved"), ("TURF", "grass"),
                          ("Grass ", "grass"), ("GVL", "gravel"), ("SAND", "dirt"),
                          ("WATER", "water"), ("UNK", "unknown"), ("", "unknown"), (None, "unknown")):
            self.assertEqual(normalize_surface(raw), want, raw)

    def test_suitable_alternates_unchanged_by_new_code(self):
        # Regression: the baked-alternates filter must stay byte-stable — the new
        # display-layer categories live NEXT TO _is_paved, never inside it.
        self.assertEqual(suitable_alternate_idents(self._df()), {"X1"})


if __name__ == "__main__":
    unittest.main()
