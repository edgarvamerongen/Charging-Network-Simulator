# Short Share Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the long `#r=<base64>` hash share link with a short, clean `/s/<slug>` link backed by a server-side SQLite store.

**Architecture:** A new `shares.py` module owns a tiny SQLite key→blob table (`data/shares.db`). `app.py` gains `POST /api/share` (store state → return short URL) and `GET /s/<slug>` (serve the planner with the saved state injected inline as `window.__CNS_SHARE__`, so the address bar stays clean). `static/share.js` POSTs to create the link and falls back to the existing hash link if the server is unreachable. The old `#r=` decode path is untouched, so already-shared links keep working.

**Tech Stack:** Python 3 / Flask, stdlib `sqlite3` (no new dependency), vanilla JS, `unittest` (in-process Flask test client) + Node `node:test` harness.

## Global Constraints

- **Lane:** desktop/backend only — touch ONLY `shares.py`, `app.py`, `templates/index.html`, `static/share.js`, `tests/`, `docs/`. Never stage other roles' files.
- **No new pip dependency** — `sqlite3` is stdlib. Do not edit `requirements.txt`.
- **Server is schema-agnostic** — it stores/returns the JSON state blob verbatim and never parses the share schema. Future `share.js` schema bumps need zero server change.
- **Backward compatible** — the existing `#r=<base64>` hash path (`encode`/`decode`/`init`/`shareUrl`) stays fully working.
- **DB location** — `data/shares.db` inside the gitignored `DATA_DIR` (persists across deploys). Overridable via env `CNS_SHARES_DB` (the test suite points it at a temp file).
- **State size cap** — reject a state blob over `16 * 1024` bytes (real blobs are <1 KB).
- **Slug** — 7 chars from base62 `[0-9A-Za-z]`, generated with `secrets`.
- **Out of scope** — link expiry/cleanup; mobile (`/s/<slug>` serves the desktop template — a follow-up for the mobile-role session); analytics/link-management UI.
- **Commits** — end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Run the app with `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib` and the **main checkout's** interpreter by absolute path (worktrees have no `venv/`): `/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/venv/bin/python`.
- **Test runner:** the project's canonical runner is stdlib `unittest` (the venv has **no pytest**). Run Python tests with `… venv/bin/python -m unittest tests.<module> -v`. The venv (not system `python3`) is what has Flask, so tests that import `app` MUST use the venv interpreter.

## File Structure

| File | Responsibility |
|------|----------------|
| `shares.py` *(new)* | SQLite store: `init_db`, `save_state` (dedupe by content hash), `load_state`. Pure, no Flask. |
| `app.py` *(modify)* | `import shares` + `shares.init_db()` at startup; `POST /api/share`; `GET /s/<slug>`. |
| `templates/index.html` *(modify)* | Inline `window.__CNS_SHARE__` injection block; boot-order branch. |
| `static/share.js` *(modify)* | `createShortLink(state, _fetch)`; async `copyLink()` with hash fallback. |
| `tests/test_shares.py` *(new)* | Unit tests for `shares.py` (temp DB). |
| `tests/test_share_routes.py` *(new)* | In-process route tests (Flask test client, temp DB, auth). |
| `tests/js_share.test.mjs` *(modify)* | Node tests for `createShortLink`. |
| `tests/__init__.py` *(modify)* | Default `CNS_SHARES_DB` to a temp path so unrelated tests never write the real `data/shares.db`. |

---

### Task 1: `shares.py` — SQLite store

**Files:**
- Create: `shares.py`
- Create: `tests/test_shares.py`
- Modify: `tests/__init__.py`

**Interfaces:**
- Produces:
  - `init_db() -> None` — idempotent table create.
  - `save_state(state: dict) -> str` — returns 7-char slug; identical states dedupe to one slug.
  - `load_state(slug: str) -> dict | None`.
  - `MAX_STATE_BYTES: int` (= `16 * 1024`), `_SLUG_ALPHABET: str`, `_SLUG_LEN: int` (= 7).

