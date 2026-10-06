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
# The API tests, golden check and DES gate run against a fixture-catalog server this
# script starts on :5098 (TEST_PORT), or on CNS_BASE_URL when given.
set -u
cd "$(dirname "$0")/.."

PY=${PY:-./venv/bin/python}   # override for worktrees (no venv): PY=/abs/main-checkout/venv/bin/python bash tests/run_all.sh
rc=0

# Every layer runs on the tracked fixture catalog; the dev servers run the Notion sync in data/.
export CNS_PLANES_FILE="${CNS_PLANES_FILE:-$PWD/tests/fixtures/planes.fixture.json}"
export CNS_AIRPORTS_FILE="${CNS_AIRPORTS_FILE:-$PWD/european_airports.csv}"   # never the generated world set
# The live-server layers (API tests, golden, DES gate) post fixture aircraft to /api/simulate, so
# they get their own short-lived server on that catalog. CNS_BASE_URL=... uses a running one instead.
if [ -z "${CNS_BASE_URL:-}" ]; then
  export CNS_BASE_URL="http://127.0.0.1:${TEST_PORT:-5098}"
  if curl -s -o /dev/null "$CNS_BASE_URL/healthz"; then echo "port ${TEST_PORT:-5098} is busy: set TEST_PORT or CNS_BASE_URL"; exit 1; fi
  PORT=${TEST_PORT:-5098} DYLD_FALLBACK_LIBRARY_PATH=${DYLD_FALLBACK_LIBRARY_PATH:-/opt/homebrew/lib} "$PY" app.py > "${TMPDIR:-/tmp}/cns-test-server.log" 2>&1 &
  SRV=$!; trap 'kill $SRV 2>/dev/null' EXIT
  for _ in $(seq 1 80); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$CNS_BASE_URL/healthz")" = 200 ] && break; sleep 0.25; done
fi

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
echo "GOLDEN  (flight-engine parity baseline, on $CNS_BASE_URL):"
echo "=================================================================="
echo "--- node tests/golden_capture.mjs --check ---"
node tests/golden_capture.mjs --check || rc=1
echo
echo "--- node tests/sched_snapshot.mjs (DES parity gate) ---"
node tests/sched_snapshot.mjs || rc=1
echo

echo "=================================================================="
if [ "$rc" -eq 0 ]; then echo "ALL LAYERS PASSED"; else echo "SOME TESTS FAILED (rc=$rc) — see output above"; fi
echo "=================================================================="
exit "$rc"
