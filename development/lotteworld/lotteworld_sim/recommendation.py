"""추천 v1 입력 검증과 결정적 추천 계산."""
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import math
import re
from sys import float_info

from .map_geometry import public_walkable
from .scenario import SCENARIO_ID, integer

VERSION = "recommendation.v1"
POLICY = "baseline-v1"
SIGN_POLICY = "sign-baseline-v1"
MAX_AGE = timedelta(seconds=30)
MAX_SIM_AGE = 300
CONTEXT_FIELDS = ("scenario_id", "map_hash", "run_id", "timeline_epoch")
ACTIVE_PHASES = ("moving", "queued", "riding")
UTC_TIMESTAMP = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|\+00:00)")


class RecommendationError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(condition, message, code="invalid_input"):
    if not condition:
        raise RecommendationError(code, message)


def fields(value, label, *required):
    require(isinstance(value, dict), f"{label} 값은 객체여야 합니다.")
    for key in required:
        require(key in value, f"{label}.{key} 값이 필요합니다.")
    return value


def enum(value, label, *choices):
    require(value in choices, f"{label} 값이 지원 범위에 없습니다.")


def identifier(value, label):
    require(isinstance(value, str) and bool(value.strip()) and not re.search(r"[\ud800-\udfff]", value),
            f"{label} 값은 비어 있지 않은 올바른 문자열이어야 합니다.")


def quantity(value, label, *, positive=False):
    # int를 float로 변환하기 전에 범위를 확인해 큰 JSON 정수도 오류로 처리한다.
    require(type(value) in (int, float) and 0 <= value <= float_info.max
            and (not positive or value > 0), f"{label} 값은 유효한 범위의 유한한 수여야 합니다.")


def timestamp(value, label):
    require(isinstance(value, str) and UTC_TIMESTAMP.fullmatch(value), f"{label} 값은 UTC 시각이어야 합니다.")
    try:
        return datetime.fromisoformat(value)
    except ValueError as error:
        raise RecommendationError("invalid_input", f"{label} 값이 유효한 날짜·시각이 아닙니다.") from error


def utc_text(value):
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def check_version(value):
    require(value == VERSION, "지원하지 않는 추천 계약 버전입니다.", "unsupported_version")


