import base64
import contextlib
import hmac
import json
import math
import os
import re
import secrets
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone

try:
    import fcntl            # POSIX only; absent on Windows dev boxes
except ImportError:
    fcntl = None

from urllib.parse import quote
from flask import (Flask, render_template, request, jsonify, send_from_directory,
                   url_for, Response, redirect, make_response, session, abort)
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash
from sim import Simulator
import report
from report import generate_pdf
from spreadsheet import generate_xlsx
import shares
import airport_resolver
import flight_import

app = Flask(__name__)
# Behind the local reverse proxy (Caddy on the VPS) every request reaches gunicorn
# from 127.0.0.1 — trust ONE hop of X-Forwarded-For/-Proto so the brute-force
# throttle buckets REAL client IPs (otherwise one bad actor's 8 failures lock the
# login for every visitor) and the auth log records who actually knocked. Opt-in
# via env: forwarded headers must never be trusted when the app is exposed directly.
if os.environ.get('CNS_BEHIND_PROXY') == '1':
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
# Anchor catalog/data loading to this file's directory, not the process cwd —
# otherwise planes.json/chargers.json/airports are read relative to wherever the
# server happens to be launched from (e.g. a parent worktree), serving stale data.
simulator = Simulator(base_dir=os.path.dirname(os.path.abspath(__file__)))

# Short shareable-link store (SQLite at data/shares.db). Idempotent table
# create at import so every gunicorn worker is ready; see shares.py.
shares.init_db()


@app.before_request
def _refresh_catalog():
    """Pick up an out-of-band notion_sync.py run (data/planes.generated.json
    changed) without a restart — each gunicorn worker notices on its next
    request. Cheap mtime stat; see Simulator.maybe_reload_planes()."""
    simulator.maybe_reload_planes()

# ---------------------------------------------------------------------------
# Authentication & hardening
# ---------------------------------------------------------------------------
# The app is publicly reachable, so it sits behind a single shared password
# (one client + a handful of trusted friends — no per-user accounts needed).
# Configure it via the environment so no secret is ever committed:
#
#   CNS_PASSWORD_HASH  preferred — a werkzeug hash. Generate one with:
#                      python -c "from werkzeug.security import generate_password_hash; \
#                                 print(generate_password_hash('your-password'))"
#   CNS_APP_PASSWORD   fallback — the plaintext password (kept only in the
#                      service environment, e.g. a systemd EnvironmentFile).
#   CNS_SECRET_KEY     signs the session cookie; set a stable random value so
#                      logins survive restarts. Falls back to an ephemeral key.
#   CNS_INSECURE_COOKIES=1   send the session cookie over plain HTTP (local dev
#                            only; production is HTTPS via Cloudflare/bhosted).
#
# When NEITHER password var is set, auth is DISABLED (open app) and a loud
# warning is logged — this keeps local dev and the offline test suite working
# unchanged, but means a public deploy MUST set one of the two vars.
_PASSWORD_HASH = os.environ.get('CNS_PASSWORD_HASH') or ''
_PASSWORD_PLAIN = os.environ.get('CNS_APP_PASSWORD') or ''
_IMPORT_TOKEN = os.environ.get('CNS_IMPORT_TOKEN') or ''
AUTH_ENABLED = bool(_PASSWORD_HASH or _PASSWORD_PLAIN)

_secret_key = os.environ.get('CNS_SECRET_KEY')
if not _secret_key:
    # Ephemeral key: the app still works, but sessions reset on every restart.
    _secret_key = secrets.token_hex(32)
app.secret_key = _secret_key

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',            # blocks cross-site POSTs carrying the cookie (CSRF defence)
    SESSION_COOKIE_SECURE=os.environ.get('CNS_INSECURE_COOKIES') != '1',
    PERMANENT_SESSION_LIFETIME=timedelta(days=14),
    # Reject oversized request bodies before they reach the JSON parser — a
    # cheap cap on a memory/CPU-amplification vector (huge /api/report.* payloads).
    MAX_CONTENT_LENGTH=int(os.environ.get('CNS_MAX_CONTENT_LENGTH', str(16 * 1024 * 1024))),
)

# Endpoints reachable WITHOUT a session. Everything else requires login when
# AUTH_ENABLED. 'static' serves the login page's CSS/JS; 'healthz' lets an
# uptime monitor probe the service without credentials.
# 'pics' is public so link scrapers (WhatsApp/LinkedIn) can fetch the og share
# card + icons after being bounced to /login — it serves only brand/catalog
# images, never user data.
_PUBLIC_ENDPOINTS = {'login', 'logout', 'healthz', 'static', 'pics', 'embed', 'api_import'}

