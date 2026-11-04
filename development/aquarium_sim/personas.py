"""기존 매핑 공급자·캐시 구조를 관람 선호로 이식. 기본 공급자는 규칙 기반."""
from pathlib import Path
import json
from typing import Protocol
from .hashing import sha256_value

TAGS = ("coast", "coral", "deep", "jellyfish", "freshwater", "interactive")
PROFILES = [
    {"id":"explorer","name":"탐구형","color":"#56cfc1","preferences":{"deep":2.5,"freshwater":2.2}},
    {"id":"animal","name":"해양동물 선호형","color":"#b69af7","preferences":{"coast":3.0,"coral":1.8}},
    {"id":"experience","name":"공연 선호형","color":"#ffba70","preferences":{"interactive":3.0,"coast":2.0,"coral":2.0}},
    {"id":"calm","name":"감상형","color":"#7faaf7","preferences":{"coral":2.0,"jellyfish":3.0}}
]


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
