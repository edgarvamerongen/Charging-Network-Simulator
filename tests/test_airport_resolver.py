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

    def test_resolves_iata(self):
        r = airport_resolver.resolve('AMS')
        self.assertEqual(r['ident'], 'EHAM')
        self.assertAlmostEqual(r['lat'], 52.3086, places=3)
        self.assertAlmostEqual(r['lon'], 4.7639, places=3)
        self.assertEqual(r['name'], 'Amsterdam Schiphol')

    def test_resolves_icao_passthrough(self):
        self.assertEqual(airport_resolver.resolve('EHAM')['ident'], 'EHAM')

    def test_case_insensitive(self):
        self.assertEqual(airport_resolver.resolve('ams')['ident'], 'EHAM')

    def test_intercontinental_iata(self):
        self.assertEqual(airport_resolver.resolve('JFK')['ident'], 'KJFK')

    def test_unknown_returns_none(self):
        self.assertIsNone(airport_resolver.resolve('ZZZ'))

    def test_blank_returns_none(self):
        self.assertIsNone(airport_resolver.resolve(''))
        self.assertIsNone(airport_resolver.resolve('   '))

    def test_row_without_coords_is_skipped(self):
        self.assertIsNone(airport_resolver.resolve('NOC'))


def tearDownModule():
    """Restore global state so subsequent test modules see the real airports.csv."""
    os.environ.pop('CNS_AIRPORTS_CSV', None)
    airport_resolver._reset()


if __name__ == '__main__':
    unittest.main()
