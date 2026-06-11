# CNS — Security Review & Hardening (June 2026)

This review was triggered by the app going public ("anybody can use it"). It
covers (1) the new **login screen / access control**, (2) every safety issue
found in a full read of the backend and the report/export pipeline, (3) the
**browser-freeze crash** ("app crashed, page unresponsive, with 1 user"), and
(4) what is fixed in this branch versus what is left as a recommendation.

> TL;DR — The app had **no authentication at all**: every page and API was world-
> reachable. This branch adds a password login, hardens the report/export
> pipeline (SSRF, formula injection, path traversal, request size, tile-fetch
> timeouts), adds security headers, and fixes the freeze (an unbounded
> "frequency" field). **Action required from you:** set the access password in
> the server environment (see *Deploying the login* below) — without it the app
> stays open.

---

## 1. Access control (the login screen you asked for)

A single shared password now gates the whole app — one client plus a few trusted
friends, so no per-user accounts. Implemented in `app.py`:

- **`/login`** — a branded, mobile-friendly password page (`templates/login.html`).
- **`/logout`** — clears the session.
- **`/healthz`** — unauthenticated liveness probe (for uptime monitoring).
- A `before_request` guard redirects un-authenticated page loads to `/login` and
  returns a JSON `401` for `/api/*` calls. The mobile route `/m/` is gated too.
- The session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` (over HTTPS).
- **Brute-force throttle:** 8 failed attempts per IP per 5 minutes → `429`.
- **Open-redirect safe:** the post-login `?next=` only accepts local paths.

It is configured entirely from the environment, so **no secret is ever committed**:

| Variable | Purpose |
|---|---|
| `CNS_PASSWORD_HASH` | **Preferred.** A werkzeug password hash. |
| `CNS_APP_PASSWORD` | Fallback — plaintext password (kept only in the service env). |
| `CNS_SECRET_KEY` | Signs the session cookie. Set a stable random value so logins survive restarts. |
| `CNS_INSECURE_COOKIES=1` | Local dev over plain HTTP only (don't set in production). |
| `CNS_MAX_CONTENT_LENGTH` | Max request body in bytes (default 16 MB). |
| `CNS_DISABLE_CSP=1` | Escape hatch to turn off the Content-Security-Policy header. |

**Safety default:** if *neither* password variable is set, auth is **disabled**
and a loud warning is logged. This keeps local dev and the offline test suite
working — but it means a public deploy **must** set one of the two.

### Deploying the login on the bhosted VPS

The app runs under gunicorn (`gunicorn.conf.py`) — almost certainly via systemd.
Put the secrets in a root-only EnvironmentFile, never in the repo:

```bash
# /etc/cns.env   (chmod 600, owned by root)
CNS_PASSWORD_HASH=scrypt:32768:8:1$....         # generate with the command below
CNS_SECRET_KEY=<64 hex chars>                    # python -c "import secrets;print(secrets.token_hex(32))"
```

```ini
# in the [Service] section of the systemd unit (e.g. /etc/systemd/system/cns.service)
EnvironmentFile=/etc/cns.env
```

Generate the hash once, locally:

```bash
python -c "from werkzeug.security import generate_password_hash; print(generate_password_hash('your-password'))"
```

Then `sudo systemctl daemon-reload && sudo systemctl restart cns`. Verify with
`curl -I https://your-host/` → it should `302` to `/login`.

---

## 2. Findings

Severity reflects the *public* deployment. **Status**: ✅ fixed in this branch ·
🔶 partially mitigated · 📋 recommended (not done here).

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | **Critical** | No authentication — every route world-reachable | ✅ login added |
| 2 | **High** | Browser freeze / tab crash from unbounded "frequency" field | ✅ clamped |
| 3 | **High** | DoS: report PDF tile fetches had **no timeout** (`staticmap` waits forever) | ✅ 6 s timeout |
| 4 | **High** | SSRF in PDF photo lookup — client-named airport steers a server-side fetch whose bytes return in the PDF | ✅ host allow-list |
| 5 | **Medium** | Path traversal — payload `plane.image`/`svg` could embed `/etc/passwd` into the PDF | ✅ contained |
| 6 | **Medium** | Excel/CSV **formula injection** via user-named planes/chargers in the XLSX export | ✅ neutralised |
| 7 | **Medium** | No request-size limit — huge JSON payloads amplify CPU/memory | ✅ 16 MB cap |
| 8 | **Medium** | No security headers (CSP, X-Frame-Options, nosniff, …) | ✅ added |
| 9 | **Medium** | Shared custom planes/chargers are global & anyone can add/delete others' | 🔶 now behind login; no per-user ownership |
| 10 | **Low** | `_xml_escape` didn't escape quotes (fragile if SVG markup changes) | ✅ hardened |
| 11 | **Low** | No rate limiting on the expensive `/api/report.pdf` (beyond login) | 📋 recommend |
| 12 | **Low** | CSP allows `'unsafe-inline'` (app uses inline scripts/handlers) | 📋 recommend nonces |
| 13 | **Info** | `FLASK_DEBUG=1` would expose the Werkzeug console (RCE). Off by default. | 📋 never set in prod |

### Details on the fixed items

**#1 No authentication.** Before this branch, `GET /`, `/m/`, and all `/api/*`
endpoints answered anyone. Fixed by the login layer in section 1.

