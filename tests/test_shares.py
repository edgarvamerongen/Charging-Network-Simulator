"""Unit tests for shares.py — the SQLite short-link store. Offline; uses a
throwaway DB via CNS_SHARES_DB so the real data/shares.db is never touched."""
import os
import tempfile
import unittest

# Point the store at a throwaway DB BEFORE importing the module under test.
_TMP = tempfile.mkdtemp(prefix='cns_shares_test_')
os.environ['CNS_SHARES_DB'] = os.path.join(_TMP, 'shares.db')

import shares  # noqa: E402


class SharesStoreTest(unittest.TestCase):
    def setUp(self):
        # Dynamic path read means each test can rely on a clean, initialised DB.
        os.environ['CNS_SHARES_DB'] = os.path.join(_TMP, 'shares.db')
        shares.init_db()

    def test_init_db_is_idempotent(self):
        shares.init_db()
        shares.init_db()  # second/third call must not raise

    def test_save_then_load_round_trips(self):
        state = {'v': 1, 'o': 'EHLE', 'd': 'EDDF', 's': ['EDDK']}
        slug = shares.save_state(state)
        self.assertEqual(shares.load_state(slug), state)

    def test_slug_is_7_char_base62(self):
        slug = shares.save_state({'v': 1, 'o': 'X'})
        self.assertEqual(len(slug), shares._SLUG_LEN)
        self.assertTrue(all(c in shares._SLUG_ALPHABET for c in slug))

    def test_identical_states_dedupe_to_one_slug(self):
        a = shares.save_state({'v': 1, 'o': 'EHAM', 'd': 'LFPG'})
        b = shares.save_state({'d': 'LFPG', 'v': 1, 'o': 'EHAM'})  # key order differs
        self.assertEqual(a, b)  # canonical JSON → same hash → same slug

    def test_different_states_get_different_slugs(self):
        a = shares.save_state({'v': 1, 'o': 'EHAM'})
        b = shares.save_state({'v': 1, 'o': 'EHRD'})
        self.assertNotEqual(a, b)

    def test_unknown_slug_returns_none(self):
        self.assertIsNone(shares.load_state('zzzzzzz'))


if __name__ == '__main__':
    unittest.main()
