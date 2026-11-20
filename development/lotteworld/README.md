# 롯데월드 매직아일랜드

이 폴더는 아쿠아리움과 별도로 실행하는 Python 3.11 이상 프로젝트다. 추가 Python 패키지는 필요하지 않으며 아쿠아리움 코드·설정·화면을 불러오지 않는다.

체크리스트 1–8번에서 시나리오·설정 분리, 3D 지도·시설 표시, 연속 유입·개인 체류·퇴장, 물리적 대기열과 승하차 보행, 회차·차량 운행, 방문객 선호와 반복 이용, 연속 시연 화면과 운영 지표를 구현했다. 안내도 배치를 참고한 섬·성·다리와 여섯 시설의 입체 모형 위에 엔진의 보행·대기열·시설 운영 상태와 QR 캐릭터를 표시한다.

로컬 서버에서 모의 시설 현황과 경로로 놀이기구 한 곳을 추천할 수 있다. 시뮬레이션 기본 화면에는 시간 표시·재생바 없이 3D 지도를 배치한다. 진행 상태는 [체크리스트](../docs/implementation-checklist.md)를 따른다.

## 실행

이 폴더에서 다음 명령을 사용한다.

```powershell
./run.ps1
python -m lotteworld_sim.server --port 8767
python -m lotteworld_sim.server --validate-only
python -m lotteworld_sim.cli --validate-only --output output/scenario-metadata.json
python -m unittest discover -s tests -v
```

