"""Pre-compute each airport's nearest *suitable* alternate and bake it into
european_airports.csv as two columns:
    alternate_km    great-circle distance (km) to that nearest alternate
    alternate_ident the alternate airport's `ident`

An *alternate* is somewhere a flight could actually divert to and land, so it
must be a real airport with a paved runway — not a glider field, grass strip, or
an undocumented site. Suitability is derived from the OurAirports `runways.csv`
export (`surface`, `length_ft`, `closed`); see `suitable_alternate_idents`.

The route planner reserves divert energy from `alternate_km`; the map overlay
draws the alternate by resolving `alternate_ident`. Dependency-light: numpy +
pandas (no scipy). A chunked brute-force NN over ~7.8k points is a one-shot job.

Run as a script to augment the committed CSV in place (needs runways.csv beside
european_airports.csv):
    ./venv/bin/python airport_alternates.py
"""
import numpy as np
import pandas as pd

EARTH_KM = 6371.0

# --- runway suitability --------------------------------------------------------
# OurAirports `surface` is messy free-text; these substrings cover the paved
# families (asphalt / concrete / bitumen / tarmac / macadam / sealed). Grass,
# turf, gravel, dirt, water and unknown ('UNK', '') are treated as NOT paved.
_PAVED_TOKENS = ("ASP", "CON", "BIT", "TAR", "MAC", "SEAL", "PAV")
# Minimum runway the fleet's short-field aircraft (Velis / CX300 / Microliner)
# can use; also low enough to keep real GA strips while dropping data junk
# (16 m "runways", RC-model-club fields). The E9X wants more, but per-aircraft
# minimums are a later refinement — this is a single conservative fleet floor.
MIN_RUNWAY_M = 300
_MIN_RUNWAY_FT = MIN_RUNWAY_M / 0.3048


def _is_paved(surface):
    s = str(surface or "").upper()
    return any(tok in s for tok in _PAVED_TOKENS)


# --- surface categories (display layer) ----------------------------------------
# Full normalization of OurAirports' free-text `surface` into display categories
# for the airport card (paved / grass / gravel / dirt / water / unknown). Copied
# from the perf-engine branch's field_performance.py; when PR #30 merges, that
# module supersedes this copy and _PAVED_TOKENS above unifies with it. Kept
# SEPARATE from _is_paved so the baked alternate columns can never drift.
_SURFACE_KEYS = {
    "paved":  ("ASP", "ASPH", "CON", "CONC", "PEM", "PAVED", "BIT", "TAR", "MAC", "SEAL", "COP", "COM"),
    "grass":  ("TURF", "GRS", "GRE", "GRASS", "SOD", "LAWN"),
    "gravel": ("GVL", "GRVL", "GRAVEL", "PER", "LATERITE", "CORAL", "SHELL", "STONE"),
    "dirt":   ("DIRT", "EARTH", "CLAY", "SAND", "SAN", "GROUND", "SOIL", "NAT"),
    "water":  ("WATER", "WAT"),
}
RWY_CATEGORIES = ("paved", "grass", "gravel", "dirt", "water", "unknown")


def normalize_surface(raw):
    """Map a messy OurAirports surface string to one display category."""
    if raw is None:
        return "unknown"
    s = str(raw).strip().upper()
    if not s or s in ("UNK", "U", "X", "N", "NIL", "NONE", "?"):
        return "unknown"
    for cat, keys in _SURFACE_KEYS.items():
        if any(s.startswith(k) or k in s for k in keys):
            return cat
    return "unknown"


def runway_length_columns(runways_df):
    """Per-airport longest OPEN runway per surface category, in whole meters.

    Returns a DataFrame indexed by `airport_ident` with one nullable-int column
    per category: rwy_paved_m, rwy_grass_m, rwy_gravel_m, rwy_dirt_m,
    rwy_water_m, rwy_unknown_m. Airports absent from runways.csv simply don't
    appear (a later left-join leaves their cells blank). Pure — no file IO."""
    rw = runways_df
    length_ft = pd.to_numeric(rw["length_ft"], errors="coerce")
    closed = rw["closed"].fillna("0").astype(str).str.strip()
    open_ok = closed.isin(["0", ""]) & length_ft.notna() & (length_ft > 0)
    cat = rw["surface"].map(normalize_surface)
    frame = pd.DataFrame({
        "airport_ident": rw["airport_ident"],
        "cat": cat,
        "length_m": length_ft * 0.3048,
    })[open_ok]
    longest = (frame.groupby(["airport_ident", "cat"])["length_m"].max()
                    .round().astype("Int64").unstack("cat"))
    longest = longest.reindex(columns=list(RWY_CATEGORIES))
    longest.columns = [f"rwy_{c}_m" for c in longest.columns]
    return longest


def augment_runway_columns(path="european_airports.csv", runways_path="runways.csv"):
    """Append/refresh ONLY the rwy_*_m columns on the airport CSV, leaving the
    baked alternate columns byte-identical (a newer local runways.csv must not
    shift alternate_ident). Idempotent: pre-existing rwy_* columns are replaced."""
    df = pd.read_csv(path)
    runways = pd.read_csv(runways_path, dtype=str)
    df = df.drop(columns=[c for c in df.columns if c.startswith("rwy_")])
    longest = runway_length_columns(runways)
    df = df.merge(longest, how="left", left_on="ident", right_index=True)
    df.to_csv(path, index=False)
    return df


