"""
airport_resolver — resolve an airport code (ICAO or IATA) to coordinates,
against the full global airports.csv (the OurAirports dataset shipped in the
repo). Unlike sim.py (which loads the Europe-only catalog), this resolves any
airport worldwide, so imported flights to non-European destinations still carry
real coordinates into the build blob.

The 85k-row CSV is indexed once into in-memory dicts (ICAO ident + IATA),
lazily on first resolve(). Override the CSV path with CNS_AIRPORTS_CSV (tests
point it at a small fixture). _reset() drops the cache so a test can swap files.
"""
import csv
import os
import threading

_lock = threading.Lock()
_by_icao = None
_by_iata = None


def _csv_path():
    return os.environ.get('CNS_AIRPORTS_CSV') or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), 'airports.csv')


def _reset():
    global _by_icao, _by_iata
    _by_icao = None
    _by_iata = None


def _load():
    global _by_icao, _by_iata
    if _by_icao is not None:
        return
    with _lock:
        if _by_icao is not None:
            return
        icao, iata = {}, {}
        with open(_csv_path(), newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                lat, lon = row.get('latitude_deg'), row.get('longitude_deg')
                if not lat or not lon:
                    continue
                try:
                    rec = {
                        'ident': row['ident'],
                        'name': row.get('name') or row['ident'],
                        'lat': float(lat),
                        'lon': float(lon),
                    }
                except (KeyError, ValueError):
                    continue
                ident = (row.get('ident') or '').strip().upper()
                if ident and ident not in icao:
                    icao[ident] = rec
                code = (row.get('iata_code') or '').strip().upper()
                if code and code not in iata:
                    iata[code] = rec
        _by_icao, _by_iata = icao, iata


def resolve(code):
    """Resolve an ICAO or IATA code to {ident,name,lat,lon}, or None.
    ICAO (ident) is tried before IATA, per spec."""
    if not code or not str(code).strip():
        return None
    _load()
    q = str(code).strip().upper()
    return _by_icao.get(q) or _by_iata.get(q)