# In-memory brute-force throttle for the login form. Per-worker (not shared
# across gunicorn workers), which is fine for slowing guessing of a single
# shared password; a determined attacker is further bounded by the password's
# own entropy. For multi-instance deployments move this to Redis.
_LOGIN_MAX_ATTEMPTS = 8
_LOGIN_WINDOW_S = 300
_login_attempts = {}                          # ip -> (count, window_start_ts)
_login_lock = threading.Lock()


def _login_blocked(ip):
    now = time.time()
    with _login_lock:
        count, start = _login_attempts.get(ip, (0, now))
        if now - start > _LOGIN_WINDOW_S:
            return False                       # window elapsed → fresh slate
        return count >= _LOGIN_MAX_ATTEMPTS


def _login_record_failure(ip):
    now = time.time()
    with _login_lock:
        count, start = _login_attempts.get(ip, (0, now))
        if now - start > _LOGIN_WINDOW_S:
            count, start = 0, now
        _login_attempts[ip] = (count + 1, start)


def _login_reset(ip):
    with _login_lock:
        _login_attempts.pop(ip, None)


def _password_ok(candidate):
    """Constant-time check of a submitted password against the configured one."""
    candidate = candidate or ''
    if _PASSWORD_HASH:
        try:
            return check_password_hash(_PASSWORD_HASH, candidate)
        except Exception:
            return False
    if _PASSWORD_PLAIN:
        return hmac.compare_digest(candidate, _PASSWORD_PLAIN)
    return False


def _safe_next(target):
    """Only allow same-site relative redirects after login (no open redirect)."""
    if target and target.startswith('/') and not target.startswith('//'):
        return target
    return url_for('index')


def _compute_asset_version():
    """Cache-busting token for /static/*.js, computed ONCE at startup so it adds
    nothing to request latency. It's the current git commit, so the token only
    changes when new code is DEPLOYED — between deploys the static URLs are
    identical and browsers cache the JS exactly as before (zero per-load cost).
    On a deploy the token changes, forcing a single fresh fetch — which is the
    point: it kills the stale-cache bug. Falls back to the process start time if
    git isn't available (still stable per process / per restart)."""
    try:
        sha = subprocess.check_output(
            ['git', 'rev-parse', '--short', 'HEAD'],
            cwd=os.path.dirname(os.path.abspath(__file__)),
            stderr=subprocess.DEVNULL,
        ).decode().strip()
        if sha:
            return sha
    except Exception:
        pass
    return str(int(time.time()))


ASSET_VERSION = _compute_asset_version()

# MDN-recommended UA test: presence of "Mobi" covers iPhone Safari, Chrome/
# Firefox on Android, etc., without false-positiving Android tablets. Users
# misidentified either way can override with /?desktop=1 or /?mobile=1 (sticky).
_MOBILE_UA_RE = re.compile(r'Mobi', re.I)

# ---- server-side persistence for user-defined planes & chargers ----------
# Lives in ./data so it's separate from the built-in JSON in the repo. .gitignore
# keeps the data dir out of version control, so deploys never overwrite user data.
DATA_DIR = os.path.join(os.path.dirname(__file__), 'data')
CUSTOM_FILES = {
    'planes':   os.path.join(DATA_DIR, 'custom_planes.json'),
    'chargers': os.path.join(DATA_DIR, 'custom_chargers.json'),
}
MAX_CUSTOMS = 5    # per type, keeps the UI tidy and the data file bounded
LOG_FILES = {
    'planes':   os.path.join(DATA_DIR, 'planes_log.txt'),
    'chargers': os.path.join(DATA_DIR, 'chargers_log.txt'),
    'auth':     os.path.join(DATA_DIR, 'auth_log.txt'),
}


def _client_ip():
    """Behind a Cloudflare Tunnel, request.remote_addr is 127.0.0.1; the real
    client IP is in CF-Connecting-IP. Use it if present, fall back otherwise."""
    return request.headers.get('CF-Connecting-IP') or request.remote_addr or '?'


def _fmt_val(v):
    if isinstance(v, str):
        return '"' + v.replace('\\', '\\\\').replace('"', '\\"') + '"'
    return str(v)


def _log(kind, action, **fields):
    """Append a one-line audit record. Never raises — logging must never break
    the API path. Lines are short (well under PIPE_BUF) so concurrent writers
    on POSIX don't interleave."""
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        fields.setdefault('from', _client_ip())
        body = ' '.join(f'{k}={_fmt_val(v)}' for k, v in fields.items())
        line = f'{ts} {action:<7} {body}\n'
        with open(LOG_FILES[kind], 'a', encoding='utf-8') as f:
            f.write(line)
    except OSError:
        pass


def _is_finite_num(x):
    """True iff x is a real, finite number (rejects None, str, inf, NaN)."""
    try:
        return math.isfinite(float(x))
    except (TypeError, ValueError):
        return False


