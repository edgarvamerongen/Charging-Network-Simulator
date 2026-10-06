"""World airport set: the build behind world_airports.csv and the v2 browser feed.

Pure functions (pandas + numpy), so the build is testable without the OurAirports
dumps; prepare_world.py is the CLI that reads the dumps and writes the outputs.

The set is every OurAirports small, medium and large airport with coordinates, with
the same derived columns european_airports.csv carries (runway lengths per surface,
nearest suitable divert alternate). The alternate search runs over the WHOLE set, so
an airport near a region boundary can divert across it.

The browser feed is columnar (one array per field, short keys) so ~48,000 airports
ship as a few MB of JSON that gzips to ~1 MB; app.js unpacks it into the same
records /api/airports serves.
"""
import hashlib
import json
import math

import pandas as pd

from airport_alternates import compute_alternate_columns, runway_length_columns

TYPES = ("small_airport", "medium_airport", "large_airport")
RWY_COLS = ("rwy_paved_m", "rwy_grass_m", "rwy_gravel_m", "rwy_dirt_m", "rwy_water_m", "rwy_unknown_m")
# feed key -> record field (app.js unpacks with the same table)
FEED_FIELDS = {
    "i": "ident", "n": "name", "t": "type", "la": "latitude_deg", "lo": "longitude_deg",
    "c": "iso_country", "m": "municipality", "a": "iata_code",
    "ak": "alternate_km", "ai": "alternate_ident",
    "rp": "rwy_paved_m", "rg": "rwy_grass_m", "rv": "rwy_gravel_m",
    "rd": "rwy_dirt_m", "rw": "rwy_water_m", "ru": "rwy_unknown_m",
}
FEED_VERSION = 1


def select_airports(airports_df):
    """Small, medium and large airports that have coordinates (heliports, seaplane bases, closed fields out)."""
    df = airports_df[airports_df["type"].isin(TYPES)]
    return df.dropna(subset=["latitude_deg", "longitude_deg"]).copy()


def build_world(airports_df, runways_df):
    """The world set with european_airports.csv's derived columns: alternate_km, alternate_ident, rwy_*_m."""
    df = select_airports(airports_df).reset_index(drop=True)
    df["alternate_km"], df["alternate_ident"] = compute_alternate_columns(df, runways_df)
    return df.merge(runway_length_columns(runways_df), how="left", left_on="ident", right_index=True)


def _clean(v, kind):
    if v is None or (isinstance(v, float) and math.isnan(v)) or v is pd.NA:
        return None
    if kind == "s":
        s = str(v).strip()
        return s or None
    if kind == "i":
        return int(round(float(v)))
    return float(v)


def columnar_feed(df):
    """The compact browser feed: {v, hash, n, f: {key: [values...]}}. Coordinates to 5 decimals (~1 m),
    alternate km to 0.1, runway metres as integers, type as 0/1/2 (small/medium/large); missing -> null."""
    f = {}
    for key, col in FEED_FIELDS.items():
        vals = df[col].tolist() if col in df.columns else [None] * len(df)
        if key == "t":
            f[key] = [TYPES.index(v) for v in vals]
        elif key in ("la", "lo"):
            f[key] = [round(float(v), 5) for v in vals]
        elif key == "ak":
            f[key] = [None if _clean(v, "f") is None else round(float(v), 1) for v in vals]
        elif key.startswith("r") and len(key) == 2:
            f[key] = [_clean(v, "i") for v in vals]
        else:
            f[key] = [_clean(v, "s") for v in vals]
    body = json.dumps(f, separators=(",", ":"), ensure_ascii=False)
    return {"v": FEED_VERSION, "hash": hashlib.sha1(body.encode("utf-8")).hexdigest()[:12], "n": len(df), "f": f}


def unpack_feed(feed):
    """The inverse of columnar_feed, as app.js does it: a list of airport records."""
    f, out = feed["f"], []
    for k in range(feed["n"]):
        rec = {}
        for key, col in FEED_FIELDS.items():
            v = f[key][k]
            rec[col] = TYPES[v] if key == "t" else v
        out.append(rec)
    return out
