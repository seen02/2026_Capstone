from collections import Counter
from math import dist
import unittest

from lotteworld_sim.background import BackgroundRun, Motion, Visitor
from lotteworld_sim.map_geometry import public_walkable
from lotteworld_sim.scenario import load_inputs
from lotteworld_sim.visitor_routes import Path, PUBLIC_WALK_VARIANTS, VisitorRoutes, WALK_M_PER_S


class TracedRun(BackgroundRun):
    def __init__(self, *args, **kwargs):
        self.trace = []
        super().__init__(*args, **kwargs)

    def _walk_to_queue(self, now, visitor, key, path, fraction):
        self.trace.append(('choice', now, visitor.visitor_id, key))
        super()._walk_to_queue(now, visitor, key, path, fraction)

    def _wait_elapsed(self, now, visitor):
        if visitor.wait_deadline == now:
            self.trace.append(('timeout', now, visitor.visitor_id, visitor.facility_id))
        super()._wait_elapsed(now, visitor)

    def _vacate_slot(self, now, visitor, shoulder_offset):
        self.trace.append(('vacated', now, visitor.visitor_id, visitor.facility_id))
        super()._vacate_slot(now, visitor, shoulder_offset)

    def _unload_visitor(self, now, visitor, paths, on_leave):
        self.trace.append(('completed', now, visitor.visitor_id, visitor.facility_id))
        super()._unload_visitor(now, visitor, paths, on_leave)


class VisitorBehaviorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scenario = load_inputs()
        cls.routes = VisitorRoutes(cls.scenario.map, cls.scenario.metadata()['queue_report'])

    def start(self, *, only=None, patience=None, automatic=True, **config):
        now = [0]
        continuous = dict(self.scenario.continuous, time_scale=1, initial_people=0, target_people=1,
                          admission_interval_sim_s=1)
        continuous.update(config)
        preferences = self.scenario.preferences
        if only:
            scores = {key: 5 if key == only else 0 for key in preferences['tags']}
            preferences = dict(preferences, profiles=[{'id': only, 'preferences': scores}])
        if patience:
            preferences = dict(preferences, behavior=dict(preferences['behavior'], wait_patience_sim_s=[patience] * 2))
        operations = self.scenario.ride_operations['facilities'] if automatic else None
        return TracedRun(continuous, self.routes, clock=lambda: now[0],
                         preferences=preferences, ride_operations=operations), now

    def test_profile_and_remaining_time_change_first_destination(self):
        for key in ('atlantis', 'arcana-ride'):
            with self.subTest(key=key):
                run, now = self.start(only=key)
                now[0] = 1
                visitor, = run.snapshot()['background']['visitors']
                self.assertEqual(visitor['facility_id'], key)
                self.assertEqual(visitor['preference_profile_id'], key)

        run, now = self.start(only='atlantis', stay_sim_s=[60, 60])
        now[0] = 60
        visitor, = run.snapshot()['background']['visitors']
        self.assertEqual(visitor['state'], 'waiting_to_exit')
        self.assertIsNone(visitor['facility_id'])
        now[0] = 61
        self.assertEqual(run.snapshot()['background']['exited_total'], 1)
        self.assertFalse(run.trace)

    def test_unloaded_visitors_turn_toward_different_destinations_after_gate(self):
        run, now = self.start(target_people=0)
        facility = 'comet-express'
        queue = run.queues[facility]
        paths = queue.paths
        targets = ('gyro-drop', 'gyro-spin')
        people = [
            Visitor(index + 1, 0, 10000, facility_id=facility, wait_patience=900, walking_variant=variant,
                    profile={'preferences': {key: 5 if key == target else 0 for key in run.facility_ids}})
            for index, (target, variant) in enumerate(zip(targets, (0, 3)))
        ]
        run._queue_unloading(0, queue, people)
        for index, person in enumerate(people):
            now[0] = index + paths.unloading.offsets[1] / WALK_M_PER_S
            run.advance()
            self.assertEqual(person.phase, 'walking_from_ride')
            self.assertLess(dist(person.motion.path.point_at(person.motion.distance_at(now[0])),
                                 paths.unloading.points[1]), 1e-8)

        now[0] = paths.exit_releases[-1][0] / WALK_M_PER_S + 3
        run.advance()
        self.assertEqual(tuple(person.facility_id for person in people), targets)
        early_headings = []
        for person in people:
            self.assertEqual(person.phase, 'walking_to_queue')
            path = person.motion.path
            self.assertLess(dist(path.points[0], paths.unloading.points[1]), 10)
            self.assertNotIn(paths.unloading.points[-1], path.points[:2])
            self.assertTrue(all(public_walkable(self.scenario.map, path.point_at(offset), self.routes.radius)
                                for offset in range(0, int(path.length) + 1)))
            ahead = path.point_at(6)
            early_headings.append(tuple(b - a for a, b in zip(path.points[0], ahead)))
        self.assertGreater(dist(*early_headings), 1)

    def test_unseen_congestion_is_rechecked_at_facility_approach(self):
        key = 'comet-express'
        run, now = self.start(only=key, patience=300)
        queue = run.queues[key]
        # 입구에서 관찰할 줄 인원만 준비한다. 만석 전에 대기 허용 시간으로 거절되는 경우다.
        queue.members = [Visitor(i, 0, 1000) for i in range(100, 140)]
        self.assertLess(len(queue.members), queue.capacity)
        now[0] = 1
        run.advance()
        visitor = run.visitors[1]
        self.assertEqual(visitor.facility_id, key)
        now[0] = visitor.motion.end
        run.advance()
        self.assertIsNone(visitor.slot)
        self.assertIsNone(visitor.facility_id)
        self.assertEqual(len(queue.members), 40)
        self.assertGreater(visitor.motion.end, now[0])

    def test_patience_timeout_releases_slot_only_after_stepping_into_side_path(self):
        key = 'atlantis'
        run, now = self.start(only=key, patience=180, automatic=False)
        now[0] = 1
        run.advance()
        visitor = run.visitors[1]
        now[0] = visitor.motion.end
        run.advance()
        deadline = now[0] + 180
        self.assertEqual(visitor.wait_deadline, deadline)

        now[0] = deadline
        run.advance()
        self.assertEqual(visitor.phase, 'leaving_queue')
        self.assertIn(visitor, run.queues[key].members)
        self.assertIsNotNone(visitor.slot)
        now[0] = visitor.motion.end
        run.advance()
        self.assertNotIn(visitor, run.queues[key].members)
        self.assertIsNone(visitor.slot)
        self.assertFalse(visitor.completed_rides)
        now[0] = visitor.motion.end
        run.advance()
        self.assertIsNone(visitor.facility_id)
        self.assertGreater(visitor.motion.end, now[0])

    def test_completing_all_facilities_allows_repeats_until_scheduled_departure(self):
        run, now = self.start(stay_sim_s=[10000, 10000])
        now[0] = 8000
        visitor, = run.snapshot()['background']['visitors']
        self.assertEqual(set(visitor['completed_rides']), set(self.routes.facilities))
        self.assertTrue(any(count > 1 for count in visitor['completed_rides'].values()))
        self.assertFalse(visitor['departure_requested'])

        now[0] = 10300
        state = run.snapshot()['background']
        self.assertEqual(state['exited_total'], 1)
        self.assertEqual(state['entered_total'], state['present_people'] + state['exited_total'])

    def test_seed_reproduces_choices_timeouts_and_ride_history_across_polling_rates(self):
        config = dict(initial_people=240, target_people=240, admission_interval_sim_s=5)
        polled, polled_time = self.start(**config)
        jumped, jumped_time = self.start(**config)
        for polled_time[0] in range(0, 3600, 37):
            state = polled.snapshot()['background']
            self.assertEqual(state['entered_total'], state['present_people'] + state['exited_total'])
            self.assertLessEqual(state['present_people'], 240)
        polled_time[0] = jumped_time[0] = 3600
        polled_state, jumped_state = polled.snapshot(), jumped.snapshot()
        polled_state.pop('run_id')
        jumped_state.pop('run_id')
        self.assertEqual(polled_state, jumped_state)
        self.assertEqual(polled.trace, jumped.trace)
        counts = Counter(event for event, _, _, _ in polled.trace)
        self.assertGreater(counts['timeout'], 0)
        self.assertGreater(counts['vacated'], 0)
        completed = Counter((visitor, facility) for event, _, visitor, facility in polled.trace if event == 'completed')
        self.assertTrue(any(count > 1 for count in completed.values()))

    def test_open_paths_spread_across_plaza_and_bridge_by_direction(self):
        routes = self.routes
        target = routes.facilities['comet-express'].approach
        a = routes.nodes[routes.boundary]
        b = routes.nodes['bridge-island']
        paths = [routes.visitor_path(routes.boundary, target, variant) for variant in range(PUBLIC_WALK_VARIANTS)]
        self.assertEqual(len({path.points[1] for path in paths}), PUBLIC_WALK_VARIANTS)
        self.assertEqual(len({path.points[4:] for path in paths}), PUBLIC_WALK_VARIANTS)

        def side(point):
            return ((b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])) / dist(a, b)

        for variant, outgoing in enumerate(paths):
            incoming = routes.visitor_path(target, routes.boundary, variant)
            self.assertGreater(side(outgoing.points[1]), 0)
            self.assertLess(side(incoming.points[-2]), 0)
            for path in (outgoing, incoming):
                # 다리 끝 경계 양쪽 1m는 입장·퇴장 처리점이다.
                for offset in range(1, int(path.length)):
                    point = path.point_at(offset)
                    self.assertTrue(public_walkable(self.scenario.map, point, routes.radius), point)

    def test_walk_trail_retains_corner_order_in_either_direction(self):
        path = Path([(0, 0), (2, 0), (2, 2)])
        self.assertEqual(Motion(path, 0, 0, 4, 1).trail(3, 2), [[1, 1, 0], [2, 2, 0], [3, 2, 1]])
        self.assertEqual(Motion(path, 0, 4, 0, 1).trail(5, 4), [[1, 2, 1], [2, 2, 0], [4, 0, 0]])