def _read_list(path):
    if not os.path.exists(path):
        return []
    try:
        with open(path) as f:
            data = json.load(f)
            if not isinstance(data, list):
                return []
            # Drop entries that violate numeric invariants (inf/NaN from older
            # versions that didn't bound-check). Keeping them risks 500s deep
            # in the simulator math. We silently filter — operators can spot
            # gaps via the audit log.
            cleaned = []
            for entry in data:
                if not isinstance(entry, dict):
                    continue
                # Numeric fields that downstream math relies on; checked per file kind.
                num_keys = ('battery_kwh', 'range_km', 'speed_kmh') if 'battery_kwh' in entry else ('power_kw',)
                if all(_is_finite_num(entry.get(k)) for k in num_keys):
                    cleaned.append(entry)
            return cleaned
    except (OSError, ValueError):
        return []


def _write_list(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Write-to-temp + atomic rename: a concurrent reader never sees a torn,
    # half-written JSON file, and a crash mid-write leaves the old file intact.
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix='.tmp')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


@contextlib.contextmanager
def _custom_lock(kind):
    """Cross-process mutex around the read-modify-write of a customs file.
    Without it, two gunicorn workers handling concurrent POSTs can both read
    the same list, each append, and the second write silently drops the first
    entry (and the MAX_CUSTOMS cap can be raced past). No-op where fcntl is
    unavailable (Windows dev), matching the previous best-effort behaviour."""
    if fcntl is None:
        yield
        return
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(os.path.join(DATA_DIR, f'.{kind}.lock'), 'w') as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)


def _new_id(prefix):
    return f"{prefix}_{int(time.time() * 1000)}"


# A client may supply its own id (the localStorage→server migration in
# static/planes.js re-posts legacy entries with their existing ids). Accept it
# only when it's a sane token AND not already taken — otherwise DELETE-by-id
# could remove a different entry than the one the user clicked.
_CLIENT_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')


def _accept_client_id(client_id, data):
    cid = str(client_id or '')
    if _CLIENT_ID_RE.match(cid) and not any(e.get('id') == cid for e in data):
        return cid
    return None


@app.before_request
def _require_login():
    """Gate every endpoint behind the shared password when auth is enabled.
    Public endpoints (login/logout/health/static) and an already-authenticated
    session pass through. API calls get a JSON 401; page loads get redirected
    to the login screen (preserving where they were headed)."""
    if not AUTH_ENABLED:
        return None
    if request.endpoint in _PUBLIC_ENDPOINTS:
        return None
    if session.get('authed'):
        return None
    if request.path.startswith('/api/'):
        return jsonify({'error': 'Authentication required. Please log in.'}), 401
    return redirect(url_for('login', next=request.path))


@app.after_request
def _security_headers(resp):
    """Defence-in-depth response headers applied to every response."""
    is_embed = request.path == '/embed'

    resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
    if not is_embed:
        resp.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
    resp.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    resp.headers.setdefault('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')

    if os.environ.get('CNS_DISABLE_CSP') != '1':
        if is_embed:
            resp.headers.setdefault('Content-Security-Policy', (
                "default-src 'none'; "
                "script-src 'unsafe-inline' https://unpkg.com; "
                "style-src 'unsafe-inline' https://unpkg.com; "
                "img-src data: https://*.basemaps.cartocdn.com https://server.arcgisonline.com https://unpkg.com; "
                "connect-src https://*.basemaps.cartocdn.com https://server.arcgisonline.com; "
                "frame-ancestors *"
            ))
        else:
            # CSP scoped to the origins the app actually uses (Bootstrap/driver.js on
            # jsDelivr, Leaflet on unpkg, Google Fonts, Carto map tiles, Esri satellite).
            # 'unsafe-inline' is required by the app's inline scripts/styles; tightening
            # that to nonces is a follow-up (see docs/SECURITY_REVIEW.md).
            resp.headers.setdefault('Content-Security-Policy', (
                "default-src 'self'; "
                "base-uri 'self'; "
                "object-src 'none'; "
                "frame-ancestors 'self'; "
                "form-action 'self'; "
                "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; "
                "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com; "
                "font-src 'self' data: https://fonts.gstatic.com; "
                "img-src 'self' data: blob: https://*.basemaps.cartocdn.com https://server.arcgisonline.com "
                "https://unpkg.com https://cdn.jsdelivr.net https://cns.ghettofaust.exposed; "
                "connect-src 'self' https://*.basemaps.cartocdn.com https://server.arcgisonline.com"
            ))
    return resp


@app.route('/healthz')
def healthz():
    """Unauthenticated liveness probe for uptime monitoring."""
    return jsonify({'status': 'ok'})