**#2 Freeze — see section 3.**

**#3 Tile-fetch DoS.** `report.py` built `staticmap.StaticMap(...)` for the
network map and the satellite cover **without `tile_request_timeout`**, which
defaults to `None` = wait forever, with up to 3 retries. A slow/hostile tile
host could wedge a gunicorn worker; with only `workers=2 × threads=4 = 8` slots,
a handful of such requests denies service. Now both calls pass
`tile_request_timeout=6`.

**#4 SSRF.** `generate_pdf` passes the client-supplied `focusAirport` name into
`_wikidata_image` → it resolves an image URL from Wikidata/Wikipedia responses →
`_http_get(img_url)` fetched it and embedded the bytes into the returned PDF
(`report.py`). `_http_get` had no scheme/host restriction. Now every outbound
`_http_get` is restricted to **https on the Wikimedia family** of hosts
(`_fetch_host_allowed`), so a crafted name can't make the server hit an internal
URL (e.g. cloud metadata at `169.254.169.254`) and reflect its body.

**#5 Path traversal.** `os.path.join(PICS_DIR, img)` with a payload-controlled
`img` resolved `/etc/passwd` or `../../secret` and base64-embedded it into the
PDF. Now routed through `_safe_pics_path`, which refuses anything resolving
outside `PICS_DIR`.

**#6 Formula injection.** `spreadsheet.py` wrote user names (custom plane/charger
names are shared across all visitors!) straight into cells. A name like
`=cmd|'/c calc'!A0` becomes a live formula/DDE when the victim opens the XLSX.
Now user-controlled string cells pass through `_safe_text`, which prefixes a
leading `= + - @` (or tab/CR) with an apostrophe so the spreadsheet app treats
it as text — without touching the workbook's own intended `=SUM(...)` formulas.

**#7/#8 Request cap & headers.** `MAX_CONTENT_LENGTH` rejects oversized bodies;
an `after_request` adds `Content-Security-Policy`, `X-Frame-Options: SAMEORIGIN`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy`, and `Permissions-Policy`.
The CSP is scoped to the exact CDN/tile origins the app uses (jsDelivr, unpkg,
Google Fonts, Carto tiles, Esri satellite), so the map and styling keep working.

### Confirmed non-issues (checked, no action needed)

- **XSS via custom names in the UI** — `scheduler.js` / `mobile.js` HTML-escape
  names before `innerHTML` (`esc()` / `window.escHtml`). Report HTML uses Jinja
  autoescaping; the three `| safe` filters carry only server-generated SVG whose
  user labels are `_xml_escape`d.
- **SQL injection** — there is no database (yet); airport lookups are pandas
  filters over a static CSV.
- **XLSX worksheet tab names** — already sanitised (`_tab`).
- **PDF cover CSS `url()`** — only ever receives a server-built `data:` URI.

---

## 3. The freeze: "app crashed, page unresponsive, with 1 user"

**Root cause: an unbounded "Expected frequency" (`freqN`) field.** Nothing — not
the input, not the backend — capped how many flights/day a trip could claim. A
typo or paste (e.g. `100000`, or `1e9`) fanned that number out through the
scheduler into:

- one **lane** per instance (`scheduler.js` `runGlobal`),
- one **rotation record** + several positioned **DOM nodes** each
  (`renderInto` / `buildInstance`), with an O(n²) event-queue insertion,
- one animated **Leaflet marker** per instance, updated **every animation frame**
  (`animation.js`).

At a few thousand, the main thread is blocked for many seconds; at tens of
thousands the tab freezes ("page unresponsive") or runs out of memory and
crashes — exactly the report, and it needs only one user. This is the most
likely cause of what your friend hit.

**Fix.** A hard cap of **200 rotations/day per trip** at the single chokepoint
every path flows through — `instancesPerDay` in `scheduler.js` — which also
floors NaN/0/negative to 1. The desktop inputs additionally clamp to ≤ 2000 and
carry a native `max`. Verified: `freqN = 100000` (or `14000/week`, or `NaN`) now
yields a bounded 1–200 instances instead of locking the tab.

> Note (worktree lanes): `static/mobile.js` is the mobile session's file, so its
> own input handler isn't clamped here — but the `scheduler.js` cap protects
> mobile too, since both share that code path. A matching input clamp in
> `mobile.js` is a small follow-up for the mobile session.

---

## 4. Recommended next steps (not in this branch)

1. **Rate-limit the expensive endpoints** (`/api/report.pdf`, `/api/report.xlsx`,
   `/api/simulate`) per session/IP — even behind login, one user can hammer the
   PDF pipeline. `Flask-Limiter` (memory or Redis) is the easy path.
2. **Wall-clock budget + waypoint cap** around `generate_pdf` so a pathological
   payload (routes spanning the globe → many tiles) can't run long.
3. **Tighten the CSP** to nonces instead of `'unsafe-inline'` (needs touching the
   inline scripts in `templates/index.html`).
4. **Per-user ownership** for custom planes/chargers once a database lands (see
   `docs/DATABASE_PLAN.md`) — today they're global and mutually deletable.
5. **Rotate the access password** periodically; consider a second "admin"
   password later if you want to separate edit rights from view rights.
6. **Dependency hygiene** — pin and routinely `pip-audit` the requirements.
```
