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


class ValidateTest(unittest.TestCase):
    def test_ok(self):
        flight_import.validate_normalized(
            {'source': 's', 'flights': [{'route': ['AMS', 'BER']}]})  # no raise

    def test_missing_flights(self):
        with self.assertRaises(ValueError):
            flight_import.validate_normalized({'source': 's'})

    def test_empty_flights(self):
        with self.assertRaises(ValueError):
            flight_import.validate_normalized({'flights': []})

    def test_route_too_short(self):
        with self.assertRaises(ValueError):
            flight_import.validate_normalized({'flights': [{'route': ['AMS']}]})

    def test_bad_freq_basis(self):
        with self.assertRaises(ValueError):
            flight_import.validate_normalized(
                {'flights': [{'route': ['A', 'B']}], 'defaults': {'freq_basis': 'monthly'}})


# Minimal fake resolver: 5-letter idents are returned verbatim with dummy coords.
_FAKE = {
    'AMS': {'ident': 'EHAM', 'name': 'Schiphol', 'lat': 52.31, 'lon': 4.76},
    'BER': {'ident': 'EDDB', 'name': 'Berlin', 'lat': 52.36, 'lon': 13.50},
    'JFK': {'ident': 'KJFK', 'name': 'JFK', 'lat': 40.64, 'lon': -73.78},
}
def _resolve(code):
    return _FAKE.get(str(code).strip().upper())

_PLANES = {'beta_plane': {'range_km': 500}, 'vaeridion': {'range_km': 500}}


class BuildBlobTest(unittest.TestCase):
    def test_assembles_blob_and_report(self):
        payload = {'source': 'demo', 'flights': [
            {'route': ['AMS', 'BER', 'AMS'], 'date': '2022-01-01'},
            {'route': ['AMS', 'BER', 'AMS'], 'date': '2022-01-15'},
        ]}
        blob, report = flight_import.build_blob(payload, _resolve, _PLANES)
        self.assertEqual(blob['v'], 1)
        self.assertEqual(blob['k'], 'build')
        self.assertEqual(blob['cfg'], {})
        self.assertEqual(report['flights_in'], 2)
        self.assertEqual(report['routes_out'], 1)        # both rows aggregate
        self.assertEqual(len(blob['fl']), 1)
        f = blob['fl'][0]
        self.assertEqual(f['t'], 'retour')
        self.assertEqual(f['o']['i'], 'EHAM')
        self.assertEqual(f['d']['i'], 'EDDB')
        self.assertEqual(f['p'], 'beta_plane')
        self.assertEqual(f['c'], 'dc_320')
        self.assertEqual(f['fu'], 'week')

    def test_actual_frequency_is_rate_over_span(self):
        # 2 flights, 14 days apart -> span 2 weeks -> 1.0/week
        payload = {'flights': [
            {'route': ['AMS', 'BER'], 'date': '2022-01-01'},
            {'route': ['AMS', 'BER'], 'date': '2022-01-15'},
        ]}
        blob, _ = flight_import.build_blob(payload, _resolve, _PLANES)
        self.assertEqual(blob['fl'][0]['fn'], 1.0)

    def test_regular_frequency_is_one(self):
        payload = {'defaults': {'freq_basis': 'regular'}, 'flights': [
            {'route': ['AMS', 'BER'], 'date': '2022-01-01'},
            {'route': ['AMS', 'BER'], 'date': '2022-06-01'},
        ]}
        blob, report = flight_import.build_blob(payload, _resolve, _PLANES)
        self.assertEqual(blob['fl'][0]['fn'], 1)
        self.assertEqual(report['freq_basis_used'], 'regular')

    def test_no_dates_falls_back_to_regular(self):
        payload = {'defaults': {'freq_basis': 'actual'},
                   'flights': [{'route': ['AMS', 'BER']}, {'route': ['AMS', 'BER']}]}
        blob, report = flight_import.build_blob(payload, _resolve, _PLANES)
        self.assertEqual(report['freq_basis_used'], 'regular')
        self.assertEqual(blob['fl'][0]['fn'], 1)

    def test_unresolved_code_drops_flight(self):
        payload = {'flights': [
            {'route': ['AMS', 'BER']},
            {'route': ['AMS', 'ZZZ']},   # ZZZ unresolved
        ]}
        blob, report = flight_import.build_blob(payload, _resolve, _PLANES)
        self.assertEqual(report['routes_out'], 1)
        self.assertEqual(report['dropped'], 1)
        self.assertEqual(report['unresolved_codes'], ['ZZZ'])

    def test_long_haul_counts_as_infeasible_for_default(self):
        payload = {'flights': [{'route': ['AMS', 'JFK']}]}   # ~5800 km >> 500
        _blob, report = flight_import.build_blob(payload, _resolve, _PLANES)
        self.assertEqual(report['infeasible_for_default'], 1)

    def test_unknown_default_plane_falls_back_to_beta(self):
        payload = {'defaults': {'plane': 'nope'}, 'flights': [{'route': ['AMS', 'BER']}]}
        blob, _ = flight_import.build_blob(payload, _resolve, _PLANES)
        self.assertEqual(blob['fl'][0]['p'], 'beta_plane')


if __name__ == '__main__':
    unittest.main()