[매직아일랜드 지도](http://127.0.0.1:8767)를 열면 3D 지도가 화면 대부분을 채운다. 브라우저 전체 화면 버튼으로 큰 화면에 띄울 수 있다. 지도에서 시설 모형·이름표를 선택하거나 **시설 찾기**에서 시설을 고르면 상세 패널이 열린다. 패널에서 동선 보기로 다리와 시설 입출구 사이의 참조 경로와 거리, 시설 가까이 보기로 확대 시점을 확인한다. 닫기 또는 Esc 키로 상세를 닫는다.

왼쪽 드래그는 회전, 오른쪽 드래그는 이동, 휠은 확대·축소다. 터치는 한 손가락 회전, 두 손가락 확대·이동이다. 지도 위 집계는 배경 방문객의 총유입·체류·총퇴장과 QR 참여 인원을 보여 준다. 시설 상세에서는 누적 회차·대기·탑승 인원 및 차량 상태를, QR 캐릭터를 선택하면 진행 상태와 모의 추천 경로를 확인할 수 있다. [시뮬레이션 웹 요구사항](../docs/simulation-web.md)

서버를 시작하면 배경 방문객의 유입·보행·대기·퇴장과 여섯 시설의 회차 운행이 자동으로 진행되며 Ctrl+C로 종료한다. `GET /api/meta`는 지도 준비 상태 `map_ready: true`와 배경 순환 상태 `status: continuous_running`, `runnable: true`를 반환한다. 아래 명령으로 인원·대기열과 아트란티스 차량을 확인할 수 있다.

```powershell
$state = Invoke-RestMethod http://127.0.0.1:8767/api/state
$state.background | Select-Object target_people, entered_total, present_people, exited_total
$state.background.queues
$state.rides.atlantis.vehicles
$state.qr.characters
```

`configs/continuous.json`을 수정하고 서버를 재시작하면 연속 시연 인원·체류·배속을 바꿀 수 있다. 발표 중에는 `--no-reload`로 실행해 Python 저장에 따른 자동 재시작을 끌 수 있다. `--config 경로`는 이전 일일 시간표 검증용 입력을 지정한다. CLI의 `--validate-only`는 설정 메타데이터를 출력한다. [설정과 상태 계약](docs/configuration.md#연속-시연-설정과-상태)

## QR 사용자 진입과 선호 입력

서버를 실행하고 [공통 QR 진입 주소](http://127.0.0.1:8767/user?sign_id=magic-island-west)를 연다. QR에는 `http://<접속 가능한 서버 주소>:8767/user?sign_id=magic-island-west`를 넣는다. 같은 네트워크의 휴대폰에서 시험할 때는 PC의 LAN 주소를 사용하고 서버에 `--host 0.0.0.0`을 넘긴다.

```powershell
python -m lotteworld_sim.server --host 0.0.0.0 --port 8767
```

시설 손잡이를 끌어 표지판 안내 대상인 **자이로스핀·혜성특급·자이로드롭**의 1~3순위를 정한 뒤 **선호 저장**을 누른다. 사용자 지도는 내 캐릭터를 따라가며 모의 추천 목적지 이름을 누르면 경로 전체를 보여 준다. 지도를 직접 움직였으면 **내 캐릭터 다시 따라가기**로 돌아갈 수 있다. 전체 지도에서 **QR 참여** 목록의 캐릭터를 선택하면 해당 위치를 확대한다. 같은 브라우저에서 다시 열면 연결된 캐릭터와 저장 순위가 복구된다. 독립 브라우저 프로필은 별도 세션을 받는다.

**추천 수락하고 출발**을 누르면 가상 캐릭터가 시설 입구로 걸어가 배경 방문객과 같은 줄에 선다. 차례가 되면 실제 시뮬레이션 차량에 탑승하고, 운행이 끝나면 출구를 지나 공공 보행로까지 걸어간다. 전체 지도와 사용자 웹에서 같은 대기 순서·차량 번호·하차 상태를 확인한다. 차량의 월드 좌표가 제공되지 않는 구간에는 양쪽 지도에서 시설의 탑승 기준점에 차량 탑승 표식을 표시한다. 수락 보상과 하차 후 다음 추천은 후속 범위다.

| HTTP | 입력과 결과 |
| --- | --- |
| `POST /api/user/session` | JSON으로 `contract_version: "recommendation.v1"`과 `sign_id: "magic-island-west"`를 전달한다. 새 세션이면 30분 유효한 `HttpOnly`, `SameSite=Strict` 쿠키를 발급한다. 유효한 쿠키를 보내면 기존 세션을 반환한다. |
| `GET /api/user/session` | 발급된 쿠키로 세션을 조회한다. 진입·조회·선호 저장의 응답은 `context`, `session`, `character`, `sign`, `facilities`, `offer`, `time_scale`을 제공한다. `character`는 전체 지도와 같은 형식의 공개 캐릭터 상태이며 `offer`는 수락 가능한 추천이다. |
| `PUT /api/user/preferences` | 쿠키와 JSON의 `contract_version`, `context`, `session_id`, `expected_revision`, `preference_order`를 보낸다. 안내 대상 세 시설 ID를 각각 한 번씩 순위에 넣는다. 첫 유효 저장은 phase를 `ready`로, revision을 0에서 1로 바꾼다. 이후 순위를 바꾸면 revision이 증가한다. 동일 저장 재시도는 한 번만 반영된다. |
| `GET /api/user/recommendation` | 쿠키로 확인한 `ready` 세션의 위치와 선호를 사용한다. `sign-baseline-v1`은 표지판의 세 시설을 평가한다. 응답의 `source.kind`는 `mock`이다. |
| `POST /api/user/recommendation/accept` | 쿠키와 현재 추천의 실행 문맥·세션 및 추천 ID·revision·snapshot 번호·요청 ID를 확인하고 서버에 저장된 경로로 출발한다. 한 세션의 이용은 같은 엔진에서 한 번 처리하며 같은 요청을 다시 보내면 같은 수락 결과를 반환한다. |

등록되지 않은 표지판은 404, 잘못된 순열은 400, 유효한 세션 자격이 없으면 401, 만료 또는 실행·revision 충돌과 선호 미입력은 409를 반환한다. 현재 지도에서 초기 배치가 불가능하거나 모든 자리가 사용 중이면 503을 반환한다.

기본 시연에서는 표지판의 세 시설이 모두 정상 운행하며 대기열에 합류할 수 있다. 모의 예상 대기는 자이로스핀 5분, 혜성특급 8분, 자이로드롭 15분이다.

표지판은 가상 좌표 `[101, 149]`m에 있다. 서버는 현재 지도와 `west-center` 연결을 검증한 반경 12m 이내의 좌표 중 하나를 배정한다. 현재 지도에는 간격 2m의 유효 배치 102곳이 있다. 추천 경로에는 캐릭터의 좌표에서 `west-center`까지의 연결 구간과 이후 시설 입구까지 기존 모의 경로가 포함된다. 사용자 추천을 지원하는 모의 파일은 `west-center` 경로를 포함해야 한다.

세션은 발급 시각부터 실제 시간으로 30분간 유효하다. 재접속은 만료 시각을 연장하지 않는다. 만료된 캐릭터는 전체 지도와 사용자 웹의 다음 상태 갱신에서 사라지고, 다음 QR 진입 때 배치 자리를 회수한다. 세션은 연속 실행과 같은 `run_id`를 사용한다. 서버 재시작 후 QR 주소에서 새 세션을 받고, 모의 추천 파일을 갱신하는 동안에는 기존 실행과 세션을 유지한다. [상태 계약](docs/configuration.md#연속-시연-설정과-상태)

## 로컬 추천 API

이 폴더에서 주소·포트·모의 데이터 파일을 지정해 서버를 실행한다. 예제에 사용한 값은 기본값과 같다. 추천 계산과 HTTP 서버는 Python 표준 라이브러리로 실행된다.

```powershell
python -m lotteworld_sim.server --host 127.0.0.1 --port 8767 --mock-data configs/recommendation-mock.json
```

다른 PowerShell 창에서 실행 문맥·시설 ID·사용 가능한 시작 위치를 조회하고 추천을 요청한다. `session_id`, `character_id`, `revision`은 개발용 참조값이다. 선호는 6개 시설의 전체 순서다.

```powershell
$base = 'http://127.0.0.1:8767'
$mock = Invoke-RestMethod "$base/api/recommendation/mock" -ErrorAction Stop
$position = $mock.positions | Where-Object { $_.node_id -eq 'west-center' }
$request = @{
    contract_version = $mock.contract_version
    context = $mock.context
    session_id = 'session-local-001'
    character_id = 'character-local-001'
    revision = 1
    position = $position
    preference_order = @('atlantis', 'gyro-spin', 'gyro-drop', 'arcana-ride', 'comet-express', 'gyro-swing')
}
$result = Invoke-RestMethod "$base/api/recommendation" -Method Post -ContentType 'application/json' -Body ($request | ConvertTo-Json -Depth 8)
$result | ConvertTo-Json -Depth 12
```

기본 파일의 이 요청은 자이로스핀(`gyro-spin`), 선호 2순위, 예상 대기 300초, 가상 보행 경로 약 61.8m를 반환한다. 응답에는 경로·한국어 이유·제외 사유·`source.kind: mock`·`snapshot_seq`·평가 및 만료 시각이 들어 있다. 같은 모의 값과 위치·선호를 다시 요청하면 선택과 근거가 같다. 요청마다 새 모의 관측을 계산하므로 시각·스냅샷 번호·추천 ID는 새로 발행한다.

| HTTP | 결과 |
| --- | --- |
| 200 | `recommended` 또는 `no_candidate`. 후보가 없으면 `recommendation: null`과 시설별 제외 사유를 반환한다. |
| 400 | 필수 필드·선호 순서·좌표·JSON 오류인 `invalid_input` 또는 `unsupported_version` |
| 409 | 현재 지도·모의 실행과 다른 `context_mismatch`. 실행 정보를 다시 조회해 요청한다. |
| 413·415 | 64KiB를 넘는 본문 또는 `application/json` 이외의 형식 |
| 503 | `mock_data_unavailable`. 모의 파일의 형식·경로·지도 해시를 확인한다. |

기본 경로 표는 `west-center`, `west-north`, `west-spin`에서 6개 시설 입구까지의 `open-plaza-v1` 경유점을 제공한다. 경로를 조회하려면 지원하는 `node_id`와 일치하는 `point`를 보낸다. 경로 표에 등록되지 않은 공공 보행 위치나 `node_id: null`인 유효 좌표는 `route_unavailable`로 제외한다. 위치가 지도 밖이나 전용 구역에 있으면 입력 오류를 반환한다. 이 개발용 API는 테스트용 세션 사본과 시설 현황을 요청마다 생성한다. QR 세션의 추천 연동은 `GET /api/user/recommendation`을 사용한다.

`--mock-data`는 시설별 운영·대기 상태와 경로 표를 읽을 JSON을 지정한다. 파일이나 시나리오 설정이 바뀌면 새 `run_id`를 발급한다. 지도 변경 또는 출발 노드 추가 시 `node_routes`의 키를 확인한 뒤 다음 명령으로 지도 해시와 경로 표를 함께 갱신한다. `--check`를 마지막에 붙이면 파일을 쓰지 않고 일치 여부를 검사한다.

```powershell
python -m lotteworld_sim.cli --validate-only --output output/scenario-metadata.json | Out-Null
node scripts/generate_mock_routes.mjs output/scenario-metadata.json configs/recommendation-mock.json
```

`GET /api/recommendation/mock`에서 지도 해시 불일치가 나오면 위 명령으로 모의 경로를 갱신한 뒤 GET을 다시 호출한다. 성공 응답의 `contract_version`, `context`, `positions`를 사용해 POST 본문을 새로 만든다.

[공통 데이터 계약 v1](../docs/contracts/recommendation-v1.md)과 [로컬 추천 검증 기록](../docs/verification/recommendation-server-minimum.md)을 참고한다.

## 설정과 개발 범위

- `configs/map.json`: 6개 시설의 독립 ID·1회 탑승 정원, 가상 좌표·구획·연결 그래프·대기 자리 배치 규칙. 1회 정원의 2.5배 이상을 몸체·간격·회전 여백까지 검사하며 이 배치를 런타임 예약에도 사용한다.
- `configs/day.json`은 이전 시간표 계획의 10–19시 관측·계획 진입 10,350명·개인 예정 체류 120–240분과 출처를 보존한다. 서버는 이 값의 일관성을 검증한다.
- `configs/continuous.json`은 연속 시연에 적용할 초기·목표 인원, 보충 간격, 개인 체류 범위와 배속을 정의한다.
- `configs/preferences.json`은 시설별 가중치와 0–5의 유형별 선호 점수, 대기 허용 시간 범위, 재탑승 감점을 설정한다. [행동 설정과 상태 필드](docs/configuration.md#방문객-선호와-반복-이용)

세부 계약은 [설정 계약](docs/configuration.md), 개발 기준은 [명세](../docs/design.md), 다음 작업은 [체크리스트](../docs/implementation-checklist.md)를 따른다. 두 폴더를 동시에 실행해도 아쿠아리움 기본 포트8765와 겹치지 않는다.

## 대기줄과 보행 광장

6개 시설에 반원 회전부와 이탈 게이트가 있는 접힌 대기줄을 표시한다. 방문객은 초록 입구부터 대기 자리에 합류하고 앞자리가 나면 황금색 탑승 진입점 쪽으로 전진한다. 만석이면 다른 시설로 향한다. 하차 보행이 시작되면 빨간 출구를 한 명씩 1 내부 초 간격으로 통과한 뒤 공공 보행로에 합류한다. 대기열 집계는 `/api/state`에서 확인할 수 있다. 지도 라벨과 시설 상세에는 자리 수를 표시하지 않는다. [물리적 대기열 검증](../docs/verification/magic-island-physical-queues-and-boarding.md)

## 지도 검증

[3D 지도 검증 기록](../docs/verification/magic-island-map3d.md)에 검사 범위와 결과를 정리했다. 전용 Python 검사, `node tests/route.test.mjs`, `node tests/verify_map3d.cjs`를 사용한다. 브라우저 검사는 개발용 Playwright와 설치된 Chrome이 필요하며 임시 포트의 검증 서버를 자동 시작·종료한다. `MAGIC_MAP_URL`을 지정하면 실행 중인 서버를 사용하고, `PLAYWRIGHT_CHANNEL`로 Chrome 외 채널을 선택할 수 있다. 자동 서버의 Python 경로는 `PYTHON`으로 지정할 수 있다. 런타임 서버에는 Node·Playwright·외부 CDN이 필요하지 않으며 Three.js는 로컬 사본을 제공한다. [재사용·라이선스](docs/reuse.md)를 참고한다.

PowerShell이 `run.ps1`을 차단하면 실행 정책 변경 없이 다음 명령을 이 폴더에서 사용한다.

```powershell
& "C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe" -m lotteworld_sim.server --port 8767
```

`node tests/navigation.test.mjs`로 접힌 대기줄·광장 경로·장애물 우회를 검사한다.

## 저장 후 새로고침

기본 실행은 개발 자동 반영 모드다. HTML·CSS·JavaScript·지도·일일 운영·시설 운행·선호 JSON은 저장 후 브라우저를 새로고침하면 최신 내용을 읽는다. 설정 오류는 HTTP 422로 알리고 올바르게 저장하면 같은 서버에서 복구한다. Python 파일을 저장하면 같은 포트에서 새 서버 프로세스를 시작하며 배경 실행과 QR 세션도 새로 시작된다.

`--no-reload`를 사용해도 자동 반영 대상 설정과 정적 파일은 새로고침으로 반영된다. `/api/state`에 사용하는 지도·연속 시연·시설 운행 설정은 서버를 다시 시작할 때 적용된다. `--validate-only`는 설정과 보행 경로를 검증한 뒤 종료한다.

최종 제품의 QR 관람객 화면·영상 기반 분석 및 추천 서버·관리자 대시보드와 시뮬레이션의 관계는 [최종 소프트웨어 계획](../docs/software-plan.md)을 따른다.
