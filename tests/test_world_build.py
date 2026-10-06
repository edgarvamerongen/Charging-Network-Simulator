"""World airport build (world_data.py): selection, derived columns, the columnar browser feed, and the
generated files' coverage of today's European idents."""
import json
import os
import unittest

from tests._helpers import REPO_ROOT

try:
    import pandas as pd
    import world_data as W
except ImportError:  # pandas is a dev dependency (requirements-dev.txt)
    pd = None


def _airports():
    rows = [
        # ident, type, lat, lon, country
        ("AAAA", "large_airport", 0.0, 0.0, "AA"),
        ("BBBB", "small_airport", 0.0, 1.0, "BB"),
        ("CCCC", "medium_airport", 0.0, 179.9, "NA"),     # Namibia's code must survive as text
        ("DDDD", "small_airport", 0.0, -179.9, "DD"),      # across the antimeridian from CCCC
        ("HELI", "heliport", 0.0, 0.5, "AA"),
        ("NOCO", "small_airport", None, None, "AA"),
    ]
    return pd.DataFrame([{"ident": i, "type": t, "latitude_deg": la, "longitude_deg": lo, "iso_country": c,
                          "name": i.title(), "municipality": None, "iata_code": None} for i, t, la, lo, c in rows])


def _runways():
    def rw(ident, surface, ft, closed="0"):
        return {"airport_ident": ident, "surface": surface, "length_ft": str(ft), "closed": closed}
    return pd.DataFrame([rw("AAAA", "ASP", 6000), rw("BBBB", "GRS", 2000), rw("CCCC", "CON", 4000), rw("DDDD", "ASP", 3000)])


@unittest.skipIf(pd is None, "pandas not installed")
class WorldBuild(unittest.TestCase):
    def test_selection_keeps_fixed_wing_airports_with_coordinates(self):
        df = W.select_airports(_airports())
        self.assertEqual(sorted(df["ident"]), ["AAAA", "BBBB", "CCCC", "DDDD"])

    def test_alternates_search_the_whole_set_and_cross_the_antimeridian(self):
        df = W.build_world(_airports(), _runways()).set_index("ident")
        self.assertEqual(df.loc["BBBB", "alternate_ident"], "AAAA")    # grass BBBB is no alternate; AAAA is
        self.assertEqual(df.loc["CCCC", "alternate_ident"], "DDDD")    # 0.2 deg away across 180, not 179.9 deg west
        self.assertLess(df.loc["CCCC", "alternate_km"], 30)
        self.assertEqual(int(df.loc["AAAA", "rwy_paved_m"]), round(6000 * 0.3048))

    def test_feed_round_trip_is_lossless(self):
        df = W.build_world(_airports(), _runways())
        feed = json.loads(json.dumps(W.columnar_feed(df)))
        recs = {r["ident"]: r for r in W.unpack_feed(feed)}
        self.assertEqual(feed["n"], 4)
        self.assertEqual(recs["CCCC"]["iso_country"], "NA")
        self.assertEqual(recs["CCCC"]["type"], "medium_airport")
        self.assertEqual(recs["BBBB"]["rwy_grass_m"], round(2000 * 0.3048))
        self.assertIsNone(recs["BBBB"]["rwy_paved_m"])
        self.assertAlmostEqual(recs["DDDD"]["longitude_deg"], -179.9)
        self.assertEqual(recs["BBBB"]["alternate_ident"], "AAAA")


@unittest.skipIf(pd is None or not os.path.exists(os.path.join(REPO_ROOT, "world_airports.csv")), "no generated world set")
class GeneratedWorldSet(unittest.TestCase):
    def test_every_european_ident_is_in_the_world_set(self):
        eu = set(pd.read_csv(os.path.join(REPO_ROOT, "european_airports.csv"), usecols=["ident"])["ident"])
        world = set(pd.read_csv(os.path.join(REPO_ROOT, "world_airports.csv"), usecols=["ident"], keep_default_na=False)["ident"])
        missing = sorted(eu - world)
        # OurAirports retires a few idents between dumps; saved networks keep their own coordinates.
        self.assertLess(len(missing), len(eu) * 0.01, f"{len(missing)} European idents missing, e.g. {missing[:10]}")

    def test_the_feed_matches_the_csv(self):
        with open(os.path.join(REPO_ROOT, "static", "geo", "airports-world.json"), encoding="utf-8") as fh:
            feed = json.load(fh)
        n = len(pd.read_csv(os.path.join(REPO_ROOT, "world_airports.csv"), usecols=["ident"]))
        self.assertEqual(feed["n"], n)
        self.assertTrue(all(len(v) == n for v in feed["f"].values()))
        idx = feed["f"]["i"]
        for ident in ("NZQN", "EHAM", "KJFK", "FAOR"):   # Queenstown, Schiphol, JFK, Johannesburg
            self.assertIn(ident, idx)


if __name__ == "__main__":
    unittest.main()
