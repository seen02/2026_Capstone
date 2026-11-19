"""매직아일랜드 지도·운영·선호·연속 시연 설정 계약."""
from dataclasses import dataclass
from hashlib import sha256
import json
import math
from pathlib import Path
import re
from .map_geometry import validate_geometry
from .queue_capacity import validate_queue_capacity, queue_report

ROOT = Path(__file__).resolve().parents[1]
RIDE_OPERATIONS_PATH = Path("configs/ride-operations.json")
CONTINUOUS_PATH = Path("configs/continuous.json")
SCENARIO_ID = "magic-island"
FACILITIES = {"atlantis", "gyro-drop", "gyro-swing", "gyro-spin", "comet-express", "arcana-ride"}
MAP_READY = "매직아일랜드 설정 검증을 마쳤습니다. 연속 유입을 실행하려면 서버를 시작하세요."
DEFAULT_PREFERENCE_BEHAVIOR = {
    "facility_weights": dict.fromkeys(FACILITIES, 1),
    "wait_patience_sim_s": (300, 1500),
    "repeat_weight": 0.25,
    "time_cost_scale_sim_s": 300,
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value, minimum, maximum):
    return type(value) in (int, float) and minimum <= value <= maximum and math.isfinite(value)


def integer(value, minimum=0):
    return type(value) is int and value >= minimum


def clock(value):
    require(isinstance(value, str) and re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value), "시각은 HH:MM 형식이어야 합니다.")
    hour, minute = map(int, value.split(":"))
    return hour * 60 + minute


def read_json(path):
    def reject_constant(value):
        raise ValueError(f"유한하지 않은 JSON 값입니다: {value}")
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"), parse_constant=reject_constant)
    except (OSError, ValueError) as exc:
        raise ValueError(f"설정 JSON을 읽을 수 없습니다: {path}") from exc
    require(isinstance(data, dict), "설정은 JSON 객체여야 합니다.")
    require(type(data.get("schema_version")) is int and data["schema_version"] == 1, "지원하는 설정 스키마는 1입니다.")
    require(data.get("scenario_id") == SCENARIO_ID, "매직아일랜드 전용 설정이 필요합니다.")
    return data


