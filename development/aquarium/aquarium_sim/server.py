"""로컬 웹 지도와 시뮬레이션 API. 추가 Python 패키지가 필요하지 않다."""
import argparse
from copy import deepcopy
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import threading
from urllib.parse import urlparse
from .engine import Simulation, clock_seconds
from .personas import PROFILES

ROOT = Path(__file__).resolve().parents[1]


def load_inputs(root=ROOT, config_path=None):
    try:
        map_data = json.loads((root/"configs/aquarium_map.json").read_text(encoding="utf-8"))
        config = json.loads(Path(config_path or root/"configs/day.json").read_text(encoding="utf-8"))
        if not isinstance(config, dict) or config.get("scenario_id", "aquarium") != "aquarium":
            raise ValueError("아쿠아리움 전용 운영 설정이 필요합니다.")
        return map_data, config
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("아쿠아리움 지도·운영 설정을 읽을 수 없습니다.") from exc


class App:
    def __init__(self, config_path=None):
        self.map,self.config=load_inputs(config_path=config_path)
        self.arrival_profiles=json.loads((ROOT/"configs/arrival_profiles.json").read_text(encoding="utf-8"))
        self.lock=threading.Lock()
        self.sim=Simulation(self.map,deepcopy(self.config))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,app=None,**kwargs):
        self.app=app
        super().__init__(*args,directory=str(ROOT/"web"),**kwargs)

    def log_message(self,format,*args):
        pass

    def _json(self,data,status=200,download=False):
        body=json.dumps(data,ensure_ascii=False,allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Content-Length",str(len(body)))
        self.send_header("Cache-Control","no-store")
        if download:self.send_header("Content-Disposition",'attachment; filename="aquarium-report.json"')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path=urlparse(self.path).path
        if path=="/api/meta":
            return self._json(dict(scenario_id="aquarium",runnable=True,map=self.app.map,config=self.app.config,personas=PROFILES,arrival_profiles=self.app.arrival_profiles))
        if path=="/api/state":
            with self.app.lock:data=self.app.sim.snapshot()
            return self._json(data)
        if path=="/api/signs":
            with self.app.lock:
                state=self.app.sim.snapshot()
                data=dict(schema_version=1,time=state["time"],mode="monitor_only",
                          hardware_connected=False,signs=self.app.map["signs"],zones=state["zones"])
            return self._json(data)
        if path.startswith("/api/"):return self._json({"error":"없는 API입니다."},404)
        return super().do_GET()

    def do_POST(self):
        origin=self.headers.get("Origin")
        if origin and urlparse(origin).netloc!=self.headers.get("Host"):
            return self._json({"error":"같은 로컬 화면에서만 조작할 수 있습니다."},403)
        try:
            length=int(self.headers.get("Content-Length","0"))
            if not 0 <= length <= 10000:raise ValueError("요청 크기가 너무 큽니다.")
            data=json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(data,dict):raise ValueError("객체 형식의 입력이 필요합니다.")
            with self.app.lock:
                frames=[]
                compact=data.get("motion_format")=="compact-v1"
                if self.path=="/api/reset":
                    cfg=deepcopy(self.app.config)
                    for key in ("daily_visitors","seed"):
                        if key in data:cfg[key]=data[key]
                    if data.get("arrival_profile"):
                        cfg["arrivals"]=deepcopy(self.app.arrival_profiles[data["arrival_profile"]])
                        cfg["provenance"]["arrivals"]=f"선택 분포: {cfg['arrivals']['label']}. 교정 상태: {cfg['arrivals']['calibration_status']}."
                    self.app.sim=Simulation(self.app.map,cfg)
                elif self.path=="/api/seek":
                    target=data.get("target")
                    sim=self.app.sim
                    if type(target) not in (int,float) or not math.isfinite(target) or not clock_seconds(sim.config["opening"])<=target<=sim.horizon:
                        raise ValueError("이동 시각은 개장부터 시뮬레이션 종료 사이여야 합니다.")
                    if target<sim.now:
                        sim=Simulation(self.app.map,deepcopy(sim.config))
                    sim.advance_to(target)
                    self.app.sim=sim
                elif self.path=="/api/advance":
                    if "target" in data:target=data["target"]
                    else:
                        seconds=data.get("seconds",60)
                        if type(seconds) not in (int,float) or not 0<=seconds<=3600:
                            raise ValueError("진행 간격은 0~3600초여야 합니다.")
                        target=self.app.sim.now+seconds
                    if data.get("motion"):
                        if type(target) not in (int,float) or not math.isfinite(target) or target<self.app.sim.now:
                            raise ValueError("재생 시각은 현재 시각 이후의 유한한 수여야 합니다.")
                        if target-self.app.sim.now>60:raise ValueError("연속 재생 요청은 60초 이내여야 합니다.")
                        frames.append(self.app.sim.motion_snapshot(compact=compact))
                        end=min(target,self.app.sim.horizon)
                        while self.app.sim.now<end:
                            self.app.sim.advance_to(min(end,self.app.sim.now+.25))
                            frames.append(self.app.sim.motion_snapshot(compact=compact))
                    else:self.app.sim.advance_to(target)
                else:return self._json({"error":"없는 API입니다."},404)
                snapshot=self.app.sim.snapshot()
                if frames:
                    snapshot["motion_frames"]=frames
                    if compact:snapshot["motion_format"]="compact-v1"
            self._json(snapshot)
        except (ValueError,KeyError,TypeError) as exc:
            self._json({"error":str(exc)},400)


def make_server(port=8765, config_path=None):
    return ThreadingHTTPServer(("127.0.0.1",port),partial(Handler,app=App(config_path)))


def main():
    parser=argparse.ArgumentParser(description="아쿠아리움 시뮬레이션 실행")
    parser.add_argument("--port",type=int,default=8765)
    parser.add_argument("--config",type=Path,help="별도 실험 설정 JSON")
    parser.add_argument("--validate-only",action="store_true",help="입력 검증 후 종료")
    args=parser.parse_args()
    try:
        if args.validate_only:
            app=App(args.config)
            print(json.dumps(dict(scenario_id="aquarium",runnable=True,daily_visitors=app.config["daily_visitors"]),ensure_ascii=False))
            return
        server=make_server(args.port,args.config)
    except (ValueError,KeyError,TypeError) as exc:
        parser.error(f"아쿠아리움 설정 오류: {exc}")
    print(f"아쿠아리움 시뮬레이션: http://127.0.0.1:{server.server_port}",flush=True)
    print("종료하려면 Ctrl+C를 누르세요.",flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()


if __name__=="__main__":main()
