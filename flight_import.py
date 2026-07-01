"""
flight_import — deterministic conversion of a normalized flight payload into a
CNS build blob + a structured report. Pure functions (resolution is injected),
so they unit-test without Flask or the airport CSV.

Pipeline (build_blob): validate → resolve codes → classify trip type →
aggregate identical routes into frequencies → assemble the build blob.
"""

import hashlib
import math
from datetime import datetime


def classify_trip(idents):
    """Classify an ordered list of resolved airport idents into a CNS trip.

    route[0]==route[-1] (round trip):
      - exactly one distinct intermediate -> 'retour' (o=start, d=far point)
      - multiple distinct intermediates   -> 'circular' (o=d=start, s=stops)
    otherwise -> 'oneway' (o=first, d=last, s=middles).
    """
    o = idents[0]
    last = idents[-1]
    if o == last:
        seen, mids = set(), []
        for x in idents[1:-1]:
            if x not in seen:
                seen.add(x)
                mids.append(x)
        if len(mids) == 1:
            return {'t': 'retour', 'o': o, 'd': mids[0], 's': []}
        return {'t': 'circular', 'o': o, 'd': o, 's': mids}
    return {'t': 'oneway', 'o': o, 'd': last, 's': list(idents[1:-1])}


_DEFAULT_PLANE = 'beta_plane'
_DEFAULT_CHARGER = 'dc_320'
_VALID_BASIS = ('actual', 'regular')


def validate_normalized(payload):
    """Raise ValueError if the normalized payload is structurally invalid."""
    if not isinstance(payload, dict):
        raise ValueError('payload must be an object')
    flights = payload.get('flights')
    if not isinstance(flights, list) or not flights:
        raise ValueError('payload.flights must be a non-empty array')
    for i, fl in enumerate(flights):
        if not isinstance(fl, dict):
            raise ValueError('flights[%d] must be an object' % i)
        route = fl.get('route')
        if not isinstance(route, list) or len(route) < 2:
            raise ValueError('flights[%d].route must have >= 2 codes' % i)
        if not all(isinstance(c, str) and c.strip() for c in route):
            raise ValueError('flights[%d].route codes must be non-empty strings' % i)
        trip = fl.get('trip')
        if trip is not None and trip != 'oneway':
            raise ValueError('flights[%d].trip must be "oneway" if set' % i)
    defaults = payload.get('defaults') or {}
    basis = defaults.get('freq_basis')
    if basis is not None and basis not in _VALID_BASIS:
        raise ValueError('defaults.freq_basis must be one of %s' % (_VALID_BASIS,))


def _haversine_km(a, b):
    R = 6371.0
    lat1, lon1, lat2, lon2 = map(math.radians, (a['lat'], a['lon'], b['lat'], b['lon']))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def _parse_date(s):
    if not s or not isinstance(s, str):
        return None
    try:
        return datetime.strptime(s.strip()[:10], '%Y-%m-%d')
    except ValueError:
        return None


def _pt(rec):
    return {'i': rec['ident'], 'la': rec['lat'], 'lo': rec['lon'], 'n': rec['name']}


def build_blob(payload, resolve, planes_by_id):
    """Convert a validated-or-raw normalized payload into (blob, report)."""
    validate_normalized(payload)
    flights = payload['flights']
    defaults = payload.get('defaults') or {}

    plane = defaults.get('plane')
    if plane not in planes_by_id:
        plane = _DEFAULT_PLANE
    charger = defaults.get('charger') or _DEFAULT_CHARGER
    plane_range = (planes_by_id.get(plane) or {}).get('range_km') or 0

    # 1. Resolve + classify each flight; group by route signature.
    groups = {}          # signature -> {'trip','recs','count','dates'}
    order = []           # preserve first-seen order
    dropped = 0
    unresolved = set()
    for fl in flights:
        recs = [resolve(c) for c in fl['route']]
        bad = [c for c, r in zip(fl['route'], recs) if r is None]
        if bad:
            for c in bad:
                unresolved.add(str(c).strip().upper())
            dropped += 1
            continue
        idents = [r['ident'] for r in recs]
        if fl.get('trip') == 'oneway':
            # Caller declared an exact ordered chain (e.g. a reconstructed
            # rotation): keep every leg, no de-dup, even when start == end.
            trip = {'t': 'oneway', 'o': idents[0], 'd': idents[-1], 's': idents[1:-1]}
        else:
            trip = classify_trip(idents)
        sig = trip['t'] + '|' + '>'.join(idents)
        if sig not in groups:
            groups[sig] = {'trip': trip, 'recs': recs, 'count': 0, 'dates': []}
            order.append(sig)
        g = groups[sig]
        g['count'] += 1
        d = _parse_date(fl.get('date'))
        if d:
            g['dates'].append(d)

    # 2. Frequency basis: 'actual' needs a datable span across the whole dataset.
    basis = defaults.get('freq_basis') or 'actual'
    all_dates = [d for g in groups.values() for d in g['dates']]
    if basis == 'actual' and len(all_dates) < 2:
        basis = 'regular'
    weeks = 1.0
    if basis == 'actual':
        weeks = max((max(all_dates) - min(all_dates)).days / 7.0, 1.0)

    # 3. Assemble fl[] and the feasibility estimate.
    fl_out = []
    infeasible = 0
    for sig in order:
        g = groups[sig]
        trip, recs = g['trip'], g['recs']
        by_ident = {r['ident']: r for r in recs}
        if basis == 'regular':
            fn = 1
        else:
            fn = max(round(g['count'] / weeks, 2), 0.01)
        entry = {
            'id': 'imp_' + hashlib.sha1(sig.encode('utf-8')).hexdigest()[:10],
            'p': plane, 'c': charger, 't': trip['t'], 'fn': fn, 'fu': 'week',
            'o': _pt(by_ident[trip['o']]),
            'd': _pt(by_ident[trip['d']]),
        }
        if trip['s']:
            entry['s'] = [_pt(by_ident[i]) for i in trip['s']]
        fl_out.append(entry)
        # longest consecutive leg vs default plane range
        longest = max(_haversine_km(recs[i], recs[i + 1]) for i in range(len(recs) - 1))
        if plane_range and longest > plane_range:
            infeasible += 1

    blob = {'v': 1, 'k': 'build', 'fl': fl_out, 'cfg': {}, 'sch': {}, 'ms': {}}
    report = {
        'flights_in': len(flights),
        'routes_out': len(fl_out),
        'dropped': dropped,
        'unresolved_codes': sorted(unresolved),
        'infeasible_for_default': infeasible,
        'freq_basis_used': basis,
    }
    return blob, report