- [ ] **Step 1: Point the test package at a throwaway DB.** Replace the contents of `tests/__init__.py` with:

```python
# Redirect the short-link store (shares.py) to a throwaway DB for the whole
# test run, so importing app.py during tests never writes the real
# data/shares.db. Individual test modules may override CNS_SHARES_DB.
import os as _os
import tempfile as _tempfile

_os.environ.setdefault(
    'CNS_SHARES_DB',
    _os.path.join(_tempfile.gettempdir(), 'cns_test_shares.db'),
)
```

- [ ] **Step 2: Write the failing unit tests.** Create `tests/test_shares.py`:

```python
"""Unit tests for shares.py — the SQLite short-link store. Offline; uses a
throwaway DB via CNS_SHARES_DB so the real data/shares.db is never touched."""
import os
import tempfile
import unittest

# Point the store at a throwaway DB BEFORE importing the module under test.
_TMP = tempfile.mkdtemp(prefix='cns_shares_test_')
os.environ['CNS_SHARES_DB'] = os.path.join(_TMP, 'shares.db')

import shares  # noqa: E402


class SharesStoreTest(unittest.TestCase):
    def setUp(self):
        # Dynamic path read means each test can rely on a clean, initialised DB.
        os.environ['CNS_SHARES_DB'] = os.path.join(_TMP, 'shares.db')
        shares.init_db()

    def test_init_db_is_idempotent(self):
        shares.init_db()
        shares.init_db()  # second/third call must not raise

    def test_save_then_load_round_trips(self):
        state = {'v': 1, 'o': 'EHLE', 'd': 'EDDF', 's': ['EDDK']}
        slug = shares.save_state(state)
        self.assertEqual(shares.load_state(slug), state)

    def test_slug_is_7_char_base62(self):
        slug = shares.save_state({'v': 1, 'o': 'X'})
        self.assertEqual(len(slug), shares._SLUG_LEN)
        self.assertTrue(all(c in shares._SLUG_ALPHABET for c in slug))

    def test_identical_states_dedupe_to_one_slug(self):
        a = shares.save_state({'v': 1, 'o': 'EHAM', 'd': 'LFPG'})
        b = shares.save_state({'d': 'LFPG', 'v': 1, 'o': 'EHAM'})  # key order differs
        self.assertEqual(a, b)  # canonical JSON → same hash → same slug

    def test_different_states_get_different_slugs(self):
        a = shares.save_state({'v': 1, 'o': 'EHAM'})
        b = shares.save_state({'v': 1, 'o': 'EHRD'})
        self.assertNotEqual(a, b)

    def test_unknown_slug_returns_none(self):
        self.assertIsNone(shares.load_state('zzzzzzz'))


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 3: Run the tests to verify they fail.**

Run: `cd "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/.claude/worktrees/sad-kilby-8612cc" && DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/venv/bin/python" -m unittest tests.test_shares -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'shares'`.

- [ ] **Step 4: Implement `shares.py`.** Create `shares.py`:

