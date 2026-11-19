from collections import Counter
import unittest

from lotteworld_sim.background import BackgroundRun, Visitor
from lotteworld_sim.scenario import load_inputs
from lotteworld_sim.visitor_routes import VisitorRoutes


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
