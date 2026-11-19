"""QR 세션, 추천 수락과 시뮬레이션 이용 상태를 관리한다."""
from datetime import datetime, timedelta, timezone
import math
import secrets
from threading import Lock
from uuid import uuid4

from .map_geometry import public_walkable
from .recommendation import (
    VERSION, RecommendationError, RecommendationPolicy, check_version, fields, identifier, require, timestamp, utc_text,
)
from .scenario import SCENARIO_ID

SIGN_ID = "magic-island-west"
SIGN_POINT = (101, 149)
SIGN_FACILITIES = ("gyro-spin", "comet-express", "gyro-drop")
ROUTE_ANCHOR = "west-center"
PLACEMENT_RADIUS_M = 12
PLACEMENT_SPACING_M = 2
SESSION_LIFETIME = timedelta(minutes=30)


def initial_positions(policy):
    sign_point = list(SIGN_POINT)
    anchor = policy.nodes.get(ROUTE_ANCHOR)
    require(anchor is not None and public_walkable(policy.map, sign_point, 0.75),
            "표지판이나 경로 연결 노드가 현재 지도에서 유효하지 않습니다.", "sign_unavailable")

    x, y = sign_point
    offsets = range(-PLACEMENT_RADIUS_M, PLACEMENT_RADIUS_M + 1, PLACEMENT_SPACING_M)
    positions = []
    for dx in offsets:
        for dy in offsets:
            offset = math.hypot(dx, dy)
            if not PLACEMENT_SPACING_M <= offset <= PLACEMENT_RADIUS_M:
                continue
            point = [x + dx, y + dy]
            steps = max(1, math.ceil(math.dist(point, anchor) / 0.5))
            # 0.5m 이내 간격의 검사점마다 여유를 두어 검사점 사이에도 보행 공간을 확보한다.
            if all(public_walkable(policy.map, [
                point[axis] + (anchor[axis] - point[axis]) * step / steps for axis in range(2)
            ], 0.75) for step in range(steps + 1)):
                positions.append((offset, point))
    require(bool(positions), "현재 지도에서 캐릭터의 초기 위치를 배치할 수 없습니다.", "sign_unavailable")
    return [point for _, point in sorted(positions)]


