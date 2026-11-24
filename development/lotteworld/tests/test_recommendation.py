from copy import deepcopy
import json
from math import floor
import unittest

from lotteworld_sim.recommendation import RecommendationError, RecommendationPolicy
from lotteworld_sim.scenario import ROOT, load_inputs

EXAMPLES = ROOT.parent / "docs" / "contracts" / "examples"


def fixture(name):
    return json.loads((EXAMPLES / name).read_text(encoding="utf-8"))


def indexed(rows):
    return {row["facility_id"]: row for row in rows}


class PolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.policy = RecommendationPolicy(load_inputs().metadata())

    def setUp(self):
        self.data = fixture("mock-input.json")
        self.states = indexed(self.data["snapshot"]["facilities"])
        self.routes = indexed(self.data["routes"])

    def assert_error(self, code, data=None):
        with self.assertRaises(RecommendationError) as caught:
            self.policy.recommend(self.data if data is None else data)
        self.assertEqual(caught.exception.code, code)

    def test_contract_fixture_and_reproducibility(self):
        result = self.policy.recommend(self.data)
        self.assertEqual(result, self.policy.recommend(deepcopy(self.data)))
        example = fixture("workflow.json")["recommendation"]
        for key in ("facility_id", "rank", "wait_seconds", "distance_m", "cost", "expires_at", "expires_sim_time_s", "reason_codes"):
            self.assertEqual(result["recommendation"][key], example["recommendation"][key])
        self.assertEqual(indexed(result["excluded"]), indexed(example["excluded"]))
        self.data["routes"].reverse()
        self.data["snapshot"]["facilities"].reverse()
        self.assertEqual(result, self.policy.recommend(self.data))
        simulation = self.policy.recommend(fixture("simulation-input.json"))
        self.assertEqual(simulation["source"]["kind"], "simulation")

    def test_preference_wins_a_rounded_cost_tie(self):
        self.data["session"]["preference_order"] = ["gyro-drop", "gyro-spin", "arcana-ride", "atlantis", "comet-express", "gyro-swing"]
        self.states["gyro-spin"]["wait"]["seconds"] = 0
        spin_cost = 0.1 + 0.2 * self.routes["gyro-spin"]["distance_m"] / 500
        rounding_limit = (floor(spin_cost * 1e9 + 0.5) + 0.5) / 1e9
        tied_drop_cost = (spin_cost + rounding_limit) / 2
        self.states["gyro-drop"]["wait"]["seconds"] = 12000 * (
            tied_drop_cost - 0.2 * self.routes["gyro-drop"]["distance_m"] / 500
        )
        answer = self.policy.recommend(self.data)["recommendation"]
        self.assertEqual(answer["facility_id"], "gyro-drop")
        self.states["gyro-drop"]["wait"]["seconds"] += 0.001
        self.assertEqual(self.policy.recommend(self.data)["recommendation"]["facility_id"], "gyro-spin")

    def test_unridden_facilities_are_prioritized_then_most_recent_ride_is_deferred(self):
        policy = RecommendationPolicy(load_inputs().metadata(), sign_facilities=("gyro-spin", "gyro-drop", "comet-express"))
        self.data.update(policy_id=policy.policy_id)
        self.data["session"]["preference_order"] = ["gyro-spin", "gyro-drop", "comet-express"]

        for completed, last, expected in (
            ((), None, "gyro-spin"),
            (("gyro-spin",), "gyro-spin", "gyro-drop"),
            (("gyro-spin", "gyro-drop"), "gyro-drop", "comet-express"),
        ):
            with self.subTest(completed=completed):
                rec = policy.recommend(self.data, completed_facilities=completed,
                                       last_completed_facility=last)["recommendation"]
                self.assertEqual(rec["facility_id"], expected)

        self.states["comet-express"]["admission"] = "not_accepting"
        completed = ("gyro-spin", "gyro-drop")
        rec = policy.recommend(self.data, completed_facilities=completed, last_completed_facility="gyro-drop")["recommendation"]
        self.assertEqual(rec["facility_id"], "gyro-spin")
        self.states["gyro-spin"]["admission"] = "not_accepting"
        rec = policy.recommend(self.data, completed_facilities=completed, last_completed_facility="gyro-drop")["recommendation"]
        self.assertEqual(rec["facility_id"], "gyro-drop")

    def test_round_start_skips_last_ride_even_when_it_is_the_only_available_facility(self):
        result = self.policy.recommend(self.data, last_completed_facility="gyro-spin")
        self.assertNotEqual(result["recommendation"]["facility_id"], "gyro-spin")

        for facility, row in self.states.items():
            if facility != "gyro-spin":
                row["admission"] = "not_accepting"
        result = self.policy.recommend(self.data, last_completed_facility="gyro-spin")
        self.assertEqual(result["result"], "no_candidate")
        self.assertEqual(indexed(result["excluded"])["gyro-spin"]["codes"], ["round_start_recent_ride"])

    def test_unridden_candidates_are_ranked_by_preferences_wait_and_distance(self):
        policy = RecommendationPolicy(load_inputs().metadata(), sign_facilities=("gyro-spin", "gyro-drop", "comet-express"))
        self.data.update(policy_id=policy.policy_id)
        self.data["session"]["preference_order"] = ["gyro-drop", "gyro-spin", "comet-express"]
        self.states["gyro-spin"]["wait"]["seconds"] = 0
        self.states["comet-express"]["wait"]["seconds"] = 0
        completed = ("gyro-drop",)

        rec = policy.recommend(self.data, completed_facilities=completed)["recommendation"]
        self.assertEqual((rec["facility_id"], rec["rank"]), ("gyro-spin", 2))
        self.states["gyro-spin"]["wait"]["seconds"] = 3600
        rec = policy.recommend(self.data, completed_facilities=completed)["recommendation"]
        self.assertEqual((rec["facility_id"], rec["rank"]), ("comet-express", 3))
        self.data["session"]["preference_order"] = ["gyro-drop", "comet-express", "gyro-spin"]
        self.states["gyro-spin"]["wait"]["seconds"] = 0
        rec = policy.recommend(self.data, completed_facilities=completed)["recommendation"]
        self.assertEqual((rec["facility_id"], rec["rank"]), ("comet-express", 2))

    def test_recommendation_keeps_independent_exclusion_reasons(self):
        self.states["gyro-drop"].update(admission="full", queue_people=110)
        self.states["gyro-spin"]["wait"].update(status="stale", seconds=None)
        self.states["gyro-spin"]["observed_at"] = "2026-11-17T07:59:30Z"
        self.states["gyro-spin"]["as_of_sim_time_s"] = 299
        self.routes["arcana-ride"].update(status="unreachable", points=[], distance_m=None)
        result = self.policy.recommend(self.data)
        self.assertEqual(result["result"], "recommended")
        self.assertEqual(result["recommendation"]["facility_id"], "comet-express")
        self.assertEqual({row["facility_id"]: row["codes"] for row in result["excluded"]}, {
            "arcana-ride": ["route_unreachable"], "atlantis": ["wait_unknown"],
            "gyro-drop": ["admission_unavailable"],
            "gyro-spin": ["wait_stale", "observation_stale"], "gyro-swing": ["operation_unavailable", "admission_unavailable"],
        })

    def test_freshness_boundaries_and_failures(self):
        snapshot, session = self.data["snapshot"], self.data["session"]
        snapshot["generated_at"] = "2026-11-17T07:59:31Z"
        for row in snapshot["facilities"]:
            row.update(observed_at=snapshot["generated_at"], as_of_sim_time_s=300)
        snapshot["clock"]["mode"] = "paused"
        session["position_sim_time_s"] = 300
        self.assertEqual(self.policy.recommend(self.data)["result"], "recommended")
        for field, value in (("observed_at", "2026-11-17T07:59:30.999999Z"), ("as_of_sim_time_s", 299)):
            row = self.states["gyro-spin"]
            previous, row[field] = row[field], value
            result = self.policy.recommend(self.data)
            self.assertEqual(indexed(result["excluded"])["gyro-spin"]["codes"], ["observation_stale"])
            row[field] = previous
        session["position_sim_time_s"] = 299
        self.assert_error("position_stale")
        session["position_sim_time_s"] = 600
        snapshot["generated_at"] = "2026-11-17T07:59:30.999999Z"
        self.assert_error("snapshot_stale")

    def test_invalid_contract_fields_and_temporal_states(self):
        cases = (
            (("contract_version",), "recommendation.v2", "unsupported_version"),
            (("context", "map_hash"), "0" * 64, "context_mismatch"),
            (("context", "timeline_epoch"), True, "invalid_input"),
            (("session", "preference_order"), ["atlantis"] * 6, "invalid_input"),
            (("session", "position", "point"), [137, 130], "invalid_input"),
            (("session", "position_sim_time_s"), 601, "invalid_input"),
            (("session", "expires_at"), self.data["evaluation_at"], "session_expired"),
            (("session", "phase"), "awaiting_preferences", "session_not_ready"),
            (("snapshot", "clock", "mode"), "ended", "run_ended"),
            (("snapshot", "generated_at"), "2026-11-17T08:00:02Z", "invalid_input"),
            (("snapshot", "facilities", 0, "observed_at"), "2026-11-17T08:00:01Z", "invalid_input"),
            (("snapshot", "facilities", 0, "as_of_sim_time_s"), 601, "invalid_input"),
            (("snapshot", "facilities", 0, "facility_id"), "gyro-swing", "invalid_input"),
            (("snapshot", "facilities", 0, "queue_people"), True, "invalid_input"),
            (("snapshot", "facilities", 0, "wait", "seconds"), float("nan"), "invalid_input"),
            (("snapshot", "facilities", 1, "admission"), "accepting", "invalid_input"),
            (("snapshot", "facilities", 2, "wait", "seconds"), 0, "invalid_input"),
            (("routes", 0, "distance_m"), 15, "invalid_input"),
            (("routes", 0, "target_node_id"), "gyro-drop-exit", "invalid_input"),
        )
        for path, value, code in cases:
            with self.subTest(path=path):
                data = deepcopy(self.data)
                row = data
                for key in path[:-1]:
                    row = row[key]
                row[path[-1]] = value
                self.assert_error(code, data)
