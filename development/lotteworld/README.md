# 롯데월드 매직아일랜드

이 폴더는 아쿠아리움과 별도로 실행하는 Python 3.11 이상 프로젝트다. 추가 Python 패키지는 필요하지 않으며 아쿠아리움 코드·설정·화면을 불러오지 않는다.

현재 체크리스트 1번인 시나리오·설정 분리까지만 구현했다. 지도 형상·보행·시간표 실행·시설 운행·재생은 후속 단계다. 실행 가능한 지도를 대신하는 아쿠아리움 데이터는 포함하지 않는다.

## 실행

이 폴더에서 다음 명령을 사용한다.

```powershell
./run.ps1
python -m lotteworld_sim.server --port 8767
python -m lotteworld_sim.server --validate-only
python -m lotteworld_sim.cli --validate-only --output output/scenario-metadata.json
python -m unittest discover -s tests -v
```

설정 확인 화면은 http://127.0.0.1:8767 이다. `/api/meta`는 검증된 지도·운영·선호 설정과 각각의 SHA-256 해시, `scenario_id`, `runnable: false`를 반환한다. 재생 API는 HTTP 409로 미구현 상태를 알려 준다. CLI에서 `--validate-only`를 생략하면 오류로 종료하며 시뮬레이션 결과 파일을 만들지 않는다. 내보낸 파일은 설정 메타데이터다.

`--config 경로`는 별도의 매직아일랜드 운영 JSON을 읽는다. 지도와 선호는 이 폴더의 `configs/`만 사용한다. 다른 시나리오 설정·지원하지 않는 스키마·잘못된 시간표·비중·체류·선호 값은 거절한다.

## 설정과 개발 범위

- `configs/map.json`: 6개 시설의 독립 ID와 이름. 현재 `status: planned`, `geometry: null`이다.
- `configs/day.json`: 관측 10~19시, 계획 진입 10,350명, 시간별 9구간, 대기 포함 개인 예정 체류 120~240분과 출처·가정이다. 이번에는 로드·검증만 하며 도착 시각을 생성하지 않는다.
- `configs/preferences.json`: 시설 ID별 0~5의 선호 계약이다. 동일 선호 기준형 하나는 검증용 가정이며 행동 정책·방문객 유형 분포는 7번에서 구현한다.

세부 계약은 [설정 계약](docs/configuration.md), 개발 기준은 [명세](../docs/design.md), 다음 작업은 [체크리스트](../docs/implementation-checklist.md)를 따른다. 두 폴더를 동시에 실행해도 아쿠아리움 기본 포트8765와 겹치지 않는다.
