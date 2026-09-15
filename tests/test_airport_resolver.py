"""Unit tests for airport_resolver — code→coords over a tiny fixture CSV."""
import csv
import os
import tempfile
import unittest

_TMP = tempfile.mkdtemp(prefix='cns_resolver_test_')
_CSV = os.path.join(_TMP, 'airports.csv')
with open(_CSV, 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f)
    w.writerow(['ident', 'type', 'name', 'latitude_deg', 'longitude_deg', 'iata_code'])
    w.writerow(['EHAM', 'large_airport', 'Amsterdam Schiphol', '52.3086', '4.7639', 'AMS'])
    w.writerow(['EDDB', 'large_airport', 'Berlin Brandenburg', '52.3617', '13.5023', 'BER'])
    w.writerow(['KJFK', 'large_airport', 'John F Kennedy Intl', '40.6394', '-73.7793', 'JFK'])
    w.writerow(['XXNO', 'small_airport', 'No Coords', '', '', 'NOC'])
os.environ['CNS_AIRPORTS_CSV'] = _CSV

import airport_resolver  # noqa: E402


class AirportResolverTest(unittest.TestCase):
    def setUp(self):
        os.environ['CNS_AIRPORTS_CSV'] = _CSV
        airport_resolver._reset()

    def test_resolve_cases(self):
        cases = [
            ('AMS', {'ident': 'EHAM', 'lat': 52.3086, 'lon': 4.7639, 'name': 'Amsterdam Schiphol'}),
            ('EHAM', {'ident': 'EHAM'}),                 # ICAO passthrough
            ('ams', {'ident': 'EHAM'}),                  # case insensitive
            ('JFK', {'ident': 'KJFK'}),                  # intercontinental IATA
            ('ZZZ', None),                               # unknown
            ('', None),                                  # blank
            ('   ', None),                               # whitespace
            ('NOC', None),                               # row without coords is skipped
        ]
        for query, expected in cases:
            with self.subTest(query=query):
                r = airport_resolver.resolve(query)
                if expected is None:
                    self.assertIsNone(r)
                    continue
                for key, val in expected.items():
                    if key in ('lat', 'lon'):
                        self.assertAlmostEqual(r[key], val, places=3)
                    else:
                        self.assertEqual(r[key], val)


def tearDownModule():
    """Restore global state so subsequent test modules see the real airports_index.csv."""
    os.environ.pop('CNS_AIRPORTS_CSV', None)
    airport_resolver._reset()


if __name__ == '__main__':
    unittest.main()
