"""
Auth-layer tests for app.py — run in-process against Flask's test client, so
they need no live server (unlike test_api.py).

Auth is configured by environment variables read at import time, so we set them
BEFORE importing app. CNS_INSECURE_COOKIES=1 lets the session cookie ride over
the test client's plain-HTTP requests.
"""
import os
import unittest

os.environ.setdefault('CNS_APP_PASSWORD', 'test-secret-pw')
os.environ.setdefault('CNS_SECRET_KEY', 'unit-test-fixed-key')
os.environ.setdefault('CNS_INSECURE_COOKIES', '1')

import app as cns_app  # noqa: E402


class AuthTestCase(unittest.TestCase):
    def setUp(self):
        cns_app.app.config['TESTING'] = True
        self.client = cns_app.app.test_client()
        # auth is enabled for this process; reset the brute-force throttle so
        # tests don't interfere with each other
        cns_app.AUTH_ENABLED = True
        with cns_app._login_lock:
            cns_app._login_attempts.clear()

    def _login(self):
        return self.client.post('/login', data={'password': 'test-secret-pw'})

    # ---- gating ----------------------------------------------------------
    def test_healthz_is_public(self):
        r = self.client.get('/healthz')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json().get('status'), 'ok')

    def test_index_redirects_to_login_when_unauthed(self):
        r = self.client.get('/')
        self.assertEqual(r.status_code, 302)
        self.assertIn('/login', r.headers['Location'])

    def test_mobile_route_is_also_gated(self):
        r = self.client.get('/m/')
        self.assertEqual(r.status_code, 302)
        self.assertIn('/login', r.headers['Location'])

    def test_api_returns_json_401_when_unauthed(self):
        r = self.client.get('/api/airports')
        self.assertEqual(r.status_code, 401)
        self.assertIn('error', r.get_json())

    def test_login_page_renders(self):
        r = self.client.get('/login')
        self.assertEqual(r.status_code, 200)
        self.assertIn(b'Sign in', r.data)

    # ---- credential flow -------------------------------------------------
    def test_wrong_password_rejected(self):
        r = self.client.post('/login', data={'password': 'nope'})
        self.assertEqual(r.status_code, 401)
        self.assertIn(b'Incorrect password', r.data)

    def test_correct_password_grants_access(self):
        r = self._login()
        self.assertEqual(r.status_code, 302)
        # session now lets API + pages through
        self.assertEqual(self.client.get('/api/airports').status_code, 200)
        self.assertEqual(self.client.get('/').status_code, 200)

    def test_logout_clears_session(self):
        self._login()
        self.assertEqual(self.client.get('/api/airports').status_code, 200)
        self.client.get('/logout')
        self.assertEqual(self.client.get('/api/airports').status_code, 401)

    # ---- hardening -------------------------------------------------------
    def test_open_redirect_blocked(self):
        r = self.client.post('/login',
                             data={'password': 'test-secret-pw', 'next': '//evil.example.com/'})
        self.assertEqual(r.status_code, 302)
        loc = r.headers['Location']
        self.assertFalse(loc.startswith('//evil') or loc.startswith('http://evil'),
                         f'open redirect not blocked: {loc}')

    def test_safe_next_is_honoured(self):
        r = self.client.post('/login',
                             data={'password': 'test-secret-pw', 'next': '/m/'})
        self.assertEqual(r.status_code, 302)
        self.assertTrue(r.headers['Location'].endswith('/m/'))

    def test_security_headers_present(self):
        r = self.client.get('/login')
        self.assertEqual(r.headers.get('X-Content-Type-Options'), 'nosniff')
        self.assertEqual(r.headers.get('X-Frame-Options'), 'SAMEORIGIN')
        self.assertIn('Content-Security-Policy', r.headers)
        self.assertIn("frame-ancestors", r.headers['Content-Security-Policy'])

    def test_brute_force_throttle(self):
        # exhaust the per-IP attempt budget, then expect a 429
        last = None
        for _ in range(cns_app._LOGIN_MAX_ATTEMPTS + 2):
            last = self.client.post('/login', data={'password': 'wrong'})
        self.assertEqual(last.status_code, 429)
        self.assertIn(b'Too many attempts', last.data)

    def test_auth_disabled_is_open(self):
        # Simulate a deploy with no password configured: the app must serve
        # without a login (preserves local dev / the offline test suite).
        cns_app.AUTH_ENABLED = False
        try:
            self.assertEqual(self.client.get('/api/airports').status_code, 200)
        finally:
            cns_app.AUTH_ENABLED = True


if __name__ == '__main__':
    unittest.main()