def validate(map_data, config, preferences):
    """전체 묶음의 교차 참조와 합계를 검사하고 읽기 쉬운 오류로 정규화한다."""
    try:
        for data in (map_data, config, preferences):
            require(type(data["schema_version"]) is int and data["schema_version"] == 1 and data["scenario_id"] == SCENARIO_ID, "설정의 시나리오·스키마가 일치하지 않습니다.")
            require(bool(data["provenance"]), "출처·가정 설명이 필요합니다.")
        facilities = map_data["facilities"]
        require(isinstance(facilities, list) and len(facilities) == 6, "6개 시설 목록이 필요합니다.")
        require({f["id"] for f in facilities} == FACILITIES and all(isinstance(f["name"], str) and f["name"].strip() for f in facilities), "시설 ID·이름이 올바르지 않습니다.")
        validate_geometry(map_data, require, number)
        validate_queue_capacity(map_data, require, number)
        require(integer(config["seed"]), "시드는 0 이상의 정수여야 합니다.")
        observation, stay, arrivals = config["observation"], config["stay"], config["arrivals"]
        start, end = clock(observation["start"]), clock(observation["end"])
        require(start < end, "관측 시작은 종료보다 빨라야 합니다.")
        require(observation["end_event"] == "world_of_light" and observation["force_exit"] is False, "관측 종료는 월드 오브 라이트이며 강제 퇴장이 아닙니다.")
        require(stay["distribution"] == "uniform" and stay["starts_at"] == "actual_entry" and stay["includes_waiting"] is True and stay["clip_at_observation_end"] is False, "체류는 실제 진입부터 대기를 포함하며 관측 종료로 잘라내지 않습니다.")
        minutes = stay["minutes"]
        require(isinstance(minutes, list) and len(minutes) == 2 and all(number(v, 1, 1440) for v in minutes) and minutes[0] <= minutes[1], "체류 범위는 양수의 오름차순 분 단위 두 값이어야 합니다.")
        require(arrivals["model"] == "fixed_hourly_counts" and arrivals["within_slot"] == "uniform_seconds", "시간별 고정 인원·구간 내 초 단위 균등 배분 설정이 필요합니다.")
        baseline, total, share = arrivals["daily_baseline"], arrivals["planned_total"], arrivals["observation_share"]
        require(integer(baseline, 1) and integer(total) and number(share, 0, 1), "계획 인원·비중이 올바르지 않습니다.")
        require(math.isclose(baseline * share, total, rel_tol=0, abs_tol=1e-7), "하루 기준 인원×관측 비중과 계획 합계가 다릅니다.")
        cursor, counts, shares = start, 0, 0.0
        slots = arrivals["slots"]
        require(isinstance(slots, list) and bool(slots), "시간별 유입 목록이 필요합니다.")
        for slot in slots:
            a, b = clock(slot["start"]), clock(slot["end"])
            require(a == cursor and b - a == 60 and b <= end, "시간 구간은 관측 범위를 빈틈·중복 없이 한 시간씩 채워야 합니다.")
            count, weight = slot["count"], slot["share"]
            require(integer(count) and number(weight, 0, 1), "시간별 인원은 음수가 아닌 정수, 비중은 0~1이어야 합니다.")
            require(math.isclose(baseline * weight, count, rel_tol=0, abs_tol=1e-7), "시간별 인원과 하루 기준 비중이 다릅니다.")
            cursor, counts, shares = b, counts + count, shares + weight
        require(cursor == end and counts == total and math.isclose(shares, share, rel_tol=0, abs_tol=1e-9), "시간별 유입의 범위·인원·비중 합계가 관측 설정과 다릅니다.")
        tags, profiles = preferences["tags"], preferences["profiles"]
        require(preferences["status"] == "provisional", "선호 설정은 시연용 가정 상태여야 합니다.")
        require(isinstance(tags, list) and len(tags) == 6 and set(tags) == FACILITIES, "선호 태그는 지도 시설 6개와 일치해야 합니다.")
        require(isinstance(profiles, list) and bool(profiles), "선호 유형이 하나 이상 필요합니다.")
        ids = set()
        for profile in profiles:
            pid, values = profile["id"], profile["preferences"]
            require(isinstance(pid, str) and bool(pid) and pid not in ids, "선호 유형 ID가 없거나 중복됩니다.")
            require(isinstance(profile["name"], str) and bool(profile["name"].strip()), "선호 유형 이름이 필요합니다.")
            require(isinstance(values, dict) and set(values) == set(tags) and all(number(v, 0, 5) for v in values.values()), "모든 시설의 선호는 0~5의 유한한 숫자여야 합니다.")
            ids.add(pid)
        behavior = preferences.get("behavior", DEFAULT_PREFERENCE_BEHAVIOR)
        require(isinstance(behavior, dict), "방문객 행동 설정은 객체여야 합니다.")
        weights = behavior["facility_weights"]
        require(isinstance(weights, dict) and weights.keys() == FACILITIES
                and all(number(v, 0.01, 10) for v in weights.values()), "시설별 가중치는 0.01~10이어야 합니다.")
        patience = behavior["wait_patience_sim_s"]
        require(isinstance(patience, (list, tuple)) and len(patience) == 2
                and all(number(v, 1, 86400) for v in patience) and patience[0] <= patience[1],
                "대기 허용 시간은 1~86400 내부 초의 오름차순 두 값이어야 합니다.")
        require(number(behavior["repeat_weight"], 0.01, 1), "재탑승 가중치는 0.01~1이어야 합니다.")
        require(number(behavior["time_cost_scale_sim_s"], 1, 3600), "이동·대기 비용 기준은 1~3600 내부 초여야 합니다.")
    except (KeyError, TypeError, AttributeError, IndexError) as exc:
        raise ValueError("설정의 필수 항목이 없거나 자료형이 올바르지 않습니다.") from exc


