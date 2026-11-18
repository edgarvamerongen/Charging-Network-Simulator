"""Curated corrections to the raw OurAirports dumps, applied before every regeneration.

prepare_data.py (european_airports.csv + airports_index.csv) and prepare_world.py
(world_airports.csv + static/geo/airports-world.json) both run apply_reinstated() on the
raw airports/runways frames right after loading them, so a rebuild keeps these rows.

REINSTATED: airports OurAirports has retired as closed (type 'closed', ident moved to a
national GB-xxxx style code), which drops them from every CNS set, but that CNS still
plans networks for because a reopening is under way. Each entry adds the airport back
under its real ICAO code with the runway OurAirports no longer lists as open. The closed
row stays in the raw data, so airports_index.csv keeps resolving the old ident and
saved links that used it keep working.

When OurAirports lists the ident again, its own row wins and the curated one is skipped.
Curated rows get ids from CURATED_ID_BASE up, far outside OurAirports' id range (the
column is carried through the CSVs but nothing reads it).
"""

import pandas as pd

CURATED_ID_BASE = 9_000_000

REINSTATED = [
    {
        # Closed 30 Nov 2022 (passenger flights ended 4 Nov 2022). City of Doncaster took a
        # 125-year lease (Mar 2024); the South Yorkshire Mayoral Combined Authority set a
        # £138m reopening budget (Nov 2024); Munich Airport International was appointed
        # operator (Feb 2025); commercial flights are expected from 2028 at the earliest.
        # Source: https://en.wikipedia.org/wiki/Doncaster_Sheffield_Airport (read 2026-11-18).
        "closed_ident": "GB-1212",
        "airport": {
            "id": CURATED_ID_BASE + 1,
            "ident": "EGCN",
            "type": "medium_airport",
            "name": "Doncaster Sheffield Airport (Robin Hood)",
            "latitude_deg": 53.475287,
            "longitude_deg": -1.004267,
            "elevation_ft": 56,
            "continent": "EU",
            "iso_country": "GB",
            "iso_region": "GB-ENG",
            "municipality": "Doncaster, South Yorkshire",
            "scheduled_service": "no",
            "icao_code": "EGCN",
            "iata_code": "DSA",
            "gps_code": "EGCN",
            "wikipedia_link": "https://en.wikipedia.org/wiki/Doncaster_Sheffield_Airport",
            "keywords": "Robin Hood Airport, RAF Finningley, reopening",
        },
        "runways": [
            # 02/20, 2,893 m x 60 m asphalt (9,491 ft x 197 ft).
            {"id": CURATED_ID_BASE + 1, "length_ft": 9491, "width_ft": 197, "surface": "ASP",
             "lighted": 1, "closed": 0, "le_ident": "02", "he_ident": "20"},
        ],
    },
]


def apply_reinstated(airports_df, runways_df, entries=None):
    """(airports_df, runways_df) with every REINSTATED airport and its runways appended.

    Pure: returns new frames and leaves the inputs alone. An entry whose ident the raw
    airports already list is skipped (OurAirports' own row wins). New runway cells are
    strings, matching the dtype=str the prepare scripts read runways.csv with."""
    entries = REINSTATED if entries is None else entries
    present = set(airports_df["ident"])
    new_airports, new_runways = [], []
    for entry in entries:
        ap = entry["airport"]
        if ap["ident"] in present:
            continue
        new_airports.append(dict(ap))
        for rw in entry["runways"]:
            new_runways.append({k: str(v) for k, v in
                                {**rw, "airport_ref": ap["id"], "airport_ident": ap["ident"]}.items()})
    if new_airports:
        airports_df = pd.concat([airports_df, pd.DataFrame(new_airports)], ignore_index=True)
    if new_runways:
        runways_df = pd.concat([runways_df, pd.DataFrame(new_runways)], ignore_index=True)
    return airports_df, runways_df
