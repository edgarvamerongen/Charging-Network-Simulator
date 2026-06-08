"""Pre-compute each airport's nearest *other* airport and bake it into
european_airports.csv as two columns:
    alternate_km    great-circle distance (km) to that nearest airport
    alternate_ident the nearest airport's `ident`

The route planner reserves divert energy from `alternate_km`; the map overlay
draws the alternate by resolving `alternate_ident`. Dependency-light: numpy only
(no scipy). A chunked brute-force NN over ~7.8k points is a one-shot, ~1 s job.

Run as a script to augment the committed CSV in place:
    ./venv/bin/python airport_alternates.py
"""
import numpy as np
import pandas as pd

EARTH_KM = 6371.0


def nearest_alternate(lats, lons, chunk=512):
    """(km, idx): for each point, the great-circle distance (km) to its nearest
    *other* point and that other point's row index.

    lats, lons: 1-D array-likes of degrees, equal length n. Vectorised in
    row-chunks so peak memory is O(chunk * n), not O(n**2).
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
    out_km = np.empty(n, dtype=float)
    out_idx = np.empty(n, dtype=np.int64)
    for s in range(0, n, chunk):
        e = min(s + chunk, n)
        # |a - b|**2 = 2 - 2 a.b on the unit sphere -> (e-s, n)
        d2 = 2.0 - 2.0 * (pts[s:e] @ pts.T)
        d2[np.arange(e - s), np.arange(s, e)] = np.inf   # exclude self
        # Clamp fp noise (both negative and sub-epsilon positive) to 0.
        # On the unit sphere 2-2a.b is in [0,4]; values below ~9e-16 (4*eps)
        # are pure rounding error (e.g. two identical points give ~4e-16).
        d2 = np.where(d2 < 4.0 * np.finfo(float).eps, 0.0, d2)
        j = d2.argmin(axis=1)
        chord = np.sqrt(d2[np.arange(e - s), j])
        out_km[s:e] = EARTH_KM * 2.0 * np.arcsin(np.clip(chord / 2.0, 0.0, 1.0))
        out_idx[s:e] = j
    return out_km, out_idx


def nearest_alternate_km(lats, lons, chunk=512):
    """Great-circle km to each point's nearest *other* point (see
    nearest_alternate)."""
    return nearest_alternate(lats, lons, chunk)[0]


def augment_csv(path="european_airports.csv"):
    """Read the airport CSV, (re)compute the alternate columns, write back."""
    df = pd.read_csv(path)
    km, idx = nearest_alternate(df["latitude_deg"].to_numpy(),
                                df["longitude_deg"].to_numpy())
    df["alternate_km"] = np.round(km, 3)
    df["alternate_ident"] = df["ident"].to_numpy()[idx]
    df.to_csv(path, index=False)
    return df


if __name__ == "__main__":
    out = augment_csv()
    col = out["alternate_km"]
    print(f"Wrote alternate_km/alternate_ident for {len(out)} airports "
          f"(min {col.min():.1f} km, median {col.median():.1f} km, "
          f"max {col.max():.1f} km).")