@app.route('/login', methods=['GET', 'POST'])
def login():
    if not AUTH_ENABLED:
        return redirect(url_for('index'))
    if session.get('authed'):
        return redirect(_safe_next(request.args.get('next')))

    error = None
    if request.method == 'POST':
        ip = _client_ip()
        if _login_blocked(ip):
            _log('auth', 'BLOCK', reason='rate-limited')
            return render_template('login.html',
                                   error='Too many attempts. Wait a few minutes and try again.'), 429
        if _password_ok(request.form.get('password', '')):
            session.clear()
            session['authed'] = True
            session.permanent = True
            _login_reset(ip)
            _log('auth', 'LOGIN')
            return redirect(_safe_next(request.form.get('next') or request.args.get('next')))
        _login_record_failure(ip)
        _log('auth', 'FAIL')
        error = 'Incorrect password.'

    return render_template('login.html', error=error,
                           next=request.args.get('next', '')), (401 if error else 200)


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login') if AUTH_ENABLED else url_for('index'))


@app.route('/')
def index():
    override = request.args.get('desktop') == '1' or request.cookies.get('cns_force_desktop') == '1'
    clear    = request.args.get('mobile') == '1'
    if clear:
        override = False
    if not override and _MOBILE_UA_RE.search(request.headers.get('User-Agent', '')):
        return redirect('/m/')
    resp = make_response(render_template('index.html', planes=simulator.planes, chargers=simulator.chargers, asset_version=ASSET_VERSION))
    if request.args.get('desktop') == '1':
        resp.set_cookie('cns_force_desktop', '1', max_age=60*60*24*365, samesite='Lax')
    elif clear:
        resp.set_cookie('cns_force_desktop', '', max_age=0, samesite='Lax')
    return resp


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


@app.route('/embed')
def embed():
    """Public embed page — serves a lightweight, iframe-embeddable preview card."""
    origin_q    = request.args.get('origin', '').strip()
    dest_q      = request.args.get('destination', '').strip()
    plane_id    = request.args.get('plane', '').strip()
    charger_id  = request.args.get('charger', '').strip()
    trip_type   = request.args.get('tripType', 'one-way')
    theme       = request.args.get('theme', 'light')
    utm_source  = request.args.get('utm_source', '')

    airports = simulator.get_all_airports()

    origin = resolve_airport(origin_q, airports) if origin_q else None
    destination = resolve_airport(dest_q, airports) if dest_q else None

    # Resolve plane (fallback: first catalog plane)
    plane = None
    for p in simulator.planes:
        if p['id'] == plane_id:
            plane = p
            break
    if not plane:
        # Prefer beta_plane (mid-size, showcase aircraft) as embed default
        for p in simulator.planes:
            if p['id'] == 'beta_plane':
                plane = p
                break
        if not plane:
            plane = simulator.planes[0]

    # Resolve charger (fallback: plane's default, then first catalog charger)
    charger = None
    for ch in simulator.chargers:
        if ch['id'] == (charger_id or plane.get('default_charger_id', '')):
            charger = ch
            break
    if not charger:
        charger = simulator.chargers[0]

    # Determine tier and optionally simulate
    sim_result = None
    if origin and destination:
        tier = 'full' if plane_id else 'route'
        try:
            sim_result = simulator.simulate(
                plane['id'], origin['ident'], destination['ident'],
                charger['id'], trip_type)
        except Exception:
            sim_result = None
    elif origin:
        tier = 'range'
    else:
        tier = 'network'

    # Build share state for click-through URL
    share_state = {'v': 1}
    if origin:
        share_state['o'] = origin['ident']
    if destination:
        share_state['d'] = destination['ident']
    share_state['a'] = plane['id']
    share_state['c'] = charger['id']
    share_state['t'] = trip_type
    share_state['f'] = {'n': 1, 'u': 'day'}
    share_state['w'] = True
    share_state['s'] = []

    cns_base = request.host_url.rstrip('/')
    if origin or destination:
        click_url = cns_base + '/#r=' + encode_share_state(share_state)
    else:
        click_url = cns_base + '/'

    # Reachable airports for range tier
    reachable = []
    if tier == 'range':
        range_km = plane.get('range_km', 500)
        olat, olon = origin['latitude_deg'], origin['longitude_deg']
        for ap in airports:
            if ap['ident'] == origin['ident']:
                continue
            d = _haversine(olat, olon, ap['latitude_deg'], ap['longitude_deg'])
            if d <= range_km:
                reachable.append({
                    'ident': ap['ident'], 'name': ap['name'],
                    'lat': ap['latitude_deg'], 'lon': ap['longitude_deg'],
                    'type': ap['type'], 'dist': round(d, 1),
                })

    # Airports for network tier (medium+ only to keep the map fast)
    network_airports = []
    if tier == 'network':
        network_airports = [
            {'ident': ap['ident'], 'name': ap['name'],
             'lat': ap['latitude_deg'], 'lon': ap['longitude_deg']}
            for ap in airports
            if ap.get('type') in ('large_airport', 'medium_airport')
        ]

    resp = make_response(render_template(
        'embed.html',
        tier=tier, theme=theme,
        origin=origin, destination=destination,
        plane=plane, charger=charger,
        sim_result=sim_result,
        reachable=reachable,
        network_airports=network_airports,
        click_url=click_url,
        utm_source=utm_source,
    ))
    resp.headers['Cache-Control'] = 'public, max-age=3600'
    resp.headers['Vary'] = 'Accept-Encoding'
    return resp


