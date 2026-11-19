# 로컬 모의 추천 서버 검증

검증일은 2026-11-18이다. [추천 API 실행과 호출 예시](../../lotteworld/README.md#로컬-추천-api)를 사용했다. 계산에는 [공통 데이터 계약 v1](../contracts/recommendation-v1.md)의 개발용 `baseline-v1` 정책을 적용했다.

기본 QR 시연의 최신 설정은 자이로스핀·혜성특급·자이로드롭 모두 정상 운행이다. 각 시설의 추천 결과는 [QR 진입 검증 기록](qr-user-entry-and-preferences.md)에 있다.

| 검사 | 확인 결과 |
| --- | --- |
| `python -m unittest discover -s tests -v` (`development/lotteworld/`) | 26개 통과. 이 중 추천 정책·HTTP 검증은 9개다. |
| `python -m unittest discover -s tests -v` (`development/`) | 시나리오 선택·검증·독립 실행 5개 통과. 매직아일랜드와 아쿠아리움의 서버를 동시에 실행해 각 메타데이터와 `/api/state` 응답을 대조했다. |
| `python -m unittest discover -s tests -v`, `tests/*.test.mjs` 개별 실행 (`development/aquarium/`) | Python 39개와 JavaScript 테스트 파일 4개 통과. |
| `node tests/route.test.mjs`, `node tests/navigation.test.mjs` | 기존 양방향 그래프·공공 광장 경로와 장애물 우회 검사 통과. |
| `node scripts/generate_mock_routes.mjs output/scenario-metadata.json configs/recommendation-mock.json --check` | 현재 지도 해시와 기본 출발점 3곳에서 시설 입구 6곳으로 향하는 18개 정적 경로 일치. |
| README의 PowerShell HTTP 예제 | 루트 `run.py`에서 주소·임시 포트·상대 경로의 모의 데이터 파일을 지정해 실행했다. 자이로스핀(`gyro-spin`), 2순위, 300초, 57.812442089876946m, 비용 `0.148124977`을 확인했다. |

Windows 제한 실행 환경에서는 번들 Python을 사용했고 테스트의 임시 디렉터리는 쓰기 가능한 작업공간의 `output/test-tmp`에 생성했다. `node tests/verify_map3d.cjs`는 현재 환경에 Playwright 모듈이 없어 브라우저 검증을 시작하지 못했다.

## 추천 검사 세부 결과

- 선호 순서를 바꿔 자이로스핀과 자이로드롭 선택을 바꿨다. 같은 순서에서 자이로드롭의 모의 대기를 900초에서 1500초로 바꾸자 `west-spin`에서는 자이로스핀이 선택됐다. 그 상태에서 `west-north`로 위치를 바꾸면 자이로드롭이 선택됐다.
- 아르카나라이드의 알려진 0초 대기를 추천에 사용했다. 아트란티스의 미집계, 폐쇄·중단 시설, 줄 포화, 오래된 대기·관측, 연결 불가·미제공 경로는 각각 제외했다. 모든 시설이 탈락하면 `no_candidate`와 시설별 사유 6건을 반환했다.
- 실제 30초·시뮬레이션 300초의 경계, 미래 시각, 만료 세션·종료 실행, 잘못된 버전·지도 해시·시설 순열·JSON·좌표를 검사했다. 모의 파일의 지도 해시가 다를 때 추천 API는 503을 반환했고 파일을 복구하면 새 실행 문맥에서 다시 추천했다.
- 고정 계약 입력을 반복 계산하고 시설·경로 목록 순서를 바꿔도 결과가 동일했다. 같은 모의 HTTP 요청을 반복했을 때는 시설·비용·선호·대기·경로가 같고 스냅샷 버전은 증가했다.

영속 세션, 실제 엔진의 상태 공급, 임의 좌표의 동적 광장 경로, 수락·보상, 휴대폰 접속과 AWS는 이후 검증 범위다.

## 자이로드롭 출구 지도 변경 후 재검증

자이로드롭 출구·복귀 동선과 주변 건물 영역을 수정한 지도에서 이전 해시의 모의 데이터를 읽으면 `mock_data_unavailable`이 발생했다. 현행 지도에서 18개 경로를 다시 생성하고 공통 계약 JSON 예제 3개의 해시와 입출구 참조를 대조했다. `west-center`에서 출발하는 예제 경로는 기존 경유점·거리와 일치했다. 실행 중인 `127.0.0.1:8767`에서 새 문맥을 조회하고 예제 POST를 보내 자이로스핀 추천, 2순위, 300초, 약 57.8m를 확인했다.

참여자가 PowerShell에서 예제 GET과 POST를 다시 실행해 자이로스핀·대기 300초·경로 약 57.8m를 직접 확인했다. 매직아일랜드 Python 테스트 26개와 Node 경로 검사 2개도 재검증했다. Python 첫 실행에서는 64KiB 초과 요청 검사 중 Windows 연결이 한 차례 끊겼고, 재실행에서는 26개가 모두 통과했다.
