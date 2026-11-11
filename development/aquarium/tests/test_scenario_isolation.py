import json
from pathlib import Path
import tempfile
import unittest

from aquarium_sim.personas import PROFILES, TAGS, load_preferences
from aquarium_sim.server import load_inputs


class AquariumIsolationTests(unittest.TestCase):
    def test_existing_preference_values_are_preserved(self):
        self.assertEqual(tuple(TAGS), ("coast", "coral", "deep", "jellyfish", "freshwater", "interactive"))
        self.assertEqual([p["id"] for p in PROFILES], ["explorer", "animal", "experience", "calm"])
        self.assertEqual(PROFILES[0]["preferences"], {"deep": 2.5, "freshwater": 2.2})
        self.assertEqual(PROFILES[2]["preferences"], {"interactive": 3.0, "coast": 2.0, "coral": 2.0})
        self.assertEqual(load_inputs()[1]["daily_visitors"], 1000)

    def test_preferences_reject_wrong_scenario_tags_and_values(self):
        original = json.loads((Path(__file__).resolve().parents[1] / "configs/preferences.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "preferences.json"
            for key, value in (("scenario_id", "magic-island"), ("tags", ["atlantis"]), ("profiles", [])):
                invalid = dict(original, **{key: value})
                path.write_text(json.dumps(invalid), encoding="utf-8")
                with self.assertRaises(ValueError):
                    load_preferences(path)
            original["profiles"][0]["preferences"]["deep"] = float("nan")
            path.write_text(json.dumps(original), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_preferences(path)