@app.route('/m/')
def index_mobile():
    """Mobile-first variant: full-screen map + Google-Maps-style bottom
    sheet + slim top bar. Reuses every static/*.js module from the
    desktop build — only the layout + bottom-sheet glue (static/mobile.js)
    is mobile-specific. Desktop template is unchanged."""
    return render_template('index_mobile.html', planes=simulator.planes, chargers=simulator.chargers)


@app.route('/pics/<path:filename>')
def pics(filename):
    return send_from_directory('pics', filename)


@app.route('/api/airports', methods=['GET'])
def get_airports():
    return jsonify(simulator.get_all_airports())


# ---- airport hover photo (live-map preview) ---------------------------------
# A small WebP thumbnail per airport for the map's hover popup. Reuses the PDF
# cover's exact resolution pipeline (report.airport_photo_thumb -> curated photo /
# Wikidata-Wikipedia lead image / Esri satellite fallback) and its on-disk cache,
# so the hover image is literally "just like in the PDF". Auth-gated like the rest
# of the app (only logged-in users hovering the map reach it), which also bounds
# the outbound Wikimedia/Esri fetches to authenticated callers.
_airport_idx = None


def _airport_by_ident(ident):
    ident = (ident or '').strip().upper()
    if not report._SAFE_IDENT_RE.match(ident):
        return None
    global _airport_idx
    if _airport_idx is None:
        _airport_idx = {a['ident'].upper(): a
                        for a in simulator.get_all_airports() if a.get('ident')}
    return _airport_idx.get(ident)


# ── Airport resolution (used by /embed) ────────────────────────────────────
_TYPE_RANK = {'large_airport': 0, 'medium_airport': 1, 'small_airport': 2}

def resolve_airport(query, airports):
    """Resolve a fuzzy airport name or ICAO/IATA code to an airport record.

    Matching priority: exact ICAO → exact IATA → exact municipality →
    substring on name (prefer larger type) → substring on municipality
    (prefer larger type).  Returns None if no match.
    """
    q = (query or '').strip()
    if not q:
        return None
    q_upper = q.upper()
    q_lower = q.lower()

    for ap in airports:
        if ap['ident'].upper() == q_upper:
            return ap

    for ap in airports:
        if (ap.get('iata_code') or '').upper() == q_upper:
            return ap

    for ap in airports:
        if (ap.get('municipality') or '').lower() == q_lower:
            return ap

    hits = [ap for ap in airports if q_lower in ap['name'].lower()]
    if hits:
        return min(hits, key=lambda a: _TYPE_RANK.get(a.get('type'), 9))

    hits = [ap for ap in airports if q_lower in (ap.get('municipality') or '').lower()]
    if hits:
        return min(hits, key=lambda a: _TYPE_RANK.get(a.get('type'), 9))

    return None


def encode_share_state(state):
    """Encode a CNSShare-compatible state dict to a base64url string.

    Matches the encoding in static/share.js: JSON → UTF-8 → base64url (no padding).
    """
    json_bytes = json.dumps(state, separators=(',', ':')).encode()
    return base64.urlsafe_b64encode(json_bytes).rstrip(b'=').decode()


def _haversine(lat1, lon1, lat2, lon2):
    """Great-circle distance in km between two lat/lon points."""
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1))*math.cos(math.radians(lat2))*math.sin(dlon/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))


@app.route('/api/airport-photo/<ident>', methods=['GET'])
def airport_photo(ident):
    ap = _airport_by_ident(ident)
    if ap is None:
        abort(404)
    data, credit = report.airport_photo_thumb(
        ap['ident'], ap.get('name', ''),
        ap.get('latitude_deg'), ap.get('longitude_deg'), ap.get('type'),
        iso_country=ap.get('iso_country', ''))
    if not data:
        if credit == '__busy__':
            # cold-build slots full — ask the client to retry (it must NOT cache
            # this as "no photo"), rather than queueing behind a held worker.
            return Response(status=503, headers={'Retry-After': '2'})
        abort(404)   # no usable image — the client falls back to the plain popup
    resp = Response(data, mimetype='image/webp')
    # Fetched once, then served from the on-disk thumbnail cache; let the browser
    # hold it too so a re-hover never re-requests.
    resp.headers['Cache-Control'] = 'public, max-age=604800'
    if credit:
        resp.headers['X-Photo-Credit'] = quote(credit)   # may carry non-ASCII (—, ©)
    return resp


