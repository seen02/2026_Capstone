"""매직아일랜드 연속 유입·지도·QR 사용자 진입·모의 추천 서버."""
import argparse
from functools import partial
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import sys
import threading
import uuid
from hashlib import sha256
from pathlib import Path
from time import monotonic
from urllib.parse import urlparse
from .background import BackgroundRun
from .scenario import load_continuous, load_inputs, RIDE_OPERATIONS_PATH, ROOT, SCENARIO_ID
from .devserver import signatures, supervise
from .recommendation import VERSION, RecommendationError, require
from .recommendation_mock import MOCK_FILENAME, MockRecommendation
from .user_sessions import SESSION_IDLE_TIMEOUT, UserSessions, sign_position_metadata
from .visitor_routes import VisitorRoutes

WEB = Path(__file__).resolve().parents[1] / "web"
DEFAULT_PORT = 3000
UNAVAILABLE = "연속 시연에서 이 API는 아직 지원하지 않습니다."
BACKGROUND_RUNNING = "배경 방문객의 유입·체류·퇴장과 놀이시설 순환 운행이 실행 중입니다."
RECOMMENDATION_ERRORS = {
    "context_mismatch": 409, "session_expired": 409, "session_not_ready": 409,
    "snapshot_stale": 409, "position_stale": 409, "run_ended": 409, "mock_data_unavailable": 503,
    "body_too_large": 413, "unsupported_media_type": 415,
    "session_required": 401, "unknown_sign": 404, "session_mismatch": 409, "revision_mismatch": 409,
    "placement_full": 503, "sign_unavailable": 503,
    "recommendation_expired": 409, "recommendation_invalidated": 409,
    "idempotency_conflict": 409, "session_conflict": 409, "route_unavailable": 409,
    "engine_unavailable": 503,
}
SESSION_COOKIE = "magic_island_session"
ASSETS = {
    "/": ("index.html", "text/html"),
    "/operator": ("index.html", "text/html"),
    "/magic-pass.css": ("magic-pass.css", "text/css"),
    "/workspace.css": ("workspace.css", "text/css"),
    "/operator.css": ("operator.css", "text/css"),
    "/user": ("user.html", "text/html"),
    "/user.css": ("user.css", "text/css"),
    "/map.css": ("map.css", "text/css"),
    "/map-viewport.css": ("map-viewport.css", "text/css"),
    **{f"/{name}": (name, "text/javascript") for name in (
        "map.js", "operator.js", "operator-visuals.js", "map3d.js", "geometry.mjs", "rides.mjs", "route.mjs", "navigation.mjs", "queue.mjs",
        "user.js", "live-state.mjs",
        "vendor/three/three.module.js", "vendor/three/three.core.js", "vendor/three/OrbitControls.js")},
    "/vendor/three/LICENSE": ("vendor/three/LICENSE", "text/plain"),
    **{f"/vendor/fonts/{name}.woff2": (f"vendor/fonts/{name}.woff2", "font/woff2")
       for name in ("great-vibes", "noto-serif-kr")},
}


class ScenarioStore:
    def __init__(self,root=ROOT,config_path=None):
        self.root=Path(root)
        self.lock=threading.RLock();self.signature=None;self.error=None
        self.instance=uuid.uuid4().hex
        self.continuous = load_continuous(self.root, config_path)
        self.metadata()

    def metadata(self):
        with self.lock:
            paths = [self.root / 'configs/map.json',
                     self.root / 'configs/preferences.json', self.root / RIDE_OPERATIONS_PATH]
            current=signatures(paths)
            if current!=self.signature:
                self.signature=current
                try:
                    scenario = load_inputs(root=self.root, continuous=self.continuous)
                    metadata = dict(scenario.metadata(), status="continuous_running",
                                    runnable=True, message=BACKGROUND_RUNNING)
                    metadata["signs"] = [
                        {**sign_position_metadata(scenario.map, metadata["hashes"]["map"], sign_id),
                         "name": sign["name"], "facility_ids": sign["facility_ids"]}
                        for sign_id, sign in scenario.map["geometry"]["signposts"].items()
                    ]
                    if not hasattr(self, 'value') or self.value['hashes']['map'] != metadata['hashes']['map']:
                        self.routes = VisitorRoutes(scenario.map, metadata['queue_report'])
                    self.value = metadata
                    self.error = None
                except ValueError as error:
                    self.error=str(error)
            if self.error:raise ValueError(self.error)
            return self.value

    def version(self):
        metadata=self.metadata()
        files=[p for p in (self.root/'web').rglob('*') if p.is_file()]
        stamp=repr((self.instance,metadata['hashes'],signatures(files)))
        return sha256(stamp.encode()).hexdigest()


