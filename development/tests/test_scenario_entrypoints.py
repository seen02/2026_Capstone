"""선택 진입점·독립 복사본·다른 시나리오 설정 거절의 통합 검증."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


class EntrypointTests(unittest.TestCase):
    def run_process(self, *args, cwd=ROOT):
        return subprocess.run([sys.executable, *args], cwd=cwd, capture_output=True)

    def test_selection_and_modes_from_outside_project(self):
        with tempfile.TemporaryDirectory() as directory:
            for scenario in ("aquarium", "magic-island"):
                for mode in ("server", "cli"):
                    with self.subTest(scenario=scenario, mode=mode):
                        result = self.run_process(str(ROOT / "run.py"), "--scenario", scenario, "--mode", mode, "--validate-only", cwd=directory)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(json.loads(result.stdout)["scenario_id"], scenario)
            for args in ([], ["--scenario", "unknown"], ["--scenario", "../aquarium"]):
                result = self.run_process(str(ROOT / "run.py"), *args, cwd=directory)
                self.assertNotEqual(result.returncode, 0)

    def test_cross_scenario_config_rejected(self):
        for scenario, config in (("aquarium", "lotteworld/configs/continuous.json"), ("magic-island", "aquarium/configs/day.json")):
            for mode in ("server", "cli"):
                result = self.run_process("run.py", "--scenario", scenario, "--mode", mode, "--config", config, "--validate-only")
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(b"Traceback", result.stderr)

    def test_relative_custom_paths_and_output(self):
        with tempfile.TemporaryDirectory() as directory:
            config = json.loads((ROOT / "lotteworld/configs/continuous.json").read_text(encoding="utf-8"))
            config["seed"] = 77
            (Path(directory) / "custom.json").write_text(json.dumps(config), encoding="utf-8")
            for config_args in (("--config", "custom.json"), ("--config=custom.json",)):
                result = self.run_process(str(ROOT / "run.py"), "--scenario", "magic-island", "--mode", "cli", "--validate-only", *config_args, "--output=result.json", cwd=directory)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads((Path(directory) / "result.json").read_text(encoding="utf-8"))["continuous"]["seed"], 77)

    def test_each_folder_runs_without_sibling(self):
        with tempfile.TemporaryDirectory() as directory:
            for folder, package in (("aquarium", "aquarium_sim"), ("lotteworld", "lotteworld_sim")):
                copy = Path(directory) / folder
                shutil.copytree(ROOT / folder, copy, ignore=shutil.ignore_patterns("__pycache__", "output", ".venv"))
                result = self.run_process("-m", f"{package}.server", "--validate-only", cwd=copy)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_servers_run_concurrently_with_independent_metadata(self):
        sys.path.insert(0, str(ROOT / "aquarium"))
        sys.path.insert(0, str(ROOT / "lotteworld"))
        from aquarium_sim.server import make_server as aquarium_server
        from lotteworld_sim.server import make_server as magic_server
        servers = [aquarium_server(0), magic_server(0)]
        threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in servers]
        for thread in threads:
            thread.start()
        try:
            def get(index, path):
                return urlopen(f"http://127.0.0.1:{servers[index].server_port}{path}")
            with get(0, "/api/meta") as response:
                aquarium = json.load(response)
            with get(1, "/api/meta") as response:
                magic = json.load(response)
            self.assertEqual(aquarium["scenario_id"], "aquarium")
            self.assertEqual(magic["scenario_id"], "magic-island")
            self.assertTrue(aquarium["runnable"])
            self.assertTrue(magic["runnable"])
            self.assertEqual(magic["status"], "continuous_running")
            self.assertEqual(aquarium["config"]["daily_visitors"], 1000)
            self.assertNotIn("config", magic)
            with get(0, "/api/state") as response:
                self.assertEqual(json.load(response)["metrics"]["inside"], 0)
            with get(0, "/") as response:
                self.assertIn("아쿠아리움", response.read().decode("utf-8"))
            with get(1, "/api/state") as response:
                state = json.load(response)
                self.assertEqual(state["scenario_id"], magic["scenario_id"])
                self.assertEqual(state["map_hash"], magic["hashes"]["map"])
                self.assertEqual(state["background"]["target_people"], magic["continuous"]["target_people"])
                self.assertEqual(set(state["background"]["queues"]), set(magic["queue_report"]))
        finally:
            for server in servers:
                server.shutdown()
                server.server_close()
            for thread in threads:
                thread.join()


if __name__ == "__main__":
    unittest.main()
