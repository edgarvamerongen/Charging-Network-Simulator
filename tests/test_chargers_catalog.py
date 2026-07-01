"""The catalog must include the 10 MW Elysian charger used by rotation imports."""
import json
import os
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class ChargerCatalogTest(unittest.TestCase):
    def test_elysian_10mw_present(self):
        with open(os.path.join(_ROOT, 'chargers.json')) as f:
            chargers = json.load(f)
        by_id = {c['id']: c for c in chargers}
        self.assertIn('dc_10000', by_id)
        c = by_id['dc_10000']
        self.assertEqual(c['power_kw'], 10000)
        self.assertEqual(c['name'], 'Elysian 10 MW')
        self.assertEqual(c['type'], 'Elysian')
        for key in ('id', 'name', 'power_kw', 'type', 'image'):
            self.assertIn(key, c)


if __name__ == '__main__':
    unittest.main()
