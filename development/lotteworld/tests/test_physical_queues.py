from itertools import combinations, pairwise
from math import dist
import unittest

from lotteworld_sim.background import BackgroundRun
from lotteworld_sim.map_geometry import public_walkable
from lotteworld_sim.scenario import load_inputs
from lotteworld_sim.visitor_routes import UNLOAD_GAP_S, VisitorRoutes, WALK_M_PER_S


class PhysicalQueueTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scenario = load_inputs()
        cls.reports = cls.scenario.metadata()['queue_report']
        cls.routes = VisitorRoutes(cls.scenario.map, cls.reports)

    def setUp(self):
        self.now = 0

    def start(self, population):
        config = dict(self.scenario.continuous, initial_people=population, target_people=population, time_scale=1)
        return BackgroundRun(config, self.routes, clock=lambda: self.now)

    @staticmethod
    def people(run):
        return {row['visitor_id']: row for row in run.snapshot()['background']['visitors']}

    def test_full_queues_reroute_at_entrance_and_conserve_population(self):
        run = self.start(1500)
        full = set()
        rerouted = False
        previous = {}
        samples = set(range(0, 1801, 10)) | {i / 4 for i in range(80, 141)} | {7200, 43200}
        for self.now in sorted(samples):
            state = run.snapshot()['background']
            self.assertEqual(state['entered_total'], state['present_people'] + state['exited_total'])
            self.assertLessEqual(state['present_people'], 1500)
            reservations = {key: {} for key in state['queues']}
            for visitor in state['visitors']:
                key, slot = visitor['facility_id'], visitor['queue_slot']
                if slot is not None:
                    self.assertNotIn(slot, reservations[key])
                    self.assertIn(slot, range(self.reports[key]['capacity']))
                    reservations[key][slot] = visitor['point']
                    if visitor['state'] == 'queued':
                        self.assertEqual(visitor['point'], tuple(self.reports[key]['slots'][slot]))
                    continue
                before = previous.get(visitor['visitor_id'])
                if before and before in full and key != before and visitor['state'] == 'walking_to_queue':
                    rerouted = True
            previous = {v['visitor_id']: v['facility_id'] for v in state['visitors'] if v['state'] == 'walking_to_queue'}
            for key, queue in state['queues'].items():
                self.assertEqual(len(reservations[key]), queue['reserved_count'])
                self.assertLessEqual(queue['queued_count'], queue['reserved_count'])
                points = [p for _, p in sorted(reservations[key].items())]
                self.assertTrue(all(dist(a, b) >= 2 * self.routes.radius - 1e-8 for a, b in pairwise(points)))
                if queue['reserved_count'] == queue['capacity']:
                    full.add(key)
        self.assertEqual(full, set(self.reports))
        self.assertTrue(rerouted)
        self.assertGreater(state['exited_total'], 6000)

    def test_queue_withdrawal_releases_place_and_advances_followers(self):
        run = self.start(240)
        self.now = 600
        before = self.people(run)
        facility = 'gyro-drop'
        queued = sorted((v for v in before.values() if v['facility_id'] == facility and v['state'] == 'queued'),
                        key=lambda v: v['queue_slot'], reverse=True)
        leaving, following = queued[10:12]
        visitor_id = leaving['visitor_id']
        self.assertTrue(run.withdraw(visitor_id))
        self.assertFalse(run.withdraw(visitor_id))
        self.assertEqual(self.people(run)[visitor_id]['queue_slot'], leaving['queue_slot'])
        self.now += .5
        after = self.people(run)
        self.assertEqual(after[visitor_id]['state'], 'leaving_queue')
        self.assertIsNone(after[visitor_id]['queue_slot'])
        self.assertEqual(after[following['visitor_id']]['queue_slot'], leaving['queue_slot'])
        self.assertEqual(after[following['visitor_id']]['state'], 'advancing_queue')
        self.now += 180
        self.assertNotEqual(self.people(run)[visitor_id]['facility_id'], facility)

    def test_expired_passenger_walks_to_bridge_before_being_counted_as_exited(self):
        run = self.start(240)
        self.now = 600
        before = self.people(run)
        heads = [v for v in before.values() if v['state'] == 'queued'
                 and v['queue_slot'] == self.reports[v['facility_id']]['capacity'] - 1]
        first = min(heads, key=lambda v: v['leave_at_sim_s'])
        visitor_id, facility = first['visitor_id'], first['facility_id']
        self.now = first['leave_at_sim_s'] - .1
        self.assertEqual(run.board_next(facility, 1), (visitor_id,))
        self.now += 30
        waited = self.people(run)[visitor_id]
        self.assertEqual(waited['state'], 'at_boarding_point')
        self.assertTrue(waited['departure_requested'])
        self.assertIsNone(waited['queue_slot'])
        self.assertEqual(run.unload(facility), (visitor_id,))
        merge = self.routes.facilities[facility]
        self.now += merge.unloading.length / WALK_M_PER_S + 1
        departing = self.people(run)[visitor_id]
        self.assertEqual(departing['state'], 'walking_to_exit')
        self.assertTrue(public_walkable(self.scenario.map, departing['point'], self.routes.radius))
        self.now += self.routes.public_path(merge.exit_merge, self.routes.boundary).length / WALK_M_PER_S
        self.assertNotIn(visitor_id, self.people(run))

    def test_all_facilities_board_in_order_and_discharge_at_red_point_one_at_a_time(self):
        run = self.start(600)
        for facility in self.scenario.map['facilities']:
            with self.subTest(facility=facility['id']):
                key = facility['id']
                paths = self.routes.facilities[key]
                self.now += 600
                queued = sorted((v for v in self.people(run).values() if v['facility_id'] == key and v['state'] == 'queued'),
                                key=lambda v: v['queue_slot'], reverse=True)
                expected = tuple(v['visitor_id'] for v in queued[:paths.boarding_capacity])
                self.assertEqual(len(expected), paths.boarding_capacity)
                self.assertEqual(run.board_next(key), expected)
                self.assertEqual(run.board_next(key), ())
                self.assertEqual(run.unload(key), ())
                board_start = self.now
                for tick in range(1, 33):
                    self.now = board_start + tick / 4
                    rows = self.people(run)
                    moving = [rows[v]['point'] for v in expected if rows[v]['state'] == 'walking_to_board']
                    self.assertTrue(all(dist(a, b) >= 2 * self.routes.radius - 1e-8 for a, b in pairwise(moving)))
                self.now = board_start + 40
                after_boarding = self.people(run)
                for visitor_id in expected:
                    self.assertEqual(after_boarding[visitor_id]['state'], 'at_boarding_point')
                    self.assertEqual(after_boarding[visitor_id]['point'], tuple(self.reports[key]['boarding_target']))
                self.assertEqual(run.unload(key), expected)
                self.assertEqual(run.unload(key), ())
                red_point = self.routes.nodes[facility['exit']]
                first_crossing = self.now + paths.unloading.offsets[1] / WALK_M_PER_S
                for i, visitor_id in enumerate(expected):
                    self.now = first_crossing + i * UNLOAD_GAP_S
                    rows = self.people(run)
                    self.assertAlmostEqual(dist(rows[visitor_id]['point'], red_point), 0)
                    disembarking = [rows[v]['point'] for v in expected if v in rows and rows[v]['state'] == 'walking_from_ride']
                    for a, b in combinations(disembarking, 2):
                        self.assertGreaterEqual(dist(a, b), self.routes.radius * 2)
                    self.now += UNLOAD_GAP_S / 2
                    rows = self.people(run)
                    self.assertTrue(all(dist(rows[v]['point'], red_point) >= self.routes.radius
                                        for v in expected if v in rows and rows[v]['state'] == 'walking_from_ride'))
