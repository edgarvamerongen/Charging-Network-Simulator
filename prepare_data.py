import os
import sys

import pandas as pd
from airport_alternates import compute_alternate_columns, runway_length_columns

# The raw OurAirports dumps are gitignored (only the generated
# european_airports.csv is tracked) — fail with a pointer, not a stack trace.
_RAW_INPUTS = ("airports.csv", "countries.csv", "runways.csv")
_missing = [f for f in _RAW_INPUTS if not os.path.exists(f)]
if _missing:
    sys.exit(
        f"Missing raw input file(s): {', '.join(_missing)}. Download the "
        "OurAirports dumps (https://ourairports.com/data/) into this directory "
        "first — they are gitignored and only needed to regenerate "
        "european_airports.csv."
    )

# Load datasets
airports = pd.read_csv("airports.csv")
countries = pd.read_csv("countries.csv")

# -----------------------------------------
# Filter European countries
# -----------------------------------------
# Assumes countries.csv has a column like:
# continent or continent_code

european_countries = countries[
    countries["continent"].isin(["EU", "Europe"])
]

# Get ISO country codes
europe_codes = set(european_countries["code"])

# -----------------------------------------
# Filter airport types
# -----------------------------------------
valid_types = [
    "small_airport",
    "medium_airport",
    "large_airport"
]

# -----------------------------------------
# Filter airports
# -----------------------------------------
eu_airports = airports[
    (airports["type"].isin(valid_types)) &
    (airports["iso_country"].isin(europe_codes))
]

# Optional: remove rows without coordinates
eu_airports = eu_airports.dropna(
    subset=["latitude_deg", "longitude_deg"]
)

# -----------------------------------------
# Pre-bake each airport's nearest *suitable* alternate (nearest airport with a
# paved runway, from runways.csv) so the planner can reserve divert energy and
# the map can draw the alternate, without any runtime search.
# -----------------------------------------
eu_airports = eu_airports.copy()
runways = pd.read_csv("runways.csv", dtype=str)
eu_airports["alternate_km"], eu_airports["alternate_ident"] = \
    compute_alternate_columns(eu_airports, runways)

# Longest OPEN runway per surface category (rwy_paved_m, rwy_grass_m, ...) for
# the airport-card display — same source file, display-layer categories.
eu_airports = eu_airports.merge(runway_length_columns(runways),
                                how="left", left_on="ident", right_index=True)

# -----------------------------------------
# Save result
# -----------------------------------------
eu_airports.to_csv("european_airports.csv", index=False)

# -----------------------------------------
# Preview
# -----------------------------------------
print(eu_airports[[
    "name",
    "type",
    "iso_country",
    "municipality",
    "latitude_deg",
    "longitude_deg"
]].head())

print(f"\nTotal European airports: {len(eu_airports)}")