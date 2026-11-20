import unittest

from lotteworld_sim.background import BackgroundRun
from lotteworld_sim.scenario import load_inputs


class BackgroundTests(unittest.TestCase):
    def test_empty_start_and_departure_at_admission_boundary(self):
        real_time = 0
        config = {**load_inputs().continuous, "target_people": 2, "initial_people": 0,
                  "admission_interval_sim_s": 60, "stay_sim_s": [60, 60], "time_scale": 6}
        run = BackgroundRun(config, clock=lambda: real_time)
        for real_time, entered, present, exited in (
            (0, 0, 0, 0), (9, 0, 0, 0), (10, 1, 1, 0),
            (19, 1, 1, 0), (20, 2, 1, 1), (30, 3, 1, 2),
        ):
            with self.subTest(real_time=real_time):
                state = run.snapshot()
                self.assertEqual(state["clock"]["sim_time_s"], real_time * 6)
                people = state["background"]
                self.assertEqual(
                    (people["entered_total"], people["present_people"], people["exited_total"]),
                    (entered, present, exited),
                )
                for visitor in people["visitors"]:
                    latest_slot = (real_time // 10) * 60
                    self.assertEqual(visitor["entered_at_sim_s"], latest_slot)
                    self.assertEqual(visitor["leave_at_sim_s"], latest_slot + 60)

    def test_240_people_conservation_and_reproducibility_over_14_days(self):
        real_time = 0
        config = {**load_inputs().continuous, "target_people": 240, "initial_people": 240}
        run = BackgroundRun(config, clock=lambda: real_time)
        jumped = BackgroundRun(config, clock=lambda: real_time)
        initial = run.snapshot()["background"]
        target = config["target_people"]
        self.assertEqual((initial["present_people"], initial["entered_total"], initial["exited_total"]),
                         (target, target, 0))
        self.assertTrue(all(visitor["entered_at_sim_s"] < 0 for visitor in initial["visitors"]))
        previous_entered, previous_exited = target, 0
        for real_time in range(60, 14 * 86400 // config["time_scale"] + 1, 60):
            state = run.snapshot()
            people = state["background"]
            present, entered, exited = (people[key] for key in ("present_people", "entered_total", "exited_total"))
            self.assertEqual(entered, present + exited)
            self.assertLessEqual(present, target)
            self.assertGreaterEqual(present, target - 10)
            self.assertGreaterEqual(entered, previous_entered)
            self.assertGreaterEqual(exited, previous_exited)
            self.assertEqual(present, len({visitor["visitor_id"] for visitor in people["visitors"]}))
            now = state["clock"]["sim_time_s"]
            for visitor in people["visitors"]:
                start, end = visitor["entered_at_sim_s"], visitor["leave_at_sim_s"]
                self.assertTrue(start <= now < end)
                self.assertTrue(7199.999999 <= end - start <= 10800.000001)
            if real_time == 7200:
                self.assertGreater(exited, target * 3)
                self.assertTrue(all(visitor["visitor_id"] > target for visitor in people["visitors"]))
            previous_entered, previous_exited = entered, exited
        self.assertGreater(exited, target * 100)
        self.assertEqual(jumped.snapshot()["background"], people)

    def test_default_1500_people_stay_near_target_for_two_accelerated_hours(self):
        real_time = 0
        config = load_inputs().continuous
        self.assertEqual((config["initial_people"], config["target_people"]), (1500, 1500))
        run = BackgroundRun(config, clock=lambda: real_time)
        for real_time in range(0, 7201, 10):
            people = run.snapshot()["background"]
            present = people["present_people"]
            self.assertTrue(1470 <= present <= 1500)
            self.assertEqual(people["entered_total"], present + people["exited_total"])
        self.assertGreater(people["exited_total"], 6000)
