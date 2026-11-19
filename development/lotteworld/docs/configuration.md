# 매직아일랜드 설정 계약

설정·지도와 로컬 모의 추천 서버의 연결은 [추천·시뮬레이션 공통 데이터 계약 v1](../../docs/contracts/recommendation-v1.md)을 따른다. `hashes.map`을 지도 버전으로 사용하고 QR 사용자의 선호 순위는 기존 0–5 프로필과 구분한다. 모의 파일 설정과 추천 HTTP 호출 형식은 [로컬 추천 API](../README.md#로컬-추천-api)를 참고한다.

연속 시연의 유입·체류·퇴장은 `configs/continuous.json`으로 설정한다. 이전 시간표는 입력 호환과 실험 기록을 위해 검증한다. 현재 우선순위는 [체크리스트](../../docs/implementation-checklist.md)를 따른다.

아래 다섯 JSON은 `schema_version: 1`, `scenario_id: magic-island`와 `provenance`를 포함한다. `lotteworld_sim/scenario.py`의 `load_inputs`는 자료형·범위·파일 간 참조를 검사한다.

| 파일 | 현재 계약 |
| --- | --- |
| `configs/map.json` | 6개 고유 시설 ID·이름, `map_ready` 상태, 미터 좌표·구획·양방향 보행 그래프 |
| `configs/day.json` | 음수가 아닌 정수 시드, 관측 시작·종료와 월드 오브 라이트 종료 이벤트, 강제 퇴장 금지, 실제 진입부터 대기 포함 균등 체류, 관측 종료로 체류 자르기 금지 |
| `configs/preferences.json` | 지도 시설과 일치하는 태그 6개, 선호 유형과 시설별 0–5 점수, 시설 가중치와 대기·재탑승 정책, `provisional` 상태 |
| `configs/ride-operations.json` | 지도 시설 6개별 운행·하차·승차 확인·출발 간격, 차량 수·동시 승하차 대수·가상 코스 구간 수 |
| `configs/continuous.json` | 수동 종료까지 반복하는 배경 방문객 유입·체류·퇴장 설정 |

운영 설정의 `arrivals`는 하루 기준 인원·관측 비중·관측 계획 합계와 `slots`를 분리한다. 한 시간 단위의 시작 포함·끝 제외 구간은 관측 시작부터 종료까지 빈틈·중복 없이 이어져야 한다. 각 행의 `count = daily_baseline × share`, 전체 `planned_total = daily_baseline × observation_share`, 행별 인원·비중의 합계를 검증한다. 이 계약으로 관측 구간에 19시 이후 몫을 몰아넣거나 구간을 중복하는 입력을 검출한다.

이전 시간표의 기본값 검증은 9구간 합 10,350명, 13–16시 4,600명, 피크 14–15시 1,610명을 확인한다. 근거와 지도·시설 명세는 [설계 문서](../../docs/design.md)에 남긴다.

`--validate-only` 출력은 `status: map_ready`, `runnable: false`이고 실행 중 `GET /api/meta`는 `status: continuous_running`, `runnable: true`다. 양쪽 모두 `map_ready: true`, `map_view: guide-map-3d`와 다섯 설정·해시를 제공한다. 정렬된 JSON의 UTF-8 바이트를 SHA-256으로 계산하며 `day.json`은 `hashes.config`, 시설 운행은 `hashes.ride_operations`, 연속 시연은 `hashes.continuous`에 대응한다.

서버의 기본 바인딩 주소는 `127.0.0.1`이다. `/`는 지도 화면을 제공하며 정적 자원 요청은 허용 목록을 사용한다. `GET /api/state`는 연속 시연 상태를 제공한다. 안내판·보고서·수동 진행·되감기·초기화 API는 HTTP 409, 없는 경로는 HTTP 404를 반환한다.

## 연속 시연 설정과 상태

| 필드 | 기본값 | 단위와 검증 범위 |
| --- | ---: | --- |
| `target_people` | 240 | 동시 배경 방문객 목표 겸 상한. 1~10,000명의 정수 |
| `initial_people` | 240 | 실행 시작에 이미 체류 중으로 배치할 인원. 0 이상이고 목표 이하인 정수 |
| `admission_interval_sim_s` | 5 | 빈자리가 처음 생긴 뒤 첫 입장까지의 간격. 빈자리가 남으면 같은 간격으로 한 명씩 입장. 1~3,600 내부 초의 정수 |
| `stay_sim_s` | [7200, 10800] | 개인별 전체 예정 체류의 균등분포 범위. 60~86,400 내부 초의 오름차순 두 값 |
| `time_scale` | 6 | 실제 경과 1초당 내부 경과 초. 0.1~60 |
| `seed` | 20261119 | 0 이상의 정수. 같은 설정·경과 시간에서 같은 방문객 순서를 재현 |

초기 인원은 각자 체류 기간의 0~100%가 이미 지났다고 균등 추출하고, 실행 시작과 동시에 누적 진입에 포함한다. 따라서 초기 명단의 진입 시각은 내부 시작 전을 나타내는 음수가 될 수 있다. 초기 인원이 목표보다 작으면 실행 시작 기준으로 첫 간격부터 한 명씩 채운다. 목표를 채운 동안 보류 입장을 쌓지 않으며, 예정 퇴장과 입장 시각이 같으면 퇴장을 먼저 처리한다. 서버의 단조 시계로 경과 시간을 계산하고 상태 조회가 없어도 유입·퇴장을 진행한다.

`GET /api/state`는 `scenario_id`, 서버 실행 중 일정한 `run_id`, 보행에 사용하는 `map_hash`, `status: continuous_running`, `clock.sim_time_s`·`clock.time_scale`을 반환한다. `background`는 `target_people`, `entered_total`(누적 진입), `present_people`(현재 체류), `exited_total`(누적 퇴장), 현재 체류 중인 `visitors`와 시설별 `queues`를 담는다. 예정 체류가 끝난 방문객도 다리 외부 경계를 통과할 때까지 현재 체류에 포함한다. 경계를 통과해 빈자리가 생기면 보충 간격을 적용한다. `entered_total = present_people + exited_total`을 유지한다.

서버는 시작 시 검증한 연속 설정·지도 좌표·시설 운행·방문객 선호를 실행 전체에 사용한다. `/api/meta`의 지도·기존 시간표·시설 운행·선호 설정은 저장 후 다시 읽으며, 지도·운행·선호 변경은 서버 재시작 시 새 실행에 적용한다. `/api/state`의 `map_hash`·`ride_operations_hash`·`preferences_hash`로 현재 실행이 쓰는 입력을 식별한다. QR 세션은 모의 추천 문맥과 실제 시간 만료를 사용하며 `background` 집계의 대상에서 제외한다. 시연용 인원 가정은 [연속 시연 검증 기록](../../docs/verification/magic-island-continuous-arrivals.md)을 따른다.

### 물리적 대기열과 승하차 보행

`visitors`는 실행 내 증가하는 정수 `visitor_id` 순이다. 각 행은 진입 시각 `entered_at_sim_s`, 예정 퇴장 시각 `leave_at_sim_s`, 평면 미터 좌표 `point: [x,z]`, `state`, `facility_id`, `queue_slot`, `vehicle_id`, `departure_requested`를 제공한다. `preference_profile_id`는 배정한 선호 유형 ID다. `completed_rides`는 하차 보행을 시작한 시점까지 시설별로 센 이용 횟수이며 첫 이용 전에는 빈 객체다. `queue_slot`은 해당 시설 `queue_report.slots`의 0부터 시작하는 예약 인덱스이며 값이 클수록 탑승 지점에 가깝다. 보행 중인 방문객의 좌표는 경로를 따라 갱신한다. `vehicle_id`는 승차 접근부터 하차 보행 시작 전까지 배정된 시설 내 차량 번호다. 시설·자리·차량 배정이 없거나 현재 보행 좌표가 없는 경우 해당 필드는 `null`이다. `departure_requested`는 예정 체류 만료 이후 참이다.

| 상태 | 동작 |
| --- | --- |
| `walking_to_queue` | 공공 그래프에서 시설 입구 앞 연결점으로 이동한다. 진입할 수 없으면 시설을 다시 고른다. 공공 연결점을 순회하며 자리를 다시 확인하는 동안 `facility_id`는 `null`일 수 있다. |
| `joining_queue`, `queued`, `advancing_queue` | 자리 하나를 예약하고 줄 중심선을 걷는다. 앞자리가 비면 대기 순서대로 전진한다. |
| `leaving_queue` | 자리에서 옆 통로로 옮긴 뒤 별도 게이트를 통해 공공 보행로에 복귀한다. 통로에 들어서면 자리를 해제한다. |
| `walking_to_board`, `at_boarding_point` | 선두부터 1회 정원 이내로 탑승 진입점을 거쳐 시설 경계까지 걷는다. |
| `on_ride`, `waiting_for_station` | 운행 중이거나 코스 주행을 마치고 빈 승강장을 기다린다. 현재 좌표는 `null`이다. |
| `awaiting_unload`, `walking_from_ride` | 하차 순서를 기다리고 시설 경계에서 빨간 출구를 1 내부 초 간격으로 통과한다. 이후 전용 연결을 통해 공공 보행로에 합류한다. |
| `waiting_to_exit` | 남은 체류 시간과 대기 허용 시간으로 갈 수 있는 시설이 없으면 현재 공공 연결점에서 예정 체류 만료까지 머문다. |
| `walking_to_exit` | 다리 외부 경계로 돌아간다. 도착 시 명단에서 빠지고 `exited_total`이 증가한다. |

시설별 `queues`에는 `capacity`(배치한 자리 수), `reserved_count`(걷는 사람 포함 예약 수), `queued_count`(배정된 자리에 도착해 서 있는 인원)가 포함된다. 이동 속도는 내부 초당 1.4m로 가정한다. 대기열의 진입과 이탈 보행은 경로를 따라 최소 1m 간격으로 시작한다. 공공 보행 중 체류가 만료되면 현재 경로의 합류점에서 다리로 향한다. 줄에서 만료되면 배정된 자리까지 이동을 마친 뒤 이탈하고, 승차에 들어간 뒤 만료되면 하차 후 다리로 향한다.

서버에서 가동하는 여섯 시설은 모두 자동으로 승하차를 진행한다. `BackgroundRun`에 운행 설정을 주지 않은 대기열 검증에서는 `board_next(facility_id, seats)`·`unload(facility_id)`로 한 묶음의 보행을 확인할 수 있다. `withdraw(visitor_id)`는 대기 중 이탈을 요청한다. 방문객의 3D 표시는 체크리스트 8번에서 연결한다. [공간·런타임 검증](../../docs/verification/magic-island-physical-queues-and-boarding.md)

### 방문객 선호와 반복 이용

`preferences.json`의 선호 유형 중 하나를 입장 때 같은 확률로 뽑는다. 기본 다섯 유형은 균등·속도·낙하·회전·테마이며 시설별 점수 0은 해당 유형에서 선택하지 않는다는 뜻이다. 시설 가중치와 유형 점수·배정 확률은 시연용 가정이다. [인기도와 목적지 선택 근거](../../docs/magic-island-research.md#인기도와-목적지-선택)

| `behavior` 필드 | 기본값 | 단위와 검증 범위 |
| --- | --- | --- |
| `facility_weights` | 여섯 시설 모두 1 | 시설별 0.01~10의 유한한 상대 가중치 |
| `wait_patience_sim_s` | [300, 1500] | 개인 기본 대기 허용 시간을 균등 추출할 범위. 1~86,400 내부 초의 오름차순 두 값 |
| `repeat_weight` | 0.25 | 한 번 이상 이용한 시설에 곱하는 0.01~1의 값 |
| `time_cost_scale_sim_s` | 300 | 이동·대기 비용을 완만하게 조정하는 기준. 1~3,600 내부 초 |

기존 형식에서 `behavior`를 생략하면 표의 기본값을 적용한다. 개인의 시설별 대기 허용 시간은 기본 시간에 `0.5 + 선호 점수 / 10`을 곱한다. 선택 후보는 공공 보행, 대기, 승차·운행·하차 예상 시간이 남은 체류에 들어오고 대기가 허용 시간보다 짧은 시설이다. 후보별 추첨 가중치는 `시설 가중치 × 개인 선호 점수 × 재탑승 계수 ÷ (1 + (공공 보행 + 예상 대기) / 비용 기준)`이다. 미이용 시설의 재탑승 계수는 1이다.

시설 입구 앞 공공 연결점에서는 `앞 예약 인원 × 명목 출발 간격 ÷ 좌석 수`와 줄 선두까지의 보행 시간 중 큰 값을 대기로 추정한다. 명목 간격은 설정한 최소 출발 간격, 코스 첫 구간 통과 시간, 차량당 명목 회차 시간 및 승강장당 승하차 시간 중 가장 긴 값이다. 떨어져 있는 시설에는 줄 선두까지의 기본 보행 시간만 적용한다. 입구에 도착하면 대기 추정, 남은 시간, 자리, 진입 간격을 다시 확인한다.

예약 후에는 개인 허용 시간과 예정 퇴장 전에 승차·운행·하차에 필요한 시간을 뺀 대기 여유 중 더 짧은 시간을 적용한다. 한도에 이르면 옆 통로로 이동하고, 자리를 해제한 뒤 공공 경로에서 다른 시설을 먼저 찾는다. 승차를 시작하면 대기 한도는 해제된다. 이미 이용한 시설도 남은 시간이 충분하면 다시 고를 수 있으며, 정해진 체류가 만료되면 다리 경계를 지나 퇴장한다.

체류 기간, 초기 체류 경과, 선호 유형과 대기 허용 시간 배정, 목적지 추첨에는 각각 별도의 난수 흐름을 사용한다. 같은 설정·시드·내부 시각에서 조회 간격과 무관하게 같은 선택과 이용 이력을 얻는다. [행동 및 재현 검증](../../docs/verification/magic-island-visitor-behavior.md)

## 시설별 운행 설정

`GET /api/meta`와 `--validate-only` 출력의 `ride_operations.facilities`는 지도와 같은 시설 ID로 조회한다. `--config`는 유입·체류 등 기존 일일 설정을 바꾸는 옵션이며 시설별 운행 설정은 `configs/ride-operations.json`에서 읽는다.

| 필드 | 단위와 의미 |
| --- | --- |
| `ride_seconds` | 차량 한 대 또는 한 탑승 묶음의 출발부터 하차 가능한 정지까지의 초 |
| `unloading_seconds` | 승강장 배정 시점부터 하차를 위해 확보하는 최소 초 |
| `boarding_and_check_seconds` | 첫 승객의 승차 접근을 시작할 때부터 추가 승차·출발 전 확인에 배정하는 초 |
| `dispatch_interval_seconds` | 시설에서 연속 출발 사이에 두는 최소 초. 실제 다음 출발은 차량·승강장·코스가 준비될 때까지 늦어질 수 있다. |
| `vehicle_count` | 시설에서 재사용할 차량·열차 편성 또는 순차 운행 장치의 수 |
| `station_capacity` | 승하차를 동시에 처리할 수 있는 차량 또는 운행 장치의 수 |
| `course_section_count` | 같은 주행 시간의 가상 코스 구간 수. 생략 시 `1`, 범위는 `1`부터 `ride_seconds`까지의 정수 |

운행 시간·출발 간격·차량 수·동시 승하차 대수는 양의 정수다. 하차와 승차·확인 시간은 각각 0 이상의 정수다. 아트란티스는 8인승 보트 8대·승강장 2곳·운행 120초·최소 출발 간격 30초를 사용한다. 혜성특급은 26인승 열차 1편성·승강장 1곳·운행 140초·최소 출발 간격 230초를 시연용 가정으로 사용한다. 네 단일 회차 시설도 각각 운행 장치 1대와 승강장 1곳을 사용한다. [시연용 초기값과 근거](../../docs/magic-island-research.md#시연용-초기값)

### 회차·차량 운행과 상태

- 대기열 선두가 예약 위치에 도착하면 승차를 시작한다. 승차·확인 시간 안에 준비된 후속 대기객을 정원까지 받는다. 시간이 끝나면 새 승객 수락을 마치고 이미 선택한 승객의 접근이 끝날 때까지 기다린다. 승객이 있으면 빈 좌석으로도 출발하고, 빈 차량은 가용 상태로 대기한다.
- 승차를 마친 차량은 출발 간격과 첫 코스 구간이 열릴 때까지 승강장을 점유한다. 코스는 같은 소요 시간의 가상 구간으로 나누며 모든 차량이 같은 순서와 속도로 통과한다. 선행 차량이 첫 구간을 비운 뒤 출발하면 나머지 구간에서도 간격이 유지된다. 기본 아트란티스는 30초 구간 4개, 다른 시설은 1개를 사용한다.
- 복귀한 차량은 공용 승강장이 찼으면 코스 밖의 논리적 복귀 대기 상태에 머무른다. 빈 승강장은 복귀 순서대로 먼저 배정하고, 이후 가용 차량을 투입한다. 승강장의 번호는 점유를 나타내는 논리적 위치다. 시설별 지도에는 하나의 승차 접근로와 하나의 빨간 출구를 사용한다.
- 하차 보행은 승강장 배정부터 시작하고 모든 차량의 출구 통과를 1 내부 초 간격으로 예약한다. 하차 시간과 출구까지 걷는 시간은 겹쳐 진행되며, 설정한 하차 시간이 끝나고 마지막 승객이 빨간 출구를 통과한 뒤 승강장을 비운다. 퇴장 예정 시각이 지난 승객은 하차와 다리 보행을 마친 뒤 퇴장으로 집계한다.

`GET /api/state`의 `rides`는 시설 ID별 `vehicle_count`, `station_capacity`, `seats_per_vehicle`, `dispatch_count`, `last_dispatch_at_sim_s`, `next_dispatch_min_at_sim_s`, `course_section_count`, `course_entry_available_at_sim_s`를 제공한다. 최소 간격 시각과 첫 구간 가용 시각은 실제 출발의 하한이다. 첫 출발 전의 마지막 출발 시각은 `null`, 두 하한은 내부 시각 `0`이다.

각 `vehicles` 행은 1부터 시작하는 시설별 `vehicle_id`, `state`, `station_slot`, `course_section`, `last_dispatched_at_sim_s`, `passenger_ids`를 담는다. 상태는 `available`(대기), `boarding`(접근·확인), `ready`(출발 대기), `running`(운행), `waiting_for_station`(복귀 후 승강장 대기), `unloading`(하차)이다. `station_slot`과 `course_section`은 점유 중에만 1부터 시작하는 번호를 제공한다. 승차로 배정된 방문객은 하차 보행을 시작할 때 차량 명단에서 빠진다. [검증 기록](../../docs/verification/magic-island-ride-operations.md)

## 지도 형상 계약 (2번)

`geometry`는 `units: m`, `axis: x-right-y-down`이다. JSON의 두 번째 평면 좌표를 3D의 z로 옮기고 3D y를 높이로 사용한다. 길이·높이는 같은 가상 미터 단위다. 지도 픽셀을 실측 거리로 환산하지 않는다. 기본 `bounds`는 `[0,0,370,330]`이며 시설·구획과 참조 통행 폭은 범위 안에 있어야 한다.

- `render_style: guide-map-3d`, `island_outline`: 섬 외곽의 유한한 2D 꼭짓점 목록. 중복·자기 교차·면적 없는 다각형을 거절한다. `island`·`lake` 사각형은 배경 범위의 기존 메타데이터이며 실제 섬 경계는 `island_outline`이다.
- `public_space: island-minus-reservations`: 섬 내부의 넓은 포장 면에서 시설의 `bounds`·`queue`·`exit_area`, `castle`, `scenery_buildings`, `landscape_beds`를 제외한다. 나머지는 그래프 중심선 밖이라도 보행 가능하다. 섬 윤곽은 주 섬·남쪽 메이플 돌출부·다리 양옆 수면 홈을 구분한다. 섬 밖에서는 다리의 실제 직사각형 유효 폭만 허용한다. `public_walkable(map_data, point, radius=0)`가 개인 반경·해안 경계·제외 구획을 반영한다.
- `landscape_beds`: 실제로 녹지로 표시하는 작은 식재 사각형 목록. 나무도 이 안에만 배치한다. 시설·대기·주 동선과 겹칠 수 없다. `scenery_buildings`는 성 뒤 배경 건물의 예약 구획이다. `castle_height_m`은 성의 표시 높이 기준이다. `castle_forward`는 성 정면과 다리의 공통 방향, `castle_model_scale_xz`는 회전 후 점유 구획에 맞춘 평면 배율, `forecourt_width_m`은 정면 광장의 표시 폭이다.
- `nodes`: 고유 문자열 `id`와 유한한 두 좌표 `point`. ID에 붙은 숫자는 식별자이며 현재 좌표를 뜻하지 않는다. `boundary`는 다리 경계 노드를 참조한다. `bridge_placement: castle-forecourt-to-southeast`이며 `bridge-island`에서 외부 경계까지 한 개의 직선 다리로 연결한다. 성 중심·성 정문·다리 시작·끝은 `castle_forward`와 같은 축에 있어야 한다.
- `edges`: 고유 `id`, 기존 노드를 가리키는 `source`·`target`, `width`, `kind`. 양방향이며 0 길이·중복 연결을 거절한다. 최소 참조 폭은 `main`·`bridge` 8m이며 기본 다리 폭은 12m다. `branch` 5m, `exit` 3m다. 이 폭은 보행 가능한 포장 면 전체를 제한하지 않는다. 다리 외 연결은 반폭까지 섬 내부에 있어야 한다.
- 시설별 `shape`: `drop`, `swing`, `water-coaster`, `comet-coaster`, `disk`, `speedway`. `bounds`·`queue`·`exit_area`는 `[x,y,width,height]`다. `entrance`·`exit`는 서로 다른 노드를 참조한다. `model_height_m`은 모형 높이 기준, `label_anchor`는 이름표의 평면 기준점이다. 모든 시설은 `level: 0`이다. 혜성특급은 `comet-coaster`로 지상에 표시하며 B1·지하 절개는 사용하지 않는다.

`validate_geometry`는 좌표·자료형·범위·참조, 모든 노드의 연결성과 다리에서 입출구까지의 왕복 경로, 예약 구획의 상호 겹침과 섬 내부 배치, 연결 동선의 유효 폭과 대기 완충을 검사한다. 대기 구획과 참조 동선에는 1.5m 완충을 적용하고 해당 입구 지선·전용 하차 접속부만 예외다. 입구는 대기 구획 경계에 있고 바깥쪽에서 접근해야 하며 출구는 전용 하차 합류 구획 안에 있어야 한다. `VisitorRoutes`는 이 그래프의 공공 연결과 별도의 입구 접속, 대기 중심선, 이탈 게이트, 승하차 전용 구간을 사용한다.

`walking_route(map_data, source, target)`와 `route.mjs`는 연결 그래프 내 최단 노드 목록과 거리를 반환하는 검사용 참조다. 실제 지도 표시 경로는 `navigation.mjs`의 `createNavigator(map).route(source,target)`를 사용한다. 결과의 `nodes`는 양 끝의 ID, `points`는 실제 표시 경로의 평면 좌표, `distance_m`은 좌표 간 거리 합, `mode`는 `open-plaza`다.

표시 탐색은 2m 격자·반경 0.25m와 포장 면·장애물·해안·다리를 사용한다. 대각선 모서리 관통을 막고 직선 통과가 가능한 경유점을 합친다. 입출구는 전용 지선의 짧은 접속부로 공공 보행 면에 연결한다. 안내 거리는 격자 탐색과 직선화로 계산한다. 공공 광장의 일반적인 사람 사이 충돌 회피는 후속 범위다.

`queue.mjs`의 `queueLayout(bounds,entrance,rules,boardingCapacity,rideBounds,queueCapacity)`와 Python `queue_capacity.py`는 같은 반원 회전부·벨트 경계(`railPaths`)와 직선 자리 좌표를 생성한다. 시설의 `queue_capacity`는 정수 대기 정원이다. 정원을 열별로 고르게 배분하고 남는 자리는 앞 열부터 한 자리씩 추가한다. 이 필드를 생략한 지도는 물리적으로 배치 가능한 자리 전체를 사용한다. 이탈 통로가 있는 쪽의 벨트는 첫 줄의 이탈 게이트에서 두 부분으로 나뉜다. `rails`는 간섭 검사용 선분이며 기둥은 경계의 호 길이에 따라 배치한다. 지도 라벨과 상세에는 수용 인원·자리 수를 표시하지 않는다. 시설의 `boarding_capacity`는 1회 탑승 정원이다. 아트란티스는 보트 1대 8명, 혜성특급은 열차 1편성 26명, 나머지는 1회차 정원이다.

`geometry.queue_rules`는 `minimum_boarding_multiple: 2.5`, `person_radius_m: 0.3`, `spacing_m: 0.8`, `end_clearance_m: 0.8`이다. 진입 통로·회전 구간을 제외하고 직선 줄의 양 끝 여백을 남겨 자리를 만든다. 자리 몸체의 구획 포함, 기둥·벨트 간섭, 전체 자리 간격과 `ceil(boarding_capacity × minimum_boarding_multiple)` 이상 수용을 검증한다. 부족하면 설정을 거절한다. `/api/meta`의 `queue_report`는 시설별 정원, `slots`, `rails`, `railPaths`, `boarding_exit`, `boarding_target`, `reverse_rows`와 보행용 `points`, `withdrawal`, `slot_indices`, `withdrawal_slot_indices`를 제공한다. 화면의 배치·수용 수치를 서버 결과와 대조한다.

지도 바닥은 연속된 포장 면과 실제 다리 메시로 구성한다. 연결 그래프의 섬 내부 지선, 논리적 `plaza`, 정면 연결 띠는 별도 바닥으로 그리지 않는다. 성 정면·다리 축과 예약 구획·보행 가능 판정은 유지한다.

대기 외곽은 시설별 `queue`를 따른다. 혜성특급·자이로스핀은 12×28m, 아르카나라이드는 24.4×16m, 나머지는 24.4×12m이며 하차 합류 외곽은 8×6m다. 대기 외곽과 `queue_capacity`를 함께 검사한다. 시설 이름표와 동선 강조선은 관찰용 주석이며 물리적 점유 구획이 아니다. 모형은 정적 형상으로 운행·차량 가동 상태를 나타내지 않는다.

## 3D 자원과 준비 상태

고정 허용 목록으로 `/map.js`, `/map3d.js`, `/geometry.mjs`, `/rides.mjs`, `/route.mjs`, `/navigation.mjs`, `/queue.mjs`, `/map.css`, `/vendor/three/three.module.js`, `/vendor/three/three.core.js`, `/vendor/three/OrbitControls.js`, `/vendor/three/LICENSE`만 제공한다. 모듈은 JavaScript MIME을 사용한다. 임의 디렉터리·다른 프로젝트의 파일은 제공하지 않는다.

`map_ready: true`와 `map_view: guide-map-3d`는 지도 표시 준비를 나타낸다. 실행 서버의 `runnable`은 배경 방문객 순환의 실행 여부다. `window.inspectMagicMap()`은 브라우저 검증용 읽기 전용 장면 스냅샷이다. WebGL 미지원·그래픽 연결 오류는 화면에 안내한다.

## 개발 중 변경 반영

정적 파일은 매 요청마다 파일에서 읽고 `Cache-Control: no-store`로 제공한다. 지도·일일 운영·선호·시설 운행 JSON은 파일 수정 시각·크기 변경을 감지해 묶음 전체를 다시 검증한다. 성공하면 같은 서버의 `/api/meta`가 새 설정·해시·수용량을 반환한다. 잘못 저장한 입력은 422이며, 수정 저장 후 다시 요청하면 복구한다.

CLI 기본 모드는 `devserver.py`가 Python 소스 변경을 감지해 자식 서버를 같은 포트에서 다시 시작한다. `--no-reload`는 이 감시만 끈다. `/api/dev-version`의 `version`은 정적 자원·설정·실행 인스턴스 식별자이며, `instance`는 Python 서버를 다시 불러오면 바뀐다. 사용자 화면은 자동 새로고침하지 않으므로 저장 후 브라우저 새로고침을 사용한다. 기존 감시 기능이 없는 서버에는 한 번의 재실행이 필요하다.

## 대기 입구·탑승 진입·이용 후 퇴장

`entrance`는 초록 대기줄 입구, `exit`는 이용 후 빨간 퇴장점이다. 대기줄 출구는 별도의 `queue_report.boarding_exit`이며 황금색 점으로 표시한다. 대기줄과 탑승 진입점에는 지도 이름표를 생성하지 않는다. `boarding_target`은 해당 놀이기구 구획의 가장 가까운 경계점이다. 접힌 줄의 횡방향을 필요에 따라 뒤집어 마지막 줄이 놀이기구 가까운 쪽 경계로 이어지게 한다. `points[0]`은 초록 입구이고 `points[-1]`은 탑승 진입점이다. 방향 화살표와 자리 순서도 같은 방향을 따른다.

현재 지도에서는 입구보다 탑승 진입점의 시설 구획까지 거리가 짧은지, 짧은 탑승 연결이 다른 구획을 침범하지 않는지 검사한다. 탑승 진입선은 정적 안내 표시다. 줄 이동·탑승·운행·하차 상태의 지도 표시는 체크리스트 8번에서 연결한다.