class RecommendationPolicy:
    def __init__(self, metadata, *, sign_facilities=None):
        self.map = metadata["map"]
        self.map_hash = metadata["hashes"]["map"]
        self.nodes = {node["id"]: node["point"] for node in self.map["geometry"]["nodes"]}
        self.entrances = {facility["id"]: facility["entrance"] for facility in self.map["facilities"]}
        self.ranked_facilities = tuple(self.entrances if sign_facilities is None else sign_facilities)
        self.policy_id = POLICY if sign_facilities is None else SIGN_POLICY
        if sign_facilities is not None:
            require(len(self.ranked_facilities) == len(set(self.ranked_facilities)) == 3
                    and set(self.ranked_facilities) <= self.entrances.keys(),
                    "표지판에는 지도에 등록된 서로 다른 시설 세 곳이 필요합니다.")

    def context(self, value):
        fields(value, "context", *CONTEXT_FIELDS)
        identifier(value["run_id"], "context.run_id")
        require(integer(value["timeline_epoch"]), "context.timeline_epoch 값은 음이 아닌 정수여야 합니다.")
        require(value["scenario_id"] == SCENARIO_ID and value["map_hash"] == self.map_hash,
                "시나리오 또는 지도 버전이 일치하지 않습니다.", "context_mismatch")
        return {key: value[key] for key in CONTEXT_FIELDS}

    def point(self, value):
        require(isinstance(value, list) and len(value) == 2, "좌표는 [x, y] 배열이어야 합니다.")
        bounds = self.map["geometry"]["bounds"]
        for coordinate, limit in zip(value, bounds[2:]):
            quantity(coordinate, "좌표")
            require(coordinate <= limit, "좌표가 지도 범위를 벗어났습니다.")
        return value

    def position(self, value):
        fields(value, "position", "point", "node_id")
        point = self.point(value["point"])
        node = value["node_id"]
        if node is not None:
            identifier(node, "position.node_id")
            require(self.nodes.get(node) == point, "위치가 지도 노드의 좌표와 일치하지 않습니다.")
        return {"point": point, "node_id": node}

    def facility_rows(self, rows, label):
        require(isinstance(rows, list) and len(rows) == len(self.entrances), f"{label}에는 시설별로 한 행씩 필요합니다.")
        indexed = {}
        for row in rows:
            facility = fields(row, label, "facility_id")["facility_id"]
            identifier(facility, "facility_id")
            require(facility in self.entrances and facility not in indexed, f"{label} 시설 ID가 중복되거나 등록되지 않았습니다.")
            indexed[facility] = row
        return indexed

    def preference_order(self, order):
        require(isinstance(order, list) and all(isinstance(item, str) for item in order),
                "선호 순위는 시설 ID 배열이어야 합니다.")
        require(len(order) == len(self.ranked_facilities) and set(order) == set(self.ranked_facilities),
                "선호 입력 대상 시설을 모두 한 번씩 순위에 넣어 주세요.")

    def session(self, session, evaluation, sim_time):
        fields(session, "session", "session_id", "character_id", "revision", "created_at", "expires_at",
               "phase", "position", "position_sim_time_s", "preference_order", "active_visit_id")
        for key in ("session_id", "character_id"):
            identifier(session[key], f"session.{key}")
        require(integer(session["revision"]), "session.revision 값은 음이 아닌 정수여야 합니다.")
        created = timestamp(session["created_at"], "session.created_at")
        expires = timestamp(session["expires_at"], "session.expires_at")
        require(created <= evaluation and created < expires, "세션 생성·평가·만료 시각이 올바르지 않습니다.")
        phase = session["phase"]
        enum(phase, "session.phase", "awaiting_preferences", "ready", "ended", *ACTIVE_PHASES)
        visit = session["active_visit_id"]
        if phase in ACTIVE_PHASES or visit is not None:
            identifier(visit, "session.active_visit_id")
        require(phase not in ("ready", "awaiting_preferences") or visit is None, "대기 중인 세션에는 진행 중인 이용이 없어야 합니다.")
        order = session["preference_order"]
        if order != [] or phase not in ("awaiting_preferences", "ended"):
            self.preference_order(order)
        position = self.position(session["position"])
        position_time = session["position_sim_time_s"]
        quantity(position_time, "session.position_sim_time_s")
        require(position_time <= sim_time, "위치 시각이 현재 시뮬레이션 시각보다 늦습니다.")
        require(evaluation < expires and phase != "ended", "세션이 만료되었거나 종료되었습니다.", "session_expired")
        require(phase == "ready", "추천을 조회할 수 있는 세션 상태가 아닙니다.", "session_not_ready")
        require(sim_time - position_time <= MAX_SIM_AGE, "현재 위치가 오래되었습니다.", "position_stale")
        require(public_walkable(self.map, position["point"]), "추천 출발 위치는 공공 보행 구역이어야 합니다.")
        return position

    def facility(self, row, generated, evaluation, sim_time):
        fields(row, "facility", "observed_at", "as_of_sim_time_s", "operation", "admission", "queue_people", "riding_people", "wait")
        operation, admission = row["operation"], row["admission"]
        enum(operation, "operation", "open", "suspended", "closed", "unknown")
        enum(admission, "admission", "accepting", "full", "not_accepting", "unknown")
        require(operation == "open" or admission != "accepting", "운영 중인 시설만 합류를 받을 수 있습니다.")
        for key in ("queue_people", "riding_people"):
            require(row[key] is None or integer(row[key]), f"{key} 값은 음이 아닌 정수 또는 null이어야 합니다.")
        wait = fields(row["wait"], "wait", "status", "seconds", "method")
        status = wait["status"]
        enum(status, "wait.status", "known", "unknown", "stale", "not_applicable")
        if status == "known":
            quantity(wait["seconds"], "wait.seconds")
        else:
            require(wait["seconds"] is None, "미집계 또는 제시할 수 없는 대기는 초 값을 가질 수 없습니다.")
        if status == "known" or wait["method"] is not None:
            identifier(wait["method"], "wait.method")
        require(status != "not_applicable" or admission != "accepting", "합류 가능한 시설의 대기는 not_applicable일 수 없습니다.")

        observed, observed_sim = row["observed_at"], row["as_of_sim_time_s"]
        require((observed is None) == (observed_sim is None), "실제 관측 시각과 시뮬레이션 관측 시각을 함께 제공해야 합니다.")
        stale = False
        if observed is None:
            require(status == "unknown" and row["queue_people"] is None and row["riding_people"] is None,
                    "관측 시각이 없으면 인원과 예상 대기가 미집계여야 합니다.")
        else:
            observed = timestamp(observed, "observed_at")
            quantity(observed_sim, "as_of_sim_time_s")
            require(observed <= generated and observed_sim <= sim_time, "시설 관측 시각이 스냅샷 시각보다 늦습니다.")
            stale = evaluation - observed > MAX_AGE or sim_time - observed_sim > MAX_SIM_AGE

        codes = []
        if operation != "open":
            codes.append("operation_unavailable")
        if admission != "accepting":
            codes.append("admission_unavailable")
        if status == "unknown":
            codes.append("wait_unknown")
        if status == "stale":
            codes.append("wait_stale")
        if stale:
            codes.append("observation_stale")
        return codes

    def route(self, route, origin, target):
        fields(route, "route", "status", "origin", "target_node_id", "points", "distance_m", "method", "walking_seconds")
        status = route["status"]
        enum(status, "route.status", "reachable", "unreachable", "unavailable")
        identifier(route["method"], "route.method")
        require(self.position(route["origin"]) == origin, "경로 출발점이 세션 위치와 다릅니다.")
        require(route["target_node_id"] == target, "경로 도착 노드는 해당 시설 입구여야 합니다.")
        points = route["points"]
        if status == "reachable":
            require(isinstance(points, list) and len(points) >= 2, "연결된 경로에는 두 개 이상의 경유점이 필요합니다.")
            for point in points:
                self.point(point)
            require(points[0] == origin["point"] and points[-1] == self.nodes[target], "경유점의 양 끝이 출발 위치·시설 입구와 달라서는 안 됩니다.")
            quantity(route["distance_m"], "route.distance_m")
            require(abs(sum(math.dist(a, b) for a, b in zip(points, points[1:])) - route["distance_m"]) <= 0.001,
                    "경로 거리와 경유점 거리의 합이 일치하지 않습니다.")
            if route["walking_seconds"] is not None:
                quantity(route["walking_seconds"], "route.walking_seconds")
        else:
            require(points == [] and route["distance_m"] is None and route["walking_seconds"] is None,
                    "사용할 수 없는 경로에는 거리·시간·경유점이 없어야 합니다.")

    def recommend(self, data, *, completed_facilities=frozenset(), last_completed_facility=None):
        """서버가 조립한 완전한 RecommendationInput으로 평가한다."""
        fields(data, "input", "contract_version", "context", "evaluation_at", "policy_id", "session", "snapshot", "routes")
        check_version(data["contract_version"])
        context = self.context(data["context"])
        require(data["policy_id"] == self.policy_id, "지원하지 않는 추천 정책입니다.")
        evaluation = timestamp(data["evaluation_at"], "evaluation_at")
        require(evaluation <= datetime.max.replace(tzinfo=timezone.utc) - MAX_AGE, "평가 시각에 만료 시간을 더할 수 없습니다.")
        snapshot = fields(data["snapshot"], "snapshot", "snapshot_seq", "generated_at", "source", "clock", "facilities")
        require(integer(snapshot["snapshot_seq"]), "snapshot_seq 값은 음이 아닌 정수여야 합니다.")
        source = fields(snapshot["source"], "source", "kind", "provider_id")
        enum(source["kind"], "source.kind", "mock", "simulation")
        identifier(source["provider_id"], "source.provider_id")
        clock = fields(snapshot["clock"], "clock", "sim_time_s", "time_scale", "mode")
        quantity(clock["sim_time_s"], "clock.sim_time_s")
        quantity(clock["time_scale"], "clock.time_scale", positive=True)
        enum(clock["mode"], "clock.mode", "running", "paused", "ended")
        generated = timestamp(snapshot["generated_at"], "snapshot.generated_at")
        require(generated <= evaluation, "스냅샷 발행 시각이 평가 시각보다 늦습니다.")
        require(clock["mode"] != "ended", "종료된 실행에서는 추천할 수 없습니다.", "run_ended")
        require(evaluation - generated <= MAX_AGE, "시설 상태 스냅샷이 오래되었습니다.", "snapshot_stale")

        sim_time = clock["sim_time_s"]
        session = data["session"]
        position = self.session(session, evaluation, sim_time)
        facilities = self.facility_rows(snapshot["facilities"], "facilities")
        routes = self.facility_rows(data["routes"], "routes")
        candidates, excluded = [], []
        ranks = {facility: rank for rank, facility in enumerate(session["preference_order"], 1)}
        rank_span = len(self.ranked_facilities) - 1
        for facility in sorted(self.entrances):
            row, route = facilities[facility], routes[facility]
            codes = self.facility(row, generated, evaluation, sim_time)
            self.route(route, position, self.entrances[facility])
            if facility not in ranks:
                continue
            if route["status"] != "reachable":
                codes.append(f"route_{route['status']}")
            recently_completed = facility == last_completed_facility
            if recently_completed and not completed_facilities:
                codes.append("round_start_recent_ride")
            if codes:
                excluded.append({"facility_id": facility, "codes": codes})
                continue
            rank, seconds, distance = ranks[facility], row["wait"]["seconds"], route["distance_m"]
            cost = 0.5 * (rank - 1) / rank_span + 0.3 * min(seconds / 3600, 1) + 0.2 * min(distance / 500, 1)
            priority = (facility in completed_facilities, recently_completed)
            candidates.append((priority, math.floor(cost * 1e9 + 0.5) / 1e9, rank, seconds, distance, facility))

        result = {"contract_version": VERSION, "context": context, "result": "no_candidate",
                  "session_id": session["session_id"], "session_revision": session["revision"],
                  "snapshot_seq": snapshot["snapshot_seq"], "source": source, "policy_id": self.policy_id,
                  "evaluated_at": utc_text(evaluation), "recommendation": None, "excluded": excluded}
        if candidates:
            _, cost, rank, seconds, distance, facility = min(candidates)
            identity = [context, self.policy_id, session["session_id"], session["character_id"], session["revision"],
                        snapshot["snapshot_seq"], result["evaluated_at"], facility, rank, seconds, distance]
            recommendation_id = sha256(json.dumps(identity, sort_keys=True).encode("utf-8")).hexdigest()
            result["result"] = "recommended"
            result["recommendation"] = {
                "recommendation_id": recommendation_id, "facility_id": facility, "rank": rank,
                "wait_seconds": seconds, "distance_m": distance, "cost": cost, "route": routes[facility],
                "expires_at": utc_text(evaluation + MAX_AGE), "expires_sim_time_s": sim_time + MAX_SIM_AGE,
                "reason_codes": ["preference_wait_distance"],
                "reason_text": f"선호 {rank}순위, 예상 대기 {seconds:g}초, 가상 보행 경로 {distance:.1f}m를 함께 고려했습니다.",
            }
        return result
