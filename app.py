import json
import os
import time
from datetime import datetime, timezone

from flask import Flask, render_template, request, jsonify, send_from_directory
from sim import Simulator

app = Flask(__name__)
simulator = Simulator()

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


def _read_list(path):
    if not os.path.exists(path):
        return []
    try:
        with open(path) as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
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
    return render_template('index.html', planes=simulator.planes, chargers=simulator.chargers)


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

    if not all([origin, destination]) or not (plane_id or plane_obj) or not (charger_id or charger_obj):
        return jsonify({"error": "Missing parameters"}), 400

    if isinstance(origin, dict) and isinstance(destination, dict):
        result = simulator.simulate_by_coords(plane_id, origin, destination, charger_id, trip_type, plane_obj, charger_obj)
    else:
        result = simulator.simulate(plane_id, origin, destination, charger_id, trip_type, plane_obj, charger_obj)
    return jsonify(result)


if __name__ == '__main__':
    # Dev convenience only. In production the app is served by gunicorn (app:app),
    # which never runs this block. Debug is OFF unless you opt in via FLASK_DEBUG=1.
    app.run(host='127.0.0.1',
            port=int(os.environ.get('PORT', '5055')),
            debug=os.environ.get('FLASK_DEBUG') == '1')