def validate_ride_operations(operations, facility_ids):
    facilities = operations.get("facilities")
    require(isinstance(facilities, dict) and facilities.keys() == facility_ids,
            "운행 설정의 시설 ID는 지도 시설 6개와 일치해야 합니다.")
    require(bool(operations.get("provenance")), "운행 설정의 출처·가정 설명이 필요합니다.")
    fields = {
        "ride_seconds": 1,
        "unloading_seconds": 0,
        "boarding_and_check_seconds": 0,
        "dispatch_interval_seconds": 1,
        "vehicle_count": 1,
        "station_capacity": 1,
    }
    for facility_id, operation in facilities.items():
        require(isinstance(operation, dict), f"{facility_id} 운행 설정은 객체여야 합니다.")
        for field, minimum in fields.items():
            require(integer(operation.get(field), minimum),
                    f"{facility_id}의 {field} 값은 {minimum} 이상의 정수여야 합니다.")
        sections = operation.get("course_section_count", 1)
        require(integer(sections, 1) and sections <= operation["ride_seconds"],
                f"{facility_id}의 course_section_count 값은 1 이상이고 운행 초 이하여야 합니다.")


def load_continuous(root):
    config = read_json(Path(root) / CONTINUOUS_PATH)
    provenance = config.get("provenance")
    require(isinstance(provenance, str) and bool(provenance.strip()), "연속 시연 설정의 출처·가정 설명이 필요합니다.")
    require(integer(config.get("seed")), "연속 시연 시드는 0 이상의 정수여야 합니다.")
    target, initial = config.get("target_people"), config.get("initial_people")
    require(integer(target, 1) and target <= 10000, "목표 인원은 1~10000명의 정수여야 합니다.")
    require(integer(initial) and initial <= target, "초기 인원은 0명 이상이고 목표 인원 이하여야 합니다.")
    interval = config.get("admission_interval_sim_s")
    require(integer(interval, 1) and interval <= 3600, "입장 간격은 1~3600 내부 초의 정수여야 합니다.")
    stay = config.get("stay_sim_s")
    require(isinstance(stay, list) and len(stay) == 2 and all(number(v, 60, 86400) for v in stay)
            and stay[0] <= stay[1], "체류 범위는 60~86400 내부 초의 오름차순 두 값이어야 합니다.")
    require(number(config.get("time_scale"), 0.1, 60), "내부 시간 배속은 0.1~60이어야 합니다.")
    return config


@dataclass(frozen=True)
class Scenario:
    map: dict
    config: dict
    preferences: dict
    ride_operations: dict
    continuous: dict

    def metadata(self):
        parts = {"map": self.map, "config": self.config, "preferences": self.preferences,
                 "ride_operations": self.ride_operations, "continuous": self.continuous}
        hashes = {key: sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False).encode("utf-8")).hexdigest() for key, value in parts.items()}
        return dict(scenario_id=SCENARIO_ID, name="롯데월드 매직아일랜드", status="map_ready", map_ready=True, map_view="guide-map-3d",
                    runnable=False, message=MAP_READY, hashes=hashes, queue_report=queue_report(self.map), **parts)


def load_inputs(root=ROOT, config_path=None, *, continuous=None):
    root = Path(root)
    scenario = Scenario(read_json(root / "configs/map.json"),
                        read_json(config_path or root / "configs/day.json"),
                        read_json(root / "configs/preferences.json"),
                        read_json(root / RIDE_OPERATIONS_PATH),
                        load_continuous(root) if continuous is None else continuous)
    validate(scenario.map, scenario.config, scenario.preferences)
    validate_ride_operations(scenario.ride_operations, {facility["id"] for facility in scenario.map["facilities"]})
    return scenario
