"""Tests for the /embed route and supporting functions."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import app as cns_app

# Minimal airport fixtures — enough fields to exercise resolve_airport
_AIRPORTS = [
    {'ident': 'EHKD', 'name': 'De Kooy Airfield',              'municipality': 'Den Helder', 'iata_code': '',    'type': 'medium_airport', 'latitude_deg': 52.923401, 'longitude_deg': 4.78062},
    {'ident': 'EHAM', 'name': 'Amsterdam Airport Schiphol',     'municipality': 'Amsterdam',  'iata_code': 'AMS', 'type': 'large_airport',  'latitude_deg': 52.308601, 'longitude_deg': 4.76389},
    {'ident': 'EDDF', 'name': 'Frankfurt am Main Airport',      'municipality': 'Frankfurt',  'iata_code': 'FRA', 'type': 'large_airport',  'latitude_deg': 50.033333, 'longitude_deg': 8.570556},
    {'ident': 'EDFH', 'name': 'Frankfurt-Hahn Airport',         'municipality': 'Hahn',       'iata_code': 'HHN', 'type': 'medium_airport', 'latitude_deg': 49.948601, 'longitude_deg': 7.26389},
    {'ident': 'EHLE', 'name': 'Lelystad Airport',               'municipality': 'Lelystad',   'iata_code': '',    'type': 'small_airport',  'latitude_deg': 52.460278, 'longitude_deg': 5.527222},
]


class TestResolveAirport(unittest.TestCase):

    def test_exact_icao(self):
        r = cns_app.resolve_airport('EHAM', _AIRPORTS)
        self.assertEqual(r['ident'], 'EHAM')

    def test_icao_case_insensitive(self):
        r = cns_app.resolve_airport('eham', _AIRPORTS)
        self.assertEqual(r['ident'], 'EHAM')

    def test_exact_iata(self):
        r = cns_app.resolve_airport('AMS', _AIRPORTS)
        self.assertEqual(r['ident'], 'EHAM')

    def test_iata_case_insensitive(self):
        r = cns_app.resolve_airport('fra', _AIRPORTS)
        self.assertEqual(r['ident'], 'EDDF')

    def test_exact_municipality(self):
        r = cns_app.resolve_airport('Den Helder', _AIRPORTS)
        self.assertEqual(r['ident'], 'EHKD')

    def test_substring_name_prefers_larger_airport(self):
        """'frankfurt' matches both EDDF and EDFH by name; EDDF is large_airport."""
        r = cns_app.resolve_airport('frankfurt', _AIRPORTS)
        self.assertEqual(r['ident'], 'EDDF')

    def test_substring_municipality(self):
        r = cns_app.resolve_airport('Lelystad', _AIRPORTS)
        self.assertEqual(r['ident'], 'EHLE')

    def test_no_match_returns_none(self):
        r = cns_app.resolve_airport('nonexistent', _AIRPORTS)
        self.assertIsNone(r)

    def test_empty_query_returns_none(self):
        r = cns_app.resolve_airport('', _AIRPORTS)
        self.assertIsNone(r)

    def test_whitespace_query_returns_none(self):
        r = cns_app.resolve_airport('   ', _AIRPORTS)
        self.assertIsNone(r)


if __name__ == '__main__':
    unittest.main()