# ---- airport-resident chargers (real-world NRG2FLY install data) -------------
# Structured per-airport plug data, keyed by ICAO. Loaded once at startup (it's
# a small tracked catalog, like planes.json / chargers.json), so reads add no
# per-request file IO. Missing/invalid file degrades to an empty mapping rather
# than crashing the app.
def _load_airport_chargers():
    path = os.path.join(os.path.dirname(__file__), 'airports', 'airport_chargers.json')
    try:
        with open(path) as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


AIRPORT_CHARGERS = _load_airport_chargers()


@app.route('/api/airport-chargers', methods=['GET'])
def get_airport_chargers():
    return jsonify(AIRPORT_CHARGERS)


@app.route('/api/airport-chargers/<icao>', methods=['GET'])
def get_airport_chargers_one(icao):
    airport = AIRPORT_CHARGERS.get(icao.upper())
    if airport is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(airport)


# ---- custom planes & chargers (shared across all visitors on this server) ----
@app.route('/api/custom/planes', methods=['GET'])
def list_custom_planes():
    return jsonify(_read_list(CUSTOM_FILES['planes']))


@app.route('/api/custom/planes', methods=['POST'])
def add_custom_plane():
    p = request.json or {}
    try:
        battery = float(p.get('battery_kwh'))
        rng = float(p.get('range_km'))
        spd = float(p.get('speed_kmh'))
    except (TypeError, ValueError):
        _log('planes', 'REJECT', reason='non-numeric battery/range/speed', name=p.get('name', ''))
        return jsonify({'error': 'battery_kwh / range_km / speed_kmh must be numbers'}), 400
    if not p.get('name') or not (battery > 0 and rng > 0 and spd > 0):
        _log('planes', 'REJECT', reason='missing or non-positive fields', name=p.get('name', ''))
        return jsonify({'error': 'name + positive battery/range/speed required'}), 400
    # Reject inf/NaN and absurd-but-finite values that would later overflow
    # the simulator's energy/time math (see sim.calculate_flight_by_distance).
    # Ceilings are deliberately generous: ~10× the largest realistic electric
    # airframe but small enough that distance × kWh/km stays inside float64.
    if not all(math.isfinite(v) for v in (battery, rng, spd)):
        _log('planes', 'REJECT', reason='non-finite battery/range/speed', name=p.get('name', ''))
        return jsonify({'error': 'battery/range/speed must be finite numbers'}), 400
    if not (battery <= 100_000 and rng <= 50_000 and spd <= 5_000):
        _log('planes', 'REJECT', reason='value out of range', name=p.get('name', ''))
        return jsonify({'error': 'battery_kwh ≤ 100000, range_km ≤ 50000, speed_kmh ≤ 5000'}), 400

    with _custom_lock('planes'):
        data = _read_list(CUSTOM_FILES['planes'])
        if len(data) >= MAX_CUSTOMS:
            _log('planes', 'REJECT', reason=f'cap of {MAX_CUSTOMS} reached', name=p.get('name', ''))
            return jsonify({'error': f'Limit of {MAX_CUSTOMS} custom planes reached — remove one first.'}), 400

        saved = {'id': _accept_client_id(p.get('id'), data) or _new_id('custom'),
                 'name': str(p['name'])[:80],
                 'battery_kwh': battery, 'range_km': rng, 'speed_kmh': spd}
        if p.get('seats') not in (None, ''):
            try:    saved['seats'] = int(p['seats'])
            except (TypeError, ValueError): pass
        if p.get('load_kg') not in (None, ''):
            try:    saved['load_kg'] = float(p['load_kg'])
            except (TypeError, ValueError): pass
        # Optional battery charge C-rate (used by the charging-curve model factor).
        # Only persist a sane, finite, positive value; otherwise it falls back to
        # the global slider default at calculation time.
        if p.get('c_rate') not in (None, ''):
            try:
                cr = float(p['c_rate'])
                if math.isfinite(cr) and 0 < cr <= 10:
                    saved['c_rate'] = cr
            except (TypeError, ValueError):
                pass

        data.append(saved)
        _write_list(CUSTOM_FILES['planes'], data)
    _log('planes', 'ADD', **saved)
    return jsonify(saved), 201


@app.route('/api/custom/planes/<plane_id>', methods=['DELETE'])
def delete_custom_plane(plane_id):
    with _custom_lock('planes'):
        data = _read_list(CUSTOM_FILES['planes'])
        target = next((p for p in data if p.get('id') == plane_id), None)
        if not target:
            _log('planes', 'MISS', op='delete', id=plane_id)
            return jsonify({'error': 'not found'}), 404
        kept = [p for p in data if p.get('id') != plane_id]
        _write_list(CUSTOM_FILES['planes'], kept)
    _log('planes', 'DELETE', id=plane_id, name=target.get('name', ''))
    return jsonify({'deleted': plane_id})


