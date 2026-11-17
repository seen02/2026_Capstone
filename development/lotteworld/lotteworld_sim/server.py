"""지도·설정 확인 로컬 서버. 아쿠아리움 화면과 엔진을 사용하지 않는다."""
import argparse
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import sys
import threading
import uuid
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlparse
from .scenario import load_inputs, NOT_READY, ROOT
from .devserver import signatures, supervise

WEB = Path(__file__).resolve().parents[1] / "web"
ASSETS = {
    "/": ("index.html", "text/html"),
    "/map.css": ("map.css", "text/css"),
    **{f"/{name}": (name, "text/javascript") for name in (
        "map.js", "map3d.js", "geometry.mjs", "rides.mjs", "route.mjs", "navigation.mjs", "queue.mjs",
        "vendor/three/three.module.js", "vendor/three/three.core.js", "vendor/three/OrbitControls.js")},
    "/vendor/three/LICENSE": ("vendor/three/LICENSE", "text/plain"),
}


class ScenarioStore:
    def __init__(self,root=ROOT,config_path=None):
        self.root=Path(root);self.config_path=config_path
        self.lock=threading.RLock();self.signature=None;self.error=None
        self.instance=uuid.uuid4().hex
        self.metadata()

    def metadata(self):
        with self.lock:
            paths=[self.root/'configs/map.json',Path(self.config_path) if self.config_path else self.root/'configs/day.json',self.root/'configs/preferences.json']
            current=signatures(paths)
            if current!=self.signature:
                self.signature=current
                try:
                    self.value=load_inputs(root=self.root,config_path=self.config_path).metadata();self.error=None
                except ValueError as error:
                    self.error=str(error)
            if self.error:raise ValueError(self.error)
            return self.value

    def version(self):
        metadata=self.metadata()
        files=[p for p in (self.root/'web').rglob('*') if p.is_file()]
        stamp=repr((self.instance,metadata['hashes'],signatures(files)))
        return sha256(stamp.encode()).hexdigest()


class Handler(BaseHTTPRequestHandler):
    def __init__(self, *args, store, web_root, **kwargs):
        self.store=store;self.web_root=Path(web_root)
        super().__init__(*args, **kwargs)

    def log_message(self, *args):
        pass

    def respond(self, data, status=200, html=False, content_type=None):
        body = (data if html else json.dumps(data, ensure_ascii=False, allow_nan=False)).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", (content_type or ("text/html" if html else "application/json")) + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ASSETS:
            filename, mime = ASSETS[path]
            try:
                return self.respond((self.web_root / filename).read_text(encoding="utf-8-sig"), html=True, content_type=mime)
            except OSError:
                return self.respond({'error':'화면 파일을 읽을 수 없습니다.'},503)
        if path == "/api/meta":
            try:return self.respond(self.store.metadata())
            except ValueError as error:return self.respond({'error':str(error)},422)
        if path == '/api/dev-version':
            try:return self.respond({'version':self.store.version(),'instance':self.store.instance})
            except ValueError as error:return self.respond({'error':str(error)},422)
        if path in ("/api/state", "/api/signs", "/api/report"):
            return self.respond({"error": NOT_READY, "scenario_id": "magic-island", "runnable": False}, 409)
        self.respond({"error": "없는 경로입니다."}, 404)

    def do_POST(self):
        if urlparse(self.path).path in ("/api/reset", "/api/advance", "/api/seek"):
            return self.respond({"error": NOT_READY, "runnable": False}, 409)
        self.respond({"error": "없는 API입니다."}, 404)


def make_server(port=8767, config_path=None, root=ROOT, web_root=None):
    store=ScenarioStore(root,config_path)
    return ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, store=store,web_root=web_root or Path(root)/'web'))


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="매직아일랜드 지도·설정 서버")
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument("--config", type=Path, help="매직아일랜드 운영 설정 JSON")
    parser.add_argument("--validate-only", action="store_true", help="설정만 검증하고 종료")
    parser.add_argument('--no-reload',action='store_true',help='Python 자동 재시작 없이 실행')
    args = parser.parse_args()
    try:
        if args.validate_only:
            print(json.dumps(load_inputs(config_path=args.config).metadata(), ensure_ascii=False))
            return
        if not args.no_reload:
            load_inputs(config_path=args.config)
            raise SystemExit(supervise(ROOT,args.port,args.config))
        server = make_server(args.port, args.config)
    except ValueError as exc:
        parser.error(str(exc))
    print(f"매직아일랜드 지도·설정: http://127.0.0.1:{server.server_port}", flush=True)
    print(NOT_READY, flush=True)
    print("종료하려면 Ctrl+C를 누르세요.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
