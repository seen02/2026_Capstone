from math import dist
import unittest

from lotteworld_sim.background import BackgroundRun
from lotteworld_sim.scenario import load_inputs
from lotteworld_sim.visitor_routes import UNLOAD_GAP_S, VisitorRoutes, WALK_M_PER_S


SINGLE_RIDES = ('gyro-drop', 'gyro-swing', 'gyro-spin', 'arcana-ride')


class RideOperationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scenario = load_inputs()
        cls.routes = VisitorRoutes(cls.scenario.map, cls.scenario.metadata()['queue_report'])
        cls.operations = cls.scenario.ride_operations['facilities']

    def start(self, facilities, **config):
        self.now = 0
        settings = {key: self.operations[key].copy() for key in facilities}
        continuous = dict(self.scenario.continuous, time_scale=1)
        continuous.update(config)
        return BackgroundRun(continuous, self.routes, ride_operations=settings, clock=lambda: self.now)

    def test_four_single_rides_dispatch_with_empty_seats_and_repeat(self):
        run = self.start(SINGLE_RIDES)
        launches = {key: [] for key in SINGLE_RIDES}
        previous_boarding = {key: None for key in SINGLE_RIDES}
        for self.now in range(1100):
            state = run.snapshot()
            people = {v['visitor_id']: v for v in state['background']['visitors']}
            for key, ride in state['rides'].items():
                with self.subTest(facility=key, now=self.now):
                    vehicle, = ride['vehicles']
                    passengers = vehicle['passenger_ids']
                    if vehicle['state'] == 'boarding':
                        if previous_boarding[key] is not None:
                            self.assertEqual(passengers[:len(previous_boarding[key])], previous_boarding[key])
                        previous_boarding[key] = passengers
                    else:
                        previous_boarding[key] = None
                    if len(launches[key]) == ride['dispatch_count']:
                        continue
                    self.assertEqual(vehicle['state'], 'running')
                    self.assertEqual(vehicle['vehicle_id'], 1)
                    self.assertIsNone(vehicle['station_slot'])
                    self.assertTrue(1 <= len(passengers) <= ride['seats_per_vehicle'])
                    if not launches[key]:
                        self.assertLess(len(passengers), ride['seats_per_vehicle'])
                    else:
                        self.assertGreaterEqual(ride['last_dispatch_at_sim_s'] - launches[key][-1],
                                                self.operations[key]['dispatch_interval_seconds'] - 1e-8)
                    self.assertTrue(all(people[i]['state'] == 'on_ride' and people[i]['facility_id'] == key
                                        and people[i]['vehicle_id'] == 1 and people[i]['queue_slot'] is None
                                        for i in passengers))
                    launches[key].append(ride['last_dispatch_at_sim_s'])
        self.assertTrue(all(len(times) >= 3 for times in launches.values()))

    def test_expired_passengers_finish_each_single_ride_and_walk_to_bridge(self):
        for key, visitor_id, stay in (('gyro-drop', 1, 425), ('gyro-swing', 2, 425),
                                      ('gyro-spin', 5, 425), ('arcana-ride', 6, 350)):
            with self.subTest(facility=key):
                run = self.start(SINGLE_RIDES, initial_people=0, target_people=6,
                                 admission_interval_sim_s=1, stay_sim_s=[stay, stay])
                self.now = stay + visitor_id
                state = run.snapshot()
                ride = state['rides'][key]
                self.assertEqual(ride['vehicles'][0]['passenger_ids'], [visitor_id])
                visitor = next(v for v in state['background']['visitors'] if v['visitor_id'] == visitor_id)
                self.assertEqual(visitor['state'], 'on_ride')
                self.assertTrue(visitor['departure_requested'])
                returned = ride['last_dispatch_at_sim_s'] + self.operations[key]['ride_seconds']
                paths = self.routes.facilities[key]
                self.now = returned + paths.unloading.offsets[1] / WALK_M_PER_S
                state = run.snapshot()['background']
                visitor = next(v for v in state['visitors'] if v['visitor_id'] == visitor_id)
                self.assertEqual(visitor['state'], 'walking_from_ride')
                self.assertAlmostEqual(dist(visitor['point'], paths.unloading.points[1]), 0)
                self.assertIsNone(visitor['vehicle_id'])
                walked_to_exit = returned + paths.unloading.length / WALK_M_PER_S
                bridge_crossing = walked_to_exit + self.routes.public_path(paths.exit_merge, self.routes.boundary).length / WALK_M_PER_S
                self.now = bridge_crossing - .01
                before = run.snapshot()['background']
                visitor = next(v for v in before['visitors'] if v['visitor_id'] == visitor_id)
                self.assertEqual(visitor['state'], 'walking_to_exit')
                self.now = bridge_crossing + .01
                after = run.snapshot()['background']
                self.assertNotIn(visitor_id, {v['visitor_id'] for v in after['visitors']})
                self.assertEqual(after['exited_total'], before['exited_total'] + 1)
                self.assertEqual(after['entered_total'], after['present_people'] + after['exited_total'])

    def test_saturated_single_ride_waits_for_last_passenger_to_cross_red_exit(self):
        key = 'gyro-drop'
        run = self.start((key,), initial_people=1500, target_people=1500, stay_sim_s=[86400, 86400])
        for self.now in range(600):
            ride = run.snapshot()['rides'][key]
            if len(ride['vehicles'][0]['passenger_ids']) == ride['seats_per_vehicle'] and ride['vehicles'][0]['state'] == 'running':
                break
        else:
            self.fail('정원을 채운 회차가 출발하지 않았습니다.')

        settings = self.operations[key]
        returned = ride['last_dispatch_at_sim_s'] + settings['ride_seconds']
        first_crossing = returned + self.routes.facilities[key].unloading.offsets[1] / WALK_M_PER_S
        last_crossing = first_crossing + (ride['seats_per_vehicle'] - 1) * UNLOAD_GAP_S
        self.assertGreater(last_crossing, returned + settings['unloading_seconds'])
        self.now = last_crossing - .01
        state = run.snapshot()['rides'][key]
        self.assertEqual(state['vehicles'][0]['state'], 'unloading')
        self.assertEqual(state['vehicles'][0]['station_slot'], 1)
        heads = [v.visitor_id for v in run.queues[key].members[:ride['seats_per_vehicle']]]
        self.now = last_crossing + .01
        boarded = run.snapshot()['rides'][key]['vehicles'][0]['passenger_ids']
        self.assertEqual(boarded, heads)
        self.now = last_crossing + settings['boarding_and_check_seconds'] - .01
        self.assertEqual(run.snapshot()['rides'][key]['dispatch_count'], ride['dispatch_count'])
        self.now += 40
        state = run.snapshot()['rides'][key]
        self.assertEqual(state['dispatch_count'], ride['dispatch_count'] + 1)
        self.assertGreaterEqual(state['last_dispatch_at_sim_s'], last_crossing + settings['boarding_and_check_seconds'])
