from dataclasses import replace
from fractions import Fraction
from math import dist, inf, nextafter
import unittest

from lotteworld_sim.background import BackgroundRun, Visitor
from lotteworld_sim.scenario import load_inputs
from lotteworld_sim.visitor_routes import Path, UNLOAD_GAP_S, VisitorRoutes, WALK_M_PER_S


SINGLE_RIDES = ('gyro-drop', 'gyro-swing', 'gyro-spin', 'arcana-ride')


class RideOperationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scenario = load_inputs()
        cls.routes = VisitorRoutes(cls.scenario.map, cls.scenario.metadata()['queue_report'])
        cls.operations = cls.scenario.ride_operations['facilities']

    def start(self, facilities, *, operation_overrides=None, **config):
        self.now = 0
        settings = {key: self.operations[key].copy() for key in facilities}
        for key, changes in (operation_overrides or {}).items():
            settings[key].update(changes)
        continuous = dict(self.scenario.continuous, time_scale=1)
        continuous.update(config)
        return BackgroundRun(continuous, self.routes, ride_operations=settings, clock=lambda: self.now)

    def test_four_single_rides_dispatch_with_empty_seats_and_repeat(self):
        run = self.start(SINGLE_RIDES, initial_people=240, target_people=240)
        launches = {key: [] for key in SINGLE_RIDES}
        previous_boarding = {key: None for key in SINGLE_RIDES}
        for self.now in range(1100):
            state = run.snapshot()
            people = {v['visitor_id']: v for v in state['background']['visitors']}
            for key, ride in state['rides'].items():
                with self.subTest(facility=key, now=self.now):
                    vehicle, = ride['vehicles']
                    passengers = vehicle['passenger_ids']
                    self.assertEqual(ride['riding_people'], sum(
                        people[visitor_id]['state'] in ('on_ride', 'waiting_for_station')
                        for visitor_id in passengers))
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

    def test_full_queue_serves_background_then_qr_arrivals_in_order(self):
        key = 'comet-express'
        run = self.start((key,), initial_people=0, target_people=0)
        queue = run.queues[key]
        queue.paths = replace(queue.paths, slots=queue.paths.slots[-1:])
        run.rides[key].seats = 1
        prior = Visitor(1, 0, 10000, facility_id=key)
        run.visitors[1] = prior
        run.entered_total = 1
        run._join_queue(0, prior, queue)
        entrance = Path(queue.paths.queue.points[:3])
        run.start_qr_visit('qr-first', key, entrance)
        self.now = 1
        run.start_qr_visit('qr-second', key, entrance)
        self.now = 25
        run.advance()
        self.assertEqual([visitor.visitor_id for visitor in queue.members], [1])
        self.assertEqual([visitor.visitor_id for visitor in queue.entrance_waiters], ['qr-first', 'qr-second'])
        boarded = []
        for self.now in range(26, 1500):
            ride = run.snapshot()['rides'][key]
            self.assertLessEqual(len(queue.members), 1)
            if ride['dispatch_count'] == len(boarded):
                continue
            vehicle, = ride['vehicles']
            passenger, = vehicle['passenger_ids'] + vehicle['qr_character_ids']
            boarded.append(passenger)
            if len(boarded) == 3:
                break
        self.assertEqual(boarded, [1, 'qr-first', 'qr-second'])
        self.now += self.operations[key]['ride_seconds'] + queue.paths.unloading.length / WALK_M_PER_S + 2
        for character_id in ('qr-first', 'qr-second'):
            result = run.qr_visit_state(character_id)
            self.assertEqual(result['phase'], 'completed')
            self.assertEqual(result['position']['point'], list(queue.paths.unloading.points[-1]))

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

    def test_atlantis_and_comet_reuse_vehicles_with_station_course_and_seat_limits(self):
        run = self.start((*SINGLE_RIDES, 'atlantis', 'comet-express'), initial_people=1500, target_people=1500)
        departures = {'atlantis': [], 'comet-express': []}
        max_stations = max_sections = 0
        for self.now in range(1000):
            state = run.snapshot()
            people = state['background']
            self.assertEqual(people['entered_total'], people['present_people'] + people['exited_total'])
            self.assertLessEqual(people['present_people'], 1500)
            riders = set()
            for key, ride in state['rides'].items():
                vehicles = ride['vehicles']
                self.assertEqual([v['vehicle_id'] for v in vehicles], list(range(1, ride['vehicle_count'] + 1)))
                stations = [v['station_slot'] for v in vehicles if v['station_slot'] is not None]
                sections = [v['course_section'] for v in vehicles if v['course_section'] is not None]
                self.assertEqual(len(stations), len(set(stations)))
                self.assertEqual(len(sections), len(set(sections)))
                self.assertTrue(all(1 <= slot <= ride['station_capacity'] for slot in stations))
                self.assertTrue(all(1 <= section <= ride['course_section_count'] for section in sections))
                for vehicle in vehicles:
                    passengers = vehicle['passenger_ids']
                    self.assertLessEqual(len(passengers), ride['seats_per_vehicle'])
                    for passenger in passengers:
                        self.assertNotIn((key, vehicle['vehicle_id'], passenger), riders)
                        riders.add((key, vehicle['vehicle_id'], passenger))
                if key == 'atlantis':
                    max_stations = max(max_stations, len(stations))
                    max_sections = max(max_sections, len(sections))
                if key in departures and len(departures[key]) < ride['dispatch_count']:
                    launch = ride['last_dispatch_at_sim_s']
                    vehicle, = (v for v in vehicles if v['last_dispatched_at_sim_s'] == launch)
                    self.assertEqual(vehicle['state'], 'running')
                    self.assertTrue(vehicle['passenger_ids'])
                    departures[key].append((launch, vehicle['vehicle_id']))
            self.assertEqual(riders, {(v['facility_id'], v['vehicle_id'], v['visitor_id'])
                                      for v in people['visitors'] if v['vehicle_id'] is not None})
        self.assertEqual((max_stations, max_sections), (2, 4))
        self.assertGreaterEqual(len(departures['atlantis']), 16)
        first_two_rotations = [vehicle for _, vehicle in departures['atlantis'][:16]]
        self.assertEqual(first_two_rotations, list(range(1, 9)) * 2)
        self.assertGreaterEqual(len(departures['comet-express']), 3)
        for key, interval, count, stations, seats in (('atlantis', 30, 8, 2, 8), ('comet-express', 230, 1, 1, 26)):
            ride = state['rides'][key]
            self.assertEqual((ride['vehicle_count'], ride['station_capacity'], ride['seats_per_vehicle']),
                             (count, stations, seats))
            times = [when for when, _ in departures[key]]
            gaps = [second - first for first, second in zip(times, times[1:])]
            self.assertTrue(all(gap >= interval - 1e-8 for gap in gaps))
            if key == 'atlantis':
                self.assertAlmostEqual(min(gaps), interval)

    def test_ready_boat_waits_for_clear_course_even_after_dispatch_interval(self):
        key = 'atlantis'
        run = self.start((key,), operation_overrides={key: {'course_section_count': 2}},
                         initial_people=1500, target_people=1500)
        ride = run.rides[key]
        for self.now in range(300):
            run.advance()
            if ride.dispatch_count == 1 and ride.next_dispatch_at <= self.now < ride.course_entry_at:
                waiting = next((v for v in ride.vehicles if v.state == 'ready'), None)
                if waiting:
                    break
        else:
            self.fail('출발 간격이 지난 뒤 코스가 빌 때까지 기다리는 보트가 없습니다.')
        clear = ride.course_entry_at
        self.assertAlmostEqual(clear - ride.last_dispatch_at, 60)
        self.now = clear - .01
        run.advance()
        self.assertEqual(ride.dispatch_count, 1)
        self.assertEqual(waiting.state, 'ready')
        self.now = clear
        run.advance()
        self.assertEqual(ride.dispatch_count, 2)
        self.assertEqual(waiting.dispatched_at, clear)

    def test_station_contention_delays_departures_and_serializes_shared_exit(self):
        key = 'atlantis'
        settings = {'ride_seconds': 12, 'course_section_count': 12, 'dispatch_interval_seconds': 1,
                    'boarding_and_check_seconds': 0, 'unloading_seconds': 220}
        run = self.start((key,), operation_overrides={key: settings}, initial_people=1500, target_people=1500,
                         stay_sim_s=[86400, 86400])
        ride = run.rides[key]
        blocked = None
        shared_exit = False
        unload_starts = set()
        for self.now in range(700):
            previously_returning = list(ride.returning)
            run.advance()
            admitted = [v for v in previously_returning if v.state == 'unloading']
            self.assertEqual(admitted, previously_returning[:len(admitted)])
            if len(ride.station) == 2 and all(v.state == 'unloading' for v in ride.station.values()):
                if ride.returning and blocked is None:
                    blocked = (ride.dispatch_count, ride.last_dispatch_at, ride.returning[0])
                # 두 번째 보트의 승강장은 준비됐어도 첫 보트 승객이 공용 통로를 먼저 사용한다.
                shared_exit |= (not ride.returning and all(v.passengers for v in ride.station.values()))
            unload_starts.update((v.visitor_id, v.motion.start) for v in run.visitors.values()
                                 if v.facility_id == key and v.phase == 'walking_from_ride')
            if blocked and ride.dispatch_count > blocked[0]:
                self.assertGreater(ride.last_dispatch_at - blocked[1], settings['unloading_seconds'])
                self.assertNotEqual(blocked[2].state, 'waiting_for_station')
                break
        else:
            self.fail('승강장 대기 후 출발이 재개되지 않았습니다.')
        self.assertTrue(shared_exit)
        self.assertGreater(len(unload_starts), 8)
        times = sorted(when for _, when in unload_starts)
        self.assertTrue(all(b - a >= UNLOAD_GAP_S - 1e-8 for a, b in zip(times, times[1:])))

    def test_fractional_course_clearance_keeps_sections_exclusive_at_boundaries(self):
        key = 'atlantis'
        run = self.start((key,), operation_overrides={key: {'course_section_count': 7, 'dispatch_interval_seconds': 1}},
                         initial_people=1500, target_people=1500)
        for self.now in range(600):
            ride = run.snapshot()['rides'][key]
            if ride['dispatch_count']:
                break
        self.assertEqual(ride['dispatch_count'], 1)
        start = Fraction(ride['last_dispatch_at_sim_s'])
        section_seconds = Fraction(120, 7)
        clear = ride['course_entry_available_at_sim_s']
        self.assertLess(Fraction(nextafter(clear, -inf)), start + section_seconds)
        self.assertGreaterEqual(Fraction(clear), start + section_seconds)

        for index in range(1, 7):
            boundary = float(start + index * section_seconds)
            for self.now in (nextafter(boundary, -inf), boundary, nextafter(boundary, inf)):
                vehicles = run.snapshot()['rides'][key]['vehicles']
                sections = [v['course_section'] for v in vehicles if v['course_section'] is not None]
                self.assertEqual(len(sections), len(set(sections)))

    def test_facilities_remain_idle_without_waiting_visitors(self):
        run = self.start(self.operations, initial_people=0, admission_interval_sim_s=3600)
        self.now = 1800
        state = run.snapshot()
        self.assertEqual(state['background']['present_people'], 0)
        for ride in state['rides'].values():
            self.assertEqual(ride['dispatch_count'], 0)
            self.assertTrue(all(vehicle['state'] == 'available' for vehicle in ride['vehicles']))
