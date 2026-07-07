"""In-process tests for POST /api/admin/sync-catalog (Flask test client).

Mirrors tests/test_import_route.py: set auth env BEFORE importing app, patch the
module-level token in setUp (import order across the suite is not guaranteed),
and stub notion_sync.sync so no live Notion call happens.
"""
import os
import tempfile
import unittest

os.environ.setdefault('CNS_APP_PASSWORD', 'test-secret-pw')
os.environ.setdefault('CNS_SECRET_KEY', 'unit-test-fixed-key')
os.environ.setdefault('CNS_INSECURE_COOKIES', '1')
os.environ['CNS_SYNC_TOKEN'] = 'test-sync-token'
_DB = os.path.join(tempfile.mkdtemp(prefix='cns_sync_route_'), 'shares.db')
os.environ['CNS_SHARES_DB'] = _DB

import app as cns_app   # noqa: E402
import notion_sync      # noqa: E402
import shares           # noqa: E402

_AUTH = {'Authorization': 'Bearer test-sync-token'}


def _report(**over):
    base = {'synced_at': 'x', 'emitted': 0, 'ok': [], 'hidden': [], 'skipped': [],
            'carried_forward': [], 'notion_pages_read': 0, 'abort': None}
    base.update(over)
    return base


class SyncCatalogRouteTest(unittest.TestCase):
    def setUp(self):
        os.environ['CNS_SHARES_DB'] = _DB
        cns_app.app.config['TESTING'] = True
        self.client = cns_app.app.test_client()
        cns_app._SYNC_TOKEN = 'test-sync-token'   # patch (app may have imported earlier)
        cns_app.AUTH_ENABLED = True                # ensure the auth gate is active
        shares.init_db()
        self._orig_sync = notion_sync.sync

    def tearDown(self):
        notion_sync.sync = self._orig_sync

    def _stub(self, rc, report):
        notion_sync.sync = lambda *a, **k: (rc, report)

    def test_requires_auth(self):
        r = self.client.post('/api/admin/sync-catalog')
        self.assertEqual(r.status_code, 401)

    def test_rejects_wrong_token(self):
        r = self.client.post('/api/admin/sync-catalog',
                             headers={'Authorization': 'Bearer nope'})
        self.assertEqual(r.status_code, 401)

    def test_token_success_returns_report_200(self):
        self._stub(0, _report(emitted=3, ok=['a', 'b', 'c']))
        r = self.client.post('/api/admin/sync-catalog', headers=_AUTH)
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(r.get_json()['emitted'], 3)

    def test_abort_returns_502_with_report(self):
        self._stub(2, _report(abort='no valid aircraft emitted'))
        r = self.client.post('/api/admin/sync-catalog', headers=_AUTH)
        self.assertEqual(r.status_code, 502)
        self.assertIn('no valid aircraft', r.get_json()['abort'])

    def test_session_without_token_is_rejected(self):
        # No user-facing trigger: a logged-in session alone must NOT authorize a
        # sync — catalog availability is admin/automation (token) only.
        self.client.post('/login', data={'password': 'test-secret-pw'})
        self._stub(0, _report(emitted=1, ok=['a']))
        r = self.client.post('/api/admin/sync-catalog')   # session, no token
        self.assertEqual(r.status_code, 401)


if __name__ == '__main__':
    unittest.main()
