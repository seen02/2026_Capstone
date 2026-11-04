"""운영기관의 분별 입장 집계(time,count)를 별도 실험 설정으로 변환한다."""
import argparse
import csv
import json
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from aquarium_sim.engine import clock_seconds, arrival_schedule

def import_counts(config, rows, source):
    config=json.loads(json.dumps(config))
    start,end=(clock_seconds(config[k]) for k in ("opening","last_entry"))
    counts={}
    for row in rows:
        t=clock_seconds(row["time"])
        count=int(row["count"])
        if not start<=t<end or t in counts or count<0:
            raise ValueError("집계 시각 중복·운영시간 이탈·음수 인원이 있습니다.")
        counts[t]=count
    if set(counts)!=set(range(start,end,60)):
        raise ValueError("입장 가능 시간의 모든 분을 포함해야 합니다. 실제 0명은 0으로 명시하고 결측치는 보완해 주세요.")
    config["arrivals"]={"model":"conditional_poisson_minutes","intensity":"empirical_minutes",
        "minute_weights":[counts[t] for t in range(start,end,60)],
        "calibration_status":"user_supplied_observations","source":source}
    config["provenance"]["arrivals"]="사용자가 제공한 분별 입장 집계로 상대 입장률 설정. 출처·집계일의 적합성은 별도 검토 필요."
    arrival_schedule(config)
    return config

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv",type=Path)
    parser.add_argument("--source",required=True,help="자료 출처·집계 기간")
    parser.add_argument("--config",type=Path,default=ROOT/"configs/day.json")
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args()
    with args.csv.open(encoding="utf-8-sig",newline="") as f:
        data=import_counts(json.loads(args.config.read_text(encoding="utf-8")),csv.DictReader(f),args.source)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(data,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(f"분별 입장 분포 설정 저장: {args.output}")
