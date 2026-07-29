"""Charger catalog invariants. The 10 MW Elysian unit is RETIRED (2026-07-29):
multi-charger aircraft combine standard units via simultaneous_charging
(e.g. the Elysian charges on N chargers at once) instead of one mega-charger."""
import json
import os
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class ChargerCatalogTest(unittest.TestCase):
    def _catalog(self):
        with open(os.path.join(_ROOT, 'chargers.json')) as f:
            return json.load(f)

    def test_elysian_10mw_retired(self):
        by_id = {c['id']: c for c in self._catalog()}
        self.assertNotIn('dc_10000', by_id)

    def test_every_charger_has_required_keys(self):
        for c in self._catalog():
            for key in ('id', 'name', 'power_kw', 'type', 'image'):
                self.assertIn(key, c, f"{c.get('id')}: missing {key}")
            self.assertGreater(c['power_kw'], 0)

    def test_ids_unique(self):
        ids = [c['id'] for c in self._catalog()]
        self.assertEqual(len(ids), len(set(ids)))


if __name__ == '__main__':
    unittest.main()
