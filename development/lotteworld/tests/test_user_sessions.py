from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from http.cookiejar import CookieJar
import json
import math
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener

from lotteworld_sim.map_geometry import public_walkable
from lotteworld_sim.recommendation import VERSION
from lotteworld_sim.scenario import ROOT
from lotteworld_sim.server import make_server
from lotteworld_sim.user_sessions import SIGN_ID


class UserSessionAPITests(unittest.TestCase):
    def setUp(self):
        self.mock_path = Path(self.enterContext(tempfile.TemporaryDirectory())) / "mock.json"
        self.mock_path.write_bytes((ROOT / "configs/recommendation-mock.json").read_bytes())
        self.background_time = 0
        server = make_server(0, mock_data=self.mock_path, clock=lambda: self.background_time)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.base = f"http://127.0.0.1:{server.server_port}"
        self.client = self.new_client()

    @staticmethod
    def new_client():
        return build_opener(HTTPCookieProcessor(CookieJar()))

    def request(self, path, body=None, *, method="GET", client=None, headers=None):
        client = client or self.client
        headers = {} if headers is None else dict(headers)
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps({"contract_version": VERSION, **body}).encode()
        req = Request(self.base + path, data=data, headers=headers, method=method)
        try:
            response = client.open(req, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.code, json.load(response), response.headers

    def enter(self, sign=SIGN_ID, *, client=None, **extra):
        return self.request("/api/user/session", {"sign_id": sign, **extra}, method="POST", client=client)

    def save(self, entry, order, *, client=None, revision=None):
        return self.request("/api/user/preferences", {
            "context": entry["context"],
            "session_id": entry["session"]["session_id"],
            "expected_revision": entry["session"]["revision"] if revision is None else revision,
            "preference_order": order,
        }, method="PUT", client=client)

    def assert_error(self, response, status, code):
        self.assertEqual((response[0], response[1]["error"]["code"]), (status, code))

    def test_common_entry_restores_session_and_isolates_independent_clients(self):
        other = self.new_client()
        with ThreadPoolExecutor(max_workers=2) as pool:
            first_future = pool.submit(self.enter, position={"point": [0, 0], "node_id": None})
            second_future = pool.submit(self.enter, client=other)
            first_status, first, first_headers = first_future.result()
            second_status, second, _ = second_future.result()
        self.assertEqual((first_status, second_status), (200, 200))
        for flag in ("HttpOnly", "SameSite=Strict", "Max-Age=1800", "Path=/api/user/"):
            self.assertIn(flag, first_headers["Set-Cookie"])
        self.assertEqual(first["session"]["phase"], "awaiting_preferences")
        self.assertEqual(first["session"]["revision"], 0)
        self.assertEqual(first["session"]["preference_order"], [])
        self.assertEqual([row["facility_id"] for row in first["facilities"]],
                         ["gyro-spin", "comet-express", "gyro-drop"])
        self.assertEqual(first["context"], second["context"])
        for key in ("session_id", "character_id", "position"):
            self.assertNotEqual(first["session"][key], second["session"][key])
        origin = first["sign"]["position"]["point"]
        self.assertEqual(origin, [101, 149])
        one, two = (entry["session"]["position"]["point"] for entry in (first, second))
        self.assertGreaterEqual(math.dist(one, two), 2)
        _, meta, _ = self.request("/api/meta")
        self.assertEqual(first["sign"]["map_hash"], first["context"]["map_hash"])
        self.assertEqual(first["sign"]["map_hash"], meta["hashes"]["map"])
        self.assertTrue(all(public_walkable(meta["map"], point, 0.5) for point in (origin, one, two)))
        self.assertTrue(all(2 <= math.dist(origin, point) <= 12 for point in (one, two)))
        self.assertEqual(self.request("/api/user/session")[1], first)
        self.assertEqual(self.enter()[1], first)
        self.assertIsNone(self.enter()[2].get("Set-Cookie"))
        another = self.new_client()
        self.assert_error(self.request("/api/user/session", client=another), 401, "session_required")
        self.assert_error(self.request("/api/user/session", client=another, headers={
            "Cookie": f"magic_island_session={first['session']['session_id']}",
        }), 401, "session_required")
        bad_sign = self.enter("unknown", client=another)
        self.assert_error(bad_sign, 404, "unknown_sign")
        self.assertNotIn("Set-Cookie", bad_sign[2])

    def test_preferences_revision_and_server_owned_recommendation_input(self):
        _, entry, _ = self.enter()
        other = self.new_client()
        _, other_entry, _ = self.enter(client=other)
        self.assert_error(self.request("/api/user/recommendation"), 409, "session_not_ready")
        ids = [row["facility_id"] for row in entry["facilities"]]
        for order in ([], ids[:-1], [*ids[:-1], ids[0]], [*ids[:-1], "unknown"], [*ids[:-1], {}],
                      [*ids[:-1], "arcana-ride"], [*ids, "atlantis", "gyro-swing", "arcana-ride"]):
            self.assert_error(self.save(entry, order), 400, "invalid_input")
        self.assertEqual(self.request("/api/user/session")[1], entry)

        order = ["gyro-drop", "gyro-spin", "comet-express"]
        code, ready, _ = self.save(entry, order)
        self.assertEqual(code, 200)
        self.assertEqual(ready["session"]["phase"], "ready")
        self.assertEqual(ready["session"]["revision"], 1)
        self.assertEqual(ready["session"]["preference_order"], order)
        self.assertEqual(self.save(entry, order)[1], ready)
        self.assertEqual(self.enter()[1], ready)
        self.assert_error(self.save(entry, order[::-1]), 409, "revision_mismatch")
        self.assertEqual(self.request("/api/user/session", client=other)[1], other_entry)

        code, result, _ = self.request("/api/user/recommendation?session_id=" + other_entry["session"]["session_id"])
        self.assertEqual(code, 200)
        self.assertEqual(result["session_id"], ready["session"]["session_id"])
        self.assertEqual(result["session_revision"], 1)
        self.assertEqual(result["context"], entry["context"])
        self.assertEqual(result["source"]["kind"], "mock")
        self.assertEqual(result["policy_id"], "sign-baseline-v1")
        self.assertEqual(result["result"], "recommended")
        rec = result["recommendation"]
        self.assertEqual((rec["facility_id"], rec["rank"]), ("gyro-drop", 1))
        self.assertEqual(rec["route"]["origin"], ready["session"]["position"])
        self.assertEqual(rec["route"]["points"][0], ready["session"]["position"]["point"])
        self.assertEqual(rec["route"]["points"][1], [143, 145])

        order[:2] = reversed(order[:2])
        code, updated, _ = self.save(ready, order)
        self.assertEqual(code, 200)
        self.assertEqual(updated["session"]["revision"], 2)
        result = self.request("/api/user/recommendation")[1]
        self.assertEqual(result["session_revision"], 2)
        self.assertEqual(result["recommendation"]["facility_id"], "gyro-spin")

    def test_default_demo_can_recommend_each_sign_facility(self):
        _, state, _ = self.enter()
        waits = {"gyro-spin": 300, "comet-express": 480, "gyro-drop": 900}
        for facility, expected_wait in waits.items():
            with self.subTest(facility=facility):
                order = [facility, *(other for other in waits if other != facility)]
                code, state, _ = self.save(state, order)
                self.assertEqual(code, 200)
                code, result, _ = self.request("/api/user/recommendation")
                self.assertEqual((code, result["result"], result["excluded"]), (200, "recommended", []))
                rec = result["recommendation"]
                self.assertEqual((rec["facility_id"], rec["rank"], rec["wait_seconds"]),
                                 (facility, 1, expected_wait))

    def test_background_turnover_preserves_both_user_sessions_and_recommendation(self):
        other = self.new_client()
        _, entry, _ = self.enter()
        _, other_entry, _ = self.enter(client=other)
        order = ["gyro-drop", "gyro-spin", "comet-express"]
        _, ready, _ = self.save(entry, order)
        _, other_ready, _ = self.save(other_entry, order[::-1], client=other)
        _, initial, _ = self.request("/api/state")
        initial_population = initial["background"]["present_people"]
        self.assertEqual(initial["background"]["entered_total"], initial_population)
        self.assertEqual(initial["background"]["exited_total"], 0)
        for self.background_time in (3600, 7200, 10800):
            with self.subTest(background_time=self.background_time):
                status, state, _ = self.request("/api/state")
                self.assertEqual(status, 200)
                self.assertEqual(state["run_id"], initial["run_id"])
                people = state["background"]
                self.assertGreater(people["exited_total"], initial_population)
                self.assertEqual(people["present_people"] + people["exited_total"], people["entered_total"])
                self.assertEqual(self.request("/api/user/session")[1], ready)
                self.assertEqual(self.request("/api/user/session", client=other)[1], other_ready)
                status, result, _ = self.request("/api/user/recommendation")
                self.assertEqual(status, 200)
                self.assertEqual(result["context"], ready["context"])
                self.assertEqual(result["recommendation"]["facility_id"], order[0])

    def test_expired_session_and_new_world_release_previous_identity(self):
        _, entry, _ = self.enter()
        created = datetime.fromisoformat(entry["session"]["created_at"])
        expires = datetime.fromisoformat(entry["session"]["expires_at"])
        order = [row["facility_id"] for row in entry["facilities"]]
        self.assertEqual(expires - created, timedelta(minutes=30))
        with patch("lotteworld_sim.user_sessions.datetime", wraps=datetime) as clock:
            clock.now.return_value = expires - timedelta(seconds=1)
            _, still_active, headers = self.enter()
            self.assertEqual(still_active, entry)
            self.assertNotIn("Set-Cookie", headers)
            clock.now.return_value = expires
            self.assert_error(self.request("/api/user/session"), 409, "session_expired")
            self.assert_error(self.save(entry, order), 409, "session_expired")
            self.assert_error(self.request("/api/user/recommendation"), 409, "session_expired")
            _, after_expiry, _ = self.enter()
        self.assertNotEqual(entry["session"]["session_id"], after_expiry["session"]["session_id"])
        self.assertEqual(entry["session"]["position"], after_expiry["session"]["position"])
        self.assert_error(self.save(entry, order), 409, "session_mismatch")

        mock = json.loads(self.mock_path.read_text(encoding="utf-8"))
        mock["provider_id"] = "updated-local-mock"
        self.mock_path.write_text(json.dumps(mock), encoding="utf-8")
        self.assert_error(self.request("/api/user/session"), 401, "session_required")
        _, new_world, _ = self.enter()
        self.assertNotEqual(new_world["context"], after_expiry["context"])
        self.assertNotEqual(new_world["session"]["character_id"], after_expiry["session"]["character_id"])
        self.assert_error(self.save(after_expiry, order), 409, "context_mismatch")
