# CNS — Database Implementation Plan

## Why a database

Today the app persists data in three uncoordinated places:

| Data | Where it lives now | Problem |
|---|---|---|
| Custom planes / chargers | `data/custom_*.json` (file + `fcntl` lock) | Global to everyone; hand-rolled locking; capped at 5; no ownership |
| Saved plans (the "folder"), schedule, settings | **Browser `localStorage`** | Lost on cache clear; not shareable; tied to one device/browser |
| Audit log | `data/*_log.txt` | Unqueryable text; no retention/rotation |

A small database fixes all three: server-side plans that follow the user across
devices and can be shared by link, real ownership for custom kit, and a
queryable audit trail. It also retires the fragile file-locking dance —
transactions give atomic read-modify-write for free.

## Recommendation: SQLite + SQLAlchemy (+ Alembic)

For a single VPS serving one client and a few friends, **SQLite is the right
default** — zero ops, one file, fully transactional, easily backed up. Use
**SQLAlchemy** as the ORM and **Alembic** (via Flask-Migrate) for schema
migrations, so if you ever outgrow SQLite the move to **PostgreSQL** is a
connection-string change, not a rewrite.

```
SQLite file:   data/cns.sqlite3   (data/ is already .gitignored)
ORM:           SQLAlchemy 2.x  + Flask-SQLAlchemy
Migrations:    Alembic (Flask-Migrate)
```

Add to `requirements.txt`: `Flask-SQLAlchemy==3.1.1`, `Flask-Migrate==4.0.7`.

**SQLite concurrency note (important for gunicorn 2×4 threads):** enable WAL mode
and a busy timeout once at startup, then concurrent reads + serialized writes are
safe:

```python
# on engine connect
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA synchronous=NORMAL;
```

## Schema (v1)

```sql
-- Custom aircraft (replaces data/custom_planes.json)
CREATE TABLE custom_planes (
    id           TEXT PRIMARY KEY,          -- keep existing 'custom_…' id scheme
    name         TEXT NOT NULL,
    battery_kwh  REAL NOT NULL CHECK (battery_kwh > 0),
    range_km     REAL NOT NULL CHECK (range_km > 0),
    speed_kmh    REAL NOT NULL CHECK (speed_kmh > 0),
    seats        INTEGER,
    load_kg      REAL,
    c_rate       REAL,
    owner_id     INTEGER REFERENCES users(id),  -- NULL until accounts exist
    created_at   TEXT NOT NULL,
    created_ip   TEXT
);

-- Custom chargers (replaces data/custom_chargers.json)
CREATE TABLE custom_chargers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    power_kw    REAL NOT NULL CHECK (power_kw > 0),
    owner_id    INTEGER REFERENCES users(id),
    created_at  TEXT NOT NULL,
    created_ip  TEXT
);

-- Server-side saved plans (replaces the localStorage "folder"); shareable by token
CREATE TABLE saved_plans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    share_token TEXT UNIQUE,                 -- random; lets a plan be opened by URL
    owner_id    INTEGER REFERENCES users(id),
    name        TEXT NOT NULL,
    payload     TEXT NOT NULL,               -- the JSON the browser already assembles
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- Queryable audit trail (replaces data/*_log.txt)
CREATE TABLE audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL,
    actor_ip  TEXT,
    kind      TEXT,                          -- 'planes' | 'chargers' | 'auth' | 'plan'
    action    TEXT,                          -- 'ADD' | 'DELETE' | 'LOGIN' | …
    detail    TEXT                           -- JSON blob
);

-- Optional, only if you move beyond the single shared password later
CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
    created_at    TEXT NOT NULL
);
```

The catalogs (`planes.json`, `chargers.json`, `airport_chargers.json`,
`european_airports.csv`) **stay as files** — they're read-only reference data,
version-controlled, and pandas already serves the airport CSV efficiently. No
need to import 60k airports into SQLite unless you later want server-side
autocomplete/geo queries (then a one-time import + an R-tree index is worth it).

## Rollout (incremental, no big-bang)

**Phase 1 — introduce the DB behind the existing API (no frontend change).**
- Add the models + Flask-SQLAlchemy init in a new `db.py`; create tables on
  startup (or via `flask db upgrade`).
- One-time import script: read `data/custom_planes.json` / `custom_chargers.json`
  into the tables (idempotent on `id`).
- Rewrite the four custom-kit endpoints to use the DB. The request/response
  shape is unchanged, so `static/planes.js` / `chargers.js` keep working as-is.
  The `_custom_lock` / `_read_list` / `_write_list` file machinery is deleted.

  ```python
  @app.route('/api/custom/planes', methods=['POST'])
  def add_custom_plane():
      p = request.json or {}
      # ... the SAME validation as today ...
      plane = CustomPlane(id=_accept_client_id(...) or _new_id('custom'), name=...,
                          battery_kwh=battery, range_km=rng, speed_kmh=spd,
                          created_at=_utcnow(), created_ip=_client_ip())
      db.session.add(plane); db.session.commit()      # atomic — no flock needed
      return jsonify(plane.as_dict()), 201
  ```

**Phase 2 — server-side saved plans (the big UX win).**
- New endpoints: `POST /api/plans` (save current folder), `GET /api/plans`
  (list mine), `GET /api/plans/<id>` (load), `DELETE /api/plans/<id>`, and
  `GET /p/<share_token>` (open a shared plan read-only).
- The browser already builds a self-contained plan payload (it's what
  `/api/report.pdf` receives) — persist that JSON in `saved_plans.payload`.
- Add a small "My plans" UI; keep `localStorage` as an offline cache/fallback.

**Phase 3 — accounts & ownership (optional).**
- If you want per-person data, add the `users` table and swap the single shared
  password for login-by-email. Backfill `owner_id` on existing rows to a default
  admin user. Custom kit and plans become per-user; admins see all.

**Phase 4 — migrate the audit log.**
- Point `_log(...)` at the `audit_log` table. Gives you "who added what, when"
  as a real query instead of grepping text files.

## Operations

- **Backups:** nightly `sqlite3 data/cns.sqlite3 ".backup data/backup-$(date +%F).sqlite3"`
  (WAL-safe), keep ~14 days, and pull a copy off the VPS. The DB file is the only
  stateful thing to back up.
- **Migrations:** `flask db migrate -m "..."` + `flask db upgrade` in the deploy
  step. Alembic versioning means schema changes are reviewable and reversible.
- **Don't commit `data/cns.sqlite3`** — `data/` is already gitignored.
- **Outgrowing SQLite?** Unlikely at this scale, but if write concurrency ever
  becomes the bottleneck, provision Postgres on bhosted and change
  `SQLALCHEMY_DATABASE_URI` — the models and Alembic migrations carry over.

## Effort estimate

| Phase | Scope | Rough effort |
|---|---|---|
| 1 | DB + custom-kit migration | ~half a day |
| 2 | Saved plans + share links + UI | ~1–2 days |
| 3 | Accounts & ownership | ~1–2 days |
| 4 | Audit log to DB | ~1–2 hours |
```
