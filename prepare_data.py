import random
import numpy as np

import pandas as pd
from airport_alternates import compute_alternate_columns

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