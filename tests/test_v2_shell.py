"""
/v2 desktop shell — route + template smoke tests (in-process Flask client).
Auth env is set BEFORE importing app, like tests/test_auth.py.
"""
import os
import unittest

os.environ.setdefault('CNS_APP_PASSWORD', 'test-secret-pw')
os.environ.setdefault('CNS_SECRET_KEY', 'unit-test-fixed-key')
os.environ.setdefault('CNS_INSECURE_COOKIES', '1')

import app as cns_app  # noqa: E402


class V2ShellTestCase(unittest.TestCase):
    def setUp(self):
        cns_app.app.config['TESTING'] = True
        self.client = cns_app.app.test_client()
        self._auth = cns_app.AUTH_ENABLED
        cns_app.AUTH_ENABLED = False

    def tearDown(self):
        cns_app.AUTH_ENABLED = self._auth

    def test_v2_renders_the_new_shell(self):
        r = self.client.get('/v2')
        self.assertEqual(r.status_code, 200)
        html = r.get_data(as_text=True)
        self.assertIn('window.CNS_DATA', html)
        self.assertIn('/static/desktop.css', html)
        self.assertIn('/static/ui/app.js', html)
        self.assertIn('/static/flight-model.js', html)      # engines are loaded
        self.assertNotIn('bootstrap', html)                 # no Bootstrap in v2

    def test_v2_bridge_carries_catalogs(self):
        html = self.client.get('/v2').get_data(as_text=True)
        self.assertIn('"battery_kwh"', html)                # planes JSON
        self.assertIn('"power_kw"', html)                   # chargers JSON

    def test_classic_shell_is_untouched(self):
        html = self.client.get('/?desktop=1').get_data(as_text=True)
        self.assertIn('id="simForm"', html)
        self.assertNotIn('window.CNS_DATA', html)

    def test_v2_is_gated_like_index(self):
        cns_app.AUTH_ENABLED = True
        r = self.client.get('/v2')
        self.assertEqual(r.status_code, 302)
        self.assertIn('/login', r.headers['Location'])
