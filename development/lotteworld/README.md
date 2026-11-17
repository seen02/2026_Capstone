# 롯데월드 매직아일랜드

이 폴더는 아쿠아리움과 별도로 실행하는 Python 3.11 이상 프로젝트다. 추가 Python 패키지는 필요하지 않으며 아쿠아리움 코드·설정·화면을 불러오지 않는다.

현재 체크리스트 1–2번인 시나리오·설정 분리와 3D 지도·시설 표시를 구현했다. 안내도의 상대 배치를 참고한 비정형 섬·성·다리와 시설별 입체 모형을 회전·확대·이동하며 볼 수 있다. 성 정면과 다리는 앞 광장을 통해 같은 직선 축으로 이어진다. 주 섬·남쪽 메이플 돌출부·수면 홈과 6개 시설·넓은 보행 광장·대기 외곽을 표시한다. 시간표 실행·개별 보행·대기 자리·시설 운행·재생은 후속 단계다.

## 실행

이 폴더에서 다음 명령을 사용한다.

```powershell
./run.ps1
python -m lotteworld_sim.server --port 8767
python -m lotteworld_sim.server --validate-only
python -m lotteworld_sim.cli --validate-only --output output/scenario-metadata.json
python -m unittest discover -s tests -v
```

지도 화면은 http://127.0.0.1:8767 이다. 시설 모형·이름표·목록 선택으로 입구 접근·출구 복귀 참조 경로와 미터 거리를 확인한다. 왼쪽 드래그는 회전, 오른쪽 드래그는 이동, 휠은 확대·축소다. 위에서 보기·가림 줄이기·시설 가까이 보기와 전체 보기 복귀를 지원한다. 터치는 한 손가락 회전, 두 손가락 확대·이동이다. 혜성특급도 지상 모형이다. 섬 내부 대부분은 보행 가능한 포장 광장이고 녹지는 작은 식재 구획이다. `/api/meta`는 검증된 지도·운영·선호 설정과 각각의 SHA-256 해시, `scenario_id`, `status: map_ready`, `map_ready: true`, `map_view: guide-map-3d`, `runnable: false`를 반환한다. 재생 API는 HTTP 409로 미구현 상태를 알려 준다. CLI에서 `--validate-only`를 생략하면 오류로 종료하며 시뮬레이션 결과 파일을 만들지 않는다. 내보낸 파일은 설정 메타데이터다.

`--config 경로`는 별도의 매직아일랜드 운영 JSON을 읽는다. 지도와 선호는 이 폴더의 `configs/`만 사용한다. 다른 시나리오 설정·지원하지 않는 스키마·잘못된 시간표·비중·체류·선호 값은 거절한다.

## 설정과 개발 범위

- `configs/map.json`: 6개 시설의 독립 ID·1회 탑승 정원, 가상 좌표·구획·연결 그래프·대기 자리 배치 규칙. 1회 정원의 2.5배 이상을 몸체·간격·회전 여백까지 정적으로 검사한다. 실제 줄 이동·승하차는 후속 단계다.
- `configs/day.json`: 관측 10–19시, 계획 진입 10,350명, 시간별 9구간, 대기 포함 개인 예정 체류 120–240분과 출처·가정이다. 이번에는 로드·검증만 하며 도착 시각을 생성하지 않는다.
- `configs/preferences.json`: 시설 ID별 0–5의 선호 계약이다. 동일 선호 기준형 하나는 검증용 가정이며 행동 정책·방문객 유형 분포는 7번에서 구현한다.

세부 계약은 [설정 계약](docs/configuration.md), 개발 기준은 [명세](../docs/design.md), 다음 작업은 [체크리스트](../docs/implementation-checklist.md)를 따른다. 두 폴더를 동시에 실행해도 아쿠아리움 기본 포트8765와 겹치지 않는다.

## 대기줄과 보행 광장

6개 시설 모두 공연 대기줄 형태의 금속 기둥·벨트·접힌 줄·방향 화살표를 표시한다. 대기줄 양쪽 벨트는 반원 회전부까지 연속해서 이어진다. 초록 대기 입구에서 놀이기구에 가까운 황금색 탑승 진입점으로 진행하며 빨간 점은 이용 후 퇴장이다. 최소 수용 기준을 정적으로 검증하며 지도 라벨과 시설 상세에는 자리 수를 표시하지 않는다. 실제 대기 인원은 아직 집계하지 않는다. 섬 내부는 좁은 길 띠 없이 연속된 포장 광장이고 선택 경로도 넓은 면에서 장애물을 피해 탐색한다. 성 앞의 중복 사각 바닥을 제거했다. [표시 검증](../docs/verification/queue-and-open-plaza.md)과 [수용량·자동 반영 검증](../docs/verification/queue-capacity-and-reload.md)을 참고한다.

## 지도 검증

[3D 지도 검증 기록](../docs/verification/magic-island-map3d.md)에 검사 범위와 결과를 정리했다. 전용 Python 검사, `node tests/route.test.mjs`, `node tests/verify_map3d.cjs`를 사용한다. 브라우저 검사는 개발용 Playwright와 설치된 Chrome이 필요하며 임시 포트의 검증 서버를 자동 시작·종료한다. `MAGIC_MAP_URL`을 지정하면 실행 중인 서버를 사용하고, `PLAYWRIGHT_CHANNEL`로 Chrome 외 채널을 선택할 수 있다. 자동 서버의 Python 경로는 `PYTHON`으로 지정할 수 있다. 런타임 서버에는 Node·Playwright·외부 CDN이 필요하지 않으며 Three.js는 로컬 사본을 제공한다. [재사용·라이선스](docs/reuse.md)를 참고한다.

PowerShell이 `run.ps1`을 차단하면 실행 정책 변경 없이 다음 명령을 이 폴더에서 사용한다.

```powershell
& "C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe" -m lotteworld_sim.server --port 8767
```

`node tests/navigation.test.mjs`로 접힌 대기줄·광장 경로·장애물 우회를 검사한다.

## 저장 후 새로고침

기본 실행은 개발 자동 반영 모드다. HTML·CSS·JavaScript·지도·운영·선호 JSON을 저장한 뒤 브라우저를 새로고침하면 최신 내용을 읽는다. 설정 오류는 HTTP 422로 알리고, 올바르게 저장하면 같은 서버에서 복구한다. Python 파일은 자동으로 서버 프로세스를 다시 불러오며 실행창과 포트는 유지한다. Python 재시작 순간에는 짧게 연결이 끊길 수 있다.

이 기능이 없던 구버전 서버는 한 번 종료하고 새 명령으로 실행해야 한다. 그 이후 파일 수정마다 수동 종료·재실행할 필요가 없다. `--no-reload`는 Python 자동 재시작만 끄며 설정·정적 파일의 새로고침 반영은 유지한다. `--validate-only`는 감시 서버를 시작하지 않는다.

최종 제품의 QR 관람객 화면·영상 기반 분석 및 추천 서버·관리자 대시보드와 시뮬레이션의 관계는 [최종 소프트웨어 계획](../docs/software-plan.md)을 따른다.
