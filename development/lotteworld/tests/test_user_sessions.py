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

    def acceptance(self, offer):
        return {"context": offer["context"], "command_id": "test-walk-command",
                "session_id": offer["session_id"], "expected_session_revision": offer["session_revision"],
                "expected_snapshot_seq": offer["snapshot_seq"],
                "recommendation_id": offer["recommendation"]["recommendation_id"]}

    def accept(self, command, *, client=None):
        return self.request("/api/user/recommendation/accept", command, method="POST", client=client)

    def test_acceptance_shares_one_queue_ride_and_unload_with_overview(self):
        _, entry, _ = self.enter()
        _, ready, _ = self.save(entry, ["comet-express", "gyro-spin", "gyro-drop"])
        other = self.new_client()
        _, other_entry, _ = self.enter(client=other)
        command = self.acceptance(ready["offer"])
        self.assert_error(self.accept(command, client=other), 409, "session_mismatch")
        with ThreadPoolExecutor(max_workers=2) as pool:
            accepted = list(pool.map(lambda _: self.accept(command), range(2)))
        status, result, _ = accepted[0]
        self.assertEqual(status, 200)
        self.assertEqual(accepted[1][1], result)
        self.assert_error(self.accept({**command, "command_id": "another-command"}), 409, "session_conflict")
        self.assert_error(self.accept({**command, "expected_snapshot_seq": 0}), 409, "idempotency_conflict")
        _, moving, _ = self.request("/api/user/session")
        self.assertEqual(moving["session"]["phase"], "moving")
        self.assertEqual(moving["session"]["active_visit_id"], result["visit_id"])
        self.background_time = 3
        _, mid, _ = self.request("/api/user/session")
        _, state, _ = self.request("/api/state")
        self.assertIn(mid["character"], state["qr"]["characters"])
        self.assertIn(other_entry["character"], state["qr"]["characters"])
        self.assertGreater(mid["character"]["revision"], moving["character"]["revision"])
        self.assertNotEqual(mid["character"]["position"], moving["character"]["position"])
        self.assertTrue(mid["character"]["walk_trail"])
        facility = "comet-express"
        character_id = ready["character"]["character_id"]
        phases = []
        for self.background_time in range(4, 200):
            _, visit, _ = self.request("/api/user/session")
            character = visit["character"]
            phase = character["phase"]
            if phases and phases[-1] == phase:
                continue
            state = self.request("/api/state")[1]
            phases.append(phase)
            self.assertIn(character, state["qr"]["characters"])
            self.assertIn(other_entry["character"], state["qr"]["characters"])
            self.assertEqual(state["background"]["entered_total"],
                             state["background"]["present_people"] + state["background"]["exited_total"])
            self.assertNotIn(character_id, {visitor["visitor_id"] for visitor in state["background"]["visitors"]})
            if phase == "queued":
                self.assertGreater(character["queue_position"], 1)
                self.assertEqual(state["background"]["queues"][facility]["qr_reserved_count"], 1)
            if phase in ("boarding", "riding"):
                vehicle, = (v for v in state["rides"][facility]["vehicles"] if v["vehicle_id"] == character["vehicle_id"])
                self.assertIn(character_id, vehicle["qr_character_ids"])
                self.assertLessEqual(len(vehicle["passenger_ids"]) + len(vehicle["qr_character_ids"]),
                                     state["rides"][facility]["seats_per_vehicle"])
                if phase == "riding":
                    self.assertIsNone(character["position"]["point"])
                    self.assertIsNotNone(character["map_point"])
            if phase == "completed":
                self.assertIsNone(visit["session"]["active_visit_id"])
                nodes = {node["id"]: node["point"] for node in self.request("/api/meta")[1]["map"]["geometry"]["nodes"]}
                self.assertEqual(character["position"]["point"], nodes[character["position"]["node_id"]])
                break
        self.assertEqual(phases, ["moving", "waiting_at_entrance", "queued", "boarding", "riding", "unloading", "completed"])
        self.assertEqual(self.accept(command)[1], result)
        self.assertEqual(self.enter()[1], visit)

    def test_expired_offer_can_be_replaced_before_walking(self):
        _, entry, _ = self.enter()
        _, ready, _ = self.save(entry, ["gyro-spin", "comet-express", "gyro-drop"])
        old = self.acceptance(ready["offer"])
        self.background_time = 60
        self.assert_error(self.accept(old), 409, "recommendation_expired")
        _, offer, _ = self.request("/api/user/recommendation")
        self.assertNotEqual(offer["recommendation"]["recommendation_id"], old["recommendation_id"])
        self.assertEqual(self.accept(self.acceptance(offer))[0], 200)

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
        _, live, _ = self.request("/api/state")
        self.assertEqual(live["run_id"], first["context"]["run_id"])
        self.assertEqual(live["qr"]["context"], first["context"])
        self.assertCountEqual(live["qr"]["characters"], [first["character"], second["character"]])
        self.assertNotIn("session_id", live["qr"]["characters"][0])
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
        preview = ready["character"]["route_preview"]
        self.assertEqual(preview, {"facility_id": rec["facility_id"], "route": rec["route"],
                                  "source": result["source"]})
        live = self.request("/api/state")[1]
        self.assertIn(ready["character"], live["qr"]["characters"])
        self.assertIn(other_entry["character"], live["qr"]["characters"])

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
                observed = self.request("/api/user/session")[1]
                self.assertEqual(observed["session"], ready["session"])
                self.assertEqual(observed["character"], ready["character"])
                self.assertEqual(self.request("/api/user/session", client=other)[1], other_ready)
                status, result, _ = self.request("/api/user/recommendation")
                self.assertEqual(status, 200)
                self.assertEqual(result["context"], ready["context"])
                self.assertEqual(result["recommendation"]["facility_id"], order[0])

    def test_expired_session_releases_identity_and_mock_reload_keeps_live_context(self):
        _, entry, _ = self.enter()
        created = datetime.fromisoformat(entry["session"]["created_at"])
        expires = datetime.fromisoformat(entry["session"]["expires_at"])
        order = [row["facility_id"] for row in entry["facilities"]]
        self.assertEqual(expires - created, timedelta(minutes=30))

        mock = json.loads(self.mock_path.read_text(encoding="utf-8"))
        mock["provider_id"] = "updated-local-mock"
        self.mock_path.write_text(json.dumps(mock), encoding="utf-8")
        self.assertEqual(self.request("/api/user/session")[1], entry)
        code, entry, _ = self.save(entry, order)
        self.assertEqual(code, 200)
        self.assertEqual(entry["character"]["route_preview"]["source"]["provider_id"], "updated-local-mock")

        with patch("lotteworld_sim.user_sessions.datetime", wraps=datetime) as clock:
            clock.now.return_value = expires - timedelta(seconds=1)
            _, still_active, headers = self.enter()
            self.assertEqual(still_active, entry)
            self.assertNotIn("Set-Cookie", headers)
            clock.now.return_value = expires
            self.assert_error(self.request("/api/user/session"), 409, "session_expired")
            self.assertEqual(self.request("/api/state")[1]["qr"]["characters"], [])
            self.assert_error(self.save(entry, order), 409, "session_expired")
            self.assert_error(self.request("/api/user/recommendation"), 409, "session_expired")
            _, after_expiry, _ = self.enter()
        self.assertNotEqual(entry["session"]["session_id"], after_expiry["session"]["session_id"])
        self.assertEqual(entry["session"]["position"], after_expiry["session"]["position"])
        self.assert_error(self.save(entry, order), 409, "session_mismatch")
