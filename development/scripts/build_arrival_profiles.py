"""통계 출처가 없는 명시적 가상 입장 모형을 생성한다."""
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
base=dict(model='conditional_poisson_minutes',intensity='synthetic_peaks',
          baseline=.15,peaks=[dict(hour=10.5,sigma_hours=.65,weight=1),dict(hour=14,sigma_hours=.85,weight=.8)],
          label='가상 오전·오후 피크',calibration_status='synthetic_not_observed',
          source='가상 실험 설정',limitations='실제 시설 통계로 보정되지 않은 합성 분포')
profiles={'synthetic_peaks':base,'uniform_baseline':dict(model='conditional_poisson_minutes',intensity='uniform_baseline',
 label='균등 입장률 비교 기준',calibration_status='synthetic_not_observed',source='가상 실험 설정')}
if __name__=='__main__':
 (ROOT/'configs/arrival_profiles.json').write_text(json.dumps(profiles,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 config=json.loads((ROOT/'configs/day.json').read_text(encoding='utf-8'))
 config['arrivals']=base
 config['provenance']={'daily_visitors':'설정된 하루 입장객 수는 가상 실험 부하이며 실제 시설 통계가 아님.',
  'arrivals':'분마다 다른 합성 기대 입장률에 따른 무작위 입장. 오전·오후 피크는 조정 가능한 가정.',
  'stay_minutes':'균등분포 90~180분 가정. 전시를 모두 마치면 먼저 퇴장할 수 있음.',
  'hours':'가상 운영 설정: 09:30 개장, 17:30 입장 종료, 18:00 폐장.',
  'motion':'경로 선택은 설계 길이와 연결 인원으로 추정. 실제 이동은 최대 1.2m/s, 0.25초 보행, 몸체 폭 0.46m와 여유 0.08m의 연속 충돌 검사·대기·우회를 적용. 실측 보정 전 가정.'}
 (ROOT/'configs/day.json').write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
