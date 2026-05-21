from flask import Flask, render_template, request, jsonify, send_from_directory
from sim import Simulator

app = Flask(__name__)
simulator = Simulator()

@app.route('/')
def index():
    return render_template('index.html', planes=simulator.planes, chargers=simulator.chargers)

@app.route('/pics/<path:filename>')
def pics(filename):
    return send_from_directory('pics', filename)

@app.route('/api/airports', methods=['GET'])
def get_airports():
    return jsonify(simulator.get_all_airports())

@app.route('/api/simulate', methods=['POST'])
def simulate_flight():
    data = request.json
    origin = data.get('origin')
    destination = data.get('destination')
    plane_id = data.get('plane_id')
    charger_id = data.get('charger_id')
    trip_type = data.get('trip_type', 'one-way')
    plane_obj = data.get('plane')  # optional user-defined custom aircraft

    if not all([origin, destination, charger_id]) or not (plane_id or plane_obj):
        return jsonify({"error": "Missing parameters"}), 400

    # Coordinate-based selection (from autocomplete) is unambiguous; prefer it.
    if isinstance(origin, dict) and isinstance(destination, dict):
        result = simulator.simulate_by_coords(plane_id, origin, destination, charger_id, trip_type, plane_obj)
    else:
        result = simulator.simulate(plane_id, origin, destination, charger_id, trip_type, plane_obj)
    return jsonify(result)

if __name__ == '__main__':
    # Dev convenience only. In production the app is served by gunicorn (app:app),
    # which never runs this block. Debug is OFF unless you opt in via FLASK_DEBUG=1.
    import os
    app.run(host='127.0.0.1',
            port=int(os.environ.get('PORT', '5055')),
            debug=os.environ.get('FLASK_DEBUG') == '1')