# Short share links (SQLite) — design

**Date:** 2026-06-22
**Status:** Approved (brainstorming) — pending implementation plan
**Owner role:** desktop / backend

## Problem

Shareable route links (`CNSShare`, `static/share.js`) encode the entire planner
state as `JSON → base64url` carried in the URL **hash** (`#r=…`). The whole route
is the URL, so links are long and ugly to paste/share.

The hash was a deliberate choice: it is never sent to the server, so a shared
link survives the app's auth `302 → /login` redirect (the recipient logs in and
the route still restores). The cost of that trick is the length.

## Goal

Replace the long hash link with a short, clean link like
`https://cns.nrg2fly.nl/s/Ab3xZ9`, backed by a tiny server-side store. The
existing hash links must keep working (already shared in the wild).

## Why this is feasible despite the auth gate

The hash was needed only because URL *fragments* are not sent to the server. A
short **path** (`/s/<slug>`) does not have that problem: the login flow already
preserves the path via `next=` (`app.py` `_require_login` →
`redirect(url_for('login', next=request.path))`) and `_safe_next` accepts any
same-site relative `/…` path. So an unauthenticated recipient visiting
`/s/Ab3xZ9` is sent to `/login?next=/s/Ab3xZ9` and bounced right back after
login. No special handling required.

## Decisions (locked)

- **Storage: SQLite**, not MongoDB. Single Flask/gunicorn instance on the VPS;
  a key→blob table with low write volume needs no separate DB server. One file
  in the existing gitignored `DATA_DIR`, stdlib `sqlite3`, zero new dependency.
- **Clean URL stays** `/s/<slug>` in the address bar after open (no redirect to
  the long hash). Achieved by **inline state injection** (below), not a second
  API fetch — so there is no load flash and state is present at boot exactly like
  the hash path today.
- **Permanent links, dedupe, no expiry.** Sim routes are not sensitive; people
  expect a shared link to keep working. Content-hash dedupe bounds table growth.

## Architecture

A new backend module **`shares.py`** owns all DB logic (keeps the 736-line
`app.py` from growing; unit-testable in isolation). `app.py` gains two thin
routes that call into it. `static/share.js` gets a smarter `copyLink()`. The
existing hash (`#r=…`) encode/decode/init path is untouched.

### `shares.py` (new module)

Public surface:

- `init_db()` — `os.makedirs(DATA_DIR, exist_ok=True)`, open `data/shares.db`,
  `PRAGMA journal_mode=WAL`, `CREATE TABLE IF NOT EXISTS` (all idempotent; safe
  to call at startup and from every worker).
- `save_state(state: dict) -> str` — canonicalise the state to stable JSON
  (`json.dumps(state, sort_keys=True, separators=(',', ':'))`), `sha256` it; if a
  row with that `content_hash` exists return its existing `slug` (dedupe); else
  generate a slug, insert, return it.
- `load_state(slug: str) -> dict | None` — return the parsed state blob or
  `None` if the slug is unknown.
- `_new_slug() -> str` — 7 chars from `[0-9A-Za-z]` via `secrets.choice`;
  retry on the (astronomically rare) primary-key collision.

Connection handling: open a short-lived connection per operation
(`with sqlite3.connect(DB_PATH) as conn: …`). This is the simplest model and is
safe regardless of gunicorn worker model (process or thread), since no
connection is shared across calls. The write volume (share creation) makes the
per-call open cost irrelevant.

### Schema — `data/shares.db`

```sql
CREATE TABLE IF NOT EXISTS shares (
  slug         TEXT PRIMARY KEY,   -- 7-char base62, secrets-random
  state        TEXT NOT NULL,      -- JSON blob, same shape CNSShare.currentState() emits
  content_hash TEXT,               -- sha256 of canonical state, for dedupe
  created_at   TEXT NOT NULL       -- ISO-8601 UTC
);
CREATE INDEX IF NOT EXISTS idx_shares_hash ON shares(content_hash);
```

The DB file lives in the existing gitignored `DATA_DIR` (`app.py:174`), so it
persists across deploys (deploy = `git pull`, which never touches `data/`).

### Routes (`app.py`, all behind the existing auth gate)

1. **`POST /api/share`** — body `{"state": {...}}`.
   - Validate: body is a JSON object with a `state` object; reject otherwise
     (`400`).
   - **Size cap:** reject if the serialized state exceeds ~16 KB (real blobs are
     <1 KB) → `413`. Stops the table being used as arbitrary storage.
   - `slug = shares.save_state(state)`.
   - Return `{"slug": slug, "url": <host_url>/s/<slug>}` where the base is
     `request.host_url` (so it is correct on localhost and on the VPS).
   - The server is **schema-agnostic**: it stores/returns the blob verbatim and
     never parses the share schema. Future `share.js` schema bumps need zero
     server change.

