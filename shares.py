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
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
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
            '  content_hash TEXT NOT NULL,'
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
        for _attempt in range(10):
            slug = _new_slug()
            try:
                conn.execute(
                    'INSERT INTO shares (slug, state, content_hash, created_at) '
                    'VALUES (?, ?, ?, ?)', (slug, blob, digest, created)
                )
                return slug
            except sqlite3.IntegrityError:
                continue  # slug primary-key collision (astronomically rare) — retry
        raise RuntimeError('shares: failed to generate a unique slug after 10 attempts')


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
