"""Unit tests for report.py's pure helpers — no WeasyPrint / network needed.

Covers the two security-sensitive paths that previously had zero coverage:
  * _xml_escape + its use inside the SVG builders (labels are client data),
  * _airport_photo's ident sanitisation (the ident is client-POSTed and is
    used to build filesystem paths — a traversal ident must be treated as
    "no ident", never resolved).
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import report


HOSTILE = '<script>alert("x")</script> & <b>'


class TestXmlEscape(unittest.TestCase):
    def test_escapes_amp_lt_gt(self):
        self.assertEqual(report._xml_escape('a & <b>'), 'a &amp; &lt;b&gt;')

    def test_none_is_empty(self):
        self.assertEqual(report._xml_escape(None), '')

    def test_bar_chart_labels_escaped(self):
        svg = report._bar_chart_svg([(HOSTILE, 10.0)], fmt=lambda v: HOSTILE)
        self.assertNotIn('<script>', svg)
        self.assertIn('&lt;script&gt;', svg)

    def test_donut_legend_escaped(self):
        svg = report._donut_svg([{'label': HOSTILE, 'value': 5}], '5', 'kWh')
        self.assertNotIn('<script>', svg)

    def test_gantt_labels_escaped(self):
        svg = report._gantt_svg([{
            'planeName': HOSTILE, 'role': 'dest', 'multiLeg': False, 'freq': '1/day',
            'instances': [{'start': 7 * 60, 'phases': [
                {'kind': 'fly', 'start': 0, 'dur': 60, 'label': HOSTILE}]}],
        }])
        self.assertNotIn('<script>', svg)


class TestAirportPhotoIdentGuard(unittest.TestCase):
    def test_safe_ident_re(self):
        for ok in ('EHAM', 'LFPG', 'EH01', 'X-1', 'ab'):
            self.assertTrue(report._SAFE_IDENT_RE.match(ok), ok)
        for bad in ('', '../EHAM', 'EHAM/..', 'a' * 9, 'EH AM', '/etc', '..', 'a.b'):
            self.assertFalse(report._SAFE_IDENT_RE.match(bad), bad)

    def test_traversal_ident_reads_nothing(self):
        """A traversal ident that WOULD resolve to a real file outside pics/
        must come back blank — the read path may not leave the curated dirs."""
        with tempfile.TemporaryDirectory() as tmp:
            decoy = os.path.join(tmp, 'EVIL.jpg')
            with open(decoy, 'wb') as f:
                f.write(b'\xff\xd8secret-bytes')
            # ident that path-joins from pics/airports/ to the decoy (minus ext)
            ident = os.path.relpath(decoy[:-4], os.path.join(report.PICS_DIR, 'airports'))
            prev = report.AIRPORT_PHOTO_WIKIMEDIA
            report.AIRPORT_PHOTO_WIKIMEDIA = False   # keep the test offline
            try:
                res = report._airport_photo(ident, '', None, None)
            finally:
                report.AIRPORT_PHOTO_WIKIMEDIA = prev
            self.assertEqual(res, {'uri': '', 'credit': ''})


if __name__ == '__main__':
    unittest.main()
