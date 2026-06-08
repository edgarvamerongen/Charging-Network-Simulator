import random
import numpy as np

import pandas as pd
from airport_alternates import nearest_alternate

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
# Pre-bake each airport's nearest neighbour so the route planner can reserve
# divert energy and the map can draw the alternate, without any runtime search.
# -----------------------------------------
eu_airports = eu_airports.copy()
_alt_km, _alt_idx = nearest_alternate(eu_airports["latitude_deg"].to_numpy(),
                                      eu_airports["longitude_deg"].to_numpy())
eu_airports["alternate_km"] = np.round(_alt_km, 3)
eu_airports["alternate_ident"] = eu_airports["ident"].to_numpy()[_alt_idx]

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