"""Pytest shim. The suite is written for `python -m unittest discover -s tests`,
which puts this directory on sys.path so tests can `from _helpers import …`.
Pytest does not (tests/ is a package via __init__.py, so its rootdir insertion
doesn't help) — add the path here so `pytest tests/` collects cleanly too.
The repo root is added as well so `import sim` works regardless of cwd."""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
for p in (_HERE, os.path.dirname(_HERE)):
    if p not in sys.path:
        sys.path.insert(0, p)
