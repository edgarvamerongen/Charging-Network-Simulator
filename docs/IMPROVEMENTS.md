# CNS — Improvement Opportunities

A practical, prioritized backlog from a full read of the app. Security and the
database have their own docs (`SECURITY_REVIEW.md`, `DATABASE_PLAN.md`); this
covers everything else — reliability, performance, UX, code health, and ops.

Legend: 🟢 quick win (hours) · 🟡 medium (1–2 days) · 🔴 larger effort.

---

## Reliability & resilience

- 🟢 **Cap all unbounded numeric inputs, not just frequency.** The freeze fix
  capped `freqN`; do a sweep for any other field that sizes a loop, array, or DOM
  count (number of stops, day window, charger counts) and clamp at the parse
  site. Treat "what's the worst value a user can type/paste here?" as a checklist.
- 🟢 **Global JSON error handler for `/api/*`.** Register a Flask error handler so
  *any* uncaught exception on an API route returns `{"error": …}` JSON, never an
  HTML 500 (which breaks the browser's JSON parser). `simulate` already does this
  locally; make it app-wide.
- 🟡 **Time-budget the PDF/XLSX pipeline.** Even with tile timeouts, a giant
  payload can run long. Add a wall-clock budget and cap waypoints/airports per
  report so one request can't monopolize a worker.
- 🟡 **Make heavy exports asynchronous.** PDF generation does several external
  fetches synchronously inside the request. A tiny job queue (RQ/Redis, or even a
  thread + polling endpoint) keeps workers free and lets the UI show real
  progress instead of a spinner that can hit the 60 s gunicorn timeout.

## Performance

- 🟢 **`preload_app = True` in gunicorn.** Today each of the 2 workers loads the
  1.3 MB airport CSV into its own pandas frame (tens of MB each). Preloading
  builds the `Simulator` once before forking, so workers share it copy-on-write —
  meaningful memory savings on a small VPS.
- 🟡 **Trim the `/api/airports` payload (≈1.8 MB).** Every desktop load pulls the
  full airport list. Options, in increasing effort: enable gzip
  (`flask-compress`) → drop a server-side **typeahead endpoint**
  (`/api/airports?q=ams&limit=20`) so the browser fetches only matches → or ship
  a pre-trimmed catalog (drop closed/heliport types the UI never offers).
- 🟢 **Cache-control on read-only APIs.** `/api/airports`, `/api/airport-chargers`
  are effectively static between deploys. Add `Cache-Control: public, max-age=…`
  keyed to `ASSET_VERSION` so browsers don't refetch megabytes each visit.
- 🟢 **Disk-cache the satellite/photo covers** — already done for Wikimedia; make
  sure the Esri satellite render is cached per ICAO too, so repeat reports for the
  same airport skip the tile fetch entirely.

## Persistence & data (see DATABASE_PLAN.md)

- 🔴 **Move saved plans server-side.** The "folder" lives only in `localStorage`
  today — lost on cache clear, not shareable, single-device. The biggest UX win
  available; details in the database plan.
- 🟡 **Ownership for custom planes/chargers.** Currently global and mutually
  deletable. Behind login now, but a DB with `owner_id` makes them per-user.

## Code quality & maintainability

- 🟡 **Split `app.py` into blueprints** (`auth`, `api`, `reports`). It's ~600
  lines now and growing; blueprints keep routes, the auth layer, and the export
  endpoints separately testable.
- 🟢 **Centralize the JS HTML-escaper.** `scheduler.js` and `mobile.js` each
  define their own `esc()`/`escHtml`. Expose one shared helper (e.g. on
  `CNSState`) so every `innerHTML` interpolation uses the same audited function —
  removes the risk of a future call site forgetting to escape.
- 🟢 **A real `README`.** It's one line. A short "what it is / run it / test it /
  deploy it / env vars" gets a new collaborator (or future-you) productive fast;
  point at `SECURITY_REVIEW.md` for the deploy secrets.
- 🟢 **`.env.example`.** List every `CNS_*` variable with safe placeholder values
  so deployment config is discoverable (never commit the real values).

## Testing & CI

- 🟡 **Add GitHub Actions CI.** There's a solid suite (118 Python + 11 Node
  harnesses) but nothing runs it on push/PR. A workflow that runs
  `tests/run_all.sh` (Python + Node, server tests skip gracefully) catches
  regressions before merge. The repo even has a `session-start-hook` skill to make
  web sessions test-ready — wire the same commands into CI.
- 🟢 **Smoke test the running app in CI** — boot it with a test password and curl
  `/healthz`, `/login`, and an authed `/api/simulate`, to catch template/route
  breakage the unit tests miss. (This review did exactly that by hand.)
- 🟡 **A WeasyPrint/PDF integration test.** The PDF path has unit-tested helpers
  but no end-to-end "does a PDF actually render" test; add one gated on WeasyPrint
  being installed.

## UX

- 🟢 **Reflect the frequency cap in the UI.** The field now clamps to 2000; show a
  hint ("max 2000") or a toast when a value is clamped, so the number silently
  changing doesn't confuse anyone.
- 🟢 **"Stay signed in" is already the default** (14-day session). Consider a
  visible logout control in the app header now that there's a login.
- 🟡 **Mobile/desktop parity audit.** Two templates + two JS entry points drift
  over time; a short checklist (or shared component) keeps features in sync.

## Operations & observability

- 🟢 **`/healthz` is in** — point the bhosted/Cloudflare uptime monitor at it.
- 🟡 **Structured request logging.** Log method, path, status, duration, and
  client IP (you already resolve `CF-Connecting-IP`) to journald as JSON; makes
  "what was slow / who hit errors" answerable.
- 🟢 **Dependency scanning.** Add `pip-audit` (and GitHub Dependabot) so known CVEs
  in Flask/pandas/WeasyPrint/requests surface automatically. Versions are pinned,
  which is good — keep them moving.
- 🟢 **Never set `FLASK_DEBUG=1` in production** (Werkzeug console = RCE). Worth a
  one-line note in the deploy runbook.

---

## Suggested order

1. **Now (this branch):** login, the freeze fix, and the report-pipeline
   hardening — done.
2. **Next quick wins:** `preload_app`, gzip + cache-control on `/api/airports`,
   global JSON error handler, README + `.env.example`, CI running the suite.
3. **Then:** server-side saved plans + the SQLite database (Phases 1–2 of the DB
   plan) — the largest user-visible improvement.
4. **Later:** accounts/ownership, async exports, blueprint refactor.
```
