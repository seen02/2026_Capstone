# 롯데월드 매직아일랜드

이 폴더는 아쿠아리움과 별도로 실행하는 Python 3.11 이상 프로젝트다. 추가 Python 패키지는 필요하지 않으며 아쿠아리움 코드·설정·화면을 불러오지 않는다.

체크리스트 1–8번에서 시나리오·설정 분리, 3D 지도·시설 표시, 연속 유입·개인 체류·퇴장, 물리적 대기열과 승하차 보행, 회차·차량 운행, 방문객 선호와 반복 이용, 연속 시연 화면과 운영 지표를 구현했다. 안내도 배치를 참고한 섬·성·다리와 여섯 시설의 입체 모형 위에 엔진의 보행·대기열·시설 운영 상태와 QR 캐릭터를 표시한다.

로컬 서버에서 모의 시설 현황과 경로로 놀이기구 한 곳을 추천할 수 있다. 시뮬레이션 기본 화면에는 시간 표시·재생바 없이 3D 지도를 배치한다. 진행 상태는 [체크리스트](../docs/implementation-checklist.md)를 따른다.

## 실행

이 폴더에서 다음 명령을 사용한다. 배포 전 로컬 개발과 시연에는 기본 포트 `3000`을 사용한다.

```powershell
./run.ps1
python -m lotteworld_sim.server --port 3000
python -m lotteworld_sim.server --validate-only
python -m lotteworld_sim.cli --validate-only --output output/scenario-metadata.json
python -m unittest discover -s tests -v
```

