# 매직아일랜드 설정 계약

설정·지도와 후속 추천 서버의 연결은 [추천·시뮬레이션 공통 데이터 계약 v1](../../docs/contracts/recommendation-v1.md)을 따른다. `hashes.map`을 지도 버전으로 사용하고 QR 사용자의 선호 순위는 기존 0–5 프로필과 구분한다. 해당 계약은 설계 문서이며 아래 현재 API 동작을 변경하지 않는다.

세 JSON은 `schema_version: 1`, `scenario_id: magic-island`와 `provenance`를 포함한다. `lotteworld_sim/scenario.py`의 `load_inputs`가 매번 새 객체를 읽고 `validate`로 자료형·범위·파일 간 참조를 검사한다. 다른 시나리오로의 자동 대체나 아쿠아리움 엔진 호출은 없다.

| 파일 | 현재 계약 |
| --- | --- |
| `configs/map.json` | 6개 고유 시설 ID·이름, `map_ready` 상태, 미터 좌표·구획·양방향 보행 그래프 |
| `configs/day.json` | 음수가 아닌 정수 시드, 관측 시작·종료와 월드 오브 라이트 종료 이벤트, 강제 퇴장 금지, 실제 진입부터 대기 포함 균등 체류, 관측 종료로 체류 자르기 금지 |
| `configs/preferences.json` | 지도 시설과 일치하는 태그6개, 고유 유형 ID와 이름, 모든 시설별 0–5의 유한한 숫자, `provisional` 상태 |

운영 설정의 `arrivals`는 하루 기준 인원·관측 비중·관측 계획 합계와 `slots`를 분리한다. 한 시간 단위의 시작 포함·끝 제외 구간은 관측 시작부터 종료까지 빈틈·중복 없이 이어져야 한다. 각 행의 `count = daily_baseline × share`, 전체 `planned_total = daily_baseline × observation_share`, 행별 인원·비중의 합계를 검증한다. 이 계약으로 관측 구간에 19시 이후 몫을 몰아넣거나 구간을 중복하는 입력을 검출한다.

기본값 검증은 9구간 합10,350명, 13–16시4,600명, 피크14–15시1,610명을 확인한다. 사용자 운영 JSON은 계약을 지키는 실험용 값으로 변경할 수 있다. 최신 연구·기본 시나리오는 `../../docs/design.md`가 기준이다. 입력 설정 검증이 실제 유입·체류 엔진의 구현을 뜻하지 않는다.

`Scenario.metadata()`는 시나리오 ID, 이름, `status: map_ready`, `map_ready: true`, `runnable: false`, 준비 상태 설명과 세 설정·해시를 반환한다. 해시는 정렬된 JSON의 UTF-8 바이트를 SHA-256으로 계산한다. 동일 설정이면 해시가 같고, 시드 등 운영 값 변경은 운영 해시만 바꾼다. 해시는 설정 식별자이며 실행 결과 증명이 아니다.

서버는 로컬 주소127.0.0.1에 바인딩한다. `/`는 지도 화면, `/map.js`·`/map.css`는 전용 정적 자원, `GET /api/meta`는 설정을 제공한다. 정적 자원은 고정 허용 목록으로만 제공하고 임의 파일 경로는 거절한다. 상태·안내판·결과·진행·되감기·재시작 요청은409, 없는 경로는404다. 아쿠아리움 정적 파일은 제공하지 않는다. 엔진을 연결하는 후속 작업에서 상태 계약과 미구현 API를 명시적으로 변경한다.

## 지도 형상 계약 (2번)

`geometry`는 `units: m`, `axis: x-right-y-down`이다. JSON의 두 번째 평면 좌표를 3D의 z로 옮기고 3D y를 높이로 사용한다. 길이·높이는 같은 가상 미터 단위다. 지도 픽셀을 실측 거리로 환산하지 않는다. 기본 `bounds`는 `[0,0,370,330]`이며 시설·구획과 참조 통행 폭은 범위 안에 있어야 한다.

