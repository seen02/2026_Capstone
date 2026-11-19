from copy import deepcopy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from lotteworld_sim.recommendation import RecommendationError, RecommendationPolicy
from lotteworld_sim.recommendation_mock import MOCK_FILENAME
from lotteworld_sim.scenario import ROOT, load_inputs
from lotteworld_sim.server import make_server

EXAMPLES = ROOT.parent / "docs" / "contracts" / "examples"
MOCK_DATA = ROOT / "configs" / MOCK_FILENAME


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
        self.states["gyro-drop"]["wait"]["seconds"] = 12000 * (
            0.1 + 0.2 * (self.routes["gyro-spin"]["distance_m"] - self.routes["gyro-drop"]["distance_m"]) / 500 + 2e-10
        )
        answer = self.policy.recommend(self.data)["recommendation"]
        self.assertEqual(answer["facility_id"], "gyro-drop")
        self.states["gyro-drop"]["wait"]["seconds"] += 0.001
        self.assertEqual(self.policy.recommend(self.data)["recommendation"]["facility_id"], "gyro-spin")

    def test_recommendation_keeps_independent_exclusion_reasons(self):
        self.states["gyro-drop"].update(admission="full", queue_people=105)
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


class RecommendationAPITests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.mock_path = Path(directory) / "local.json"
        self.mock = json.loads(MOCK_DATA.read_text(encoding="utf-8"))
        self.write_mock()
        server = make_server(0, host="127.0.0.1", mock_data=self.mock_path)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.base = f"http://127.0.0.1:{server.server_port}"
        self.info = self.get("/api/recommendation/mock")
        session = fixture("mock-input.json")["session"]
        self.request = {key: session[key] for key in ("session_id", "character_id", "revision", "position", "preference_order")}
        self.request.update(contract_version=self.info["contract_version"], context=self.info["context"])

    def write_mock(self):
        self.mock_path.write_text(json.dumps(self.mock), encoding="utf-8")

    def get(self, path):
        with urlopen(self.base + path, timeout=5) as response:
            return json.load(response)

    def post(self, data=None, *, media="application/json"):
        body = data if isinstance(data, bytes) else json.dumps(self.request if data is None else data).encode()
        request = Request(self.base + "/api/recommendation", body, {"Content-Type": media})
        try:
            with urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            with error:
                return error.code, json.load(error)

    def test_local_recommendation_and_repeat(self):
        self.assertEqual(self.info["context"]["map_hash"], self.get("/api/meta")["hashes"]["map"])
        status, result = self.post()
        status2, repeat = self.post()
        self.assertEqual((status, status2), (200, 200))
        self.assertEqual(result["source"], {"kind": "mock", "provider_id": "local-mock-v1"})
        self.assertEqual(result["context"], self.info["context"])
        self.assertGreater(repeat["snapshot_seq"], result["snapshot_seq"])
        first, second = result["recommendation"], repeat["recommendation"]
        self.assertEqual((first["facility_id"], first["rank"], first["wait_seconds"]), ("gyro-spin", 2, 300))
        for key in ("facility_id", "rank", "wait_seconds", "distance_m", "cost", "route", "reason_text"):
            self.assertEqual(first[key], second[key])
        self.assertEqual(first["route"]["method"], "open-plaza-v1")
        self.assertEqual(indexed(result["excluded"])["atlantis"]["codes"], ["wait_unknown"])

    def test_preference_wait_and_position_change_the_choice(self):
        self.request["preference_order"] = ["gyro-drop", "gyro-spin", "arcana-ride", "atlantis", "comet-express", "gyro-swing"]
        self.assertEqual(self.post()[1]["recommendation"]["facility_id"], "gyro-drop")
        self.request["position"] = next(pos for pos in self.info["positions"] if pos["node_id"] == "west-spin")
        self.assertEqual(self.post()[1]["recommendation"]["facility_id"], "gyro-drop")
        indexed(self.mock["facilities"])["gyro-drop"]["wait"]["seconds"] = 1500
        self.write_mock()
        self.assertEqual(self.post()[0], 409)
        self.request["context"] = self.get("/api/recommendation/mock")["context"]
        self.assertEqual(self.post()[1]["recommendation"]["facility_id"], "gyro-spin")
        self.request["position"] = next(pos for pos in self.info["positions"] if pos["node_id"] == "west-north")
        self.assertEqual(self.post()[1]["recommendation"]["facility_id"], "gyro-drop")
        self.request["preference_order"].remove("arcana-ride")
        self.request["preference_order"].insert(0, "arcana-ride")
        self.assertEqual(self.post()[1]["recommendation"]["wait_seconds"], 0)

    def test_unsupported_route_and_invalid_requests(self):
        for data, status, code in (
            (b'{"latitude": NaN}', 400, "invalid_input"),
            (b'{"unused": 1e400}', 400, "invalid_input"),
            (b'{"revision": 1, "revision": 2}', 400, "invalid_input"),
            ({**self.request, "revision": True}, 400, "invalid_input"),
            ({**self.request, "contract_version": "recommendation.v2"}, 400, "unsupported_version"),
            ({**self.request, "position": {"point": [2, 2], "node_id": None}}, 400, "invalid_input"),
            ({**self.request, "context": {**self.request["context"], "run_id": "old-run"}}, 409, "context_mismatch"),
            (b"x" * (64 * 1024 + 1), 413, "body_too_large"),
        ):
            with self.subTest(code=code):
                actual, result = self.post(data)
                self.assertEqual((actual, result["error"]["code"]), (status, code))
        self.assertEqual(self.post(media="text/plain")[0], 415)
        self.request["position"] = {"point": [137, 130], "node_id": None}
        status, result = self.post()
        self.assertEqual((status, result["result"], result["recommendation"]), (200, "no_candidate", None))
        self.assertEqual(len(result["excluded"]), 6)
        self.assertTrue(all("route_unavailable" in row["codes"] for row in result["excluded"]))

    def test_broken_mock_is_isolated_and_recovers(self):
        original = self.mock["map_hash"]
        self.mock["map_hash"] = "0" * 64
        self.write_mock()
        status, error = self.post()
        self.assertEqual((status, error["error"]["code"]), (503, "mock_data_unavailable"))
        self.assertEqual(self.get("/api/meta")["hashes"]["map"], original)
        self.mock["map_hash"] = original
        self.write_mock()
        self.assertEqual(self.post()[0], 409)
        self.request["context"] = self.get("/api/recommendation/mock")["context"]
        self.assertEqual(self.post()[0], 200)