@app.route('/api/custom/chargers', methods=['GET'])
def list_custom_chargers():
    return jsonify(_read_list(CUSTOM_FILES['chargers']))


@app.route('/api/custom/chargers', methods=['POST'])
def add_custom_charger():
    c = request.json or {}
    try:
        power = float(c.get('power_kw'))
    except (TypeError, ValueError):
        _log('chargers', 'REJECT', reason='non-numeric power_kw', name=c.get('name', ''))
        return jsonify({'error': 'power_kw must be a number'}), 400
    if not c.get('name') or not (power > 0):
        _log('chargers', 'REJECT', reason='missing or non-positive fields', name=c.get('name', ''))
        return jsonify({'error': 'name + positive power_kw required'}), 400
    if not math.isfinite(power):
        _log('chargers', 'REJECT', reason='non-finite power_kw', name=c.get('name', ''))
        return jsonify({'error': 'power_kw must be a finite number'}), 400
    if not (power <= 100_000):
        _log('chargers', 'REJECT', reason='value out of range', name=c.get('name', ''))
        return jsonify({'error': 'power_kw ≤ 100000'}), 400

    with _custom_lock('chargers'):
        data = _read_list(CUSTOM_FILES['chargers'])
        if len(data) >= MAX_CUSTOMS:
            _log('chargers', 'REJECT', reason=f'cap of {MAX_CUSTOMS} reached', name=c.get('name', ''))
            return jsonify({'error': f'Limit of {MAX_CUSTOMS} custom chargers reached — remove one first.'}), 400

        saved = {'id': _accept_client_id(c.get('id'), data) or _new_id('charger'),
                 'name': str(c['name'])[:80],
                 'power_kw': power}

        data.append(saved)
        _write_list(CUSTOM_FILES['chargers'], data)
    _log('chargers', 'ADD', **saved)
    return jsonify(saved), 201


@app.route('/api/custom/chargers/<charger_id>', methods=['DELETE'])
def delete_custom_charger(charger_id):
    with _custom_lock('chargers'):
        data = _read_list(CUSTOM_FILES['chargers'])
        target = next((c for c in data if c.get('id') == charger_id), None)
        if not target:
            _log('chargers', 'MISS', op='delete', id=charger_id)
            return jsonify({'error': 'not found'}), 404
        kept = [c for c in data if c.get('id') != charger_id]
        _write_list(CUSTOM_FILES['chargers'], kept)
    _log('chargers', 'DELETE', id=charger_id, name=target.get('name', ''))
    return jsonify({'deleted': charger_id})


@app.route('/api/simulate', methods=['POST'])
def simulate_flight():
    data = request.json
    origin = data.get('origin')
    destination = data.get('destination')
    plane_id = data.get('plane_id')
    charger_id = data.get('charger_id')
    trip_type = data.get('trip_type', 'one-way')
    plane_obj = data.get('plane')        # optional user-defined custom aircraft
    charger_obj = data.get('charger')    # optional user-defined custom charger
    stops = data.get('stops') or None    # optional charging-stop waypoints (list of {name,lat,lon[,ident,type]})

    if not all([origin, destination]) or not (plane_id or plane_obj) or not (charger_id or charger_obj):
        return jsonify({"error": "Missing parameters"}), 400

    # Origin == destination on a STOP-LESS one-way / retour is a degenerate
    # zero-distance flight (success:true with all-zero numbers) — reject early.
    # A multi-stop trip that returns to base is a legitimate rotation
    # (e.g. AMS->LHR->AMS->...->AMS) — with stops the legs have real distance, so
    # this is NOT degenerate. The relaxation deliberately covers ALL non-training
    # types (oneway/retour/circular): skip the check whenever stops are present.
    if trip_type != 'training' and not stops:
        same = False
        if isinstance(origin, dict) and isinstance(destination, dict):
            same = (origin.get('lat') == destination.get('lat')
                    and origin.get('lon') == destination.get('lon'))
        elif isinstance(origin, str) and isinstance(destination, str):
            same = origin.strip().lower() == destination.strip().lower()
        if same:
            return jsonify({"error": "Origin and destination must differ "
                                     "(use trip_type='training' for circuit flights)."}), 400

    # A circular trip without intermediate stops is just a retour; rejecting it
    # here keeps the two types distinct (and the sim's single-leg path never
    # sees 'circular').
    if trip_type == 'circular' and not stops:
        return jsonify({"error": "A circular trip needs at least one intermediate stop. "
                                 "For a there-and-back flight, pick Return."}), 400

    # Any uncaught exception below would otherwise render Flask's HTML 500 page,
    # which breaks the browser's JSON parser and surfaces as an opaque failure.
    # Keep the response shape consistent so the UI can show a real error.
    try:
        if isinstance(origin, dict) and isinstance(destination, dict):
            result = simulator.simulate_by_coords(plane_id, origin, destination, charger_id, trip_type, plane_obj, charger_obj, stops)
        else:
            result = simulator.simulate(plane_id, origin, destination, charger_id, trip_type, plane_obj, charger_obj)
    except (OverflowError, ValueError, ZeroDivisionError, KeyError, TypeError) as e:
        # Defense in depth: an inline plane/charger object missing a field the
        # simulator expects would otherwise escape as Flask's HTML 500 page and
        # break the browser's JSON parser. Surface it as JSON instead.
        return jsonify({"error": f"Simulation failed: {type(e).__name__}: {e}"}), 500
    return jsonify(result)


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


