"""화면 없이 하루 전체 실행 및 연구용 결과 저장."""
import argparse
import json
from pathlib import Path
from .engine import Simulation
from .server import load_inputs


def main():
    parser=argparse.ArgumentParser(description="하루 관람 시뮬레이션 일괄 실행")
    parser.add_argument("--visitors",type=int,help="하루 입장객 수; 생략하면 설정 파일 값 사용")
    parser.add_argument("--seed",type=int,default=20261104)
    parser.add_argument("--output",type=Path,default=Path("output/day-report.json"))
    parser.add_argument("--config",type=Path,help="별도 실험 설정 JSON")
    parser.add_argument("--validate-only",action="store_true",help="입력 검증 후 종료")
    args=parser.parse_args()
    try:
        map_data,config=load_inputs(config_path=args.config)
        config.update(seed=args.seed)
        if args.visitors is not None:config["daily_visitors"]=args.visitors
        sim=Simulation(map_data,config)
    except (ValueError,KeyError,TypeError) as exc:
        parser.error(f"아쿠아리움 설정 오류: {exc}")
    if args.validate_only:
        print(json.dumps(dict(scenario_id="aquarium",runnable=True,daily_visitors=config["daily_visitors"]),ensure_ascii=False))
        return
    sim.advance_to(sim.horizon)
    report=sim.report()
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(report["snapshot"]["metrics"],ensure_ascii=False))
    print(f"결과 저장: {args.output.resolve()}")
    if not report["complete"]:raise SystemExit("종료 시각에 미퇴장 관람객이 있습니다. 결과를 확인하세요.")


if __name__=="__main__":main()
