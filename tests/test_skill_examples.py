"""The skill's bundled example normalized JSON must satisfy the server contract,
so the few-shot guidance can never drift from what /api/import accepts."""
import json
import os
import re
import unittest

import flight_import

_HERE = os.path.dirname(os.path.abspath(__file__))
_SKILL = os.path.join(_HERE, '..', 'skills', 'cns-import-flights')
_FAKE = {'AMS': {'ident': 'EHAM', 'name': 'Schiphol', 'lat': 52.31, 'lon': 4.76},
         'BER': {'ident': 'EDDB', 'name': 'Berlin', 'lat': 52.36, 'lon': 13.50},
         'LUZ': {'ident': 'EPLB', 'name': 'Lublin', 'lat': 51.24, 'lon': 22.71},
         'KIV': {'ident': 'LUKK', 'name': 'Chisinau', 'lat': 46.93, 'lon': 28.93}}


def _normalized_blocks(md_path):
    with open(md_path, encoding='utf-8') as f:
        text = f.read()
    return re.findall(r'```json\n(.*?)\n```', text, re.DOTALL)


class SkillExamplesTest(unittest.TestCase):
    def test_examples_are_valid_normalized(self):
        for name in ('ph-gov-xlsx.md', 'ph-gov-pdf.md'):
            for block in _normalized_blocks(os.path.join(_SKILL, 'examples', name)):
                payload = json.loads(block)
                if 'flights' not in payload:
                    continue
                flight_import.validate_normalized(payload)
                blob, report = flight_import.build_blob(
                    payload, lambda c: _FAKE.get(str(c).strip().upper()),
                    {'beta_plane': {'range_km': 500}})
                self.assertEqual(blob['k'], 'build')
                self.assertGreaterEqual(report['routes_out'], 1)

    def test_schema_file_is_valid_json(self):
        with open(os.path.join(_SKILL, 'schema.json'), encoding='utf-8') as f:
            json.load(f)


if __name__ == '__main__':
    unittest.main()
