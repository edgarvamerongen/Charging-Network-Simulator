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


class TestEncodeShareState(unittest.TestCase):

    def test_roundtrip_matches_js_format(self):
        """base64url encoding: no +, no /, no trailing =."""
        state = {'v': 1, 'o': 'EHAM', 'd': 'EDDF', 'a': 'beta_plane',
                 't': 'one-way', 'f': {'n': 1, 'u': 'day'}, 'c': 'dc_320', 'w': False, 's': []}
        blob = cns_app.encode_share_state(state)
        self.assertNotIn('+', blob)
        self.assertNotIn('/', blob)
        self.assertNotIn('=', blob)
        # Decode back
        import base64, json
        padded = blob.replace('-', '+').replace('_', '/')
        padded += '=' * (-len(padded) % 4)
        decoded = json.loads(base64.b64decode(padded).decode())
        self.assertEqual(decoded['v'], 1)
        self.assertEqual(decoded['o'], 'EHAM')

    def test_empty_state(self):
        blob = cns_app.encode_share_state({'v': 1})
        self.assertIsInstance(blob, str)
        self.assertTrue(len(blob) > 0)


class TestEmbedRoute(unittest.TestCase):

    def setUp(self):
        cns_app.app.config['TESTING'] = True
        self.client = cns_app.app.test_client()

    # ── Security headers ───────────────────────────────────────────────────

    def test_embed_allows_framing(self):
        """X-Frame-Options must NOT be SAMEORIGIN on /embed."""
        r = self.client.get('/embed')
        self.assertNotEqual(r.headers.get('X-Frame-Options'), 'SAMEORIGIN')

    def test_embed_csp_frame_ancestors_star(self):
        r = self.client.get('/embed')
        csp = r.headers.get('Content-Security-Policy', '')
        self.assertIn('frame-ancestors *', csp)

    def test_embed_cache_control(self):
        r = self.client.get('/embed')
        cc = r.headers.get('Cache-Control', '')
        self.assertIn('public', cc)

    def test_other_routes_still_sameorigin(self):
        """Non-embed routes must keep SAMEORIGIN."""
        r = self.client.get('/')
        self.assertEqual(r.headers.get('X-Frame-Options'), 'SAMEORIGIN')

    # ── Response basics ────────────────────────────────────────────────────

    def test_embed_returns_200(self):
        r = self.client.get('/embed')
        self.assertEqual(r.status_code, 200)

    def test_embed_no_auth_required(self):
        """Should work without logging in."""
        r = self.client.get('/embed')
        self.assertNotEqual(r.status_code, 302)  # not redirect to login

    # ── Tier detection ─────────────────────────────────────────────────────

    def test_network_tier_no_params(self):
        r = self.client.get('/embed')
        self.assertEqual(r.status_code, 200)
        self.assertIn(b'network', r.data.lower())  # tier marker in template

    def test_range_tier_with_origin(self):
        r = self.client.get('/embed?origin=EHAM')
        self.assertEqual(r.status_code, 200)
        self.assertIn(b'range', r.data.lower())

    def test_route_tier_with_origin_and_dest(self):
        r = self.client.get('/embed?origin=EHAM&destination=EDDF')
        self.assertEqual(r.status_code, 200)

    def test_fuzzy_origin_resolves(self):
        r = self.client.get('/embed?origin=den+helder')
        self.assertEqual(r.status_code, 200)
        # Should resolve to EHKD — check the click-through link contains it
        self.assertIn(b'EHKD', r.data)

    def test_unknown_origin_degrades_to_network(self):
        r = self.client.get('/embed?origin=nonexistent')
        self.assertEqual(r.status_code, 200)
        self.assertIn(b'network', r.data.lower())


if __name__ == '__main__':
    unittest.main()