2. **`GET /s/<slug>`** — serve the planner with state injected.
   - `state = shares.load_state(slug)`.
   - `render_template('index.html', …)` exactly as `index()` does, plus a
     `share_state` template var.
   - In `templates/index.html` `<head>`/early body:
     `{% if share_state %}<script>window.__CNS_SHARE__ = {{ share_state|tojson }};</script>{% endif %}`
     (Jinja `tojson` escapes `<`, `>`, `&` — XSS-safe; inline script already
     permitted by the app's CSP `'unsafe-inline'`).
   - Unknown slug → no injection → app boots default + a "link not found" toast.

3. *(no `GET /api/share/<slug>` needed)* — resolution is via inline injection, so
   there is no second round trip.

### Front-end

**`static/share.js`:**
- `copyLink()` → **async**: build `currentState()`, `POST /api/share`, copy the
  returned short `url`, toast "Link copied". **On any failure (offline / 401 /
  500 / no `fetch`), fall back to the existing `shareUrl()` hash link** so
  sharing never hard-fails.
- Keep `encode` / `decode` / `shareUrl` / `init` (hash path) unchanged for
  backward compat with already-shared `#r=…` links.
- `apply(state)` already accepts a decoded state object — the injected
  `window.__CNS_SHARE__` is the same shape, so it is reused as-is. No new apply
  logic.

**`templates/index.html`** boot order (currently `app.py:6153`-ish):
```js
if (window.__CNS_SHARE__)            CNSShare.apply(window.__CNS_SHARE__);  // short link
else if (window.CNSShare && CNSShare.hasLink())  CNSShare.init();           // old #r= hash link
else                                  _applyDefaultFlight();
```
Share button handler (`app.py:6181`-ish) is unchanged — still calls
`copyLink()`, now async (fire-and-forget; it copies + toasts internally).

## Error handling

- POST validation failures → `400`; oversize → `413`; both leave the client on
  the hash-link fallback.
- DB open/insert failure → `500`; client falls back to the hash link.
- Unknown slug on open → default boot + toast, never a hard error.
- Auth: all new endpoints sit behind `_require_login`; logged-out API call →
  `401` (client falls back to hash link), logged-out page visit → login then
  back to `/s/<slug>`.

## Out of scope (YAGNI / other lanes)

- **Expiry / TTL / cleanup cron** — permanent + dedupe is enough; trivial
  follow-up if the table ever grows large.
- **Mobile** (`/m/`): `/s/<slug>` serves the **desktop** template. A phone
  opening a share link gets desktop layout. Flagged as a follow-up for the
  mobile-role session — not touched here (cross-lane).
- **Slug vanity / custom aliases**, analytics/hit counters, link management UI.

## Testing (`tests/`, in-lane)

- **`tests/test_shares.py`** (pytest): save→load round-trip; dedupe (same state
  → same slug, one row); unknown slug → `None`; slug charset/length (7×base62);
  size-cap rejection; `init_db()` idempotent.
- **`tests/test_api.py`**: `POST /api/share` → `{slug, url}` with correct host;
  `GET /s/<slug>` injects `__CNS_SHARE__`; bad slug boots clean (no injection);
  endpoints `401` when logged out (mirror `test_auth.py` patterns).
- **`tests/js_share.test.mjs`**: extend — `copyLink()` POSTs and, on a stubbed
  failing `fetch`, falls back to the hash link; `apply()` still restores a state
  object (already covered) works from an injected blob.
- `tests/run_all.sh` runs the full suite.

## Files touched (all desktop/backend lane)

- **new** `shares.py`
- `app.py` — `import shares`; call `shares.init_db()` at startup; 2 routes
  (`POST /api/share`, `GET /s/<slug>`)
- `templates/index.html` — inline injection block; boot-order branch
- `static/share.js` — async `copyLink()` with hash fallback
- **new** `tests/test_shares.py`; edits to `tests/test_api.py`,
  `tests/js_share.test.mjs`
- **this spec** under `docs/superpowers/specs/`

## Deployment note

`init_db()` creates `data/` and the table on first run (idempotent). On the VPS
the DB file persists across deploys (gitignored `data/`). WAL mode keeps
multi-worker gunicorn reads clean; write volume (share creation) is tiny.