class ContinuousServer(ThreadingHTTPServer):
    def __init__(self, address, handler, user_sessions):
        self.user_sessions = user_sessions
        self.background = user_sessions.background
        super().__init__(address, handler)

    def service_actions(self):
        self.user_sessions.retire_expired()
        self.background.advance()


class Handler(BaseHTTPRequestHandler):
    def __init__(self, *args, store, web_root, mock_recommendation, user_sessions, **kwargs):
        self.store=store;self.web_root=Path(web_root)
        self.mock_recommendation = mock_recommendation
        self.user_sessions = user_sessions
        super().__init__(*args, **kwargs)

    def log_message(self, *args):
        pass

    def respond(self, data, status=200, html=False, content_type=None, cookie=None):
        if isinstance(data, bytes):
            body = data
        else:
            body = (data if html else json.dumps(data, ensure_ascii=False, allow_nan=False)).encode("utf-8")
            content_type = (content_type or ("text/html" if html else "application/json")) + "; charset=utf-8"
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def api_response(self, action):
        try:
            return action()
        except RecommendationError as error:
            return self.respond({"contract_version": VERSION, "error": {"code": error.code, "message": str(error)}},
                                RECOMMENDATION_ERRORS.get(error.code, 400))

    def request_json(self):
        require(self.headers.get_content_type() == "application/json", "요청 형식은 application/json이어야 합니다.", "unsupported_media_type")
        lengths = self.headers.get_all("Content-Length", [])
        require(not self.headers.get_all("Transfer-Encoding") and len(lengths) == 1
                and lengths[0].isascii() and lengths[0].isdigit() and len(lengths[0]) <= 10,
                "요청 본문의 Content-Length가 올바르지 않습니다.")
        length = int(lengths[0])
        require(0 < length, "요청 본문이 비어 있습니다.")
        require(length <= 64 * 1024, "요청 본문은 64KiB까지 허용됩니다.", "body_too_large")

        def reject_constant(_):
            raise ValueError

        def finite_float(value):
            parsed = float(value)
            if not math.isfinite(parsed):
                raise ValueError
            return parsed

        def unique_keys(pairs):
            value = dict(pairs)
            if len(value) != len(pairs):
                raise ValueError
            return value

        try:
            body = self.rfile.read(length)
            require(len(body) == length, "요청 본문이 중간에 끊겼습니다.")
            data = json.loads(body.decode("utf-8"), parse_constant=reject_constant,
                              parse_float=finite_float, object_pairs_hook=unique_keys)
        except (ValueError, RecursionError) as error:
            raise RecommendationError("invalid_input", "요청 본문은 올바른 UTF-8 JSON이어야 합니다.") from error
        return data

    def session_token(self):
        try:
            cookie = SimpleCookie(self.headers.get("Cookie", ""))
        except CookieError:
            return None
        return cookie[SESSION_COOKIE].value if SESSION_COOKIE in cookie else None

    def enter_user(self):
        result, token = self.user_sessions.enter(self.session_token(), self.request_json())
        return self.respond(result, cookie=self.user_session_cookie(token))

    @staticmethod
    def user_session_cookie(token, max_age=int(SESSION_IDLE_TIMEOUT.total_seconds())):
        return f"{SESSION_COOKIE}={token}; Path=/api/user/; Max-Age={max_age}; HttpOnly; SameSite=Strict"

    def get_user(self):
        token = self.session_token()
        result = self.user_sessions.get(token)
        return self.respond(result, cookie=self.user_session_cookie(token))

    def end_user(self):
        result = self.user_sessions.end(self.session_token(), self.request_json())
        return self.respond(result, cookie=self.user_session_cookie("", 0))

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ASSETS:
            filename, mime = ASSETS[path]
            try:
                asset = self.web_root / filename
                content = asset.read_bytes() if mime == "font/woff2" else asset.read_text(encoding="utf-8-sig")
                return self.respond(content, html=True, content_type=mime)
            except OSError:
                return self.respond({'error':'화면 파일을 읽을 수 없습니다.'},503)
        if path == "/api/meta":
            try:return self.respond(self.store.metadata())
            except ValueError as error:return self.respond({'error':str(error)},422)
        if path == '/api/dev-version':
            try:return self.respond({'version':self.store.version(),'instance':self.store.instance})
            except ValueError as error:return self.respond({'error':str(error)},422)
        if path == "/api/recommendation/mock":
            return self.api_response(lambda: self.respond(self.mock_recommendation.info()))
        if path == "/api/user/session":
            return self.api_response(self.get_user)
        if path == "/api/user/recommendation":
            return self.api_response(lambda: self.respond(self.user_sessions.recommend(self.session_token())))
        if path == "/api/state":
            return self.respond(self.user_sessions.engine_state())
        if path in ("/api/signs", "/api/report"):
            return self.respond({"error": UNAVAILABLE, "scenario_id": SCENARIO_ID, "runnable": False}, 409)
        self.respond({"error": "없는 경로입니다."}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/recommendation":
            return self.api_response(lambda: self.respond(self.mock_recommendation.recommend(self.request_json())))
        if path == "/api/user/session":
            return self.api_response(self.enter_user)
        if path == "/api/user/recommendation/accept":
            return self.api_response(lambda: self.respond(
                self.user_sessions.accept(self.session_token(), self.request_json())))
        if path in ("/api/reset", "/api/advance", "/api/seek"):
            return self.respond({"error": UNAVAILABLE, "runnable": False}, 409)
        self.respond({"error": "없는 API입니다."}, 404)

    def do_PUT(self):
        if urlparse(self.path).path == "/api/user/preferences":
            return self.api_response(lambda: self.respond(
                self.user_sessions.save_preferences(self.session_token(), self.request_json())))
        self.respond({"error": "없는 API입니다."}, 404)

    def do_DELETE(self):
        if urlparse(self.path).path == "/api/user/session":
            return self.api_response(self.end_user)
        self.respond({"error": "없는 API입니다."}, 404)


def make_server(port=DEFAULT_PORT, config_path=None, root=ROOT, web_root=None, *, host="127.0.0.1", mock_data=None, clock=monotonic):
    store=ScenarioStore(root,config_path)
    mock = MockRecommendation(store, mock_data or Path(root) / "configs" / MOCK_FILENAME)
    background = BackgroundRun(store.continuous, store.routes, map_hash=store.value['hashes']['map'],
                               ride_operations=store.value['ride_operations']['facilities'],
                               ride_operations_hash=store.value['hashes']['ride_operations'],
                               preferences=store.value['preferences'], preferences_hash=store.value['hashes']['preferences'],
                               clock=clock)
    user_sessions = UserSessions(store.value, background)
    handler = partial(Handler, store=store, web_root=web_root or Path(root) / "web",
                      mock_recommendation=mock, user_sessions=user_sessions)
    return ContinuousServer((host, port), handler, user_sessions)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="매직아일랜드 연속 유입·지도·QR 사용자 진입·모의 추천 서버")
    parser.add_argument("--host", default="127.0.0.1", help="서버가 요청을 받을 주소")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--config", type=Path, help="매직아일랜드 운영 설정 JSON")
    parser.add_argument("--mock-data", type=Path, help="모의 시설 현황과 경로를 저장한 JSON 경로")
    parser.add_argument("--validate-only", action="store_true", help="설정만 검증하고 종료")
    parser.add_argument('--no-reload',action='store_true',help='Python 자동 재시작 없이 실행')
    args = parser.parse_args()
    try:
        if args.validate_only:
            metadata = load_inputs(config_path=args.config).metadata()
            VisitorRoutes(metadata['map'], metadata['queue_report'])
            print(json.dumps(metadata, ensure_ascii=False))
            return
        if not args.no_reload:
            load_inputs(config_path=args.config)
            raise SystemExit(supervise(ROOT, args.port, args.config, host=args.host, mock_data=args.mock_data))
        server = make_server(args.port, args.config, host=args.host, mock_data=args.mock_data)
    except (ValueError, OSError) as exc:
        parser.error(str(exc))
    print(f"매직아일랜드 지도·QR 사용자 진입·모의 추천: http://{args.host}:{server.server_port}", flush=True)
    print(BACKGROUND_RUNNING, flush=True)
    print("종료하려면 Ctrl+C를 누르세요.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