```python
"""
shares.py — SQLite-backed store for short shareable-route links.

CNSShare (static/share.js) used to carry the whole planner state in the URL
hash (#r=<base64>), which makes long, ugly links. Here we persist each route's
state blob server-side keyed by a short random slug, so the shared URL is just
https://<host>/s/<slug>.

The store is schema-agnostic: it keeps the JSON blob verbatim and never parses
the share schema, so future share.js schema bumps need no change here. Identical
routes dedupe by content hash, so re-sharing the same route reuses one row.

The DB file lives in the app's gitignored DATA_DIR (data/shares.db), so it
survives deploys (git pull never touches data/). Override the path with
CNS_SHARES_DB (the test suite points it at a temp file). The path is read
dynamically per connection so tests can redirect it after import.
"""
import hashlib
import json
import os
import secrets
import sqlite3
from datetime import datetime, timezone

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')

_SLUG_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
_SLUG_LEN = 7
MAX_STATE_BYTES = 16 * 1024  # real blobs are <1 KB; cap stops arbitrary storage


def _db_path():
    return os.environ.get('CNS_SHARES_DB') or os.path.join(DATA_DIR, 'shares.db')


def _connect():
    path = _db_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute('PRAGMA journal_mode=WAL')
    return conn


def init_db():
    """Create the shares table if missing. Idempotent; safe to call at startup
    and from every gunicorn worker."""
    with _connect() as conn:
        conn.execute(
            'CREATE TABLE IF NOT EXISTS shares ('
            '  slug TEXT PRIMARY KEY,'
            '  state TEXT NOT NULL,'
            '  content_hash TEXT,'
            '  created_at TEXT NOT NULL'
            ')'
        )
        conn.execute(
            'CREATE INDEX IF NOT EXISTS idx_shares_hash ON shares(content_hash)'
        )


def _canonical(state):
    return json.dumps(state, sort_keys=True, separators=(',', ':'))


def _new_slug():
    return ''.join(secrets.choice(_SLUG_ALPHABET) for _ in range(_SLUG_LEN))


def save_state(state):
    """Persist a route-state dict and return its short slug. Identical states
    (by canonical-JSON hash) reuse the existing slug."""
    blob = _canonical(state)
    digest = hashlib.sha256(blob.encode('utf-8')).hexdigest()
    with _connect() as conn:
        row = conn.execute(
            'SELECT slug FROM shares WHERE content_hash = ? LIMIT 1', (digest,)
        ).fetchone()
        if row:
            return row[0]
        created = datetime.now(timezone.utc).isoformat()
        while True:
            slug = _new_slug()
            try:
                conn.execute(
                    'INSERT INTO shares (slug, state, content_hash, created_at) '
                    'VALUES (?, ?, ?, ?)', (slug, blob, digest, created)
                )
                return slug
            except sqlite3.IntegrityError:
                continue  # slug primary-key collision (astronomically rare) — retry


def load_state(slug):
    """Return the stored route-state dict for a slug, or None if unknown."""
    with _connect() as conn:
        row = conn.execute(
            'SELECT state FROM shares WHERE slug = ? LIMIT 1', (slug,)
        ).fetchone()
    if not row:
        return None
    try:
        return json.loads(row[0])
    except (ValueError, TypeError):
        return None
```

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `cd "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/.claude/worktrees/sad-kilby-8612cc" && DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/venv/bin/python" -m unittest tests.test_shares -v`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit.**

```bash
git add shares.py tests/test_shares.py tests/__init__.py
git commit -m "$(printf 'feat(share): SQLite store for short links (shares.py)\n\nKey->blob table at data/shares.db with content-hash dedupe and 7-char\nbase62 slugs. Schema-agnostic; path overridable via CNS_SHARES_DB.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: `POST /api/share` endpoint

**Files:**
- Modify: `app.py` (imports near line 27; startup near line 40; new route by the other `/api/...` routes)
- Create: `tests/test_share_routes.py`

**Interfaces:**
- Consumes: `shares.init_db`, `shares.save_state`, `shares.MAX_STATE_BYTES`.
- Produces: `POST /api/share` — body `{"state": {...}}` → `200 {"slug": str, "url": str}`; `400` non-object state; `413` oversize; `401` unauthenticated.

- [ ] **Step 1: Write the failing route tests.** Create `tests/test_share_routes.py`:

```python
"""In-process tests for the share endpoints (POST /api/share, GET /s/<slug>),
using Flask's test client so they need no live server. Auth + a temp shares DB
are configured via env BEFORE importing app."""
import os
import tempfile
import unittest

