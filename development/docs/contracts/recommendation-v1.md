# 추천·시뮬레이션 공통 데이터 계약 v1

매직아일랜드 추천과 시뮬레이션의 공통 계약이다. 개발용 모의 추천과 QR 사용자 추천은 2–7절의 계산을 공유한다. 연속 시연 서버는 `GET /api/meta`로 설정을, `GET /api/state`로 실행 중인 시뮬레이션 상태를 제공한다. HTTP 요청·응답 형식은 [로컬 추천 API](../../lotteworld/README.md#로컬-추천-api)와 [QR 사용자 진입 API](../../lotteworld/README.md#qr-사용자-진입과-선호-입력)에 있다.

2026-11-18에 보상 조건과 예제를 정정했다. 서버가 유효한 **추천 수락을 확정한 것**에 대해 보상을 지급한다. 이동·대기·탑승·이용 완료는 지급 조건에 포함되지 않는다.

## 1. 범위와 원본

모의 시설 현황으로 추천을 먼저 개발한 뒤, 같은 `RecommendationInput`에 시뮬레이션 상태 공급자를 연결한다. QR 사용자 한 세션과 가상 캐릭터 하나를 연결하며 휴대폰 GPS를 사용하지 않는다. 영상의 사람 수를 시뮬레이션 정답 인원으로 바꾸거나 모의 이용 완료로 실제 이용을 인증하지 않는다.

| 원본 | 계약에 사용하는 사실 |
| --- | --- |
| `lotteworld/configs/map.json` | 시설 ID 6개, 입출구 노드, 가상 미터 좌표, `schema_version: 1` |
| `lotteworld/configs/day.json` | 이전 시간표의 관측 시작 10:00·종료 19:00, `world_of_light`, 강제 퇴장 없음. 현재 파일/검증기에 남아 있는 설정이며 연속 시연 종료 조건은 아님 |
| `lotteworld/configs/preferences.json` | 시설별 0–5 기준형 선호. QR 순위 입력으로 자동 변환하지 않음 |
| `lotteworld/lotteworld_sim/scenario.py`의 `Scenario.metadata()` | `hashes.map/config/preferences`와 설정 메타데이터. 실행 ID는 아님 |
| `lotteworld/web/navigation.mjs`의 `createNavigator()` | 정적 광장 경로, 장애물 회피, 거리 합. 실제 보행·혼잡 시간 계산은 아님 |
| [설정 계약](../../lotteworld/docs/configuration.md) | 좌표·구획·준비 상태·설정 갱신의 기존 규칙 |

아쿠아리움의 `web-admin/contracts`는 별도 시나리오 계약이며 변경하거나 가져오지 않는다. 실제 카메라·관측 구역과 영상 전송 형식은 별도 계약에서 정의한다.

## 2. 공통 표기와 버전

아래 표의 필드는 별도 표시가 없으면 **필수**다. `T | null`은 키를 생략하지 않고 `null`을 허용한다는 뜻이다. 문자열 ID는 비어 있지 않은 불투명 식별자다. 숫자는 유한한 JSON 숫자이며 정수 필드에 boolean·소수·음수를 허용하지 않는다. 좌표는 음수를 일괄 허용하는 것이 아니라 해당 지도 경계·보행 규칙으로 검사한다. `NaN`, `Infinity`, 임의의 `-1` 미집계 표기는 금지한다.

최상위 `contract_version`은 문자열 `recommendation.v1`이다. 기존 설정의 정수 `schema_version`과 별개다. 선택 필드 추가는 v1 안에서 가능하며 소비자는 모르는 선택 필드를 무시할 수 있다. 필수 필드·단위·상태 의미를 바꾸면 계약 버전을 올린다. 알 수 없는 상태 enum·계약 버전은 추정하지 않고 거절한다. ID 비교는 대소문자를 구분하며 시설명은 식별자로 사용하지 않는다.

### Context

모든 입력·추천·명령·이벤트·보상에 `context`를 포함한다. 아래 네 필드가 모두 같아야 같은 세계의 자료다.

| 필드 | 자료형 | 의미 |
| --- | --- | --- |
| `scenario_id` | string | v1은 `magic-island` 고정 |
| `map_hash` | string | `/api/meta`의 `hashes.map` 그대로인 SHA-256 소문자 64자리. 지도 버전 역할 |
| `run_id` | string | 상태 공급 실행마다 새 ID. 모의 실행도 고유 ID를 발급 |
| `timeline_epoch` | integer ≥ 0 | 같은 실행 안의 재생 분기. seek·초기화 시 증가 |

`map_hash`는 `json.dumps(map, ensure_ascii=False, sort_keys=True, allow_nan=False).encode("utf-8")`의 SHA-256이다. 구분자 기본 공백까지 기존 Python 구현과 같아야 하므로 다른 언어에서 임의로 JSON을 정규화해 새 값을 만들지 않는다. 메타데이터 값을 전달하는 방법을 우선한다. `/api/dev-version.version`은 정적 파일까지 포함하므로 지도 버전으로 쓰지 않는다.

발행한 스냅샷은 불변이다. 같은 `(context, snapshot_seq)`로 다른 내용을 발행하지 않는다. 입력 조립 중 세션 revision이 바뀌면 해당 위치로 계산한 경로와 추천 입력을 버리고 다시 읽는다. 문맥이 다른 상태를 한 묶음으로 합치지 않는다.

공급자는 실행 시작 시 지도·운영·선호 설정 해시와 시드를 고정해 실행 기록에 보관한다. 지도/운영 설정 변경이나 서버 재시작 시 새 `run_id`를 사용한다. 실행 중 지도 자동 갱신으로 기존 세션 좌표를 재해석하지 않는다. 되감기/seek는 `timeline_epoch`를 증가시키고 이전 추천·명령을 무효화한다. v1에서는 이전 epoch의 QR 세션을 `ended`로 종료하고 새 세션·캐릭터로 다시 시작한다. 단순 배속 변경·일시정지는 epoch를 바꾸지 않는다.

## 3. 시설·지도·위치

| `facility_id` | 표시명 | 대기 입구 노드 | 이용 후 출구 노드 |
| --- | --- | --- | --- |
| `atlantis` | 아트란티스 | `atlantis-entry` | `atlantis-exit` |
| `gyro-drop` | 자이로드롭 | `gyro-drop-entry` | `gyro-drop-exit` |
| `gyro-swing` | 자이로스윙 | `gyro-swing-entry` | `gyro-swing-exit` |
| `gyro-spin` | 자이로스핀 | `gyro-spin-entry` | `gyro-spin-exit` |
| `comet-express` | 혜성특급 | `comet-express-entry` | `comet-express-exit` |
| `arcana-ride` | 아르카나라이드 | `arcana-ride-entry` | `arcana-ride-exit` |

위 이름·노드의 실제 좌표는 지도에서 조회한다. `entrance`는 줄 합류점이며 `queue_report.boarding_exit`·`boarding_target`과 다르다. `boarding_capacity`는 1회 탑승 정원이다. 대기 인원·대기 자리 수·시간당 처리량으로 사용하지 않는다.

`Position`은 `{point: [number, number], node_id: string | null}`이다. `point`는 `[x,y]`, 단위는 가상 m, `x-right-y-down`이다. Three.js에서는 `[x, 높이, y]`로 표시한다. 위경도·화면 픽셀·실측 좌표가 아니다. `node_id`가 있으면 해당 노드 좌표와 일치해야 하며 임의 좌표는 `null`이다. 공공 보행 위치와 대기·탑승 중 전용 위치의 허용 영역은 캐릭터 phase에 따라 엔진이 검사한다. 현재 위치를 시설 모형 중심으로 대체하지 않는다.

로컬 QR 진입은 표지판 `magic-island-west`를 자이로스핀·혜성특급·자이로드롭 사이의 가상 좌표 `[123, 111]`m에 등록한다. 생성 요청은 `contract_version`과 등록된 `sign_id`를 전달한다. 서버는 현재 지도의 공공 보행 구역을 검사하고 표지판에서 걸어갈 수 있는 주변의 빈 가상 위치에 캐릭터를 배치한다. 응답의 `sign`은 `{sign_id, map_hash, position}`이다.

표지판에는 자이로스핀(`gyro-spin`)·혜성특급(`comet-express`)·자이로드롭(`gyro-drop`) 방향 안내판이 각각 하나씩 있다. 같은 응답의 `facilities`에 이 세 시설을 내려주며, QR 선호 순위와 추천 대상은 서버에 설정된 안내판 목록을 따른다.

사용자 웹과 시뮬레이션 웹은 같은 `context`·`session_id`·`character_id`·`revision`의 가상 위치와 phase를 표시한다. 기존 3D 지도 자원을 양쪽에서 재사용하며 사용자 웹은 자기 캐릭터·목적지·경로를 중심으로 표시한다. 실제 GPS 위치로 표시하지 않는다. 화면별 기능·조작은 [사용자 웹](../user-web.md)과 [시뮬레이션 웹](../simulation-web.md)을 따른다. 추천 수락 요청과 보상 지급 상태 표시는 사용자 웹이 담당하고, 시뮬레이션 웹은 전체 공간과 같은 캐릭터를 표시한다. 공통 계약은 이 두 화면의 UI 명세를 대신하지 않는다.

## 4. 시각·출처와 시설 스냅샷

실제 시각 `*_at`은 UTC ISO 8601 문자열(`2026-11-17T08:00:00Z`)이다. UI는 Asia/Seoul로 표시할 수 있다. `*_sim_time_s`는 해당 실행 시작부터 경과한 **시뮬레이션 초**다. `0`은 실행 시작이며 연속 시연 중 계속 증가한다. 32400초나 특정 시각에 도달해도 자동 종료·0초 복귀·epoch 변경·사용자 세션 초기화를 하지 않는다. 기존 `day.json`의 10:00–19:00은 이전 시간표 기준이며 이 계약의 연속 실행 시간을 제한하지 않는다. 실제 경과 시간에 배속을 곱해 개별 대기시간을 다시 계산하지 않는다.

시뮬레이션 기본 시연 화면은 시간 표시·재생바 없이 3D 맵을 중심으로 구성한다. 아래 clock·관측/갱신 시각은 내부 계산·동기화·오래된 데이터 판정에 계속 필요하다. 화면에 경과 시간을 표시하지 않는 것과 데이터에서 시간을 제거하는 것은 별개다. 개발용 seek/초기화가 향후 필요할 때만 해당 epoch 무효화 규칙을 적용하며, 기본 시연 화면에 타임라인 구현을 요구하지 않는다.

### FacilitySnapshot

| 필드 | 자료형 | 의미 |
| --- | --- | --- |
| `snapshot_seq` | integer ≥ 0 | 같은 run/epoch에서 발행마다 증가하는 스냅샷 버전 |
| `generated_at` | timestamp | 공급자가 묶음을 발행한 실제 시각 |
| `source` | Source | 이 묶음의 시설 상태·지표 출처 |
| `clock` | Clock | 묶음의 재생 시각·모드 |
| `facilities` | FacilityState[6] | 지도 시설별 정확히 한 건. 누락·중복 ID는 오류 |

`Source`는 `{kind: "mock" | "simulation", provider_id: string}`이다. `mock`는 작성된 가상 현황, `simulation`은 실제 엔진 상태에서 얻은 현황이다. API 응답과 기록은 `kind`를 유지한다. 지도 설정·정적 대기 자리 좌표만으로 `simulation`을 발행하지 않는다. v1은 한 묶음에 다른 출처를 섞지 않는다. `video`·`manual` 및 영상/모형 혼합 추정은 향후 확장 때 지표별 출처·촬영/수신/분석 시각을 정의한 뒤 연결한다. 영상 인원만으로 예상 대기시간이 알려졌다고 처리하지 않는다.

`Clock`은 `{sim_time_s: number ≥ 0, time_scale: number > 0, mode: "running" | "paused" | "ended"}`다. `time_scale`은 실제 1초에 진행할 시뮬레이션 초이며 일시정지 중에는 재개 시 배속이다. `paused`에서는 시뮬레이션 시간이 증가하지 않는다. `ended`는 명시적 실행 종료이며 고정 시간표 끝이나 표시 시각의 순환으로 자동 전환하지 않는다.

### FacilityState

| 필드 | 자료형 | 의미 |
| --- | --- | --- |
| `facility_id` | string | 위 시설 ID |
| `observed_at` | timestamp \| null | 이 시설 값을 마지막으로 산출한 실제 시각. 발행 때 덮어쓰지 않음 |
| `as_of_sim_time_s` | number ≥ 0 \| null | 산출 기준 재생 시각. 현재 clock보다 미래일 수 없음 |
| `operation` | enum | `open`, `suspended`, `closed`, `unknown` |
| `admission` | enum | `accepting`, `full`, `not_accepting`, `unknown` |
| `queue_people` | integer ≥ 0 \| null | 줄에서 대기 중인 인원. 이동·탑승·수락 예약 인원 제외 |
| `riding_people` | integer ≥ 0 \| null | 현재 탑승 중 인원. 대기 인원과 중복하지 않음 |
| `wait` | WaitEstimate | 지금 줄에 합류하면 탑승을 시작하기까지의 예상 대기 |

`WaitEstimate`는 `{status: "known" | "unknown" | "stale" | "not_applicable", seconds: number ≥ 0 | null, method: string | null}`다. `known`만 숫자와 비어 있지 않은 산정 방식 ID를 가진다. 나머지는 `seconds: null`이며 `method`는 이전/시도한 방식 ID 또는 `null`이다. `unknown`은 미집계/산정 불가, `stale`은 유효기간 경과, `not_applicable`은 현재 합류가 불가능해 대기를 제시하지 않는 상태다. 과거 값을 보여줄 필요가 생기면 별도 이력에 보관한다.

- `operation: open`은 운행 가능, `suspended`는 일시 중단, `closed`는 운영 종료/휴장, `unknown`은 미확인이다. 운행 phase나 차량 상태를 뜻하지 않는다.
- 추천하려면 `open + accepting + wait.known`이 모두 필요하다. 다른 operation에서 `admission: accepting`은 모순 입력이다. `full`은 줄 합류 불가이며 `queue_people`가 알려진 경우에만 그 근거를 검사할 수 있다. 정적 자리 수를 현재 줄 인원으로 채우지 않는다.
- `known` 값의 `observed_at`·`as_of_sim_time_s`는 필수 non-null이다. 산출 시각을 모르는 경우 `wait.unknown`·인원 `null`로 표현한다. 인원 `0`은 측정 결과 0명일 때만 사용한다.
- 두 산출 시각은 함께 숫자/시각을 가지거나 함께 `null`이어야 한다. `wait.not_applicable`과 `admission.accepting`은 모순 입력으로 거절한다.
- 인원과 대기시간은 각각 독립적으로 미집계일 수 있다. 알려진 대기가 있어도 인원이 `null`일 수 있으며, 인원이 있어도 대기는 `unknown`일 수 있다.
- 원본 품질이 `known`이어도 소비자가 실제 시각/재생 시각의 나이를 검사해 오래된 값을 제외한다. 묶음 발행만 최신이라고 오래된 관측을 새 값으로 취급하지 않는다.

예: 미집계는 `{"status":"unknown","seconds":null,"method":null}`, 대기 없음은 `{"status":"known","seconds":0,"method":"mock-fixture-v1"}`이다. UI는 전자를 ‘미집계’, 후자를 ‘0분’으로 구분한다. 숫자는 내부에서 초를 유지하고 표시할 때만 분으로 변환한다. 예상 대기에는 시설까지 보행·탑승 후 운행·하차 시간은 포함하지 않는다.

## 5. 사용자 세션과 선호

### UserSession

| 필드 | 자료형 | 의미 |
| --- | --- | --- |
| `session_id` | string | 서버가 발급한 익명 세션 ID. 인증 비밀값 자체는 아님 |
| `character_id` | string | 같은 context에서 세션에 1:1 연결한 캐릭터 |
| `revision` | integer ≥ 0 | 선호·위치·phase·현재 이용 변경 때 증가 |
| `created_at`, `expires_at` | timestamp | 생성/만료 실제 시각. 로컬 QR 시연에서는 마지막 진입 또는 세션 조회 후 5분에 만료 |
| `phase` | enum | `awaiting_preferences`, `ready`, `moving`, `queued`, `riding`, `ended` |
| `position` | Position | 서버/엔진이 관리하는 현재 가상 위치 |
| `position_sim_time_s` | number ≥ 0 | 해당 위치의 재생 시각. snapshot clock보다 미래일 수 없음 |
| `preference_order` | string[] | 미입력은 `[]`, 입력 후는 적용 정책에 해당하는 시설의 중복 없는 전체 순열. QR은 안내 대상 3개, 개발용 기본 정책은 지도 시설 6개 |
| `active_visit_id` | string \| null | 진행 중인 수락/이용. `moving`·`queued`·`riding`에서 non-null. 보상 지급 상태와 독립적 |

`preference_order[0]`이 1순위다. v1은 동점·일부 순위·싫어하는 시설 제외를 지원하지 않는다. 기존 0–5 프로필은 배경 방문객용 별도 설정으로 보존한다. 순위는 일시 폐쇄 시설을 포함해 모두 저장하고 추천 단계에서 가용성을 거른다. 같은 시설 재탑승은 가능하며 한 번씩 이용했다고 강제 퇴장시키지 않는다. 선호 변경은 `ready`에서만 허용하며 revision을 증가시켜 이전 추천을 무효화한다.

QR URL을 공유해도 독립 브라우저 프로필마다 세션·캐릭터를 발급한다. 서버는 무작위 자격을 `HttpOnly`·`SameSite=Strict` 쿠키로 보내고 세션을 메모리에 저장한다. 같은 쿠키로 다시 접속하면 기존 세션을 조회한다. 로컬 사용자 추천은 이 세션의 `position`과 `preference_order`를 사용한다. 세션·캐릭터 ID는 응답에서 식별용으로 제공한다.

로컬 세션은 마지막 `GET /api/user/session` 또는 QR 진입 후 실제 시간 5분에 만료된다. 두 요청 모두 서버 만료 시각과 쿠키를 갱신한다. 같은 쿠키로 만료 전에 재진입하면 캐릭터와 대기 순서를 이어간다. 전체 지도의 조회는 참여 신호에 포함되지 않는다. `DELETE /api/user/session`은 현재 쿠키와 본문의 `contract_version`, `session_id`로 세션을 종료한다. 성공하면 `status: "ended"`와 만료된 세션 쿠키를 반환한다. 쿠키가 가리키는 활성 세션 ID가 요청과 다르면 `session_mismatch`를 반환하고 해당 세션을 보존한다. 종료된 캐릭터는 다음 상태 갱신부터 공개 명단에서 빠진다. 만료된 세션의 조회·선호 저장·추천은 차단하며 다음 QR 진입 요청에서 배치 자리를 반환한다. 서버 재시작·epoch 변경 시 v1은 세션 재개를 지원하지 않는다. 세션·실행 문맥이 바뀐 뒤 이전 선호 저장을 재전송하면 충돌로 처리한다.

수락·엔진 연동 이후에는 만료 시 신규 수락을 중지하고 진행 중 이용을 서버가 중단·종료로 정리한다. 이미 확정된 추천 수락의 보상 이력·미지급 의무는 보존한다.

## 6. 경로 공급 경계

`RouteEstimate`는 시설별 한 건이다. 아래 필드는 모두 필수다.

| 필드 | 자료형 | 의미 |
| --- | --- | --- |
| `facility_id` | string | 목표 시설 |
| `status` | enum | `reachable`, `unreachable`, `unavailable` |
| `origin` | Position | 계산에 사용한 현재 세션 위치 |
| `target_node_id` | string | 해당 시설의 `entrance` |
| `points` | [number, number][] | `reachable`은 시작·끝을 포함한 2개 이상 경유점, 다른 상태는 `[]` |
| `distance_m` | number ≥ 0 \| null | 경유점 간 유클리드 거리 합. 다른 상태는 `null` |
| `method` | string | 예: `open-plaza-v1` |
| `walking_seconds` | number ≥ 0 \| null | 별도 속도/혼잡 모형이 없으면 `null` |

`RecommendationInput.routes`는 6개 시설별 정확히 한 건이다. context와 세션 revision이 같은 입력에서 계산하며 경로 origin은 session.position과 일치해야 한다. 도착점은 입구 좌표여야 한다. 거리 합 허용 오차는 0.001m이며 내부 계산은 반올림하지 않는다. 실제 보행 시간과 단순 거리÷임의 속도를 혼동하지 않는다. v1 점수에는 거리만 쓰며 `walking_seconds: null`이어도 추천할 수 있다.

`route(source_node_id, target_node_id)`는 노드 ID를 받고 전용 입출구 접속부까지 처리한다. 개발용 모의 공급자는 이 함수로 생성한 경로 표를 현재 지도 해시와 대조해 사용한다. 기본 지원 위치는 `west-center`, `west-north`, `west-spin`이다. `open-plaza-v1`은 격자 2m·반경 0.25m의 정적 안내 거리다.

QR 추천의 `public-visibility-v1`은 캐릭터의 현재 좌표를 공공 보행 연결점과 장애물 바깥 모서리에 연결한다. 서버는 방문객 반경을 확보한 선분만 연결해 시설 입구 바깥 대기 지점까지 최단 경로를 찾고, 마지막 입구 접속부를 이어 붙인다. 첫 접속과 하차 후 추천 모두 이 방식을 쓰며, 같은 좌표열을 추천 거리·지도 표시·수락 후 이동에 사용한다.

추천 계산은 전달받은 `RouteEstimate`만 사용한다. 브라우저와 서버가 서로 다른 직선/그래프 거리를 같은 `method`로 표시하지 않는다. 노드 기반 `walking_route`/`route.mjs`는 검사용 참조이며 광장 경로의 자동 대체가 아니다. 경로 공급 실패는 `unavailable`, 실제 연결 불가는 `unreachable`로 구분하며 직선거리로 숨겨 대체하지 않는다. 경로 알고리즘·격자·반경을 바꾸면 `method`도 바꾼다.

## 7. 추천 입력·출력과 기본 정책

### RecommendationInput

| 필드 | 자료형 | 의미 |
| --- | --- | --- |
| `contract_version`, `context` | 공통 값 | 위 버전·Context |
| `evaluation_at` | timestamp | 추천 서버가 신뢰 가능한 자체 시계로 정한 평가 시각 |
| `policy_id` | string | 6개 시설을 평가하는 `baseline-v1` 또는 QR 안내 대상을 평가하는 `sign-baseline-v1` |
| `session` | UserSession | 같은 시점의 세션 복사본 |
| `snapshot` | FacilitySnapshot | 시설 현황 묶음 |
| `routes` | RouteEstimate[6] | 해당 위치에서 6개 입구까지의 경로 |

`baseline-v1`의 계수·수명은 **개발용 가정**이며 실제 최적화 결과가 아니다. 정책을 바꿀 때 새 `policy_id`와 실행 기록을 남긴다. 초기 정책은 다음 순서로 계산한다.

1. context·필드·참조를 검증한다. 세션이 만료/종료됐거나 `ready`가 아니면 추천하지 않는다. `clock.mode: ended`도 거절한다. `paused`에서 조회용 추천은 가능하지만 수락은 불가하다.
2. `generated_at ≤ evaluation_at`이고 묶음 나이(`evaluation_at - generated_at`)가 30 실제 초 이하여야 한다. 시설별 `observed_at ≤ generated_at`, `as_of_sim_time_s ≤ clock.sim_time_s`이며 관측 나이(`evaluation_at - observed_at`, `clock.sim_time_s - as_of_sim_time_s`)도 각각 30 실제 초·300 시뮬레이션 초 이하여야 한다. 둘 중 하나라도 초과하면 제외한다. 위치 나이(`clock.sim_time_s - position_sim_time_s`)도 300 시뮬레이션 초 이하여야 한다. 미래 시각은 오류이며 음수 나이를 0으로 보정하지 않는다.
3. `open + accepting + wait.known + route.reachable`인 시설만 후보로 삼는다. 미집계 대기·상태, 오래된 값, 꽉 찬 줄, 경로 실패는 제외 사유로 남긴다.
4. 후보마다 다음 비용을 계산하고 가장 낮은 한 곳을 고른다. `rank`는 1–6이다.

   `cost = 0.5 × (rank - 1) / 5 + 0.3 × min(wait.seconds / 3600, 1) + 0.2 × min(distance_m / 500, 1)`

5. 비용을 소수점 9자리로 반올림해 비교한다(0 이상 값에 대해 `floor(cost × 1e9 + 0.5) / 1e9`). 동점은 선호 순위 → 대기 초 → 거리 → 시설 ID 사전순으로 결정한다. 후보가 없으면 `no_candidate`를 반환하며 미집계 값을 0으로 넣지 않는다.

`sign-baseline-v1`은 표지판의 세 시설을 평가한다. 1~3순위 전체 범위에 같은 선호 가중치 0.5가 적용되도록 비용식의 선호 분모를 2로 둔다. 대기·거리 가중치와 동점 규칙은 위와 같다. 기본 QR 시연 데이터에서는 세 시설을 모두 `open + accepting`으로 설정해 추천 후보에 포함한다.

수락 인원을 대기 인원에 미리 더하지 않는다. 후속 엔진에서 `moving` 인원은 예상 유입, 실제 `queued` 진입은 대기 인원으로 각각 한 번만 집계한다. 예상 유입을 점수에 반영하는 정책은 별도 버전으로 도입하며 현재 정책에 효과가 구현됐다고 표시하지 않는다.

### RecommendationResult

필수 필드: `contract_version`, `context`, `result`(`recommended | no_candidate`), `session_id`, `session_revision`, `snapshot_seq`, `source`, `policy_id`, `evaluated_at`, `recommendation`, `excluded`.

`recommendation`은 `no_candidate`일 때 `null`, 성공 시 다음 객체다. `excluded`는 `{facility_id, codes: string[]}` 배열이며 평가 대상 중 제외된 시설별 한 건이다. 코드는 `operation_unavailable`, `admission_unavailable`, `wait_unknown`, `wait_stale`, `observation_stale`, `route_unreachable`, `route_unavailable`, `round_start_recent_ride`를 사용하며 여러 사유를 보존할 수 있다.

| 성공 객체 필드 | 자료형 | 의미 |
| --- | --- | --- |
| `recommendation_id` | string | 한 추천의 ID |
| `facility_id` | string | 선택한 시설 한 곳 |
| `rank`, `wait_seconds`, `distance_m`, `cost` | number | 선택 근거의 실제 계산값. rank만 정수 |
| `route` | RouteEstimate | 지도 표시·수락 재검증에 사용할 경로 |
| `expires_at` | timestamp | 평가 시각 + 30 실제 초 |
| `expires_sim_time_s` | number | 평가 snapshot clock + 300 시뮬레이션 초 |
| `reason_codes` | string[] | v1은 `preference_wait_distance` |
| `reason_text` | string | 예: ‘선호 2순위이며 예상 대기 5분과 현재 위치에서의 경로 거리를 함께 고려했습니다.’ |

만료 판정은 실제/재생 시각 중 하나라도 **만료 시각 이상**이면 만료다. 이유 문구는 보존한 근거로 만들며 ‘가장 빠름’·실측 보장 같은 계산 밖의 주장을 하지 않는다. 응답의 `source`는 입력 그대로 보존한다. 사용자 웹의 추천 카드에는 시설명과 예상 대기 시간을 표시하고, 시뮬레이션 웹에서는 선택한 QR 캐릭터의 추천 목적지와 경로를 표시한다. 추천은 예약·입장 확약이 아니다.

로컬 QR 추천의 출처는 `kind: simulation`, `provider_id: simulation-queue-v1`이다. 첫 추천, 선호 변경, 하차 후 추천은 각각 계산 시점의 시설 운영 여부와 대기열 여유, `/api/state`의 `estimated_wait_sim_s`와 동일한 시설별 추정식을 사용한다. 이 추정은 대기열에 들어간 인원과 입구로 오는 인원, 회차 간격, 탑승 정원을 반영한다. 대기열이 가득 찼거나 운행하지 않는 시설은 제외한다. 개발용 `POST /api/recommendation`의 출처는 `mock`이다.

로컬 QR 세션은 현재 바퀴에 하차를 완료한 시설을 기록한다. 바퀴 도중에는 아직 타지 않은 시설을 우선하고, 이용 가능한 미탑승 시설이 없으면 방금 탄 시설을 뒤로 미뤄 기존 비용으로 비교한다. 안내 대상 세 시설의 하차를 완료하거나 저장된 선호 순위가 바뀌면 현재 바퀴의 기록을 초기화하고 직전 이용 시설은 기억한다. 동일한 순위를 다시 저장해도 진행 중인 바퀴는 유지된다.

새 바퀴의 첫 추천에서는 직전 이용 시설을 `round_start_recent_ride`로 제외하고, 나머지 후보를 저장된 선호 순위, 현재 예상 대기 시간, 이동 거리로 평가한다. 나머지 시설이 모두 추천 불가이면 사용자 웹에서 시뮬레이션 대기열을 주기적으로 다시 조회한다. 응답의 `rank`는 저장한 선호 순위를 나타낸다.

잘못된 입력은 추천 결과로 위장하지 않고 `{contract_version, error: {code, message}}`로 반환한다. 공통 오류 코드는 `invalid_input`, `unsupported_version`, `context_mismatch`, `session_expired`, `session_not_ready`, `snapshot_stale`, `position_stale`, `run_ended`다. `message`는 한국어다. HTTP 상태·인증·라우팅은 실제 서버 구현에서 이 의미에 맞춰 정한다.

## 8. 수락·상태 전이·보상

로컬 QR 시연의 `POST /api/user/recommendation/accept`는 아래 명령 필드로 수락을 검증하고 엔진 이용을 메모리에 연결한다. 두 지도는 `moving`, `waiting_at_entrance`, `queued`, `boarding`, `riding`, `unloading`, `completed` 상태를 공유한다. `queued`의 공개 캐릭터 상태에는 1부터 시작하는 대기 순번 `queue_position`과 탑승을 시작하기까지의 예상 시뮬레이션 초 `queue_wait_sim_s`가 들어 있다. 다른 이용 상태의 두 값은 `null`이다. 예상에는 줄 선 순서, 회차당 탑승 정원, 차량·승강장 운영 상태를 반영한다.

`completed`는 하차 출구를 지나 공공 연결점에 도착했을 때 표시한다. 이 상태에서 `PUT /api/user/preferences` 또는 `GET /api/user/recommendation`을 호출하면 현 위치를 보존해 `ready`로 전환한다. 새 추천은 하차 지점과 시설 입구를 잇는 공공 보행 경로를 사용한다. 같은 세션의 기존 수락 요청은 다시 보내도 최초 성공 응답을 돌려준다. 이용 완료·수락 이벤트와 보상 응답은 전체 연동의 계약이다. [로컬 시연 API](../../lotteworld/README.md#qr-사용자-진입과-선호-입력)

### AcceptRecommendation

필수 필드: `contract_version`, `context`, `command_id`, `session_id`, `recommendation_id`, `expected_session_revision`, `expected_snapshot_seq`. 클라이언트는 목표 시설·좌표·보상값을 지정하지 않는다. 추천 서버가 저장한 추천과 최신 상태를 대조해 승인한다.

- `(context, session_id, command_id)`를 멱등 키로 사용한다. 같은 키·같은 본문 재전송은 저장된 결과를 반환하고 이동·보상을 반복하지 않는다. 같은 키의 다른 본문은 `idempotency_conflict`다. 기록은 해당 실행의 이용/보상 기록과 함께 보존한다.
- 서버는 세션 revision을 원자적으로 비교하고 한 세션에 하나의 active visit만 생성한다. 두 추천을 동시에 수락하면 한 건만 성공하고 다른 건은 `session_conflict`다. 다른 세션 간 같은 시설 추천은 독립적이며 좌석 예약은 하지 않는다.
- `expected_snapshot_seq`는 추천이 사용한 버전과 일치해야 한다. 최신 묶음이 바뀌었으면 최신 위치·운영·합류 가능·대기 신선도·경로를 다시 검사한다. 여전히 가능하면 수락하고 응답에 실제 사용한 최신 버전을 남긴다. 불가능하면 `recommendation_invalidated`로 거절하고 새 추천을 요청한다. 대기값 변경만으로 기존 수락 의사를 다른 시설로 옮기지 않는다.
- 만료 추천은 `recommendation_expired`, run/epoch/map 불일치는 `context_mismatch`, 일시정지는 `run_paused`다. 이동을 받을 엔진이 없으면 `engine_unavailable`로 거절한다. 모의 대기 입력으로 추천이 된 사실만으로 캐릭터 이동을 성공 처리하지 않는다.

성공 응답은 `{contract_version, context, command_id, accepted: true, visit_id, session_id, session_revision, snapshot_seq, phase: "moving", acceptance_event_id, reward_status, reward_id}`다. `acceptance_event_id`는 수락 확정 이벤트 ID다. `reward_status`는 `pending | granted`이며 `pending`일 때 `reward_id: null`, `granted`일 때 저장한 보상 ID를 반환한다. 수락 확정 직후 보상 지급을 시작하고 저장 실패 시 재시도한다. 이동이나 이용 완료를 기다리지 않는다. 거절 응답은 공통 오류 객체에 `command_id`를 추가하며 보상 근거를 생성하지 않는다.

수락 저장·수락 이벤트·보상 지급 의무·엔진 전달은 같은 `visit_id`로 재시도 가능한 outbox 또는 같은 수준의 원자성으로 구현한다. 응답이 끊겨도 두 개의 visit이나 보상 의무를 생성하지 않는다. 동일 command 재전송에는 저장된 응답을 반환하고, 이후 보상 지급 상태는 별도 조회로 확인한다. 이는 후속 구현 요구사항이다.

### 상태 전이

추천 생성/갱신은 `ready` phase를 바꾸지 않으며 추천 만료도 세션 종료가 아니다.

| 현재 → 다음 | 권한과 조건 | 효과 |
| --- | --- | --- |
| 생성 → `awaiting_preferences` | 세션 서버, 캐릭터/초기 위치 생성 성공 | active visit 없음 |
| `awaiting_preferences` → `ready` | 선호 전체 순열 저장 | revision 증가 |
| `ready` → `moving` | 추천 수락 원자 처리 성공 | visit·수락 이벤트·보상 지급 의무 생성, 추천 소비, revision 증가 |
| `moving` → `queued` | 엔진이 대상 입구 도착 및 줄 합류를 확인 | 대기 인원에 1회 반영 |
| `queued` → `riding` | 엔진이 실제 회차/차량의 좌석 배정·탑승 시작 확인 | 대기 감소, 탑승 증가 |
| `riding` → `ready` | 운행·하차 후 대상 시설 출구 도착 확인 | VisitCompleted 1건, 출구 위치 저장, 탑승 감소, active visit 해제, 다음 추천 허용 |
| `moving`/`queued` → `ready` | 합류 실패·운영 중단·포기, 엔진이 안전한 공공 위치 복귀 확인 | visit 중단·active visit 해제. 추가 보상 근거는 생성하지 않음 |
| `riding` → `ready` | 엔진이 중단 하차·안전 위치 복귀 확인 | visit 중단·active visit 해제. 추가 보상 근거는 생성하지 않음 |
| 임의 → `ended` | 세션 만료·사용자 종료·실행 종료/epoch 교체 | 신규 명령 중지, 이미 확정된 수락의 보상 의무 보존 |

각 전이는 서버/엔진이 session revision을 증가시킨다. 이동 중 좌표 갱신도 revision을 증가시킨다. 운행 중 중단을 즉시 순간이동/정상 완료로 처리하지 않는다. 보상 상태는 세션 phase와 독립적으로 관리하며 보상 저장 실패가 이동·다음 추천을 막지 않는다. 수락과 종료가 경합하면 같은 세션의 원자적 순서로 처리한다. 먼저 수락이 확정됐다면 이후 종료와 무관하게 보상 지급을 재시도하고, 종료가 먼저면 수락을 거절하며 보상 의무를 만들지 않는다. 이용 중단·완료 여부는 수락 보상 지급의 판정 조건이 아니다.

### RecommendationAccepted·RewardGrant·VisitCompleted

`RecommendationAccepted` 필수 필드는 `contract_version`, `context`, `event_id`, `command_id`, `recommendation_id`, `visit_id`, `session_id`, `character_id`, `facility_id`, `source`, `accepted_at`, `accepted_sim_time_s`다. 추천 서버가 유효한 추천 수락을 확정할 때 생성한다. `source`는 수락한 추천의 출처를 보존한다. 클라이언트의 버튼 클릭 통지만으로는 보상 근거가 되지 않는다.

`RewardGrant` 필수 필드는 `contract_version`, `context`, `reward_id`, `recommendation_id`, `visit_id`, `session_id`, `acceptance_event_id`, `source`, `reward_type: "recommendation_acceptance"`, `granted_at`이다. `acceptance_event_id`는 확정된 `RecommendationAccepted.event_id`를 참조한다. v1은 승인된 추천 수락 한 건에 보상 기록 한 건이며 금전·포인트 양·실제 탑승 인증을 정의하지 않는다.

`(context, session_id, recommendation_id, reward_type)`에 고유 제약을 둔다. command/event ID가 다른 재전송이라도 같은 추천 수락에 보상을 다시 지급하지 않는다. 저장 실패 시 수락 보상 의무를 `pending`으로 남겨 재시도하고, 성공 기록이 있으면 같은 grant를 반환한다. 새로운 추천의 유효한 수락은 별도 보상 근거가 될 수 있다. 지급량·한도·취소/회수 정책은 미정이다. 이미 확정된 수락의 지급 재시도는 현재 visit의 완료 여부나 세션 종료 여부로 거절하지 않고 원래 수락 기록과 대조한다.

`VisitCompleted` 필수 필드는 `contract_version`, `context`, `event_id`, `visit_id`, `session_id`, `character_id`, `facility_id`, `source`, `completed_at`, `completed_sim_time_s`, `exit_position`이다. `exit_position`은 해당 시설 `exit` 좌표이며 현재 visit·캐릭터·시설과 일치해야 한다. 엔진만 생성하며 보상 생성에는 사용하지 않는다. 모의 엔진 이벤트라면 반드시 `source.kind: mock`를 유지한다. 중복 완료 통지는 이용 상태를 다시 전이시키지 않고, 수락하지 않은 visit/이미 중단된 visit/이전 epoch의 완료는 거절한다.

## 9. 예제와 공급자 교체

| 파일 | 내용 |
| --- | --- |
| [mock-input.json](examples/mock-input.json) | 같은 지도에서 정상 대기·0초·미집계·운영 중단을 섞은 완전한 추천 입력 |
| [simulation-input.json](examples/simulation-input.json) | 같은 형식의 시뮬레이션 공급 입력 예시. 실제 실행 결과가 아닌 **구조 검증용 가상 fixture** |
| [workflow.json](examples/workflow.json) | mock 입력의 추천 결과·수락 명령·가정한 엔진 연결 후 성공 응답·수락 이벤트·수락 보상·이후 이용 완료 이벤트. 현재 API 실행 결과가 아님 |

예제의 `map_hash`·입출구·경로는 작성 시점의 로컬 지도에서 계산했다. 지도 변경 후 해시와 경로를 함께 다시 생성해야 하며 예제 해시를 런타임 상수로 쓰지 않는다. `simulation-input.json`의 `simulation` 표기는 앞으로 엔진이 제공할 객체의 형태를 설명할 뿐 현재 엔진 존재를 증명하지 않는다. 예제 workflow의 대기·운행 경과도 가정이다.

연결 경계는 `상태 공급자 → FacilitySnapshot`, `세션 저장소 → UserSession`, `경로 공급자 → RouteEstimate[]`, `추천 계산 → RecommendationResult`, `수락 서비스 → 엔진 이동 명령`, `수락 확정 이벤트 → 보상 저장소`다. 모의→엔진 전환 시 추천 필드·단위·점수를 바꾸지 않고 공급자와 run ID를 교체한다. 엔진 공급자는 줄 인원·탑승 인원·산정 시각을 실제 엔진 상태에서 채우고, 대기 추정 모형이 없으면 `unknown`으로 둔다. 추천 함수가 설정 파일을 읽어 인원을 만들어내지 않는다.

v1의 시설 상태 공급은 한 출처만 사용한다. 영상 입력은 카메라/표지판/관측 구역의 대응, 지표별 출처·오차, 운영 상태의 입력 주체와 대기 추정 모형을 별도로 결정한 뒤 연결한다. 기존 영상 관측 요구사항을 이 문서의 가상 인원 구조로 축소하지 않는다.

## 10. 검증 기준과 남은 구현

문서·fixture 검증은 [계약 검증 기록](../verification/recommendation-data-contract.md), 로컬 추천 계산과 HTTP 검사는 [로컬 추천 검증 기록](../verification/recommendation-server-minimum.md)을 따른다.

- 로컬 추천 검사는 잘못된 버전·해시·시설 순열·중복 ID·NaN, 미래·오래된 시각, 미집계·0초, 동일 입력 재현, 비용 동점, 모든 후보 탈락, 폐쇄·줄 포화·경로 실패를 다룬다.
- 수락 구현 시 중복·동시 수락, 스냅샷 변경 후 재검증, 배속·일시정지·seek·재시작 때 문맥·만료 처리를 확인한다.
- 보상 구현 시 수락 중복·종료와의 경합·저장 실패에서 승인된 수락당 한 건을 지급하는지 확인한다. 이용 완료·중단 시 추가 지급 없이 기존 수락 지급 결과를 유지하는지도 확인한다.

로컬 추천 서버는 Python 표준 라이브러리와 설정 가능한 모의 JSON 저장 경로를 사용한다. 영속 세션·수락 저장 방식, 임의 좌표 경로 어댑터, 표지판 좌표, 다중 사용자 배치, 휴대폰 네트워크 접속, 영상 연결, 실제 엔진 대기 추정은 후속 구현에서 정한다.
