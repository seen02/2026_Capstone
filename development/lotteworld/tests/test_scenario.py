from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from lotteworld_sim.scenario import CONTINUOUS_PATH, ROOT, load_continuous, load_inputs, validate, validate_ride_operations
from lotteworld_sim.server import make_server


class ScenarioTests(unittest.TestCase):
    def test_defaults_and_independent_loads(self):
        scenario = load_inputs()
        self.assertEqual(scenario.config["arrivals"]["planned_total"], 10350)
        self.assertEqual(scenario.config["stay"]["minutes"], [120, 240])
        self.assertEqual(scenario.config["observation"]["end"], "19:00")
        slots = scenario.config["arrivals"]["slots"]
        self.assertEqual(sum(s["count"] for s in slots[3:6]), 4600)
        self.assertEqual(max(s["count"] for s in slots), 1610)
        self.assertFalse(scenario.metadata()["runnable"])
        self.assertEqual(scenario.map["geometry"]["units"], "m")
        self.assertEqual(scenario.metadata()["hashes"], load_inputs().metadata()["hashes"])
        scenario.config["seed"] += 1
        self.assertNotEqual(scenario.metadata()["hashes"], load_inputs().metadata()["hashes"])

    def test_invalid_structures_and_cross_references(self):
        scenario = load_inputs()
        def change(group, keys, value):
            parts = [deepcopy(scenario.map), deepcopy(scenario.config), deepcopy(scenario.preferences)]
            node = parts[group]
            for key in keys[:-1]:
                node = node[key]
            node[keys[-1]] = value
            return parts
        cases = [
            (0, ["scenario_id"], "aquarium"), (0, ["facilities", 0, "id"], "atlantis"),
            (0, ["geometry"], {}), (0, ["facilities"], None),
            (1, ["schema_version"], True), (1, ["seed"], True),
            (1, ["observation", "end"], "25:00"), (1, ["observation", "end"], "09:00"),
            (1, ["observation", "force_exit"], True), (1, ["stay", "clip_at_observation_end"], True),
            (1, ["stay", "minutes"], [240, 120]), (1, ["stay", "minutes"], [0, 1]),
            (1, ["stay", "minutes"], [120, float("nan")]), (1, ["stay", "includes_waiting"], False),
            (1, ["arrivals", "planned_total"], 11500), (1, ["arrivals", "observation_share"], 1),
            (1, ["arrivals", "slots", 0, "count"], -1), (1, ["arrivals", "slots", 0, "count"], True),
            (1, ["arrivals", "slots", 0, "share"], float("inf")),
            (1, ["arrivals", "slots", 1, "start"], "10:00"),
            (1, ["arrivals", "slots"], []), (1, ["arrivals"], {}),
            (2, ["tags", 0], "coast"), (2, ["profiles", 0, "preferences", "atlantis"], 6),
            (2, ["profiles", 0, "preferences", "atlantis"], True),
            (2, ["profiles", 0, "preferences", "atlantis"], float("nan")),
            (2, ["profiles"], []), (2, ["profiles", 0, "preferences"], {}),
            (2, ["behavior"], None), (2, ["behavior", "facility_weights"], {"atlantis": 1}),
            (2, ["behavior", "facility_weights", "atlantis"], 0),
            (2, ["behavior", "wait_patience_sim_s"], [1500, 300]),
            (2, ["behavior", "wait_patience_sim_s"], [False, 300]),
            (2, ["behavior", "repeat_weight"], 0), (2, ["behavior", "repeat_weight"], 1.01),
            (2, ["behavior", "time_cost_scale_sim_s"], 0),
        ]
        for group, keys, value in cases:
            with self.subTest(group=group, keys=keys, value=value), self.assertRaises(ValueError):
                validate(*change(group, keys, value))

    def test_legacy_preference_settings_without_behavior_still_validate(self):
        scenario = load_inputs()
        scenario.preferences.pop('behavior')
        scenario.preferences['profiles'] = scenario.preferences['profiles'][:1]
        validate(scenario.map, scenario.config, scenario.preferences)

    def test_custom_config_errors_and_hashes(self):
        scenario = load_inputs()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "custom.json"
            config = deepcopy(scenario.config)
            config["seed"] = 12
            path.write_text(json.dumps(config), encoding="utf-8")
            loaded = load_inputs(config_path=path)
            self.assertEqual(loaded.config["seed"], 12)
            self.assertEqual(loaded.metadata()["hashes"]["map"], scenario.metadata()["hashes"]["map"])
            self.assertEqual(loaded.ride_operations, scenario.ride_operations)
            self.assertNotEqual(loaded.metadata()["hashes"]["config"], scenario.metadata()["hashes"]["config"])
            for invalid in ('[]', '{', '{"scenario_id":"aquarium","schema_version":1}'):
                path.write_text(invalid, encoding="utf-8")
                with self.assertRaises(ValueError):
                    load_inputs(config_path=path)
            with self.assertRaises(ValueError):
                load_inputs(config_path=Path(directory) / "missing.json")

    def test_cli_requires_explicit_validation(self):
        result = subprocess.run([sys.executable, "-m", "lotteworld_sim.cli"], cwd=ROOT, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(b"Traceback", result.stderr)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "metadata.json"
            result = subprocess.run([sys.executable, "-m", "lotteworld_sim.cli", "--validate-only", "--output", str(output)], cwd=ROOT, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            metadata = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(metadata["status"], "map_ready")
            self.assertEqual(metadata["ride_operations"], load_inputs().ride_operations)
            self.assertEqual(metadata["continuous"], load_inputs().continuous)

    def test_invalid_continuous_settings(self):
        defaults = load_inputs().continuous
        cases = [
            ("seed", True), ("seed", -1), ("target_people", 0), ("target_people", 10001),
            ("initial_people", -1), ("initial_people", defaults["target_people"] + 1),
            ("admission_interval_sim_s", 0), ("admission_interval_sim_s", 1.5),
            ("stay_sim_s", [10800, 7200]), ("stay_sim_s", [True, 10800]), ("stay_sim_s", [60, 10**400]),
            ("time_scale", 0), ("time_scale", float("inf")), ("time_scale", "6"),
            ("schema_version", 2), ("scenario_id", "aquarium"), ("provenance", " "),
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / CONTINUOUS_PATH
            path.parent.mkdir()
            for key, value in cases:
                with self.subTest(key=key, value=value):
                    path.write_text(json.dumps({**defaults, key: value}), encoding="utf-8")
                    with self.assertRaises(ValueError):
                        load_continuous(directory)

    def test_course_section_count_validation(self):
        scenario = load_inputs()
        facilities = {row['id'] for row in scenario.map['facilities']}
        for invalid in (True, None, 0, 2.5, 121):
            ops = deepcopy(scenario.ride_operations)
            ops['facilities']['atlantis']['course_section_count'] = invalid
            with self.subTest(count=invalid), self.assertRaisesRegex(ValueError, 'course_section_count'):
                validate_ride_operations(ops, facilities)
        del ops['facilities']['atlantis']['course_section_count']
        validate_ride_operations(ops, facilities)

    def test_metadata_and_continuous_runtime_api(self):
        now = 0
        server = make_server(0, clock=lambda: now)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with urlopen(base + "/api/meta") as response:
                data = json.load(response)
            self.assertEqual(data["scenario_id"], "magic-island")
            self.assertTrue(data["runnable"])
            self.assertEqual(data["status"], "continuous_running")
            self.assertEqual(data["continuous"], load_inputs().continuous)
            self.assertIn("continuous", data["hashes"])
            self.assertNotIn("personas", data)
            operations = data["ride_operations"]["facilities"]
            expected = {
                "atlantis": (120, 20, 40, 30, 8, 2),
                "gyro-drop": (60, 25, 50, 135, 1, 1),
                "gyro-swing": (100, 25, 50, 175, 1, 1),
                "gyro-spin": (130, 40, 80, 250, 1, 1),
                "comet-express": (140, 30, 60, 230, 1, 1),
                "arcana-ride": (90, 20, 40, 150, 1, 1),
            }
            fields = ("ride_seconds", "unloading_seconds", "boarding_and_check_seconds",
                      "dispatch_interval_seconds", "vehicle_count", "station_capacity")
            self.assertEqual({key: tuple(value[field] for field in fields) for key, value in operations.items()}, expected)
            with urlopen(base) as response:
                self.assertIn("<h1>매직아일랜드</h1>", response.read().decode())
            self.assertEqual(data['map_view'], 'guide-map-3d')
            with urlopen(base + "/api/state") as response:
                state = json.load(response)
            self.assertEqual(state["status"], "continuous_running")
            self.assertEqual(state["clock"]["time_scale"], data["continuous"]["time_scale"])
            self.assertEqual(state["map_hash"], data["hashes"]["map"])
            self.assertEqual(state["ride_operations_hash"], data["hashes"]["ride_operations"])
            self.assertEqual(state["preferences_hash"], data["hashes"]["preferences"])
            self.assertEqual(set(state["rides"]), set(expected))
            people = state["background"]
            self.assertEqual(people["target_people"], data["continuous"]["target_people"])
            self.assertEqual(people["entered_total"], people["present_people"] + people["exited_total"])
            self.assertEqual(len(people["visitors"]), people["present_people"])
            self.assertEqual({key: queue['capacity'] for key, queue in people['queues'].items()},
                             {key: report['capacity'] for key, report in data['queue_report'].items()})
            self.assertTrue(all(len(visitor['point']) == 2 for visitor in people['visitors']))
            self.assertEqual({v['preference_profile_id'] for v in people['visitors']},
                             {profile['id'] for profile in data['preferences']['profiles']})
            self.assertTrue(all(v['completed_rides'] == {} for v in people['visitors']))
            now = 600 / data['continuous']['time_scale']
            server.service_actions()
            self.assertTrue(all(ride.dispatch_count >= 2 for ride in server.background.rides.values()))
            with urlopen(base + "/api/state") as response:
                running = json.load(response)
            self.assertEqual(running['run_id'], state['run_id'])
            self.assertTrue(all(ride['dispatch_count'] >= 2 for ride in running['rides'].values()))
            self.assertTrue(any(v['completed_rides'] for v in running['background']['visitors']))
            for asset in ('/navigation.mjs','/queue.mjs'):
                with urlopen(base+asset) as response:
                    self.assertIn('text/javascript',response.headers['Content-Type'])
            for asset, mime in (("/map.js", "text/javascript"), ("/map3d.js", "text/javascript"), ("/rides.mjs", "text/javascript"), ("/geometry.mjs", "text/javascript"), ("/route.mjs", "text/javascript"), ("/vendor/three/three.module.js", "text/javascript"), ("/vendor/three/three.core.js", "text/javascript"), ("/vendor/three/OrbitControls.js", "text/javascript"), ("/vendor/three/LICENSE", "text/plain"), ("/map.css", "text/css")):
                with urlopen(base + asset) as response:
                    self.assertIn(mime, response.headers["Content-Type"])
                    self.assertGreater(len(response.read()), 100)
            for forbidden in ("/../configs/map.json", "/%2e%2e/configs/map.json", "/scenario.py"):
                with self.assertRaises(HTTPError) as caught:
                    urlopen(base + forbidden)
                self.assertEqual(caught.exception.code, 404)
            for path in ("/api/signs", "/api/report", "/api/reset", "/api/advance", "/api/seek", "/configs/day.json", "/floorplan.svg"):
                request = Request(base + path, data=b"{}") if path in ("/api/reset", "/api/advance", "/api/seek") else base + path
                with self.subTest(path=path), self.assertRaises(HTTPError) as caught:
                    urlopen(request)
                self.assertEqual(caught.exception.code, 409 if path.startswith("/api/") else 404)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
