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
            # offline: name='' and lat/lon=None skip every network branch
            res = report._airport_photo(ident, '', None, None)
            self.assertEqual(res, {'uri': '', 'credit': ''})


class TestFetchHostAllowList(unittest.TestCase):
    """SSRF guard: outbound _http_get is restricted to https Wikimedia hosts."""

    def test_allows_wikimedia_family_over_https(self):
        for ok in ('https://en.wikipedia.org/api/rest_v1/page/summary/X',
                   'https://upload.wikimedia.org/x.jpg',
                   'https://commons.wikimedia.org/wiki/Special:FilePath/X',
                   'https://query.wikidata.org/sparql',
                   'https://www.wikidata.org/w/api.php'):
            self.assertTrue(report._fetch_host_allowed(ok), ok)

    def test_blocks_other_hosts_schemes_and_lookalikes(self):
        for bad in ('http://en.wikipedia.org/x',          # not https
                    'https://evil.com/x',
                    'https://169.254.169.254/latest/meta-data',  # cloud metadata
                    'https://wikipedia.org.evil.com/x',     # suffix look-alike
                    'https://localhost/x',
                    'file:///etc/passwd',
                    'gopher://x'):
            self.assertFalse(report._fetch_host_allowed(bad), bad)

    def test_http_get_refuses_disallowed_url(self):
        with self.assertRaises(ValueError):
            report._http_get('https://evil.example.com/x')


class TestPathTraversalGuards(unittest.TestCase):
    """Both _safe_pics_path (client-supplied plane image/svg paths) and
    _safe_plane_image_path (Notion-synced photo urls, mirrors the former but
    rooted at data/plane_images) must reject traversal/absolute input, keep
    a benign relative path inside their root dir, and treat empty/None as
    blank. Table over the two functions so both get the same three checks."""

    _FUNCS = [
        (report._safe_pics_path, report.PICS_DIR,
         ('../app.py', '../../etc/passwd', '/etc/passwd', 'plane_svgs/../../app.py'),
         'plane_svgs/beta.svg'),
        (report._safe_plane_image_path, report.PLANE_IMG_DIR,
         ('/plane-images/../sync_report.json', '../../etc/passwd',
          '/etc/passwd', '/plane-images/../../app.py'),
         '/plane-images/beta_alia__x.png'),
    ]

    def test_traversal_and_absolute_rejected(self):
        for fn, _root, bads, _good in self._FUNCS:
            for bad in bads:
                with self.subTest(fn=fn.__name__, bad=bad):
                    self.assertEqual(fn(bad), '', bad)

    def test_benign_relative_stays_inside_root(self):
        for fn, root, _bads, good in self._FUNCS:
            with self.subTest(fn=fn.__name__):
                p = fn(good)
                self.assertTrue(p.startswith(os.path.realpath(root) + os.sep), p)

    def test_empty_is_blank(self):
        for fn, _root, _bads, _good in self._FUNCS:
            with self.subTest(fn=fn.__name__):
                self.assertEqual(fn(''), '')
                self.assertEqual(fn(None), '')


if __name__ == '__main__':
    unittest.main()
