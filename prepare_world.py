"""Build the world airport set from the OurAirports dumps.

    ./venv/bin/python prepare_world.py [--src DIR]

DIR holds airports.csv and runways.csv (https://ourairports.com/data/; gitignored, default: this
directory). Writes world_airports.csv (what sim.py loads; same schema as european_airports.csv)
and static/geo/airports-world.json (the compact feed the v2 page loads). The classic and mobile
views keep european_airports.csv (prepare_data.py).
"""
import argparse
import json
import os
import sys
import time

import pandas as pd

from world_data import build_world, columnar_feed

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", default=HERE, help="directory with airports.csv and runways.csv")
    args = ap.parse_args()
    paths = {n: os.path.join(args.src, n) for n in ("airports.csv", "runways.csv")}
    missing = [p for p in paths.values() if not os.path.exists(p)]
    if missing:
        sys.exit(f"Missing raw input file(s): {', '.join(missing)}. Download the OurAirports dumps "
                 "(https://ourairports.com/data/) first.")
    t0 = time.time()
    airports = pd.read_csv(paths["airports.csv"], keep_default_na=False, na_values=[""])
    runways = pd.read_csv(paths["runways.csv"], dtype=str)
    df = build_world(airports, runways)
    df.to_csv(os.path.join(HERE, "world_airports.csv"), index=False)
    feed = columnar_feed(df)
    os.makedirs(os.path.join(HERE, "static", "geo"), exist_ok=True)
    out = os.path.join(HERE, "static", "geo", "airports-world.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(feed, fh, separators=(",", ":"), ensure_ascii=False)
    print(f"{len(df)} airports ({df['type'].value_counts().to_dict()}), feed {os.path.getsize(out) / 1e6:.2f} MB, "
          f"hash {feed['hash']}, {time.time() - t0:.1f} s")


if __name__ == "__main__":
    main()
