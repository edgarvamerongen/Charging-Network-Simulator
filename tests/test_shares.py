"""Unit tests for shares.py — the SQLite short-link store. Offline; uses a
throwaway DB via CNS_SHARES_DB so the real data/shares.db is never touched."""
import os
import sqlite3
import tempfile
import unittest

# Point the store at a throwaway DB BEFORE importing the module under test.
_TMP = tempfile.mkdtemp(prefix='cns_shares_test_')
os.environ['CNS_SHARES_DB'] = os.path.join(_TMP, 'shares.db')

import shares  # noqa: E402


class SharesStoreTest(unittest.TestCase):
    def setUp(self):
        os.environ['CNS_SHARES_DB'] = os.path.join(_TMP, 'shares.db')
        for suffix in ('', '-wal', '-shm'):
            try:
                os.remove(os.path.join(_TMP, 'shares.db' + suffix))
            except FileNotFoundError:
                pass
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

    def test_content_hash_uniqueness_is_enforced(self):
        # The UNIQUE(content_hash) constraint is what makes save_state atomic
        # under a race: a second row for the same content must be rejected, so
        # concurrent savers converge on one slug instead of writing duplicates.
        slug = shares.save_state({'v': 1, 'o': 'EHAM', 'd': 'EDDF'})
        with shares._conn() as conn:
            digest = conn.execute(
                'SELECT content_hash FROM shares WHERE slug = ?', (slug,)
            ).fetchone()[0]
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    'INSERT INTO shares (slug, state, content_hash, created_at) '
                    'VALUES (?, ?, ?, ?)', ('zzz1234', '{}', digest, '2026-01-01T00:00:00+00:00')
                )

    def test_different_states_get_different_slugs(self):
        a = shares.save_state({'v': 1, 'o': 'EHAM'})
        b = shares.save_state({'v': 1, 'o': 'EHRD'})
        self.assertNotEqual(a, b)

    def test_unknown_slug_returns_none(self):
        self.assertIsNone(shares.load_state('zzzzzzz'))

    def test_max_state_bytes_is_16kib(self):
        # Updated to 64 KiB to accommodate multi-route build blobs (Task 1)
        self.assertEqual(shares.MAX_STATE_BYTES, 64 * 1024)

    def test_build_blob_round_trips_verbatim(self):
        build = {
            'v': 1, 'k': 'build',
            'fl': [{'id': 'f1', 'p': 'beta_plane', 'c': 'dc_320', 't': 'oneway',
                    'fn': 2, 'fu': 'day',
                    'o': {'i': 'EHLE', 'la': 52.46, 'lo': 5.52, 'n': 'Lelystad'},
                    'd': {'i': 'EDDF', 'la': 50.03, 'lo': 8.56, 'n': 'Frankfurt'}}],
            'cfg': {'EDDF': {'chargers': ['dc_320'], 'targetDepartureSoc': 0.8}},
            'sch': {'f1': ['08:00', '12:00']},
            'ms': {'chargeTarget': {'enabled': True, 'value': 0.9}},
        }
        slug = shares.save_state(build)
        self.assertEqual(shares.load_state(slug), build)

    def test_cap_is_64k(self):
        self.assertEqual(shares.MAX_STATE_BYTES, 64 * 1024)


if __name__ == '__main__':
    unittest.main()
