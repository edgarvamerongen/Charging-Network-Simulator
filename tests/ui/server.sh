#!/usr/bin/env bash
# One local Flask server for the UI harness (tests/ui). Started FROM THIS WORKTREE on port 5097.
# Usage: bash tests/ui/server.sh start|stop|restart|status
# Everyone shares this server; never start a second one on the port. Only templates/*.html edits
# need a restart (Flask caches compiled templates); static JS/CSS is served fresh.
set -u
# Portable: the worktree is the repo this script lives in; the scratch dir follows $CNS_UI_TMP
# (the harness's own convention) and otherwise lands in the system temp dir, never in the repo.
W="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRATCH="${CNS_UI_TMP:-${TMPDIR:-/tmp}/cns-ui-$(basename "$W")}"
PIDFILE="$SCRATCH/server.pid"
LOG="$SCRATCH/server.log"
PORT="${PORT:-5097}"
export PORT DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib

alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
health() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz" 2>/dev/null; }

start() {
  if alive; then echo "already running pid $(cat "$PIDFILE") (healthz $(health))"; return 0; fi
  if [ "$(health)" = "200" ]; then echo "port $PORT already serves /healthz but no pidfile — not starting another"; return 1; fi
  mkdir -p "$SCRATCH"
  cd "$W" || exit 1
  nohup ./venv/bin/python app.py > "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 60); do [ "$(health)" = "200" ] && { echo "started pid $(cat "$PIDFILE") on :$PORT"; return 0; }; sleep 0.25; done
  echo "server did not answer /healthz within 15 s — see $LOG"; tail -20 "$LOG"; return 1
}
stop() {
  if ! alive; then echo "not running"; rm -f "$PIDFILE"; return 0; fi
  pid=$(cat "$PIDFILE"); kill "$pid" 2>/dev/null
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  rm -f "$PIDFILE"; echo "stopped pid $pid"
}
status() {
  if alive; then echo "running pid $(cat "$PIDFILE") on :$PORT healthz=$(health) cwd=$(lsof -a -p "$(cat "$PIDFILE")" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"; else echo "not running (healthz=$(health))"; fi
}
case "${1:-status}" in
  start) start ;; stop) stop ;; restart) stop; start ;; status) status ;;
  *) echo "usage: $0 start|stop|restart|status"; exit 2 ;;
esac