os.environ.setdefault('CNS_APP_PASSWORD', 'test-secret-pw')
os.environ.setdefault('CNS_SECRET_KEY', 'unit-test-fixed-key')
os.environ.setdefault('CNS_INSECURE_COOKIES', '1')
# Own temp DB; re-pinned in setUp so a full-suite run (other test modules also
# set CNS_SHARES_DB) can't leave us pointed at the wrong file.
_DB = os.path.join(tempfile.mkdtemp(prefix='cns_share_routes_'), 'shares.db')
os.environ['CNS_SHARES_DB'] = _DB

import app as cns_app  # noqa: E402
import shares          # noqa: E402

INJECT_MARK = 'CNSINJECTTESTMARKER'  # sentinel that appears ONLY when injected


class ShareRoutesTest(unittest.TestCase):
    def setUp(self):
        os.environ['CNS_SHARES_DB'] = _DB
        cns_app.app.config['TESTING'] = True
        self.client = cns_app.app.test_client()
        cns_app.AUTH_ENABLED = True
        with cns_app._login_lock:
            cns_app._login_attempts.clear()
        shares.init_db()

    def _login(self):
        return self.client.post('/login', data={'password': 'test-secret-pw'})

    # ---- POST /api/share ----
    def test_create_requires_auth(self):
        r = self.client.post('/api/share', json={'state': {'v': 1}})
        self.assertEqual(r.status_code, 401)

    def test_create_returns_slug_and_url(self):
        self._login()
        r = self.client.post('/api/share', json={'state': {'v': 1, 'o': 'EHLE'}})
        self.assertEqual(r.status_code, 200, r.data)
        body = r.get_json()
        self.assertEqual(len(body['slug']), 7)
        self.assertTrue(body['url'].endswith('/s/' + body['slug']))

    def test_create_rejects_non_object_state(self):
        self._login()
        r = self.client.post('/api/share', json={'state': 'nope'})
        self.assertEqual(r.status_code, 400)

    def test_create_rejects_missing_state(self):
        self._login()
        r = self.client.post('/api/share', json={'nope': 1})
        self.assertEqual(r.status_code, 400)

    def test_create_rejects_oversize_state(self):
        self._login()
        big = {'v': 1, 'pad': 'x' * (16 * 1024 + 1)}
        r = self.client.post('/api/share', json={'state': big})
        self.assertEqual(r.status_code, 413)
```

(Note: the `GET /s/<slug>` tests are added in Task 3 — this file grows.)

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `cd "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/.claude/worktrees/sad-kilby-8612cc" && DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/venv/bin/python" -m unittest tests.test_share_routes -v`
Expected: FAIL — `/api/share` returns 404 (route not defined) so the 200/400/413 assertions fail.

- [ ] **Step 3: Wire `shares` into `app.py`.** After line 27 (`from spreadsheet import generate_xlsx`) add:

```python
import shares
```

Immediately after line 40 (`simulator = Simulator(...)`) add:

```python
# Short shareable-link store (SQLite at data/shares.db). Idempotent table
# create at import so every gunicorn worker is ready; see shares.py.
shares.init_db()
```

- [ ] **Step 4: Add the `POST /api/share` route.** Insert just before the `@app.route('/api/report.pdf', ...)` route (around line 678):

```python
@app.route('/api/share', methods=['POST'])
def api_share_create():
    """Persist the current route-state blob and return a short link to it.
    Body is {"state": {...}} — the object CNSShare.currentState() emits. We
    store it verbatim (schema-agnostic) keyed by a short slug."""
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get('state'), dict):
        return jsonify({'error': 'Expected JSON body {"state": {...}}.'}), 400
    state = body['state']
    if len(json.dumps(state).encode('utf-8')) > shares.MAX_STATE_BYTES:
        return jsonify({'error': 'Route state too large to share.'}), 413
    try:
        slug = shares.save_state(state)
    except Exception:
        app.logger.exception('Share save failed')
        return jsonify({'error': 'Could not create share link.'}), 500
    url = request.host_url.rstrip('/') + '/s/' + slug
    return jsonify({'slug': slug, 'url': url})
```

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `cd "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/.claude/worktrees/sad-kilby-8612cc" && DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/venv/bin/python" -m unittest tests.test_share_routes -v`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit.**

