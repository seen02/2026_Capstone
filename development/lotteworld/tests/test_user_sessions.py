from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.cookiejar import CookieJar
import json
import math
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener

from lotteworld_sim.map_geometry import distance_to_segment, public_walkable
from lotteworld_sim.recommendation import VERSION
from lotteworld_sim.server import make_server
from lotteworld_sim.user_sessions import SIGN_ID


class UserSessionAPITests(unittest.TestCase):
    def setUp(self):
        self.session_time = datetime.now(timezone.utc)
        session_clock = self.enterContext(patch("lotteworld_sim.user_sessions.datetime", wraps=datetime))
        session_clock.now.side_effect = lambda tz: self.session_time
        self.background_time = 0
        server = make_server(0, clock=lambda: self.background_time)
        self.server = server
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

    def assert_simulation_wait(self, offer):
        self.assertEqual(offer["source"], {"kind": "simulation", "provider_id": "simulation-queue-v1"})
        rec = offer["recommendation"]
        queues = self.request("/api/state")[1]["background"]["queues"]
        self.assertEqual(rec["wait_seconds"], queues[rec["facility_id"]]["estimated_wait_sim_s"])

    def finish_visit(self):
        for self.background_time in range(self.background_time + 4, self.background_time + 360, 4):
            status, session, _ = self.request("/api/user/session")
            self.assertEqual(status, 200)
            if session["session"]["phase"] == "completed":
                return session
        self.fail("시뮬레이션 이용이 제한 시간 안에 끝나지 않았습니다.")

    def test_removed_delete_does_not_end_an_active_session(self):
        _, entry, _ = self.enter()
        path = "/api/user/session"
        status, _, headers = self.request(
            path, {"session_id": entry["session"]["session_id"]}, method="DELETE",
        )
        self.assertEqual(status, 404)
        self.assertIsNone(headers.get("Set-Cookie"))
        self.assertEqual(self.request(path)[1], entry)
        self.assertEqual(self.enter()[1], entry)

    def test_acceptance_shares_one_queue_ride_and_unload_with_overview(self):
        _, entry, _ = self.enter()
        _, ready, _ = self.save(entry, ["comet-express", "gyro-spin", "gyro-drop"])
        self.assert_simulation_wait(ready["offer"])
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
        points = ready["offer"]["recommendation"]["route"]["points"]
        self.assertLess(min(distance_to_segment(mid["character"]["position"]["point"], a, b)
                            for a, b in zip(points, points[1:])), 1e-8)
        facility = "comet-express"
        character_id = ready["character"]["character_id"]
        phases = []
        waits = []
        for self.background_time in range(4, 200):
            _, visit, _ = self.request("/api/user/session")
            character = visit["character"]
            phase = character["phase"]
            if phase == "queued":
                waits.append(character["queue_wait_sim_s"])
            else:
                self.assertIsNone(character["queue_wait_sim_s"])
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
                self.session_time += timedelta(minutes=4, seconds=59)
                _, resumed, headers = self.enter()
                self.assertEqual(resumed["character"], character)
                self.assertEqual(resumed["session"]["session_id"], visit["session"]["session_id"])
                self.assertIn("Max-Age=300", headers["Set-Cookie"])
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
        expected_phases = ["moving", "queued", "boarding", "riding", "unloading", "completed"]
        if "waiting_at_entrance" in phases:
            expected_phases.insert(1, "waiting_at_entrance")
        self.assertEqual(phases, expected_phases)
        self.assertTrue(all(math.isfinite(value) and value >= 0 for value in waits))
        self.assertLess(min(waits), max(waits))
        self.assertEqual(self.accept(command)[1], result)
        self.assertEqual(self.enter()[1], visit)
        self.assert_error(self.save(moving, ["gyro-drop", "comet-express", "gyro-spin"]), 409, "revision_mismatch")
        status, next_offer, _ = self.request("/api/user/recommendation")
        self.assertEqual(status, 200)
        self.assert_simulation_wait(next_offer)
        self.assertNotEqual(next_offer["recommendation"]["facility_id"], facility)
        self.assertEqual(next_offer["recommendation"]["route"]["origin"], visit["character"]["position"])
        _, next_ready, _ = self.request("/api/user/session")
        self.assertEqual(next_ready["character"]["phase"], "ready")
        self.assertEqual(next_ready["session"]["preference_order"], [facility, "gyro-spin", "gyro-drop"])
        self.assertGreater(next_ready["character"]["revision"], visit["character"]["revision"])
        self.assertEqual(self.accept(command)[1], result)

        second_command = {**self.acceptance(next_offer), "command_id": "second-visit-command"}
        status, second_visit, _ = self.accept(second_command)
        self.assertEqual(status, 200, second_visit)
        self.assertNotEqual(second_visit["visit_id"], result["visit_id"])
        self.assertEqual(self.accept(command)[1], result)
        _, moving_again, _ = self.request("/api/user/session")
        self.assertEqual(moving_again["session"]["active_visit_id"], second_visit["visit_id"])
        self.assertEqual(moving_again["character"]["position"], visit["character"]["position"] | {"node_id": None})

        second_facility = next_offer["recommendation"]["facility_id"]
        second_finished = self.finish_visit()
        self.assertEqual(self.enter()[1]["character"]["character_id"], character_id)

        saved_order = next_ready["session"]["preference_order"]
        status, third_ready, _ = self.save(second_finished, saved_order)
        self.assertEqual(status, 200)
        third_offer = third_ready["offer"]
        self.assert_simulation_wait(third_offer)
        unused_facility, = set(saved_order) - {facility, second_facility}
        self.assertEqual(third_offer["recommendation"]["facility_id"], unused_facility)
        self.assertEqual(third_offer["recommendation"]["rank"], saved_order.index(unused_facility) + 1)

        third_command = {**self.acceptance(third_offer), "command_id": "third-visit-command"}
        self.assertEqual(self.accept(third_command)[0], 200)
        third_finished = self.finish_visit()
        status, first_offer, _ = self.request("/api/user/recommendation")
        self.assertEqual(status, 200)
        self.assert_simulation_wait(first_offer)
        self.assertIn(first_offer["recommendation"]["facility_id"], (facility, second_facility))
        self.assertIn({"facility_id": unused_facility, "codes": ["round_start_recent_ride"]}, first_offer["excluded"])
        self.assertEqual(first_offer["recommendation"]["route"]["origin"], third_finished["character"]["position"])

        fourth_command = {**self.acceptance(first_offer), "command_id": "fourth-visit-command"}
        self.assertEqual(self.accept(fourth_command)[0], 200)
        self.finish_visit()
        status, second_round_offer, _ = self.request("/api/user/recommendation")
        self.assertEqual(status, 200)
        self.assert_simulation_wait(second_round_offer)
        self.assertNotEqual(second_round_offer["recommendation"]["facility_id"],
                            first_offer["recommendation"]["facility_id"])
        self.assertFalse(any("round_start_recent_ride" in row["codes"] for row in second_round_offer["excluded"]))

    def test_changed_preferences_restart_round_but_keep_the_last_ride(self):
        _, entry, _ = self.enter()
        order = ["comet-express", "gyro-spin", "gyro-drop"]
        _, ready, _ = self.save(entry, order)
        first = ready["offer"]["recommendation"]["facility_id"]
        self.assertEqual(self.accept(self.acceptance(ready["offer"]))[0], 200)
        self.finish_visit()
        _, next_offer, _ = self.request("/api/user/recommendation")
        last = next_offer["recommendation"]["facility_id"]
        self.assertEqual(self.accept({**self.acceptance(next_offer), "command_id": "second-visit-command"})[0], 200)
        finished = self.finish_visit()
        remaining, = set(order) - {first, last}

        new_order = [last, first, remaining]
        status, updated, _ = self.save(finished, new_order)
        self.assertEqual(status, 200)
        self.assertEqual(updated["session"]["preference_order"], new_order)
        self.assert_simulation_wait(updated["offer"])
        self.assertEqual(updated["offer"]["recommendation"]["facility_id"], first)
        self.assertIn({"facility_id": last, "codes": ["round_start_recent_ride"]}, updated["offer"]["excluded"])
        self.assertEqual(self.save(finished, new_order)[1], updated)

    def test_expired_offer_can_be_replaced_before_walking(self):
        _, entry, _ = self.enter()
        _, ready, _ = self.save(entry, ["gyro-spin", "comet-express", "gyro-drop"])
        old = self.acceptance(ready["offer"])
        self.background_time = 60
        self.server.service_actions()
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
        for flag in ("HttpOnly", "SameSite=Strict", "Max-Age=300", "Path=/api/user/"):
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
        self.assertEqual(origin, [123, 111])
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
        public_sign = next(sign for sign in meta["signs"] if sign["sign_id"] == SIGN_ID)
        self.assertEqual(first["sign"], {key: public_sign[key] for key in ("sign_id", "map_hash", "position")})
        self.assertEqual(public_sign["facility_ids"], [row["facility_id"] for row in first["facilities"]])
        self.assertFalse(public_walkable(meta["map"], origin, 0.5))
        self.assertTrue(all(public_walkable(meta["map"], point, 0.5) for point in (one, two)))
        self.assertTrue(all(2 <= math.dist(origin, point) <= 12 for point in (one, two)))
        self.assertEqual(self.request("/api/user/session")[1], first)
        self.assertEqual(self.enter()[1], first)
        self.assertIn("Max-Age=300", self.enter()[2]["Set-Cookie"])
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
        self.assert_simulation_wait(result)
        self.assertEqual(result["policy_id"], "sign-baseline-v1")
        self.assertEqual(result["result"], "recommended")
        rec = result["recommendation"]
        self.assertEqual((rec["facility_id"], rec["rank"]), ("gyro-drop", 1))
        self.assertEqual(rec["route"]["origin"], ready["session"]["position"])
        self.assertEqual(rec["route"]["points"][0], ready["session"]["position"]["point"])
        self.assertEqual(rec["route"]["method"], "public-visibility-v1")
        self.assertNotIn([143, 145], rec["route"]["points"])
        origin, outside, entrance = rec["route"]["points"]
        self.assertAlmostEqual(rec["distance_m"], math.dist(origin, outside) + math.dist(outside, entrance))
        self.assertLess(rec["distance_m"], math.dist(origin, [143, 145]) + math.dist([143, 145], entrance))
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
        facilities = [row["facility_id"] for row in state["facilities"]]
        for facility in facilities:
            with self.subTest(facility=facility):
                order = [facility, *(other for other in facilities if other != facility)]
                code, state, _ = self.save(state, order)
                self.assertEqual(code, 200)
                code, result, _ = self.request("/api/user/recommendation")
                self.assertEqual((code, result["result"], result["excluded"]), (200, "recommended", []))
                rec = result["recommendation"]
                self.assertEqual((rec["facility_id"], rec["rank"]), (facility, 1))
                self.assert_simulation_wait(result)

    def test_live_queue_wait_can_change_recommendation_with_same_preferences(self):
        _, entry, _ = self.enter()
        order = ["gyro-spin", "comet-express", "gyro-drop"]
        with self.server.background.lock:
            spin_queue = self.server.background.queues["gyro-spin"]
            comet_queue = self.server.background.queues["comet-express"]
            spin_queue.approaching_people = 0
            comet_queue.approaching_people = 0
        _, ready, _ = self.save(entry, order)
        self.assertEqual(ready["offer"]["recommendation"]["facility_id"], "gyro-spin")
        self.assert_simulation_wait(ready["offer"])

        with self.server.background.lock:
            spin_queue.approaching_people = 1000
        self.session_time += timedelta(seconds=31)
        status, offer, _ = self.request("/api/user/recommendation")
        self.assertEqual(status, 200)
        self.assertEqual(offer["recommendation"]["facility_id"], "comet-express")
        self.assert_simulation_wait(offer)
        self.assertEqual(self.request("/api/user/session")[1]["session"]["preference_order"], order)

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
                self.server.service_actions()
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
                if result["recommendation"]:
                    self.assert_simulation_wait(result)
                else:
                    self.assertEqual(result["result"], "no_candidate")

    def test_expired_session_releases_identity(self):
        _, entry, _ = self.enter()
        created = datetime.fromisoformat(entry["session"]["created_at"])
        expires = datetime.fromisoformat(entry["session"]["expires_at"])
        order = [row["facility_id"] for row in entry["facilities"]]
        self.assertEqual(expires - created, timedelta(minutes=5))

        self.assertEqual(self.request("/api/user/session")[1], entry)
        code, entry, _ = self.save(entry, order)
        self.assertEqual(code, 200)
        self.assert_simulation_wait(entry["offer"])

        _, accepted, _ = self.accept(self.acceptance(entry["offer"]))
        character_id = entry["character"]["character_id"]
        self.assertTrue(accepted["accepted"])
        self.session_time = expires - timedelta(seconds=1)
        _, still_active, headers = self.request("/api/user/session")
        self.assertEqual(still_active["character"]["character_id"], character_id)
        renewal = datetime.fromisoformat(still_active["session"]["expires_at"])
        self.assertEqual(renewal, self.session_time + timedelta(minutes=5))
        self.assertIn("Max-Age=300", headers["Set-Cookie"])
        self.session_time = renewal - timedelta(seconds=1)
        self.assertEqual(self.request("/api/state")[1]["qr"]["characters"][0]["character_id"], character_id)
        self.session_time = renewal
        self.server.service_actions()
        self.assertNotIn(character_id, self.server.background.snapshot(with_qr=True)["qr_visits"])
        self.assert_error(self.request("/api/user/session"), 409, "session_expired")
        self.assertEqual(self.request("/api/state")[1]["qr"]["characters"], [])
        self.assert_error(self.save(entry, order), 409, "session_expired")
        self.assert_error(self.request("/api/user/recommendation"), 409, "session_expired")
        _, after_expiry, _ = self.enter()
        self.assertNotEqual(entry["session"]["session_id"], after_expiry["session"]["session_id"])
        self.assertEqual(entry["session"]["position"], after_expiry["session"]["position"])
        self.assert_error(self.save(entry, order), 409, "session_mismatch")