[매직아일랜드 지도](http://127.0.0.1:3000)를 열면 3D 지도가 화면 대부분을 채운다. 브라우저 전체 화면 버튼으로 큰 화면에 띄울 수 있다. **전체 보기**와 **위에서 보기**로 지도 시점을 바꾼다. 지도 위 시설 모형이나 이름표를 고르면 상세 패널이 열린다. 키보드로는 Tab 키로 이름표에 초점을 맞추고 Enter 키를 누른다. 패널의 **시설 가까이 보기**로 선택한 시설을 확대하고, 닫기 버튼이나 Esc 키로 상세를 닫는다.

왼쪽 드래그는 회전, 오른쪽 드래그는 이동, 휠은 확대·축소다. 터치는 한 손가락 회전, 두 손가락 확대·이동이다. 지도 위 집계는 현재 체류와 QR 참여를 보여 준다. 시뮬레이션 시설 상세에서는 운행 상태·대기 인원·예상 대기·탑승 인원을 확인한다. 누적 입장·퇴장은 운영자 대시보드의 방문객 흐름에, 누적 회차·합류 전 인원·차량별 상태는 대시보드의 시설 상세에 표시한다. QR 캐릭터를 선택하면 진행 상태와 추천 경로를 확인할 수 있다. [시뮬레이션 웹 요구사항](../docs/simulation-web.md)

서버를 시작하면 배경 방문객의 유입·보행·대기·퇴장과 여섯 시설의 회차 운행이 자동으로 진행되며 Ctrl+C로 종료한다. `GET /api/meta`는 지도 준비 상태 `map_ready: true`와 배경 순환 상태 `status: continuous_running`, `runnable: true`를 반환한다. 아래 명령으로 인원·대기열과 아트란티스 차량을 확인할 수 있다.

```powershell
$state = Invoke-RestMethod http://127.0.0.1:3000/api/state
$state.background | Select-Object target_people, entered_total, present_people, exited_total
$state.background.queues
$state.rides.atlantis.vehicles
$state.qr.characters
```

`configs/continuous.json`을 수정하고 서버를 재시작하면 연속 시연 인원·체류·배속을 바꿀 수 있다. 서버와 CLI에서 `--config 경로`로 별도 연속 시연 설정을 지정할 수 있다. 발표 중에는 `--no-reload`로 Python 저장에 따른 자동 재시작을 끈다. CLI의 `--validate-only`는 설정 메타데이터를 출력한다. [설정과 상태 계약](docs/configuration.md#연속-시연-설정과-상태)

## QR 사용자 진입과 선호 입력

서버를 실행하고 [공통 QR 진입 주소](http://127.0.0.1:3000/user?sign_id=magic-island-west)를 연다. QR에는 `http://<접속 가능한 서버 주소>:3000/user?sign_id=magic-island-west`를 넣는다. 같은 네트워크의 휴대폰에서 시험할 때는 PC의 LAN 주소를 사용하고 서버에 `--host 0.0.0.0`을 넘긴다.

```powershell
python -m lotteworld_sim.server --host 0.0.0.0 --port 3000
```

QR을 열면 **Magic Pass** 로딩 화면이 나타난 뒤 선호 순위, 추천 놀이기구와 예상 대기, 3D 지도를 표시한다. 첫 접속에서는 표지판 안내 대상인 **자이로스핀·혜성특급·자이로드롭**의 기본 순위로 추천을 받는다. 각 행의 손잡이를 위아래로 끌어 놓거나 방향키를 누르면 순위를 자동 저장하고 추천과 경로를 갱신한다. 같은 브라우저에서 다시 열면 연결된 캐릭터와 저장 순위가 복구된다. 독립 브라우저 프로필은 별도 세션을 받는다. [디자인 요구사항](../docs/user-web.md)

사용자 지도에는 추천 경로가 자동으로 표시되며, 내 캐릭터를 중심으로 회전·확대할 수 있다. 전체 지도에서 **QR 참여** 목록의 캐릭터를 선택하면 해당 위치를 확대한다.

**수락하고 출발**을 누르면 가상 캐릭터가 시설 입구로 걸어가 배경 방문객과 같은 줄에 선다. 사용자 웹의 추천 카드에는 대기 순서와 시뮬레이션 예상 대기 시간이 표시된다. 이후 버튼 자리에 **탑승 중**, **이용 중**, **하차 중** 상태가 나온다. 전체 지도에서 같은 캐릭터와 차량을 확인할 수 있다. 차량의 월드 좌표가 제공되지 않는 구간에는 양쪽 지도에서 시설의 탑승 기준점에 차량 탑승 표식을 표시한다.

하차를 마치고 공공 보행로에 도착하면 이번 바퀴에서 아직 타지 않은 이용 가능한 기구를 먼저 추천한다. 세 기구의 하차를 모두 마치거나 순위가 바뀌면 새 바퀴를 시작한다. 그 첫 추천에서는 방금 탄 기구를 제외한다. 후보는 저장된 선호 순위, 그 시점의 시뮬레이션 예상 대기 시간, 이동 거리로 비교하고, 경로는 캐릭터의 현재 위치에서 시작한다. 수락 보상은 후속 범위다.

| HTTP | 입력과 결과 |
| --- | --- |
| `POST /api/user/session` | JSON으로 `contract_version: "recommendation.v1"`과 `sign_id: "magic-island-west"`를 전달한다. 유효한 쿠키가 있으면 기존 세션을 복구하고 5분 만료를 갱신한다. 새 세션도 5분 유효한 `HttpOnly`, `SameSite=Strict` 쿠키를 발급한다. |
| `GET /api/user/session` | 발급된 쿠키로 세션을 조회하고 만료 시각과 쿠키를 갱신한다. 진입·조회·선호 저장의 응답은 `context`, `session`, `character`, `sign`, `facilities`, `offer`, `time_scale`을 제공한다. 공개 캐릭터의 `queued` 상태에는 `queue_position`과 `queue_wait_sim_s`가 포함된다. `offer`는 수락 가능한 추천이다. |
| `PUT /api/user/preferences` | 쿠키와 JSON의 `contract_version`, `context`, `session_id`, `expected_revision`, `preference_order`를 보낸다. 안내 대상 세 시설 ID를 각각 한 번씩 순위에 넣는다. 첫 유효 저장은 phase를 `ready`로, revision을 0에서 1로 바꾼다. 이후 순위를 바꾸면 revision이 증가한다. 동일 저장 재시도는 한 번만 반영된다. |
| `GET /api/user/recommendation` | 쿠키로 확인한 세션의 위치와 선호를 사용한다. `completed`에서 호출하면 하차 후 위치로 `ready`를 시작한다. `sign-baseline-v1`은 표지판의 세 시설을 평가한다. 응답의 `source.kind`는 `simulation`이다. |
| `POST /api/user/recommendation/accept` | 쿠키와 현재 추천의 실행 문맥·세션 및 추천 ID·revision·snapshot 번호·요청 ID를 확인하고 서버에 저장된 경로로 출발한다. 한 세션에는 동시에 이용 한 건만 연결하며, 같은 요청을 다시 보내면 같은 수락 결과를 반환한다. |

등록되지 않은 표지판은 404, 잘못된 순열은 400, 유효한 세션 자격이 없으면 401, 만료 또는 실행·revision 충돌과 선호 미입력은 409를 반환한다. 현재 지도에서 초기 배치가 불가능하거나 모든 자리가 사용 중이면 503을 반환한다.

첫 추천과 다음 추천은 요청 시점의 시뮬레이션 대기열로 계산한다. 시설별 예상 대기는 `/api/state`의 `estimated_wait_sim_s`와 같은 방식으로 추정하며, 대기열이 가득 찼거나 운행하지 않는 시설은 추천에서 제외한다.

서쪽 안내판은 가상 보행로의 `[123, 111]`m에 있다. 새 QR 캐릭터는 안내판에서 입구 다리 쪽으로 향하는 앞부분에 배치된다. 반경 12m의 2m 격자에서 공공 보행 여유 0.75m와 안내판까지의 보행 연결을 확인한 뒤 빈 위치를 배정한다. 사용자 추천은 캐릭터 현재 위치에서 시설 입구까지의 경로를 추천 점수, 지도 표시와 수락 후 이동에 사용한다.

마지막 QR 진입 또는 사용자 웹의 세션 조회로부터 실제 시간 5분 동안 접속 신호가 없으면 참여가 종료된다. 같은 브라우저에서 5분 안에 다시 열면 기존 캐릭터와 대기 순서를 이어간다. 자리를 비운 동안에도 시설 운행과 대기줄은 계속 진행한다. 만료된 캐릭터는 전체 지도의 다음 상태 갱신에서 사라지며 대기 자리는 이탈 통로를 통해 정리한다. 세션은 연속 실행과 같은 `run_id`를 사용한다. 서버를 재시작한 뒤에는 QR 주소에서 새 세션을 받는다. [상태 계약](docs/configuration.md#연속-시연-설정과-상태)

## 설정과 개발 범위

- `configs/map.json`: 6개 시설의 독립 ID·1회 탑승 정원, 가상 좌표·구획·연결 그래프·대기 자리 배치 규칙. 1회 정원의 2.5배 이상을 몸체·간격·회전 여백까지 검사하며 이 배치를 런타임 예약에도 사용한다.
- `configs/continuous.json`은 연속 시연에 적용할 초기·목표 인원, 보충 간격, 개인 체류 범위와 배속을 정의한다.
- `configs/preferences.json`은 시설별 가중치와 0–5의 유형별 선호 점수, 대기 허용 시간 범위, 재탑승 감점을 설정한다. [행동 설정과 상태 필드](docs/configuration.md#방문객-선호와-반복-이용)

세부 계약은 [설정 계약](docs/configuration.md), 개발 기준은 [명세](../docs/design.md), 다음 작업은 [체크리스트](../docs/implementation-checklist.md)를 따른다. 두 폴더를 동시에 실행해도 아쿠아리움 기본 포트8765와 겹치지 않는다.

## 대기줄과 보행 광장

6개 시설에 반원 회전부와 이탈 게이트가 있는 접힌 대기줄을 표시한다. 방문객은 초록 입구부터 대기 자리에 합류하고 앞자리가 나면 황금색 탑승 진입점 쪽으로 전진한다. 만석이면 다른 시설로 향한다. 하차 보행이 시작되면 빨간 출구를 한 명씩 1 내부 초 간격으로 통과한 뒤 공공 보행로에 합류한다. 대기열 집계는 `/api/state`에서 확인할 수 있다. 지도 라벨과 시설 상세에는 자리 수를 표시하지 않는다. [물리적 대기열 검증](../docs/verification/magic-island-physical-queues-and-boarding.md)

## 지도 검증

[3D 지도 검증 기록](../docs/verification/magic-island-map3d.md)에 검사 범위와 결과를 정리했다. 전용 Python 검사, `node tests/route.test.mjs`, `node tests/verify_map3d.cjs`를 사용한다. 브라우저 검사는 개발용 Playwright와 설치된 Chrome이 필요하며 임시 포트의 검증 서버를 자동 시작·종료한다. `MAGIC_MAP_URL`을 지정하면 실행 중인 서버를 사용하고, `PLAYWRIGHT_CHANNEL`로 Chrome 외 채널을 선택할 수 있다. 자동 서버의 Python 경로는 `PYTHON`으로 지정할 수 있다. 런타임 서버에는 Node·Playwright·외부 CDN이 필요하지 않으며 Three.js는 로컬 사본을 제공한다. [재사용·라이선스](docs/reuse.md)를 참고한다.

PowerShell이 `run.ps1`을 차단하면 실행 정책 변경 없이 다음 명령을 이 폴더에서 사용한다.

```powershell
& "C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe" -m lotteworld_sim.server --port 3000
```

`node tests/navigation.test.mjs`로 접힌 대기줄·광장 경로·장애물 우회를 검사한다.

## 저장 후 새로고침

기본 실행은 개발 자동 반영 모드다. HTML·CSS·JavaScript를 저장한 뒤 브라우저를 새로고침하면 최신 화면을 읽는다. 설정 조회도 JSON의 최신 내용을 읽으며 유효하지 않은 설정은 HTTP 422로 알린다. Python 파일을 저장하면 같은 포트에서 새 서버 프로세스를 시작한다.

`map.json`의 해안이나 식재를 바꾼 경우 서버를 한 번 재시작한 뒤 두 웹을 새로고침한다. `/api/state`의 지도·연속 시연·시설 운행 설정은 서버 시작 때 읽으며, 재시작하면 시연과 QR 세션도 새로 시작된다. `--no-reload`에서도 정적 파일은 새로고침으로 반영된다. `--validate-only`는 설정과 보행 경로를 검증한 뒤 종료한다.

통합 운영 앱, QR 관람객 화면과 영상 기반 분석·추천 서버의 역할은 최종 소프트웨어 계획에 정리했다. [최종 소프트웨어 계획](../docs/software-plan.md)