```bash
git add app.py tests/test_share_routes.py
git commit -m "$(printf 'feat(share): POST /api/share creates short links\n\nStores the route-state blob via shares.save_state and returns\n{slug, url}. Validates JSON object + 16 KB cap; behind the auth gate.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: `GET /s/<slug>` + template injection + boot wiring

**Files:**
- Modify: `app.py` (new route near `index()`, ~line 399)
- Modify: `templates/index.html` (injection block after line 2426; boot block line 6153)
- Modify: `tests/test_share_routes.py` (add open-link tests)

**Interfaces:**
- Consumes: `shares.load_state`, `simulator.planes`, `simulator.chargers`, `ASSET_VERSION`.
- Produces: `GET /s/<slug>` — serves `index.html`; on a known slug renders `window.__CNS_SHARE__ = <state>;`. Front-end boot restores it via `CNSShare.apply`.

- [ ] **Step 1: Add the open-link tests.** Append these methods inside `ShareRoutesTest` in `tests/test_share_routes.py`:

```python
    # ---- GET /s/<slug> ----
    def test_open_injects_state(self):
        self._login()
        slug = self.client.post(
            '/api/share', json={'state': {'v': 1, 'mark': INJECT_MARK}}
        ).get_json()['slug']
        r = self.client.get('/s/' + slug)
        self.assertEqual(r.status_code, 200)
        self.assertIn(b'window.__CNS_SHARE__ = ', r.data)  # the injection assignment
        self.assertIn(INJECT_MARK.encode(), r.data)        # the stored blob

    def test_open_unknown_slug_boots_without_injection(self):
        self._login()
        r = self.client.get('/s/zzzzzzz')
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(b'window.__CNS_SHARE__ = ', r.data)  # no injection line

    def test_open_requires_auth_via_redirect(self):
        r = self.client.get('/s/zzzzzzz')
        self.assertEqual(r.status_code, 302)
        self.assertIn('/login', r.headers['Location'])
        self.assertIn('next=%2Fs%2Fzzzzzzz', r.headers['Location'])
```

- [ ] **Step 2: Run the new tests to verify they fail.**

Run: `cd "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/.claude/worktrees/sad-kilby-8612cc" && DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/venv/bin/python" -m unittest tests.test_share_routes -v`
Expected: FAIL — `/s/zzzzzzz` returns 404 (logged in) / the injection assertions fail.

- [ ] **Step 3: Add the `GET /s/<slug>` route.** Insert right after the `index()` route's closing `return resp` (line 399), before `@app.route('/m/')`:

```python
@app.route('/s/<slug>')
def share_open(slug):
    """Open a shared route: serve the planner with the saved state injected so
    the front-end restores it (the address bar stays /s/<slug>). Unknown slug →
    the planner boots normally (no injection) and the UI shows a notice.
    Desktop template only; mobile share handling is a follow-up."""
    state = shares.load_state(slug)
    return make_response(render_template(
        'index.html',
        planes=simulator.planes, chargers=simulator.chargers,
        asset_version=ASSET_VERSION, share_state=state,
    ))
```

- [ ] **Step 4: Add the injection block to the template.** In `templates/index.html`, immediately after line 2426 (`<script src="/static/share.js?v={{ asset_version }}"></script>`) add:

```html
    {% if share_state %}<script>window.__CNS_SHARE__ = {{ share_state|tojson }};</script>{% endif %}
```

- [ ] **Step 5: Update the boot block.** In `templates/index.html`, replace line 6153:

