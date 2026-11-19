"""로컬 모의 상태·경로로 추천 입력을 만드는 공급자."""
from datetime import datetime, timedelta, timezone
import math
from pathlib import Path
import threading
import time
import uuid

from .devserver import signatures
from .map_geometry import public_walkable
from .recommendation import (
    VERSION, RecommendationError, RecommendationPolicy, check_version,
    fields, identifier, require, utc_text,
)
from .scenario import SCENARIO_ID, read_json

MOCK_FILENAME = "recommendation-mock.json"
ROUTE_METHOD = "open-plaza-v1"


class MockRecommendation:
    def __init__(self, store, path, *, sign_facilities):
        self.store = store
        self.path = Path(path)
        self.sign_facilities = sign_facilities
        self.lock = threading.Lock()
        self.key = None

    def _refresh(self, now):
        try:
            metadata = self.store.metadata()
            key = (metadata["hashes"], signatures([self.path]))
            if key == self.key:
                return
            self.key = None
            policy = RecommendationPolicy(metadata)
            sign_policy = RecommendationPolicy(metadata, sign_facilities=self.sign_facilities)
            definition = fields(read_json(self.path), "mock", "map_hash", "provider_id", "facilities", "node_routes")
            require(definition["map_hash"] == policy.map_hash, "모의 경로의 지도 해시가 현재 지도와 다릅니다.")
            identifier(definition["provider_id"], "mock.provider_id")
            for row in policy.facility_rows(definition["facilities"], "mock.facilities").values():
                policy.facility(self._observe(row, now, 0), now, now, 0)

            routes_by_node = {}
            node_routes = fields(definition["node_routes"], "mock.node_routes")
            require(bool(node_routes), "모의 경로 출발 노드를 한 곳 이상 설정해야 합니다.")
            for node, paths in node_routes.items():
                require(node in policy.nodes and public_walkable(policy.map, policy.nodes[node]),
                        "모의 경로 출발 노드는 공공 보행 구역에 있어야 합니다.")
                fields(paths, "mock.node_routes", *policy.entrances)
                require(paths.keys() == policy.entrances.keys(), "모의 경로는 기존 지도 시설만 포함할 수 있습니다.")
                origin = {"node_id": node, "point": policy.nodes[node]}
                routes_by_node[node] = [self._route(policy, facility, origin, paths[facility]) for facility in policy.entrances]
        except (ValueError, RecursionError) as error:
            self.key = None
            raise RecommendationError("mock_data_unavailable", f"모의 추천 데이터를 사용할 수 없습니다. {error}") from error

        self.policy, self.sign_policy = policy, sign_policy
        self.definition, self.routes_by_node = definition, routes_by_node
        self.context = {"scenario_id": SCENARIO_ID, "map_hash": policy.map_hash,
                        "run_id": f"mock-{uuid.uuid4().hex}", "timeline_epoch": 0}
        self.started = time.monotonic()
        self.seq = 0
        self.key = key

    @staticmethod
    def _observe(row, now, sim_time):
        # 요청마다 모의 모형의 새 관측을 산출한다. 저장 파일에는 과거 관측 시각이 없다.
        fields(row, "mock.facility", "operation", "admission", "queue_people", "riding_people", "wait")
        wait = fields(row["wait"], "mock.wait", "status", "seconds", "method")
        measured = wait["status"] != "unknown" or row["queue_people"] is not None or row["riding_people"] is not None
        return {**row, "observed_at": utc_text(now) if measured else None,
                "as_of_sim_time_s": sim_time if measured else None}

    @staticmethod
    def _route(policy, facility, origin, points=None):
        target = policy.entrances[facility]
        route = {"facility_id": facility, "origin": origin, "target_node_id": target,
                 "status": "unavailable", "points": [], "distance_m": None,
                 "method": ROUTE_METHOD, "walking_seconds": None}
        if points is not None:
            require(isinstance(points, list), "모의 경로의 경유점은 배열이어야 합니다.")
            for point in points:
                policy.point(point)
            route.update(status="reachable", points=points,
                         distance_m=sum(math.dist(a, b) for a, b in zip(points, points[1:])))
        policy.route(route, origin, target)
        return route

    def info(self):
        with self.lock:
            self._refresh(datetime.now(timezone.utc))
            return {"contract_version": VERSION, "context": self.context,
                    "positions": [{"node_id": node, "point": self.policy.nodes[node]} for node in sorted(self.routes_by_node)],
                    "facility_ids": sorted(self.policy.entrances)}

    def _input(self, policy, now, sim_time, session, routes, *, context=None, time_scale=1):
        self.seq += 1
        stamp = utc_text(now)
        return {"contract_version": VERSION, "context": self.context if context is None else context, "evaluation_at": stamp,
                "policy_id": policy.policy_id, "session": session, "routes": routes,
                "snapshot": {"snapshot_seq": self.seq, "generated_at": stamp,
                             "source": {"kind": "mock", "provider_id": self.definition["provider_id"]},
                             "clock": {"sim_time_s": sim_time, "time_scale": time_scale, "mode": "running"},
                             "facilities": [self._observe(row, now, sim_time) for row in self.definition["facilities"]]}}

    def recommend_for_user(self, context, session, anchor, *, sim_time, time_scale):
        with self.lock:
            now = datetime.now(timezone.utc)
            self._refresh(now)
            policy = self.sign_policy
            policy.context(context)
            position = session["position"]
            anchor_routes = self.routes_by_node.get(anchor, [])
            require(bool(anchor_routes), "표지판을 연결할 모의 경로가 없습니다.", "mock_data_unavailable")
            routes = [
                self._route(policy, route["facility_id"], position,
                            [position["point"], *route["points"]] if route["status"] == "reachable" else None)
                for route in anchor_routes
            ]
            # 캐릭터는 초기 위치에 정지해 있으므로 평가 시점에 같은 위치를 관측한다.
            data = self._input(policy, now, sim_time, {**session, "position_sim_time_s": sim_time}, routes,
                               context=context, time_scale=time_scale)
        return policy.recommend(data)

    def recommend(self, request):
        fields(request, "request", "contract_version", "context", "session_id", "character_id", "revision", "position", "preference_order")
        check_version(request["contract_version"])
        with self.lock:
            now = datetime.now(timezone.utc)
            self._refresh(now)
            policy = self.policy
            require(policy.context(request["context"]) == self.context,
                    "현재 모의 실행과 문맥이 일치하지 않습니다.", "context_mismatch")
            pos = policy.position(request["position"])
            routes = self.routes_by_node.get(pos["node_id"])
            if routes is None:
                routes = [self._route(policy, facility, pos) for facility in policy.entrances]
            sim_time = time.monotonic() - self.started
            stamp = utc_text(now)
            session = {"session_id": request["session_id"], "character_id": request["character_id"],
                       "revision": request["revision"], "created_at": stamp,
                       "expires_at": utc_text(now + timedelta(days=1)), "phase": "ready",
                       "position": pos, "position_sim_time_s": sim_time,
                       "preference_order": request["preference_order"], "active_visit_id": None}
            data = self._input(policy, now, sim_time, session, routes)
        return policy.recommend(data)
