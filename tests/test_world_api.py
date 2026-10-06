"""In-process tests for the world airport feed (GET /api/airports/world) and the airport lookups behind it:
gzip, a content-hash ETag with a 304 on revalidation, a long cache life, and /api/airports still serving the
European list the classic and mobile views read."""
import json
import os
import unittest

from tests._helpers import REPO_ROOT

os.environ.setdefault('CNS_SECRET_KEY', 'unit-test-fixed-key')
import app as cns_app  # noqa: E402
import sim             # noqa: E402

HAVE_FEED = os.path.exists(cns_app.WORLD_FEED)


@unittest.skipUnless(HAVE_FEED, 'world feed not built (prepare_world.py)')
class WorldFeed(unittest.TestCase):
    def setUp(self):
        cns_app.app.config['TESTING'] = True
        self._auth = cns_app.AUTH_ENABLED
        cns_app.AUTH_ENABLED = False
        self.client = cns_app.app.test_client()

    def tearDown(self):
        cns_app.AUTH_ENABLED = self._auth

    def test_gzip_etag_and_cache_life(self):
        r = self.client.get('/api/airports/world', headers={'Accept-Encoding': 'gzip'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get('Content-Encoding'), 'gzip')
        self.assertIn('immutable', r.headers.get('Cache-Control', ''))
        h = cns_app.world_feed()[0]
        self.assertEqual(r.headers.get('ETag'), '"' + h + '"')
        self.assertLess(len(r.data), os.path.getsize(cns_app.WORLD_FEED) / 2)

    def test_revalidation_answers_304(self):
        etag = self.client.get('/api/airports/world').headers['ETag']
        r = self.client.get('/api/airports/world', headers={'If-None-Match': etag})
        self.assertEqual(r.status_code, 304)

    def test_plain_request_is_the_columnar_feed(self):
        feed = json.loads(self.client.get('/api/airports/world').data)
        self.assertEqual(set(feed), {'v', 'hash', 'n', 'f'})
        self.assertGreater(feed['n'], 40000)
        self.assertIn('NZQN', feed['f']['i'])

    def test_europe_route_is_unchanged(self):
        eu = json.loads(self.client.get('/api/airports').data)
        self.assertTrue(all(a['ident'] for a in eu))
        self.assertNotIn('NZQN', {a['ident'] for a in eu})


@unittest.skipUnless(os.path.exists(os.path.join(REPO_ROOT, 'world_airports.csv')), 'world set not built')
class WorldLookups(unittest.TestCase):
    def test_world_simulator_resolves_beyond_europe_and_keeps_europe_for_the_list(self):
        old = os.environ.pop('CNS_AIRPORTS_FILE', None)
        try:
            s = sim.Simulator(base_dir=REPO_ROOT)
        finally:
            if old is not None:
                os.environ['CNS_AIRPORTS_FILE'] = old
        self.assertEqual(s.get_airport('NZQN')['ident'], 'NZQN')
        self.assertEqual(s.get_airport('ZQN')['ident'], 'NZQN')      # IATA
        self.assertEqual(s.get_airport('eham')['ident'], 'EHAM')
        eu = {a['ident'] for a in s.get_all_airports()}
        self.assertIn('EHAM', eu)
        self.assertNotIn('NZQN', eu)
        self.assertIn('NZQN', {a['ident'] for a in s.get_all_airports(world=True)})


if __name__ == '__main__':
    unittest.main()
