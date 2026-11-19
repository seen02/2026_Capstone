"""QR 진입으로 발급한 세션과 초기 캐릭터 배치를 관리한다."""
from datetime import datetime, timedelta, timezone
import math
import secrets
from threading import Lock
from uuid import uuid4

from .map_geometry import public_walkable
from .recommendation import VERSION, check_version, fields, require, timestamp, utc_text

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
    def __init__(self, recommendation):
        self.recommendation = recommendation
        self.lock = Lock()
        self.context = None
        self.sessions = {}
        self.positions = None

    def _world(self):
        policy, context, sim_time = self.recommendation.user_world()
        if context != self.context:
            self.context = context
            self.sessions.clear()
            self.positions = None
        return policy, sim_time

    def _response(self, policy, session):
        names = {row["id"]: row["name"] for row in policy.map["facilities"]}
        return {"contract_version": VERSION, "context": self.context, "session": session,
                "sign": {"sign_id": SIGN_ID, "map_hash": self.context["map_hash"],
                         "position": {"point": list(SIGN_POINT), "node_id": None}},
                "facilities": [{"facility_id": facility, "name": names[facility]}
                               for facility in policy.ranked_facilities]}

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
            policy, sim_time = self._world()
            now = datetime.now(timezone.utc)
            self.sessions = {
                key: session for key, session in self.sessions.items()
                if now < timestamp(session["expires_at"], "expires_at")
            }
            if token in self.sessions:
                return self._response(policy, self.sessions[token]), None

            if self.positions is None:
                self.positions = initial_positions(policy)
            occupied = {tuple(session["position"]["point"]) for session in self.sessions.values()}
            point = next((point for point in self.positions if tuple(point) not in occupied), None)
            require(point is not None, "표지판 주변의 가상 배치가 가득 찼습니다.", "placement_full")
            session = {"session_id": f"session-{uuid4().hex}", "character_id": f"character-{uuid4().hex}",
                       "revision": 0, "phase": "awaiting_preferences", "preference_order": [],
                       "created_at": utc_text(now), "expires_at": utc_text(now + SESSION_LIFETIME),
                       "position": {"point": point, "node_id": None}, "position_sim_time_s": sim_time,
                       "active_visit_id": None}
            token = secrets.token_urlsafe(32)
            self.sessions[token] = session
            return self._response(policy, session), token

    def get(self, token):
        with self.lock:
            policy, _ = self._world()
            return self._response(policy, self._get(token))

    def save_preferences(self, token, request):
        fields(request, "request", "contract_version", "context", "session_id", "expected_revision", "preference_order")
        check_version(request["contract_version"])
        expected = request["expected_revision"]
        require(type(expected) is int and expected >= 0, "expected_revision 값은 음이 아닌 정수여야 합니다.")
        with self.lock:
            policy, _ = self._world()
            session = self._get(token)
            require(policy.context(request["context"]) == self.context,
                    "현재 실행과 요청의 문맥이 다릅니다.", "context_mismatch")
            require(request["session_id"] == session["session_id"],
                    "연결된 세션이 변경되었습니다. 페이지를 새로고침해 주세요.", "session_mismatch")
            require(session["phase"] in ("awaiting_preferences", "ready"),
                    "현재 세션에서 선호를 입력할 수 없습니다.", "session_not_ready")
            order = request["preference_order"]
            policy.preference_order(order)
            revision = session["revision"]
            if order == session["preference_order"] and expected in (revision, revision - 1):
                return self._response(policy, session)
            require(expected == revision, "이미 선호 순위가 변경되었습니다. 페이지를 새로고침해 주세요.", "revision_mismatch")
            updated = {**session, "phase": "ready", "preference_order": order, "revision": revision + 1}
            self.sessions[token] = updated
            return self._response(policy, updated)

    def recommend(self, token):
        with self.lock:
            self._world()
            session = self._get(token)
            require(session["phase"] == "ready", "선호 순위를 먼저 저장해 주세요.", "session_not_ready")
            return self.recommendation.recommend_for_user(self.context, session, ROUTE_ANCHOR)
