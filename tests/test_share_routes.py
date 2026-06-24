"""In-process tests for the share endpoints (POST /api/share, GET /s/<slug>),
using Flask's test client so they need no live server. Auth + a temp shares DB
are configured via env BEFORE importing app."""
import os
import tempfile
import unittest

os.environ.setdefault('CNS_APP_PASSWORD', 'test-secret-pw')
os.environ.setdefault('CNS_SECRET_KEY', 'unit-test-fixed-key')
os.environ.setdefault('CNS_INSECURE_COOKIES', '1')
# Own temp DB; re-pinned in setUp so a full-suite run (other test modules also
# set CNS_SHARES_DB) can't leave us pointed at the wrong file.
_DB = os.path.join(tempfile.mkdtemp(prefix='cns_share_routes_'), 'shares.db')
os.environ['CNS_SHARES_DB'] = _DB

import app as cns_app  # noqa: E402
import shares          # noqa: E402

INJECT_MARK = 'CNSINJECTTESTMARKER'  # sentinel that appears ONLY when injected


class ShareRoutesTest(unittest.TestCase):
    def setUp(self):
        os.environ['CNS_SHARES_DB'] = _DB
        cns_app.app.config['TESTING'] = True
        self.client = cns_app.app.test_client()
        cns_app.AUTH_ENABLED = True
        with cns_app._login_lock:
            cns_app._login_attempts.clear()
        shares.init_db()

    def _login(self):
        return self.client.post('/login', data={'password': 'test-secret-pw'})

    # ---- POST /api/share ----
    def test_create_requires_auth(self):
        r = self.client.post('/api/share', json={'state': {'v': 1}})
        self.assertEqual(r.status_code, 401)

    def test_create_returns_slug_and_url(self):
        self._login()
        r = self.client.post('/api/share', json={'state': {'v': 1, 'o': 'EHLE'}})
        self.assertEqual(r.status_code, 200, r.data)
        body = r.get_json()
        self.assertEqual(len(body['slug']), 7)
        self.assertTrue(body['url'].endswith('/s/' + body['slug']))

    def test_create_rejects_non_object_state(self):
        self._login()
        r = self.client.post('/api/share', json={'state': 'nope'})
        self.assertEqual(r.status_code, 400)

    def test_create_rejects_missing_state(self):
        self._login()
        r = self.client.post('/api/share', json={'nope': 1})
        self.assertEqual(r.status_code, 400)

    def test_create_rejects_oversize_state(self):
        self._login()
        big = {'v': 1, 'pad': 'x' * (64 * 1024 + 1)}
        r = self.client.post('/api/share', json={'state': big})
        self.assertEqual(r.status_code, 413)

    # ---- GET /s/<slug> ----
    def test_open_injects_state(self):
        self._login()
        slug = self.client.post(
            '/api/share', json={'state': {'v': 1, 'mark': INJECT_MARK}}
        ).get_json()['slug']
        r = self.client.get('/s/' + slug)
        self.assertEqual(r.status_code, 200)
        self.assertIn(b'window.__CNS_SHARE__ = ', r.data)  # the injection assignment
        self.assertIn(INJECT_MARK.encode(), r.data)        # the stored blob

    def test_open_unknown_slug_boots_without_injection(self):
        self._login()
        r = self.client.get('/s/zzzzzzz')
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(b'window.__CNS_SHARE__ = ', r.data)  # no injection line

    def test_open_requires_auth_via_redirect(self):
        r = self.client.get('/s/zzzzzzz')
        self.assertEqual(r.status_code, 302)
        self.assertIn('/login', r.headers['Location'])
        self.assertIn('next=/s/zzzzzzz', r.headers['Location'])

    def test_build_blob_creates_slug_and_injects_on_open(self):
        self._login()
        build = {'v': 1, 'k': 'build', 'fl': [{'id': 'f1', 'mark': INJECT_MARK}]}
        slug = self.client.post('/api/share', json={'state': build}).get_json()['slug']
        r = self.client.get('/s/' + slug)
        self.assertEqual(r.status_code, 200)
        self.assertIn(b'window.__CNS_SHARE__ = ', r.data)
        self.assertIn(b'"k": "build"', r.data)
        self.assertIn(INJECT_MARK.encode(), r.data)
