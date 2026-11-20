from collections import Counter
from dataclasses import replace
from math import ceil, dist
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
        phone_starts = []
        for person in people:
            self.assertEqual(person.phase, 'walking_to_queue')
            path = person.motion.path
            self.assertLess(dist(path.points[0], paths.unloading.points[1]), 10)
            self.assertNotIn(paths.unloading.points[-1], path.points[:2])
            self.assertTrue(all(public_walkable(self.scenario.map, path.point_at(offset), self.routes.radius)
                                for offset in range(0, int(path.length) + 1)))
            ahead = path.point_at(6)
            early_headings.append(tuple(b - a for a, b in zip(path.points[0], ahead)))
            start, end, pace = person.motion.slower
            phone_starts.append(start)
            self.assertGreaterEqual(start, 6)
            self.assertLessEqual(end, path.length - 4)
            self.assertGreater(pace, 0)
            self.assertLess(pace, person.public_speed_m_s)
        self.assertGreater(dist(*early_headings), 1)
        self.assertNotEqual(*phone_starts)

    def test_live_wait_is_read_before_walking_to_a_facility(self):
        key = 'comet-express'
        run, now = self.start(only=key, patience=300)
        queue = run.queues[key]
        # 아직 만석이 아니지만 원격으로 확인한 대기 시간이 길다.
        queue.members = [Visitor(i, 0, 1000) for i in range(100, 140)]
        self.assertLess(len(queue.members), queue.capacity)
        now[0] = 1
        run.advance()
        visitor = run.visitors[1]
        self.assertIsNone(visitor.facility_id)
        self.assertIsNone(visitor.slot)
        self.assertIn(visitor.motion.path.points[-1], [tuple(self.routes.nodes[node]) for node in self.routes.plaza_nodes])
        self.assertGreater(visitor.motion.end, now[0])
        queue.members.clear()
        now[0] = visitor.motion.end
        run.advance()
        self.assertEqual(visitor.facility_id, key)

    def test_arrival_checks_space_and_moves_on_without_a_phone_stop(self):
        key = 'comet-express'
        for full in (False, True):
            with self.subTest(full=full):
                run, now = self.start(only=key, patience=300, automatic=False)
                queue = run.queues[key]
                now[0] = 1
                run.advance()
                visitor = run.visitors[1]
                self.assertEqual(visitor.facility_id, key)
                queue.members = [Visitor(i, 0, 1000) for i in range(100, 100 + (queue.capacity if full else 40))]
                head_walk, _ = run.queue_times[key]
                run.queue_times[key] = head_walk, 230
                self.assertGreater(run._estimated_wait(key), 300)
                now[0] = visitor.motion.end
                run.advance()
                if full:
                    self.assertIsNone(visitor.slot)
                    self.assertIsNone(visitor.facility_id)
                    self.assertEqual(visitor.motion.path.points[0], tuple(self.routes.nodes[queue.paths.approach]))
                    self.assertGreater(visitor.motion.distance_at(now[0] + 1), 0)
                    self.assertIn(visitor.motion.path.points[-1],
                                  [tuple(self.routes.nodes[node]) for node in self.routes.plaza_nodes])
                else:
                    self.assertIn(visitor, queue.members)
                    self.assertEqual(visitor.phase, 'in_queue')

    def test_current_recommendations_count_visitors_already_walking_there(self):
        key = 'atlantis'
        run, now = self.start(only=key, automatic=False, target_people=2)
        queue = run.queues[key]
        queue.paths = replace(queue.paths, slots=queue.paths.slots[-1:])
        run.queue_times[key] = 0, 3 * queue.paths.boarding_capacity
        now[0] = 2
        before = run.snapshot()['background']['queues'][key]
        first, second = run.visitors.values()
        self.assertEqual(first.facility_id, key)
        self.assertIsNone(second.facility_id)
        self.assertEqual(queue.approaching_people, 1)
        self.assertFalse(queue.members)
        self.assertEqual((before['approaching_count'], before['reserved_count'], before['estimated_wait_sim_s']),
                         (1, 0, 3))
        now[0] = first.motion.end
        after = run.snapshot()['background']['queues'][key]
        self.assertEqual(queue.approaching_people, 0)
        self.assertEqual(queue.members, [first])
        self.assertEqual((after['approaching_count'], after['reserved_count'], after['estimated_wait_sim_s']),
                         (0, 1, 3))

    def test_visitor_joins_before_stay_ends_and_finishes_ride_after_it(self):
        key = 'atlantis'
        probe, probe_time = self.start(only=key, patience=180, automatic=False)
        probe_time[0] = 1
        probe.advance()
        stay = ceil(probe.visitors[1].motion.end)
        run, now = self.start(only=key, patience=180, automatic=False, stay_sim_s=[stay, stay])
        now[0] = 1
        run.advance()
        visitor = run.visitors[1]
        now[0] = visitor.motion.end
        run.advance()
        slot = visitor.slot
        self.assertIsNotNone(slot)
        self.assertGreater(visitor.leave_at_sim_s - now[0], 0)
        self.assertLessEqual(visitor.leave_at_sim_s - now[0], 2)

        now[0] = visitor.leave_at_sim_s
        still_in_line, = run.snapshot()['background']['visitors']
        self.assertTrue(still_in_line['departure_requested'])
        self.assertEqual(still_in_line['queue_slot'], slot)

        now[0] += 181
        still_in_line, = run.snapshot()['background']['visitors']
        self.assertEqual(still_in_line['state'], 'queued')
        self.assertEqual(still_in_line['queue_slot'], slot)
        self.assertEqual(run.board_next(key, 1), (visitor.visitor_id,))
        now[0] = visitor.motion.end
        self.assertEqual(run.unload(key), (visitor.visitor_id,))
        run.advance()
        self.assertEqual(visitor.phase, 'walking_from_ride')
        now[0] = visitor.motion.end
        run.advance()
        self.assertEqual(visitor.phase, 'walking_to_exit')
        self.assertEqual(visitor.completed_rides, {key: 1})
        now[0] = visitor.motion.end
        self.assertEqual(run.snapshot()['background']['exited_total'], 1)
        self.assertNotIn(visitor.visitor_id, run.visitors)

    def test_visitor_keeps_waiting_after_personal_limit_even_before_stay_ends(self):
        key = 'atlantis'
        run, now = self.start(only=key, patience=180, automatic=False)
        now[0] = 1
        run.advance()
        visitor = run.visitors[1]
        now[0] = visitor.motion.end + 181
        run.advance()
        self.assertFalse(visitor.expired)
        self.assertEqual(visitor.phase, 'in_queue')
        self.assertEqual(run.queues[key].members, [visitor])

    def test_completing_all_facilities_allows_repeats_until_scheduled_departure(self):
        run, now = self.start(stay_sim_s=[10000, 10000])
        now[0] = 8000
        visitor, = run.snapshot()['background']['visitors']
        self.assertEqual(set(visitor['completed_rides']), set(self.routes.facilities))
        self.assertTrue(any(count > 1 for count in visitor['completed_rides'].values()))
        self.assertFalse(visitor['departure_requested'])

        for now[0] in range(10001, 11202, 10):
            state = run.snapshot()['background']
            if state['exited_total']:
                break
        self.assertEqual(state['exited_total'], 1)
        self.assertEqual(state['entered_total'], state['present_people'] + state['exited_total'])

    def test_seed_reproduces_choices_and_ride_history_across_polling_rates(self):
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

    def test_walk_trail_includes_phone_pace_changes_without_stopping(self):
        walk = Motion(Path([(0, 0), (3, 0), (3, 7)]), 0, 0, 10, 2, (2, 6, 1))
        self.assertEqual([walk.distance_at(t) for t in range(8)], [0, 2, 3, 4, 5, 6, 8, 10])
        self.assertEqual(walk.trail(6, 6), [[0, 0, 0], [1, 2, 0], [2, 3, 0], [5, 3, 3], [6, 3, 5]])
