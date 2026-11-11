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

- `configs/map.json`: 6개 시설의 독립 ID와 이름, 가상 미터 좌표·구획·양방향 보행 그래프. 현재 `status: map_ready`다. 대기 외곽은 공간 예약이며 실제 대기 자리 정원이 아니다.
- `configs/day.json`: 관측 10–19시, 계획 진입 10,350명, 시간별 9구간, 대기 포함 개인 예정 체류 120–240분과 출처·가정이다. 이번에는 로드·검증만 하며 도착 시각을 생성하지 않는다.
- `configs/preferences.json`: 시설 ID별 0–5의 선호 계약이다. 동일 선호 기준형 하나는 검증용 가정이며 행동 정책·방문객 유형 분포는 7번에서 구현한다.

세부 계약은 [설정 계약](docs/configuration.md), 개발 기준은 [명세](../docs/design.md), 다음 작업은 [체크리스트](../docs/implementation-checklist.md)를 따른다. 두 폴더를 동시에 실행해도 아쿠아리움 기본 포트8765와 겹치지 않는다.

## 지도 검증

[3D 지도 검증 기록](../docs/verification/magic-island-map3d.md)에 검사 범위와 결과를 정리했다. 전용 Python 검사, `node tests/route.test.mjs`, `node tests/verify_map3d.cjs`를 사용한다. 브라우저 검사는 개발용 Playwright와 설치된 Chrome이 필요하며 임시 포트의 검증 서버를 자동 시작·종료한다. `MAGIC_MAP_URL`을 지정하면 실행 중인 서버를 사용하고, `PLAYWRIGHT_CHANNEL`로 Chrome 외 채널을 선택할 수 있다. 자동 서버의 Python 경로는 `PYTHON`으로 지정할 수 있다. 런타임 서버에는 Node·Playwright·외부 CDN이 필요하지 않으며 Three.js는 로컬 사본을 제공한다. [재사용·라이선스](docs/reuse.md)를 참고한다.

PowerShell이 `run.ps1`을 차단하면 실행 정책 변경 없이 다음 명령을 이 폴더에서 사용한다.

```powershell
& "C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe" -m lotteworld_sim.server --port 8767
```

기존 서버가 실행 중이면 `Ctrl+C`로 종료하고 다시 시작한다. 지도 설정·정적 자원 목록은 서버 시작 시 읽는다.

최종 제품의 QR 관람객 화면·영상 기반 분석 및 추천 서버·관리자 대시보드와 시뮬레이션의 관계는 [최종 소프트웨어 계획](../docs/software-plan.md)을 따른다.
