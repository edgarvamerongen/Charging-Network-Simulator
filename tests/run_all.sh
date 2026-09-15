#!/usr/bin/env bash
#
# One-shot runner for the whole Charging Network Simulator test suite.
#   - Python unit/consistency/API tests (stdlib unittest, via ./venv/bin/python) —
#     needs `pip install -r requirements-dev.txt` (pulls in pandas, for tests/test_alternates.py)
#   - Node harnesses for the browser-global calc modules (settings/charging/demand/...),
#     all node:test files under tests/js_*.test.mjs, run via one `node --test` glob
#
# Usage:  bash tests/run_all.sh
# Exit code is nonzero if any layer fails.
#
# The API tests skip themselves automatically if http://localhost:5055 is down,
# so this is safe to run offline (you just lose end-to-end coverage).
set -u
cd "$(dirname "$0")/.."

PY=${PY:-./venv/bin/python}   # override for worktrees (no venv): PY=/abs/main-checkout/venv/bin/python bash tests/run_all.sh
rc=0

echo "=================================================================="
echo "PYTHON  (unittest):  $PY -m unittest discover -s tests"
echo "=================================================================="
"$PY" -m unittest discover -s tests -p "test_*.py" -v || rc=1

echo
echo "=================================================================="
echo "NODE  (browser-global calc modules + /v2 shell helpers):"
echo "=================================================================="
node --test tests/js_*.test.mjs || rc=1

echo
echo "=================================================================="
echo "GOLDEN  (flight-engine parity baseline — skips if :5055 is down):"
echo "=================================================================="
echo "--- node tests/golden_capture.mjs --check ---"
node tests/golden_capture.mjs --check || rc=1
echo
echo "--- node tests/sched_snapshot.mjs (DES parity gate, skips if :5055 down) ---"
node tests/sched_snapshot.mjs || rc=1
echo

echo "=================================================================="
if [ "$rc" -eq 0 ]; then echo "ALL LAYERS PASSED"; else echo "SOME TESTS FAILED (rc=$rc) — see output above"; fi
echo "=================================================================="
exit "$rc"
