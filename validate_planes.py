#!/usr/bin/env python3
"""CLI validator for the aircraft catalog against planes.schema.json.

Usage:
    python3 validate_planes.py [path ...]      # defaults to planes.json (+ data/custom_planes.json if present)

Exit code is non-zero when any ERRORS are found (warnings never fail the run),
so this is CI-gateable. Stdlib-only — see plane_schema.py.
"""
import json
import os
import sys

import plane_schema

_HERE = os.path.dirname(os.path.abspath(__file__))


def _validate_file(path, schema):
    rel = os.path.relpath(path, _HERE)
    if not os.path.exists(path):
        print(f"-- {rel}: (absent, skipped)")
        return 0
    try:
        with open(path, "r") as f:
            planes = json.load(f)
    except (OSError, ValueError) as e:
        print(f"✗ {rel}: cannot parse JSON — {e}")
        return 1

    errors, warnings = plane_schema.validate(planes, schema)
    n = len(planes) if isinstance(planes, list) else "?"
    print(f"-- {rel}: {n} aircraft, {len(errors)} error(s), {len(warnings)} warning(s)")
    for pid, msg in warnings:
        print(f"   ⚠  {pid}: {msg}")
    for pid, msg in errors:
        print(f"   ✗  {pid}: {msg}")
    return len(errors)


def main(argv):
    schema = plane_schema.load_schema()
    paths = argv[1:]
    if not paths:
        paths = [os.path.join(_HERE, "planes.json")]
        custom = os.path.join(_HERE, "data", "custom_planes.json")
        if os.path.exists(custom):
            paths.append(custom)

    total = sum(_validate_file(p, schema) for p in paths)
    print()
    print("OK — catalog valid" if total == 0 else f"FAILED — {total} error(s)")
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