class UserSessions:
    def __init__(self, recommendation, metadata, background):
        self.recommendation = recommendation
        self.background = background
        self.lock = Lock()
        self.policy = RecommendationPolicy(metadata, sign_facilities=SIGN_FACILITIES)
        self.context = {"scenario_id": SCENARIO_ID, "map_hash": background.map_hash,
                        "run_id": background.run_id, "timeline_epoch": 0}
        self.sessions = {}
        self.positions = None

    @staticmethod
    def _positioned(session, visit):
        if visit is None:
            return session
        return {**session, **{key: visit[key] for key in ("phase", "position", "position_sim_time_s")},
                "revision": session["revision"] + visit["revision_delta"],
                "active_visit_id": None if visit["phase"] == "completed" else session["active_visit_id"]}

    @staticmethod
    def _character(session, visit):
        character = {key: session[key] for key in ("character_id", "revision", "phase", "position",
                                                   "position_sim_time_s", "route_preview")}
        if visit is not None:
            character.update({key: visit[key] for key in ("walk_trail", "map_point", "queue_position", "vehicle_id")})
        return character

    def _retire_expired(self, now):
        for session in self.sessions.values():
            walk = session["walk"]
            if walk and not walk.get("retired") and now >= timestamp(session["expires_at"], "expires_at"):
                self.background.retire_qr_visit(session["character_id"])
                walk["retired"] = True

    def engine_state(self):
        with self.lock:
            now = datetime.now(timezone.utc)
            self._retire_expired(now)
            snapshot = self.background.snapshot(with_motion=True, with_qr=True)
            visits = snapshot.pop("qr_visits")
            characters = []
            for session in self.sessions.values():
                if now < timestamp(session["expires_at"], "expires_at"):
                    visit = visits.get(session["character_id"])
                    characters.append(self._character(self._positioned(session, visit), visit))
            snapshot["qr"] = {"context": self.context, "characters": characters}
            return snapshot

    def _response(self, session):
        visit = self.background.qr_visit_state(session["character_id"]) if session["walk"] else None
        session = self._positioned(session, visit)
        names = {row["id"]: row["name"] for row in self.policy.map["facilities"]}
        return {"contract_version": VERSION, "context": self.context,
                "session": {key: value for key, value in session.items()
                            if key not in ("route_preview", "offer", "walk")},
                "character": self._character(session, visit),
                "offer": session["offer"] if session["phase"] == "ready" else None,
                "time_scale": self.background.time_scale,
                "sign": {"sign_id": SIGN_ID, "map_hash": self.context["map_hash"],
                         "position": {"point": list(SIGN_POINT), "node_id": None}},
                "facilities": [{"facility_id": facility, "name": names[facility]}
                               for facility in self.policy.ranked_facilities]}

    def _get(self, token):
        session = self.sessions.get(token)
        require(session is not None, "QR 진입 주소에서 세션을 연결해 주세요.", "session_required")
        require(datetime.now(timezone.utc) < timestamp(session["expires_at"], "expires_at"),
                "세션이 만료되었습니다. QR 진입 주소를 다시 열어 주세요.", "session_expired")
        return session

    def enter(self, token, request):
        fields(request, "request", "contract_version", "sign_id")
        check_version(request["contract_version"])
        require(request["sign_id"] == SIGN_ID, "등록되지 않은 표지판입니다.", "unknown_sign")
        with self.lock:
            now = datetime.now(timezone.utc)
            self._retire_expired(now)
            self.sessions = {
                key: session for key, session in self.sessions.items()
                if now < timestamp(session["expires_at"], "expires_at")
            }
            if token in self.sessions:
                return self._response(self.sessions[token]), None

            if self.positions is None:
                self.positions = initial_positions(self.policy)
            occupied = {tuple(session["position"]["point"]) for session in self.sessions.values()}
            point = next((point for point in self.positions if tuple(point) not in occupied), None)
            require(point is not None, "표지판 주변의 가상 배치가 가득 찼습니다.", "placement_full")
            session = {"session_id": f"session-{uuid4().hex}", "character_id": f"character-{uuid4().hex}",
                       "revision": 0, "phase": "awaiting_preferences", "preference_order": [],
                       "created_at": utc_text(now), "expires_at": utc_text(now + SESSION_LIFETIME),
                       "position": {"point": point, "node_id": None},
                       "position_sim_time_s": self.background.current_sim_time(),
                       "active_visit_id": None, "route_preview": None, "offer": None, "walk": None}
            token = secrets.token_urlsafe(32)
            self.sessions[token] = session
            return self._response(session), token

    def get(self, token):
        with self.lock:
            return self._response(self._get(token))

    def save_preferences(self, token, request):
        fields(request, "request", "contract_version", "context", "session_id", "expected_revision", "preference_order")
        check_version(request["contract_version"])
        expected = request["expected_revision"]
        require(type(expected) is int and expected >= 0, "expected_revision 값은 음이 아닌 정수여야 합니다.")
        with self.lock:
            session = self._get(token)
            require(self.policy.context(request["context"]) == self.context,
                    "현재 실행과 요청의 문맥이 다릅니다.", "context_mismatch")
            require(request["session_id"] == session["session_id"],
                    "연결된 세션이 변경되었습니다. 페이지를 새로고침해 주세요.", "session_mismatch")
            require(session["phase"] in ("awaiting_preferences", "ready"),
                    "현재 세션에서 선호를 입력할 수 없습니다.", "session_not_ready")
            order = request["preference_order"]
            self.policy.preference_order(order)
            revision = session["revision"]
            if order == session["preference_order"] and expected in (revision, revision - 1):
                return self._response(session)
            require(expected == revision, "이미 선호 순위가 변경되었습니다. 페이지를 새로고침해 주세요.", "revision_mismatch")
            updated = {**session, "phase": "ready", "preference_order": order, "revision": revision + 1,
                       "route_preview": None, "offer": None}
            try:
                result = self._recommend(updated)
            except RecommendationError:
                # 모의 공급자가 없어도 세션과 저장한 선호는 연속 실행에 남긴다.
                pass
            else:
                self._store_offer(updated, result)
            self.sessions[token] = updated
            return self._response(updated)

    def _recommend(self, session):
        return self.recommendation.recommend_for_user(
            self.context, session, ROUTE_ANCHOR,
            sim_time=self.background.current_sim_time(), time_scale=self.background.time_scale,
        )

    @staticmethod
    def _store_offer(session, result):
        session["offer"] = result
        rec = result["recommendation"]
        session["route_preview"] = {"facility_id": rec["facility_id"], "route": rec["route"],
                                    "source": result["source"]} if rec else None

    def _expired(self, offer):
        return (datetime.now(timezone.utc) >= timestamp(offer["expires_at"], "expires_at")
                or self.background.current_sim_time() >= offer["expires_sim_time_s"])

    def recommend(self, token):
        with self.lock:
            session = self._get(token)
            require(session["phase"] == "ready", "선호 순위를 먼저 저장해 주세요.", "session_not_ready")
            offer = session["offer"]
            if not offer or not offer["recommendation"] or self._expired(offer["recommendation"]):
                offer = self._recommend(session)
                self._store_offer(session, offer)
            return offer

    def accept(self, token, request):
        keys = ("context", "command_id", "session_id", "recommendation_id",
                "expected_session_revision", "expected_snapshot_seq")
        fields(request, "request", "contract_version", *keys)
        check_version(request["contract_version"])
        command = {key: request[key] for key in keys}
        command["context"] = self.policy.context(command["context"])
        for key in ("command_id", "session_id", "recommendation_id"):
            identifier(command[key], key)
        for key in ("expected_session_revision", "expected_snapshot_seq"):
            require(type(command[key]) is int and command[key] >= 0, f"{key} 값은 음이 아닌 정수여야 합니다.")
        with self.lock:
            session = self._get(token)
            require(command["context"] == self.context, "현재 실행과 요청의 문맥이 다릅니다.", "context_mismatch")
            require(command["session_id"] == session["session_id"], "요청과 연결된 세션이 다릅니다.", "session_mismatch")
            if walk := session["walk"]:
                if walk["command"]["command_id"] == command["command_id"]:
                    require(walk["command"] == command, "같은 수락 요청 번호에 다른 내용이 들어 있습니다.", "idempotency_conflict")
                    return walk["response"]
                raise RecommendationError("session_conflict", "이 세션에서 이미 추천을 수락했습니다.")
            require(session["phase"] == "ready", "선호 순위를 먼저 저장해 주세요.", "session_not_ready")
            require(session["revision"] == command["expected_session_revision"],
                    "추천 이후 선호 순위가 변경되었습니다.", "revision_mismatch")
            offer = session["offer"]
            rec = offer and offer["recommendation"]
            require(rec and rec["recommendation_id"] == command["recommendation_id"]
                    and offer["snapshot_seq"] == command["expected_snapshot_seq"],
                    "현재 표시된 추천을 갱신한 뒤 수락해 주세요.", "recommendation_invalidated")
            require(not self._expired(rec), "추천이 만료되었습니다. 새 추천을 확인해 주세요.", "recommendation_expired")
            current = self._recommend(session)
            if not current["recommendation"] or current["recommendation"]["route"] != rec["route"]:
                self._store_offer(session, current)
                raise RecommendationError("recommendation_invalidated", "시설 현황이나 경로가 변경되었습니다. 새 추천을 확인해 주세요.")
            route = rec["route"]
            path = self.background.routes.entrance_path(rec["facility_id"], route["points"])
            require(path and path.length > 0, "시설 입구까지 안전하게 걸을 경로를 확인할 수 없습니다.", "route_unavailable")
            require(rec["facility_id"] in self.background.rides, "시설 운행을 사용할 수 없습니다.", "engine_unavailable")
            visit_id = f"visit-{uuid4().hex}"
            revision = session["revision"] + 1
            response = {"contract_version": VERSION, "context": self.context, "command_id": command["command_id"],
                        "accepted": True, "phase": "moving", "visit_id": visit_id, "session_id": session["session_id"],
                        "session_revision": revision, "snapshot_seq": current["snapshot_seq"]}
            walk = {"command": command, "response": response}
            self.background.start_qr_visit(session["character_id"], rec["facility_id"], path)
            self.sessions[token] = {**session, "phase": "moving", "active_visit_id": visit_id,
                                    "revision": revision, "walk": walk, "offer": None}
            return response