```js
            if (window.CNSShare && CNSShare.hasLink()) CNSShare.init(); else _applyDefaultFlight();
```

with:

```js
            if (window.__CNS_SHARE__ && window.CNSShare) CNSShare.apply(window.__CNS_SHARE__);  // short /s/ link
            else if (window.CNSShare && CNSShare.hasLink()) CNSShare.init();                    // legacy #r= hash link
            else _applyDefaultFlight();
```

- [ ] **Step 6: Run the route tests to verify they pass.**

Run: `cd "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/.claude/worktrees/sad-kilby-8612cc" && DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/venv/bin/python" -m unittest tests.test_share_routes -v`
Expected: PASS (8 tests).

- [ ] **Step 7: Commit.**

```bash
git add app.py templates/index.html tests/test_share_routes.py
git commit -m "$(printf 'feat(share): GET /s/<slug> restores a route (clean URL)\n\nServes index.html with the saved state injected as window.__CNS_SHARE__;\nboot applies it via CNSShare.apply. Unknown slug boots default. Legacy\n#r= hash links still handled.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: `share.js` — create short link + async `copyLink` with fallback

**Files:**
- Modify: `static/share.js` (`copyLink` at lines 148-153; module header; export list line 166)
- Modify: `tests/js_share.test.mjs`

**Interfaces:**
- Consumes: `POST /api/share` (Task 2), `currentState`, `shareUrl`, `toast`.
- Produces: `CNSShare.createShortLink(state, _fetch?) -> Promise<string>` (resolves to the short URL, rejects on failure). `copyLink()` is now async and falls back to `shareUrl()` on any failure.

- [ ] **Step 1: Write the failing Node tests.** Append to `tests/js_share.test.mjs`:

```js
test('createShortLink POSTs the state and returns the server url', async () => {
  const S = loadShare();
  const calls = [];
  const stubFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ slug: 'Ab3xZ9', url: 'https://h/s/Ab3xZ9' }) };
  };
  const url = await S.createShortLink({ v: 1, o: 'EHLE' }, stubFetch);
  assert.equal(url, 'https://h/s/Ab3xZ9');
  assert.equal(calls[0].url, '/api/share');
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { state: { v: 1, o: 'EHLE' } });
});

test('createShortLink rejects on a non-ok response (caller falls back to hash)', async () => {
  const S = loadShare();
  const stubFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => S.createShortLink({ v: 1 }, stubFetch));
});
```

- [ ] **Step 2: Run the JS tests to verify they fail.**

Run: `cd "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/.claude/worktrees/sad-kilby-8612cc" && node tests/js_share.test.mjs`
Expected: FAIL — `S.createShortLink is not a function`.

- [ ] **Step 3: Implement `createShortLink` and rewrite `copyLink`.** In `static/share.js`, replace the `copyLink` function (lines 148-153):

```js
    async function copyLink() {
        const url = shareUrl();
        try { await navigator.clipboard.writeText(url); toast('Link copied'); }
        catch (e) { window.prompt('Copy this shareable link:', url); }
        return url;
    }
```

with:

```js
    // POST the state to the server, which stores it and returns a short
    // /s/<slug> URL. _fetch is injectable for tests; defaults to window.fetch.
    async function createShortLink(state, _fetch) {
        const f = _fetch || (typeof fetch !== 'undefined' ? fetch : null);
        if (!f) throw new Error('no fetch available');
        const resp = await f('/api/share', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state }),
        });
        if (!resp.ok) throw new Error('share request failed: ' + resp.status);
        const data = await resp.json();
        if (!data || !data.url) throw new Error('share response missing url');
        return data.url;
    }

    async function copyLink() {
        let url;
        try { url = await createShortLink(currentState()); }
        catch (e) { url = shareUrl(); }   // server unavailable → the long hash link still works
        try { await navigator.clipboard.writeText(url); toast('Link copied'); }
        catch (e) { window.prompt('Copy this shareable link:', url); }
        return url;
    }