@app.route('/api/import', methods=['POST'])
def api_import():
    """Token-gated import: a normalized flight payload in, a build-share link out.
    Public endpoint (bypasses the session gate) but enforces a bearer token so a
    portable skill can post without the interactive login. Stores the assembled
    build blob in the shares DB and returns the /s/<slug> link + a report."""
    auth = request.headers.get('Authorization', '')
    token = auth[7:] if auth.startswith('Bearer ') else ''
    if not _IMPORT_TOKEN or not hmac.compare_digest(token, _IMPORT_TOKEN):
        return jsonify({'error': 'Invalid or missing import token.'}), 401

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'Expected a JSON object body.'}), 400
    try:
        flight_import.validate_normalized(payload)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400

    planes_by_id = {p['id']: p for p in simulator.planes}
    blob, import_report = flight_import.build_blob(payload, airport_resolver.resolve, planes_by_id)

    if len(json.dumps(blob).encode('utf-8')) > shares.MAX_STATE_BYTES:
        return jsonify({'error': 'Imported build is too large to share.'}), 413
    try:
        slug = shares.save_state(blob)
    except Exception:
        app.logger.exception('Import share save failed')
        return jsonify({'error': 'Could not create import link.'}), 500

    url = request.host_url.rstrip('/') + '/s/' + slug
    return jsonify({'url': url, 'slug': slug, 'report': import_report})


@app.route('/api/report.pdf', methods=['POST'])
def report_pdf():
    """Browser POSTs a fully-computed plan; we typeset it and stream a PDF back.
    See report.py for the payload shape. Returns 400 if payload is empty, 500
    if the WeasyPrint pipeline blows up (with a JSON error message)."""
    payload = request.get_json(silent=True) or {}
    if not payload.get('airports'):
        return jsonify({'error': 'Nothing to report — add at least one flight first.'}), 400
    try:
        css_url = url_for('static', filename='report.css')
        pdf_bytes = generate_pdf(payload, css_url=css_url, request_root=request.url_root)
    except RuntimeError as e:
        # Missing dependency: surface the message verbatim so the operator sees it.
        return jsonify({'error': str(e)}), 500
    except Exception:
        # Full traceback to the server log; only a generic message to the client
        # (raw exception text can leak filesystem paths / internals).
        app.logger.exception('PDF generation failed')
        return jsonify({'error': 'PDF generation failed — see the server log for details.'}), 500

    filename = f'nrg2fly-charging-plan-{datetime.now().strftime("%Y-%m-%d")}.pdf'
    return Response(
        pdf_bytes,
        mimetype='application/pdf',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'},
    )


@app.route('/api/report.xlsx', methods=['POST'])
def report_xlsx():
    """Browser POSTs the whole-DC plan; we build a standardised, responsive XLSX
    workbook and stream it back. See spreadsheet.py for the format. Returns 400
    if the payload is empty, 500 (JSON error) if the builder fails."""
    payload = request.get_json(silent=True) or {}
    if not payload.get('airports'):
        return jsonify({'error': 'Nothing to export — add at least one flight first.'}), 400
    try:
        xlsx_bytes = generate_xlsx(payload)
    except RuntimeError as e:
        # Missing dependency (openpyxl): surface verbatim.
        return jsonify({'error': str(e)}), 500
    except Exception:
        app.logger.exception('Spreadsheet generation failed')
        return jsonify({'error': 'Spreadsheet generation failed — see the server log for details.'}), 500

    filename = f'nrg2fly-charging-plan-{datetime.now().strftime("%Y-%m-%d")}.xlsx'
    return Response(
        xlsx_bytes,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'},
    )


if __name__ == '__main__':
    # Dev convenience only. In production the app is served by gunicorn (app:app),
    # which never runs this block. Debug is OFF unless you opt in via FLASK_DEBUG=1.
    app.run(host='127.0.0.1',
            port=int(os.environ.get('PORT', '5055')),
            debug=os.environ.get('FLASK_DEBUG') == '1')
