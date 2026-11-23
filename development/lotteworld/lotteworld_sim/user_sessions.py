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
from .scenario import QR_SIGN_ID as SIGN_ID, SCENARIO_ID

PLACEMENT_RADIUS_M = 12
PLACEMENT_SPACING_M = 2
SESSION_IDLE_TIMEOUT = timedelta(minutes=5)


def sign_position_metadata(map_data, map_hash, sign_id):
    return {"sign_id": sign_id, "map_hash": map_hash,
            "position": {"point": list(map_data["geometry"]["signposts"][sign_id]["point"]), "node_id": None}}


def initial_positions(policy):
    sign_point = policy.map["geometry"]["signposts"][SIGN_ID]["point"]
    require(public_walkable(policy.map, sign_point, 0.75, ignore_signpost=SIGN_ID),
            "표지판이 현재 지도의 공공 보행 구역에 있지 않습니다.", "sign_unavailable")

    x, y = sign_point
    offsets = range(-PLACEMENT_RADIUS_M, PLACEMENT_RADIUS_M + 1, PLACEMENT_SPACING_M)
    positions = []
    for dx in offsets:
        for dy in offsets:
            offset = math.hypot(dx, dy)
            if not PLACEMENT_SPACING_M <= offset <= PLACEMENT_RADIUS_M:
                continue
            point = [x + dx, y + dy]
            steps = math.ceil(offset / 0.5)
            # 배정 위치는 기둥을 피하고, 안내판까지 이어지는 포장 여부를 확인할 때는 기둥 자체만 제외한다.
            if public_walkable(policy.map, point, 0.75) and all(public_walkable(policy.map, [
                point[axis] + (sign_point[axis] - point[axis]) * step / steps for axis in range(2)
            ], 0.75, ignore_signpost=SIGN_ID) for step in range(1, steps)):
                positions.append((offset, point))
    require(bool(positions), "현재 지도에서 캐릭터의 초기 위치를 배치할 수 없습니다.", "sign_unavailable")
    return [point for _, point in sorted(positions)]


