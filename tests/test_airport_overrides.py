"""Reinstated airports (airport_overrides.py): the curated rows the prepare scripts add back to the raw
OurAirports dumps, and the generated files carrying them (EGCN Doncaster Sheffield)."""
import csv
import json
import os
import unittest

from tests._helpers import REPO_ROOT

try:
    import pandas as pd
    import airport_overrides as O
    import world_data as W
except ImportError:  # pandas is a dev dependency (requirements-dev.txt)
    pd = None


def _raw():
    """A miniature raw dump: the closed field OurAirports keeps, plus one paved and one grass neighbour."""
    airports = pd.DataFrame([
        {"id": 1, "ident": "GB-1212", "type": "closed", "name": "Doncaster Sheffield Airport",
         "latitude_deg": 53.475287, "longitude_deg": -1.004267, "iso_country": "GB"},
        {"id": 2, "ident": "EGNE", "type": "small_airport", "name": "Retford Gamston Airport",
         "latitude_deg": 53.280602, "longitude_deg": -0.951389, "iso_country": "GB"},
        {"id": 3, "ident": "EGCF", "type": "small_airport", "name": "Sandtoft Airfield",
         "latitude_deg": 53.559358, "longitude_deg": -0.859043, "iso_country": "GB"},
    ])
    runways = pd.DataFrame([
        {"airport_ident": "EGNE", "surface": "ASP", "length_ft": "3934", "closed": "0"},
        {"airport_ident": "EGCF", "surface": "GRS", "length_ft": "2900", "closed": "0"},
    ])
    return airports, runways


@unittest.skipIf(pd is None, "pandas not installed")
class ApplyReinstated(unittest.TestCase):
    def test_adds_the_airport_and_its_runway_and_keeps_the_closed_row(self):
        airports, runways = _raw()
        a2, r2 = O.apply_reinstated(airports, runways)
        self.assertEqual(len(airports), 3)                        # inputs untouched
        self.assertIn("GB-1212", set(a2["ident"]))                # old ident still resolvable via the index
        egcn = a2[a2["ident"] == "EGCN"].iloc[0]
        self.assertEqual(egcn["iata_code"], "DSA")
        self.assertEqual(egcn["type"], "medium_airport")
        rw = r2[r2["airport_ident"] == "EGCN"].iloc[0]
        self.assertEqual((rw["surface"], rw["length_ft"], rw["closed"]), ("ASP", "9491", "0"))

    def test_upstream_row_wins_when_the_ident_is_listed_again(self):
        airports, runways = _raw()
        listed = pd.concat([airports, pd.DataFrame([{"id": 9, "ident": "EGCN", "type": "large_airport",
                                                     "name": "Upstream", "latitude_deg": 53.48, "longitude_deg": -1.0}])],
                           ignore_index=True)
        a2, r2 = O.apply_reinstated(listed, runways)
        self.assertEqual((a2["ident"] == "EGCN").sum(), 1)
        self.assertEqual(a2[a2["ident"] == "EGCN"].iloc[0]["name"], "Upstream")
        self.assertEqual(len(r2), len(runways))

    def test_the_world_build_selects_it_with_derived_columns(self):
        df = W.build_world(*O.apply_reinstated(*_raw())).set_index("ident")
        self.assertNotIn("GB-1212", df.index)                     # the closed row stays out of the planner set
        self.assertEqual(int(df.loc["EGCN", "rwy_paved_m"]), round(9491 * 0.3048))
        self.assertEqual(df.loc["EGCN", "alternate_ident"], "EGNE")
        self.assertEqual(df.loc["EGCF", "alternate_ident"], "EGCN")   # nearer than Gamston, so its new alternate

    def test_curated_ids_sit_outside_the_ourairports_range(self):
        for entry in O.REINSTATED:
            self.assertGreater(entry["airport"]["id"], O.CURATED_ID_BASE)


@unittest.skipIf(pd is None or not os.path.exists(os.path.join(REPO_ROOT, "world_airports.csv")), "no generated world set")
class GeneratedFilesCarryEGCN(unittest.TestCase):
    def _row(self, name):
        df = pd.read_csv(os.path.join(REPO_ROOT, name), keep_default_na=False, na_values=[""]).set_index("ident")
        return df

    def test_both_planner_sets_list_it_with_its_runway_and_alternate(self):
        for name in ("european_airports.csv", "world_airports.csv"):
            df = self._row(name)
            self.assertEqual(df.loc["EGCN", "iata_code"], "DSA", name)
            self.assertEqual(int(df.loc["EGCN", "rwy_paved_m"]), 2893, name)
            self.assertEqual(df.loc["EGCN", "alternate_ident"], "EGNE", name)
            # neighbours nearer to Doncaster than to their old alternate now divert there
            for ident in ("EGCF", "GB-0289", "GB-0427"):
                self.assertEqual(df.loc[ident, "alternate_ident"], "EGCN", f"{name} {ident}")
            # an eVTOL diverts to the nearest airport of any kind: Finningley's strip, 5.6 km
            self.assertEqual(df.loc["EGCN", "vtol_alternate_ident"], "GB-0289", name)
            self.assertAlmostEqual(float(df.loc["EGCN", "vtol_alternate_km"]), 5.56, places=2)

    def test_the_browser_feed_lists_it(self):
        with open(os.path.join(REPO_ROOT, "static", "geo", "airports-world.json"), encoding="utf-8") as fh:
            recs = {r["ident"]: r for r in W.unpack_feed(json.load(fh))}
        self.assertEqual(recs["EGCN"]["iata_code"], "DSA")
        self.assertEqual(recs["EGCN"]["rwy_paved_m"], 2893)
        self.assertEqual(recs["EGCF"]["alternate_ident"], "EGCN")
        self.assertEqual(recs["EGCN"]["vtol_alternate_ident"], "GB-0289")

    def test_the_resolver_index_knows_the_new_and_the_old_ident(self):
        with open(os.path.join(REPO_ROOT, "airports_index.csv"), newline="", encoding="utf-8") as fh:
            idx = {r["ident"]: r for r in csv.DictReader(fh)}
        self.assertEqual(idx["EGCN"]["iata_code"], "DSA")
        self.assertIn("GB-1212", idx)     # saved links built on the closed ident keep resolving


if __name__ == "__main__":
    unittest.main()
