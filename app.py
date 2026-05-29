import json
import math
import os
import re
import time
from datetime import datetime, timezone

from flask import Flask, render_template, request, jsonify, send_from_directory, url_for, Response, redirect, make_response
from sim import Simulator
from report import generate_pdf

app = Flask(__name__)
simulator = Simulator()

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
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)


def _new_id(prefix):
    return f"{prefix}_{int(time.time() * 1000)}"


@app.route('/')
def index():
    override = request.args.get('desktop') == '1' or request.cookies.get('cns_force_desktop') == '1'
    clear    = request.args.get('mobile') == '1'
    if clear:
        override = False
    if not override and _MOBILE_UA_RE.search(request.headers.get('User-Agent', '')):
        return redirect('/m/')
    resp = make_response(render_template('index.html', planes=simulator.planes, chargers=simulator.chargers))
    if request.args.get('desktop') == '1':
        resp.set_cookie('cns_force_desktop', '1', max_age=60*60*24*365, samesite='Lax')
    elif clear:
        resp.set_cookie('cns_force_desktop', '', max_age=0, samesite='Lax')
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

    data = _read_list(CUSTOM_FILES['planes'])
    if len(data) >= MAX_CUSTOMS:
        _log('planes', 'REJECT', reason=f'cap of {MAX_CUSTOMS} reached', name=p.get('name', ''))
        return jsonify({'error': f'Limit of {MAX_CUSTOMS} custom planes reached — remove one first.'}), 400

    saved = {'id': p.get('id') or _new_id('custom'),
             'name': str(p['name'])[:80],
             'battery_kwh': battery, 'range_km': rng, 'speed_kmh': spd}
    if p.get('seats') not in (None, ''):
        try:    saved['seats'] = int(p['seats'])
        except: pass
    if p.get('load_kg') not in (None, ''):
        try:    saved['load_kg'] = float(p['load_kg'])
        except: pass
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

    data = _read_list(CUSTOM_FILES['chargers'])
    if len(data) >= MAX_CUSTOMS:
        _log('chargers', 'REJECT', reason=f'cap of {MAX_CUSTOMS} reached', name=c.get('name', ''))
        return jsonify({'error': f'Limit of {MAX_CUSTOMS} custom chargers reached — remove one first.'}), 400

    saved = {'id': c.get('id') or _new_id('charger'),
             'name': str(c['name'])[:80],
             'power_kw': power}

    data.append(saved)
    _write_list(CUSTOM_FILES['chargers'], data)
    _log('chargers', 'ADD', **saved)
    return jsonify(saved), 201


@app.route('/api/custom/chargers/<charger_id>', methods=['DELETE'])
def delete_custom_charger(charger_id):
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

    # Origin == destination is only meaningful for training (circular pattern).
    # For one-way / retour it produces success:true with all-zero numbers, which
    # is misleading. Reject early with a clear message.
    if trip_type != 'training':
        same = False
        if isinstance(origin, dict) and isinstance(destination, dict):
            same = (origin.get('lat') == destination.get('lat')
                    and origin.get('lon') == destination.get('lon'))
        elif isinstance(origin, str) and isinstance(destination, str):
            same = origin.strip().lower() == destination.strip().lower()
        if same:
            return jsonify({"error": "Origin and destination must differ "
                                     "(use trip_type='training' for circuit flights)."}), 400

    # Any uncaught exception below would otherwise render Flask's HTML 500 page,
    # which breaks the browser's JSON parser and surfaces as an opaque failure.
    # Keep the response shape consistent so the UI can show a real error.
    try:
        if isinstance(origin, dict) and isinstance(destination, dict):
            result = simulator.simulate_by_coords(plane_id, origin, destination, charger_id, trip_type, plane_obj, charger_obj, stops)
        else:
            result = simulator.simulate(plane_id, origin, destination, charger_id, trip_type, plane_obj, charger_obj)
    except (OverflowError, ValueError, ZeroDivisionError) as e:
        return jsonify({"error": f"Simulation failed: {e}"}), 500
    return jsonify(result)


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
    except Exception as e:
        return jsonify({'error': f'PDF generation failed: {e}'}), 500

    filename = f'nrg2fly-charging-plan-{datetime.now().strftime("%Y-%m-%d")}.pdf'
    return Response(
        pdf_bytes,
        mimetype='application/pdf',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'},
    )


if __name__ == '__main__':
    # Dev convenience only. In production the app is served by gunicorn (app:app),
    # which never runs this block. Debug is OFF unless you opt in via FLASK_DEBUG=1.
    app.run(host='127.0.0.1',
            port=int(os.environ.get('PORT', '5055')),
            debug=os.environ.get('FLASK_DEBUG') == '1')