- `render_style: guide-map-3d`, `island_outline`: 섬 외곽의 유한한 2D 꼭짓점 목록. 중복·자기 교차·면적 없는 다각형을 거절한다. `island`·`lake` 사각형은 배경 범위의 기존 메타데이터이며 실제 섬 경계는 `island_outline`이다.
- `public_space: island-minus-reservations`: 섬 내부의 넓은 포장 면에서 시설의 `bounds`·`queue`·`exit_area`, `castle`, `scenery_buildings`, `landscape_beds`를 제외한다. 나머지는 그래프 중심선 밖이라도 보행 가능하다. 섬 윤곽은 주 섬·남쪽 메이플 돌출부·다리 양옆 수면 홈을 구분한다. 섬 밖에서는 다리의 실제 직사각형 유효 폭만 허용한다. `public_walkable(map_data, point, radius=0)`가 개인 반경·해안 경계·제외 구획을 반영한다.
- `landscape_beds`: 실제로 녹지로 표시하는 작은 식재 사각형 목록. 나무도 이 안에만 배치한다. 시설·대기·주 동선과 겹칠 수 없다. `scenery_buildings`는 성 뒤 배경 건물의 예약 구획이다. `castle_height_m`은 성의 표시 높이 기준이다. `castle_forward`는 성 정면과 다리의 공통 방향, `castle_model_scale_xz`는 회전 후 점유 구획에 맞춘 평면 배율, `forecourt_width_m`은 정면 광장의 표시 폭이다.
- `nodes`: 고유 문자열 `id`와 유한한 두 좌표 `point`. ID에 붙은 숫자는 식별자이며 현재 좌표를 뜻하지 않는다. `boundary`는 다리 경계 노드를 참조한다. `bridge_placement: castle-forecourt-to-southeast`이며 `bridge-island`에서 외부 경계까지 한 개의 직선 다리로 연결한다. 성 중심·성 정문·다리 시작·끝은 `castle_forward`와 같은 축에 있어야 한다.
- `edges`: 고유 `id`, 기존 노드를 가리키는 `source`·`target`, `width`, `kind`. 양방향이며 0 길이·중복 연결을 거절한다. 최소 참조 폭은 `main`·`bridge` 8m이며 기본 다리 폭은 12m다. `branch` 5m, `exit` 3m다. 이 폭은 보행 가능한 포장 면 전체를 제한하지 않는다. 다리 외 연결은 반폭까지 섬 내부에 있어야 한다.
- 시설별 `shape`: `drop`, `swing`, `water-coaster`, `comet-coaster`, `disk`, `speedway`. `bounds`·`queue`·`exit_area`는 `[x,y,width,height]`다. `entrance`·`exit`는 서로 다른 노드를 참조한다. `model_height_m`은 모형 높이 기준, `label_anchor`는 이름표의 평면 기준점이다. 모든 시설은 `level: 0`이다. 혜성특급은 `comet-coaster`로 지상에 표시하며 B1·지하 절개는 사용하지 않는다.

`validate_geometry`는 좌표·자료형·범위·참조, 모든 노드의 연결성과 다리에서 입출구까지의 왕복 경로, 예약 구획의 상호 겹침과 섬 내부 배치, 연결 동선의 유효 폭과 대기 완충을 검사한다. 대기 구획과 참조 동선에는 1.5m 완충을 적용하고 해당 입구 지선·전용 하차 접속부만 예외다. 입구는 대기 구획 경계에 있고 바깥쪽에서 접근해야 하며 출구는 전용 하차 합류 구획 안에 있어야 한다. 접힌 줄 형상은 표시용으로 제공하고 실제 줄 이동·자리 정원·승하차 보행은 4번에서 구현한다.

`walking_route(map_data, source, target)`와 `route.mjs`는 연결 그래프 내 최단 노드 목록과 거리를 반환하는 검사용 참조다. 실제 지도 표시 경로는 `navigation.mjs`의 `createNavigator(map).route(source,target)`를 사용한다. 결과의 `nodes`는 양 끝의 ID, `points`는 실제 표시 경로의 평면 좌표, `distance_m`은 좌표 간 거리 합, `mode`는 `open-plaza`다.

표시 탐색은 2m 격자·반경 0.25m와 포장 면·장애물·해안·다리를 사용한다. 대각선 모서리 관통을 막고 직선 통과가 가능한 경유점을 합친다. 입출구가 대기·하차 예약 구획의 경계에 있으므로 해당 전용 지선의 짧은 접속부를 통해 공공 보행 면에 연결한다. 격자와 직선화로 계산한 안내 거리이며 연속 공간의 정확한 최단 거리·실제 이동시간을 뜻하지 않는다. 사람 생성·충돌 회피·혼잡 시 이동은 아직 구현하지 않았다.

`queue.mjs`의 `queueLayout(bounds,entrance,rules,boardingCapacity,rideBounds)`와 Python `queue_capacity.py`는 같은 반원 회전부·양쪽 연속 벨트 경계(`railPaths`)와 직선 자리 좌표를 생성한다. `rails`는 이 연속 경계를 간섭 검사용 선분으로 나눈 값이다. 화면은 벨트를 곡선 전체에 연결하며 기둥은 경계의 호 길이에 따라 배치한다. 지도 라벨과 상세에는 수용 인원·자리 수를 표시하지 않고 내부 검증 보고에만 유지한다. 시설의 `boarding_capacity`는 1회 탑승 정원이며 아트란티스는 보트 1대 8명, 혜성특급은 열차 1편성 26명, 나머지는 1회차 정원이다. 전체 차량 수나 동시 운행 인원으로 대체하지 않는다.

