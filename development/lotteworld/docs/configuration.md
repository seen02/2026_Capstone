# 매직아일랜드 설정 계약

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

`validate_geometry`는 좌표·자료형·범위·참조, 모든 노드의 연결성과 다리에서 입출구까지의 왕복 경로, 예약 구획의 상호 겹침과 섬 내부 배치, 연결 동선의 유효 폭과 대기 완충을 검사한다. 대기 구획과 참조 동선에는 1.5m 완충을 적용하고 해당 입구 지선·전용 하차 접속부만 예외다. 입구는 대기 구획 경계에 있고 바깥쪽에서 접근해야 하며 출구는 전용 하차 합류 구획 안에 있어야 한다. 실제 접힌 줄과 승하차 보행은 4번에서 구현한다.

`walking_route(map_data, source, target)`는 연결 그래프 내 최단 노드 목록과 `distance_m`을 반환한다. 화면의 `route.mjs`도 같은 입력·유클리드 길이를 사용한다. 이는 표시된 경유 경로 기준 거리이며 넓은 포장 광장의 모든 자유 이동 경로 중 최단 거리나 실제 이동시간은 아니다. 후속 이동 계산은 `public_walkable` 영역·장애물·개인 반경을 사용하고 사람을 참조 중심선의 폭에만 가두지 않는다. 사람의 충돌 회피·혼잡 시 이동·실제 대기 자리 수는 아직 검증하지 않았다.

대기 외곽 24×12m, 하차 합류 외곽 8×6m는 가상 공간 예약이며 확정 정원이 아니다. 시설 이름표와 동선 강조선은 관찰용 주석이며 물리적 점유 구획이 아니다. 모형은 정적 형상으로 운행·차량 가동 상태를 나타내지 않는다.

## 3D 자원과 준비 상태

고정 허용 목록으로 `/map.js`, `/map3d.js`, `/geometry.mjs`, `/rides.mjs`, `/route.mjs`, `/map.css`, `/vendor/three/three.module.js`, `/vendor/three/three.core.js`, `/vendor/three/OrbitControls.js`, `/vendor/three/LICENSE`만 제공한다. 모듈은 JavaScript MIME을 사용한다. 임의 디렉터리·다른 프로젝트의 파일은 제공하지 않는다.

`Scenario.metadata()`는 `status: map_ready`, `map_ready: true`, `map_view: guide-map-3d`, `runnable: false`를 함께 반환한다. 지도 표시 준비와 유입·보행·운행 엔진 준비를 구분한다. `window.inspectMagicMap()`은 브라우저 검증용 읽기 전용 장면 스냅샷이며 운영 API가 아니다. WebGL 미지원·그래픽 연결 오류는 화면에 안내한다.