class UserSessions:
    def __init__(self, metadata, background):
        self.background = background
        self.lock = Lock()
        self.policy = RecommendationPolicy(metadata, sign_facilities=metadata['map']['geometry']['signposts'][SIGN_ID]['facility_ids'])
        self.context = {"scenario_id": SCENARIO_ID, "map_hash": background.map_hash,
                        "run_id": background.run_id, "timeline_epoch": 0}
        self.sessions = {}
        self.positions = None
        self.snapshot_seq = 0

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
            character.update({key: visit[key] for key in
                              ("walk_trail", "map_point", "queue_position", "queue_wait_sim_s", "vehicle_id")})
        return character

    def _retire_walk(self, session):
        walk = session["walk"]
        if walk and not walk.get("retired"):
            self.background.retire_qr_visit(session["character_id"])
            walk["retired"] = True

    def _retire_expired(self, now):
        for session in self.sessions.values():
            if now >= timestamp(session["expires_at"], "expires_at"):
                self._retire_walk(session)

    def retire_expired(self):
        with self.lock:
            self._retire_expired(datetime.now(timezone.utc))

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
                            if key not in ("route_preview", "offer", "walk", "accepted_commands",
                                           "completed_facilities", "last_completed_facility")},
                "character": self._character(session, visit),
                "offer": session["offer"] if session["phase"] == "ready" else None,
                "time_scale": self.background.time_scale,
                "sign": sign_position_metadata(self.policy.map, self.context["map_hash"], SIGN_ID),
                "facilities": [{"facility_id": facility, "name": names[facility]}
                               for facility in self.policy.ranked_facilities]}

    def _get(self, token, now=None):
        session = self.sessions.get(token)
        require(session is not None, "QR 진입 주소에서 세션을 연결해 주세요.", "session_required")
        if now is None:
            now = datetime.now(timezone.utc)
        require(now < timestamp(session["expires_at"], "expires_at"),
                "세션이 만료되었습니다. QR 진입 주소를 다시 열어 주세요.", "session_expired")
        return session

    def _resume(self, session, now):
        session["expires_at"] = utc_text(now + SESSION_IDLE_TIMEOUT)
        return self._response(session)

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
                return self._resume(self.sessions[token], now), token

            if self.positions is None:
                self.positions = initial_positions(self.policy)
            occupied = {tuple(session["position"]["point"]) for session in self.sessions.values()}
            point = next((point for point in self.positions if tuple(point) not in occupied), None)
            require(point is not None, "표지판 주변의 가상 배치가 가득 찼습니다.", "placement_full")
            session = {"session_id": f"session-{uuid4().hex}", "character_id": f"character-{uuid4().hex}",
                       "revision": 0, "phase": "awaiting_preferences", "preference_order": [],
                       "created_at": utc_text(now), "expires_at": utc_text(now + SESSION_IDLE_TIMEOUT),
                       "position": {"point": point, "node_id": None},
                       "position_sim_time_s": self.background.current_sim_time(),
                       "active_visit_id": None, "route_preview": None, "offer": None, "walk": None,
                       "accepted_commands": {}, "completed_facilities": frozenset(), "last_completed_facility": None}
            token = secrets.token_urlsafe(32)
            self.sessions[token] = session
            return self._response(session), token

    def get(self, token):
        with self.lock:
            now = datetime.now(timezone.utc)
            return self._resume(self._get(token, now), now)

    def end(self, token, request):
        fields(request, "request", "contract_version", "session_id")
        check_version(request["contract_version"])
        session_id = request["session_id"]
        identifier(session_id, "session_id")
        with self.lock:
            if (session := self.sessions.get(token)) is not None:
                require(session_id == session["session_id"],
                        "연결된 세션이 변경되었습니다. 페이지를 새로고침해 주세요.", "session_mismatch")
                self._retire_walk(session)
                del self.sessions[token]
        return {"contract_version": VERSION, "status": "ended"}

    def save_preferences(self, token, request):
        fields(request, "request", "contract_version", "context", "session_id", "expected_revision", "preference_order")
        check_version(request["contract_version"])
        expected = request["expected_revision"]
        require(type(expected) is int and expected >= 0, "expected_revision 값은 음이 아닌 정수여야 합니다.")
        with self.lock:
            session = self._finished_session(self._get(token))
            require(self.policy.context(request["context"]) == self.context,
                    "현재 실행과 요청의 문맥이 다릅니다.", "context_mismatch")
            require(request["session_id"] == session["session_id"],
                    "연결된 세션이 변경되었습니다. 페이지를 새로고침해 주세요.", "session_mismatch")
            require(session["phase"] in ("awaiting_preferences", "ready", "completed"),
                    "현재 세션에서 선호를 입력할 수 없습니다.", "session_not_ready")
            order = request["preference_order"]
            self.policy.preference_order(order)
            revision = session["revision"]
            order_changed = order != session["preference_order"]
            if session["phase"] != "completed" and not order_changed and expected in (revision, revision - 1):
                return self._response(session)
            require(expected == revision, "이미 선호 순위가 변경되었습니다. 페이지를 새로고침해 주세요.", "revision_mismatch")
            updated = {**session, "phase": "ready", "preference_order": order, "revision": revision + 1,
                       "route_preview": None, "offer": None, "walk": None}
            if order_changed:
                updated["completed_facilities"] = frozenset()
            try:
                result = self._recommend(updated)
            except RecommendationError:
                # 추천을 계산할 수 없는 동안에도 세션과 저장한 선호는 유지한다.
                pass
            else:
                self._store_offer(updated, result)
            self._store_ready_session(token, session, updated)
            return self._response(updated)

    def _finished_session(self, session):
        if session["walk"]:
            visit = self.background.qr_visit_state(session["character_id"])
            if visit["phase"] == "completed":
                facility = visit["facility_id"]
                completed = session["completed_facilities"] | {facility}
                if len(completed) == len(self.policy.ranked_facilities):
                    completed = frozenset()
                return {**self._positioned(session, visit), "completed_facilities": completed,
                        "last_completed_facility": facility}
        return session

    def _store_ready_session(self, token, before, updated):
        if before["phase"] == "completed":
            self.background.retire_qr_visit(before["character_id"])
        self.sessions[token] = updated

    def _recommend(self, session):
        position = session["position"]
        paths = self.background.routes.entrances_from_point(position["point"], self.policy.ranked_facilities)
        routes = []
        for facility, target in self.policy.entrances.items():
            path = paths.get(facility)
            routes.append({
                "facility_id": facility, "origin": position, "target_node_id": target,
                "status": "reachable" if path else "unavailable",
                "points": [list(point) for point in path.points] if path else [],
                "distance_m": path.length if path else None,
                "method": "public-visibility-v1", "walking_seconds": None,
            })
        sim_time, facilities = self.background.recommendation_observation()
        stamp = utc_text(datetime.now(timezone.utc))
        self.snapshot_seq += 1
        data = {
            "contract_version": VERSION, "context": self.context, "evaluation_at": stamp,
            "policy_id": self.policy.policy_id, "session": {**session, "position_sim_time_s": sim_time},
            "routes": routes,
            "snapshot": {
                "snapshot_seq": self.snapshot_seq, "generated_at": stamp,
                "source": {"kind": "simulation", "provider_id": "simulation-queue-v1"},
                "clock": {"sim_time_s": sim_time, "time_scale": self.background.time_scale, "mode": "running"},
                "facilities": [{**row, "observed_at": stamp, "as_of_sim_time_s": sim_time} for row in facilities],
            },
        }
        return self.policy.recommend(
            data,
            completed_facilities=session["completed_facilities"],
            last_completed_facility=session["last_completed_facility"],
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
            session = self._finished_session(self._get(token))
            if session["phase"] == "completed":
                ready = {**session, "phase": "ready", "revision": session["revision"] + 1,
                         "route_preview": None, "offer": None, "walk": None}
                offer = self._recommend(ready)
                self._store_offer(ready, offer)
                self._store_ready_session(token, session, ready)
                return offer
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
            if accepted := session["accepted_commands"].get(command["command_id"]):
                require(accepted["command"] == command, "같은 수락 요청 번호에 다른 내용이 들어 있습니다.", "idempotency_conflict")
                return accepted["response"]
            if session["walk"]:
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
            self.background.start_qr_visit(session["character_id"], rec["facility_id"], path)
            session["accepted_commands"][command["command_id"]] = {"command": command, "response": response}
            self.sessions[token] = {**session, "phase": "moving", "active_visit_id": visit_id,
                                    "revision": revision, "walk": {"retired": False}, "offer": None}
            return response