`geometry.queue_rules`는 `minimum_boarding_multiple: 2.5`, `person_radius_m: 0.3`, `spacing_m: 0.8`, `end_clearance_m: 0.8`이다. 진입 통로·회전 구간을 제외하고 직선 줄의 양 끝 여백을 남겨 자리를 만든다. 자리 몸체의 구획 포함, 기둥·벨트 간섭, 전체 자리 간격과 `ceil(boarding_capacity × minimum_boarding_multiple)` 이상 수용을 검증한다. 부족하면 설정을 거절한다. `/api/meta`의 `queue_report`는 시설별 `capacity`, `minimum_capacity`, `boarding_capacity`, `meets_minimum`, `slots`, `rails`, `railPaths`, `boarding_exit`, `boarding_target`, `reverse_rows`를 제공한다. 화면의 배치·수용 수치는 서버 검사와 대조한다. 실제 줄 이동·승하차는 후속 범위다.

지도 바닥은 연속된 포장 면과 실제 다리 메시로 구성한다. 연결 그래프의 섬 내부 지선, 논리적 `plaza`, 정면 연결 띠는 별도 바닥으로 그리지 않는다. 성 정면·다리 축과 예약 구획·보행 가능 판정은 유지한다.

대기 외곽은 시설별 `queue`를 따른다. 혜성특급·자이로스핀은 12×28m, 아르카나라이드는 24×16m, 나머지는 24×12m이며 하차 합류 외곽은 8×6m다. 이 구획은 가상 공간 예약이며 확정 정원이 아니다. 시설 이름표와 동선 강조선은 관찰용 주석이며 물리적 점유 구획이 아니다. 모형은 정적 형상으로 운행·차량 가동 상태를 나타내지 않는다.

## 3D 자원과 준비 상태

고정 허용 목록으로 `/map.js`, `/map3d.js`, `/geometry.mjs`, `/rides.mjs`, `/route.mjs`, `/navigation.mjs`, `/queue.mjs`, `/map.css`, `/vendor/three/three.module.js`, `/vendor/three/three.core.js`, `/vendor/three/OrbitControls.js`, `/vendor/three/LICENSE`만 제공한다. 모듈은 JavaScript MIME을 사용한다. 임의 디렉터리·다른 프로젝트의 파일은 제공하지 않는다.

`Scenario.metadata()`는 `status: map_ready`, `map_ready: true`, `map_view: guide-map-3d`, `runnable: false`를 함께 반환한다. 지도 표시 준비와 유입·보행·운행 엔진 준비를 구분한다. `window.inspectMagicMap()`은 브라우저 검증용 읽기 전용 장면 스냅샷이며 운영 API가 아니다. WebGL 미지원·그래픽 연결 오류는 화면에 안내한다.

## 개발 중 변경 반영

정적 파일은 매 요청마다 파일에서 읽고 `Cache-Control: no-store`로 제공한다. 지도·운영·선호 JSON은 파일 수정 시각·크기 변경을 감지해 묶음 전체를 다시 검증한다. 성공하면 같은 서버의 `/api/meta`가 새 설정·해시·수용량을 반환한다. 잘못 저장한 입력은 422이며, 수정 저장 후 다시 요청하면 복구한다.

CLI 기본 모드는 `devserver.py`가 Python 소스 변경을 감지해 자식 서버를 같은 포트에서 다시 시작한다. `--no-reload`는 이 감시만 끈다. `/api/dev-version`의 `version`은 정적 자원·설정·실행 인스턴스 식별자이며, `instance`는 Python 서버를 다시 불러오면 바뀐다. 사용자 화면은 자동 새로고침하지 않으므로 저장 후 브라우저 새로고침을 사용한다. 기존 감시 기능이 없는 서버에는 한 번의 재실행이 필요하다.

## 대기 입구·탑승 진입·이용 후 퇴장

`entrance`는 초록 대기줄 입구, `exit`는 이용 후 빨간 퇴장점이다. 대기줄 출구는 별도의 `queue_report.boarding_exit`이며 황금색 점으로 표시한다. 대기줄과 탑승 진입점에는 지도 이름표를 생성하지 않는다. `boarding_target`은 해당 놀이기구 구획의 가장 가까운 경계점이다. 접힌 줄의 횡방향을 필요에 따라 뒤집어 마지막 줄이 놀이기구 가까운 쪽 경계로 이어지게 한다. `points[0]`은 초록 입구이고 `points[-1]`은 탑승 진입점이다. 방향 화살표와 자리 순서도 같은 방향을 따른다.

현재 지도에서는 입구보다 탑승 진입점의 시설 구획까지 거리가 짧은지, 짧은 탑승 연결이 다른 구획을 침범하지 않는지 검사한다. 기존 대기 구획과 초록·빨간 점의 위치는 유지한다. 탑승 진입선은 정적 안내 표시다. 사람의 줄 이동·탑승·운행 중 표현·하차는 미구현이며, 대기줄을 나오는 사람의 숨김/표시나 탑승 완료 이벤트도 아직 정하지 않았다. 이 기능은 지도 준비 상태를 운행 엔진 완료로 바꾸지 않는다.