```

- [ ] **Step 4: Export `createShortLink`.** In `static/share.js`, change the return statement (line 166) from:

```js
    return { encode, decode, currentState, apply, hasLink, shareUrl, init, copyLink, toast, SCHEMA };
```

to:

```js
    return { encode, decode, currentState, apply, hasLink, shareUrl, init, createShortLink, copyLink, toast, SCHEMA };
```

- [ ] **Step 5: Update the module header comment.** In `static/share.js`, replace the first paragraph of the top doc-comment (lines 2-9) so it documents both link forms:

```js
/*
 * CNSShare — shareable route links.
 *
 * Primary form: the planner state is POSTed to /api/share, stored server-side
 * (shares.py / SQLite), and shared as a short https://<host>/s/<slug> link.
 * createShortLink()/copyLink() build it; the server injects the saved state as
 * window.__CNS_SHARE__ on open and the page restores it via apply().
 *
 * Legacy form (still supported): the state is serialised into a compact
 * base64url token in the URL *hash* (#r=...). The hash is never sent to the
 * server, so these older links still survive the auth 302 redirect. copyLink()
 * falls back to this hash link whenever the /api/share POST fails.
```

(Leave the rest of the existing comment — the "Auto charging stops…" and "Inline-planner globals…" paragraphs — unchanged.)

- [ ] **Step 6: Run the JS tests to verify they pass.**

Run: `cd "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/.claude/worktrees/sad-kilby-8612cc" && node tests/js_share.test.mjs`
Expected: PASS (all tests, including the 2 new ones).

- [ ] **Step 7: Commit.**

```bash
git add static/share.js tests/js_share.test.mjs
git commit -m "$(printf 'feat(share): copyLink POSTs for a short link, falls back to hash\n\nAdds CNSShare.createShortLink(state); copyLink awaits it and copies the\n/s/<slug> URL, falling back to the legacy #r= hash link if the request\nfails. Node tests cover both paths.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 5: Full-suite + browser end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite.**

Run: `cd "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/.claude/worktrees/sad-kilby-8612cc" && DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/venv/bin/python" -m unittest discover -s tests -p "test_*.py" && node tests/js_share.test.mjs`
Expected: all pass. (`test_api.py` live-server tests self-skip when no server is up — that's fine.)

- [ ] **Step 2: Browser end-to-end check.** Start the app via `.claude/launch.json` + `preview_start` (the only way preview reaches this Flask app), then:
  1. Build a route (Lelystad → Frankfurt), open the result panel, click **Share** → confirm the copied link is `http://127.0.0.1:5055/s/<slug>` (short, not `#r=`).
  2. Open that `/s/<slug>` URL in the preview → confirm the route restores and the address bar stays `/s/<slug>` (no redirect to a long hash, no flash).
  3. Open an old-style `#r=<blob>` link → confirm it still restores (backward compat).
  4. Check `preview_console_logs` for errors.

- [ ] **Step 3: Confirm DB file + dedupe.**

Run: `cd "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/.claude/worktrees/sad-kilby-8612cc" && DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/venv/bin/python" -c "import sqlite3; c=sqlite3.connect('data/shares.db'); print(c.execute('SELECT count(*), count(distinct content_hash) FROM shares').fetchone())"`
Expected: prints a `(rows, distinct_hashes)` tuple where the two numbers are equal (dedupe holds).

- [ ] **Step 4: Report results to the user** — test counts, the short link produced, and the round-trip screenshot. Do not claim success without the suite output and the browser round-trip.

---

## Deployment note (post-merge, for the operator)

`shares.init_db()` creates `data/` + the table on first run. On the VPS the DB persists across deploys (gitignored `data/`). No new pip dependency, so the deploy is the usual push + ssh pull + restart `cns`. WAL mode keeps multi-worker gunicorn reads clean; share-creation write volume is tiny.
