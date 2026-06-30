"""In-process tests for POST /api/import using Flask's test client."""
import os
import tempfile
import unittest

os.environ.setdefault('CNS_APP_PASSWORD', 'test-secret-pw')
os.environ.setdefault('CNS_SECRET_KEY', 'unit-test-fixed-key')
os.environ.setdefault('CNS_INSECURE_COOKIES', '1')
os.environ['CNS_IMPORT_TOKEN'] = 'test-import-token'
_DB = os.path.join(tempfile.mkdtemp(prefix='cns_import_route_'), 'shares.db')
os.environ['CNS_SHARES_DB'] = _DB

import airport_resolver  # noqa: E402
import app as cns_app   # noqa: E402
import shares            # noqa: E402

_AUTH = {'Authorization': 'Bearer test-import-token'}


class ImportRouteTest(unittest.TestCase):
    def setUp(self):
        os.environ['CNS_SHARES_DB'] = _DB
        # Ensure the resolver uses the real airports.csv regardless of what a
        # prior test module may have set (e.g. test_airport_resolver.py points
        # CNS_AIRPORTS_CSV at a 4-row fixture).
        os.environ.pop('CNS_AIRPORTS_CSV', None)
        airport_resolver._reset()
        cns_app.app.config['TESTING'] = True
        self.client = cns_app.app.test_client()
        # Patch the module-level token so the suite runs correctly even when
        # another test module imported app before CNS_IMPORT_TOKEN was set.
        cns_app._IMPORT_TOKEN = 'test-import-token'
        shares.init_db()

    def test_requires_token(self):
        r = self.client.post('/api/import', json={'flights': [{'route': ['AMS', 'BER']}]})
        self.assertEqual(r.status_code, 401)

    def test_rejects_wrong_token(self):
        r = self.client.post('/api/import', headers={'Authorization': 'Bearer nope'},
                             json={'flights': [{'route': ['AMS', 'BER']}]})
        self.assertEqual(r.status_code, 401)

    def test_rejects_malformed_body(self):
        r = self.client.post('/api/import', headers=_AUTH, json={'nope': 1})
        self.assertEqual(r.status_code, 400)

    def test_happy_path_returns_link_and_report(self):
        body = {'source': 'PH-GOV', 'flights': [
            {'route': ['AMS', 'BER', 'AMS'], 'date': '2022-01-01'},
            {'route': ['AMS', 'JFK', 'AMS'], 'date': '2022-02-01'},
            {'route': ['AMS', 'EDDL', 'AMS'], 'date': '2022-03-01'},  # ~200 km, well within 500 km range
        ]}
        r = self.client.post('/api/import', headers=_AUTH, json=body)
        self.assertEqual(r.status_code, 200, r.data)
        data = r.get_json()
        self.assertTrue(data['url'].endswith('/s/' + data['slug']))
        self.assertEqual(data['report']['flights_in'], 3)
        self.assertEqual(data['report']['routes_out'], 3)
        self.assertEqual(data['report']['infeasible_for_default'], 2)  # AMS-BER (~593km) and AMS-JFK (~5847km) exceed beta_plane 500km; AMS-EDDL (~200km) is within range
        # the stored blob is a build blob and reloads verbatim
        self.assertEqual(shares.load_state(data['slug'])['k'], 'build')


if __name__ == '__main__':
    unittest.main()
