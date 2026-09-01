"""
Carto basemap key plumbing (app.py CARTO_KEY -> `carto_key_qs` -> templates).

In-process against Flask's test client, like test_auth.py. The key is read per
request from the module global, so these flip `cns_app.CARTO_KEY` directly
instead of re-importing with a different environment.

The contract: absent key == the keyless Voyager URL we shipped with (byte-for-
byte), present key == that same URL with `?key=<key>` appended, on every tile
layer the desktop planner and the embed render.
"""
import os
import unittest

os.environ.setdefault('CNS_SECRET_KEY', 'unit-test-fixed-key')
os.environ.setdefault('CNS_INSECURE_COOKIES', '1')

import app as cns_app  # noqa: E402

VOYAGER = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'
TEST_KEY = 'unit_test_carto_key_123'


class CartoKeyTestCase(unittest.TestCase):
    def setUp(self):
        cns_app.app.config['TESTING'] = True
        self.client = cns_app.app.test_client()
        self._auth_was = cns_app.AUTH_ENABLED
        self._key_was = cns_app.CARTO_KEY
        cns_app.AUTH_ENABLED = False          # these pages are auth-gated in prod
        cns_app.CARTO_KEY = ''

    def tearDown(self):
        cns_app.AUTH_ENABLED = self._auth_was
        cns_app.CARTO_KEY = self._key_was

    def _html(self, path='/'):
        r = self.client.get(path)
        self.assertEqual(r.status_code, 200, f'{path} -> {r.status_code}')
        return r.get_data(as_text=True)

    # ---- default: no key configured -------------------------------------
    def test_planner_is_keyless_when_unset(self):
        html = self._html('/')
        self.assertIn(VOYAGER, html, 'Voyager tile URL missing entirely')
        self.assertNotIn('?key=', html, 'no key configured, yet a key query slipped in')

    def test_embed_is_keyless_when_unset(self):
        html = self._html('/embed')
        self.assertIn(VOYAGER, html)
        self.assertNotIn('?key=', html)

    # ---- key configured --------------------------------------------------
    def test_planner_appends_the_key_to_every_voyager_layer(self):
        cns_app.CARTO_KEY = TEST_KEY
        html = self._html('/')
        # One shared const feeds both the basemap switcher and the folder map,
        # so assert the const AND that no bare Voyager URL is left behind.
        self.assertIn(f'"?key={TEST_KEY}"', html, 'carto_key_qs not injected')
        self.assertEqual(html.count(VOYAGER + "' + CARTO_KEY_QS"), 2,
                         'both Voyager layers should read the injected key')

    def test_embed_appends_the_key(self):
        cns_app.CARTO_KEY = TEST_KEY
        html = self._html('/embed')
        self.assertIn(VOYAGER + "' + \"?key=" + TEST_KEY, html)

    def test_key_is_json_escaped_not_raw_interpolated(self):
        """A key is attacker-irrelevant here, but the injection point must still
        be escaped — tojson, never raw string concatenation into the script."""
        cns_app.CARTO_KEY = 'ab"cd</script>'
        html = self._html('/')
        self.assertNotIn('ab"cd</script>', html, 'raw interpolation into inline JS')
        self.assertIn('\\"cd\\u003c/script\\u003e', html)


if __name__ == '__main__':
    unittest.main()