def suitable_alternate_idents(runways_df):
    """Set of airport idents usable as a divert alternate: at least one OPEN,
    PAVED runway of length >= MIN_RUNWAY_M. Airports with no runway data, or
    only grass/short/closed runways, are excluded."""
    rw = runways_df
    length_ft = pd.to_numeric(rw["length_ft"], errors="coerce")
    closed = rw["closed"].fillna("0").astype(str).str.strip()
    paved = rw["surface"].map(_is_paved)
    ok = paved & closed.isin(["0", ""]) & (length_ft >= _MIN_RUNWAY_FT)
    return set(rw.loc[ok, "airport_ident"].dropna())


def nearest_alternate(lats, lons, candidate_mask=None, chunk=512):
    """(km, idx): for each input point, the great-circle distance (km) to its
    nearest *eligible* point and that point's row index.

    candidate_mask: optional boolean array (length n). When given, only points
    where the mask is True are eligible as an alternate (a point is never its
    own alternate). When None, every other point is eligible.

    lats, lons: 1-D array-likes of degrees, equal length n. Vectorised in
    row-chunks so peak memory is O(chunk * C), not O(n**2).
    """
    lat = np.radians(np.asarray(lats, dtype=float))
    lon = np.radians(np.asarray(lons, dtype=float))
    n = lat.size
    if lon.size != n:
        raise ValueError("lats and lons must have the same length")
    if n < 2:
        raise ValueError("nearest_alternate needs at least 2 points "
                         "(each point needs another to divert to)")
    # Unit-sphere xyz. Nearest by chord distance == nearest by great-circle
    # (monotonic), so argmin on chord, then convert the min chord to gc km.
    x = np.cos(lat) * np.cos(lon)
    y = np.cos(lat) * np.sin(lon)
    z = np.sin(lat)
    pts = np.stack([x, y, z], axis=1)            # (n, 3)

    if candidate_mask is None:
        cand_idx = np.arange(n)
    else:
        cand_idx = np.flatnonzero(np.asarray(candidate_mask, dtype=bool))
    if cand_idx.size == 0:
        raise ValueError("candidate_mask selects no eligible alternates")
    cand_pts = pts[cand_idx]                      # (C, 3)
    # Column of each global index within cand_idx, or -1 if not a candidate.
    col_of = np.full(n, -1, dtype=np.int64)
    col_of[cand_idx] = np.arange(cand_idx.size)

    out_km = np.empty(n, dtype=float)
    out_idx = np.empty(n, dtype=np.int64)
    for s in range(0, n, chunk):
        e = min(s + chunk, n)
        # |a - b|**2 = 2 - 2 a.b on the unit sphere -> (e-s, C)
        d2 = 2.0 - 2.0 * (pts[s:e] @ cand_pts.T)
        # Exclude self where a query row is itself a candidate.
        self_col = col_of[np.arange(s, e)]
        hit = self_col >= 0
        d2[np.flatnonzero(hit), self_col[hit]] = np.inf
        # Clamp fp noise (negative + sub-epsilon positive) to 0; on the unit
        # sphere 2-2a.b is in [0,4] and values below ~9e-16 (4*eps) are rounding
        # error (two identical points give ~4e-16).
        d2 = np.where(d2 < 4.0 * np.finfo(float).eps, 0.0, d2)
        j = d2.argmin(axis=1)
        chord = np.sqrt(d2[np.arange(e - s), j])
        out_km[s:e] = EARTH_KM * 2.0 * np.arcsin(np.clip(chord / 2.0, 0.0, 1.0))
        out_idx[s:e] = cand_idx[j]
    return out_km, out_idx


def nearest_alternate_km(lats, lons, chunk=512):
    """Great-circle km to each point's nearest *other* point (see
    nearest_alternate)."""
    return nearest_alternate(lats, lons, chunk=chunk)[0]


def compute_alternate_columns(airports_df, runways_df):
    """(alternate_km, alternate_ident) for airports_df, where each alternate is
    the nearest airport with a suitable paved runway (see
    suitable_alternate_idents). Every airport gets an alternate; remote ones
    just get a farther one."""
    suitable = suitable_alternate_idents(runways_df)
    mask = airports_df["ident"].isin(suitable).to_numpy()
    km, idx = nearest_alternate(airports_df["latitude_deg"].to_numpy(),
                                airports_df["longitude_deg"].to_numpy(),
                                candidate_mask=mask)
    return np.round(km, 3), airports_df["ident"].to_numpy()[idx]


def augment_csv(path="european_airports.csv", runways_path="runways.csv"):
    """Read the airport CSV + the OurAirports runways export, (re)compute the
    alternate columns (nearest airport with a suitable paved runway), write the
    airport CSV back in place."""
    df = pd.read_csv(path)
    runways = pd.read_csv(runways_path, dtype=str)
    df["alternate_km"], df["alternate_ident"] = compute_alternate_columns(df, runways)
    df.to_csv(path, index=False)
    return df


if __name__ == "__main__":
    import sys
    if "--runways-only" in sys.argv:
        out = augment_runway_columns()
        have = out[[c for c in out.columns if c.startswith("rwy_")]].notna().any(axis=1)
        print(f"Wrote rwy_*_m columns for {len(out)} airports "
              f"({int(have.sum())} with at least one runway category; "
              f"alternate columns untouched).")
    else:
        out = augment_csv()
        col = out["alternate_km"]
        n_used = out["alternate_ident"].nunique()
        print(f"Wrote alternate_km/alternate_ident for {len(out)} airports "
              f"-> {n_used} distinct paved alternates used "
              f"(min {col.min():.1f} km, median {col.median():.1f} km, "
              f"max {col.max():.1f} km).")
