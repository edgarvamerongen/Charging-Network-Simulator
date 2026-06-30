"""Unit tests for flight_import — classification, aggregation, blob assembly."""
import unittest

import flight_import


class ClassifyTripTest(unittest.TestCase):
    def test_oneway(self):
        self.assertEqual(
            flight_import.classify_trip(['EHAM', 'EDDB']),
            {'t': 'oneway', 'o': 'EHAM', 'd': 'EDDB', 's': []})

    def test_oneway_with_stops(self):
        self.assertEqual(
            flight_import.classify_trip(['EHAM', 'EDDP', 'LKPD']),
            {'t': 'oneway', 'o': 'EHAM', 'd': 'LKPD', 's': ['EDDP']})

    def test_retour_single_far_point(self):
        self.assertEqual(
            flight_import.classify_trip(['EHAM', 'EDDB', 'EHAM']),
            {'t': 'retour', 'o': 'EHAM', 'd': 'EDDB', 's': []})

    def test_circular_multiple_stops(self):
        self.assertEqual(
            flight_import.classify_trip(['EHAM', 'EPWA', 'EYVI', 'EHAM']),
            {'t': 'circular', 'o': 'EHAM', 'd': 'EHAM', 's': ['EPWA', 'EYVI']})

    def test_circular_dedupes_repeat_waypoints(self):
        # AMS-LUN-WKF-CPT-WKF-NBO-AMS → distinct intermediates, order preserved
        out = flight_import.classify_trip(['E1', 'A', 'B', 'C', 'B', 'D', 'E1'])
        self.assertEqual(out['t'], 'circular')
        self.assertEqual(out['o'], 'E1')
        self.assertEqual(out['d'], 'E1')
        self.assertEqual(out['s'], ['A', 'B', 'C', 'D'])


if __name__ == '__main__':
    unittest.main()
