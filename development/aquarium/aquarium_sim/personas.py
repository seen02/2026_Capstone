"""기존 매핑 공급자·캐시 구조를 관람 선호로 이식. 기본 공급자는 규칙 기반."""
from pathlib import Path
import json
from typing import Protocol
from .hashing import sha256_value

def load_preferences(path=None):
    path = Path(path or Path(__file__).resolve().parents[1] / "configs/preferences.json")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        tags, profiles = data["tags"], data["profiles"]
        if data["scenario_id"] != "aquarium" or type(data["schema_version"]) is not int or data["schema_version"] != 1:
            raise ValueError("아쿠아리움 전용 선호 설정이 필요합니다.")
        if not isinstance(tags, list) or len(tags) != 6 or set(tags) != {"coast", "coral", "deep", "jellyfish", "freshwater", "interactive"}:
            raise ValueError("아쿠아리움 전시 태그 6개가 필요합니다.")
        if not isinstance(profiles, list) or not profiles:
            raise ValueError("아쿠아리움 선호 유형이 필요합니다.")
        ids = set()
        for profile in profiles:
            if not isinstance(profile["id"], str) or not profile["id"] or profile["id"] in ids or not profile["name"] or not profile["color"]:
                raise ValueError("아쿠아리움 선호 유형 ID·이름·색상을 확인하세요.")
            ids.add(profile["id"])
            values = profile["preferences"]
            if not isinstance(values, dict) or not set(values) <= set(tags) or any(type(v) not in (int, float) or not 0 <= v <= 5 for v in values.values()):
                raise ValueError("아쿠아리움 선호 값은 전시 태그별 0~5여야 합니다.")
        return tuple(tags), profiles
    except (OSError, KeyError, TypeError) as exc:
        raise ValueError("아쿠아리움 선호 설정을 읽을 수 없습니다.") from exc


TAGS, PROFILES = load_preferences()


class PreferenceProvider(Protocol):
    source_name: str
    def map(self, profile: dict, scenario_context: dict) -> dict: ...


def validate_preferences(data):
    if set(data) != set(TAGS):
        raise ValueError("모든 전시 선호 항목이 필요합니다.")
    if any(type(v) not in (int,float) or not 0 <= v <= 5 for v in data.values()):
        raise ValueError("선호 값은 0~5의 유한한 숫자여야 합니다.")
    return data


class RuleProvider:
    source_name = "rule_baseline"
    def map(self, profile, scenario_context):
        return validate_preferences({tag:profile["preferences"].get(tag,1.0) for tag in TAGS})


class JsonCache:
    """ai-persona/llm/common.py의 입력·모델·정책 버전별 캐시를 수정 이식."""
    def __init__(self, directory: Path):
        self.directory = directory

    def key(self, *, profile, scenario_context, provider, model, settings):
        return sha256_value(dict(profile=profile,scenario_context=scenario_context,
                                provider=provider,model=model,settings=settings,
                                prompt_version="aquarium-1",schema_version="1"))

    def get(self, key):
        path = self.directory / f"{key}.json"
        return validate_preferences(json.loads(path.read_text(encoding="utf-8"))) if path.exists() else None

    def put(self, key, mapping):
        self.directory.mkdir(parents=True, exist_ok=True)
        (self.directory/f"{key}.json").write_text(json.dumps(validate_preferences(mapping),ensure_ascii=False),encoding="utf-8")
