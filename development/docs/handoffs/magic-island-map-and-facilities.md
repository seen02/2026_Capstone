# 매직아일랜드 지도·시나리오 현재 연결 지점

기준일: 2026-11-11. 현재 구현은 체크리스트 1–2번인 독립 설정·서버와 3D 지도다. 다음 미완료 항목은 3번 시간별 유입·개인 체류다.

## 현재 공간 기준

- 안내도의 성 정면·앞 광장·사선 다리는 같은 직선 축으로 이어진다. 주 섬·남쪽 메이플 돌출부와 다리 양옆 수면 홈을 구분한다.
- 섬 내부 대부분은 보행 가능한 포장 광장이다. 녹지는 12개 작은 식재 구획이며 시설·대기·하차·건물·성 구획은 별도 예약 영역이다.
- 혜성특급을 포함한 6개 시설은 지상 모형이다. 회전·확대·이동·시점 복귀·시설 선택·배경 가림 줄이기를 제공한다.
- `map_ready: true`, `map_view: guide-map-3d`, `runnable: false`다. 표시 모형은 정적이며 실제 유입·보행·대기·운행 엔진은 후속 항목이다.

## 원본과 검증

- [개발 지침](../../AGENTS.md)·[체크리스트](../implementation-checklist.md)·[명세](../design.md)
- [지도 설정](../../lotteworld/configs/map.json)·[공간 판정](../../lotteworld/lotteworld_sim/map_geometry.py): `public_walkable`과 `walking_route`
- [3D 장면](../../lotteworld/web/map3d.js)·[시설 모형](../../lotteworld/web/rides.mjs)·[설정 계약](../../lotteworld/docs/configuration.md)
- [현재 검증 기록](../verification/magic-island-map3d.md): 재실행 명령과 검사 범위

작업 경로는 `development/lotteworld/`이며 아쿠아리움은 독립 실행 상태로 보존한다. 현재 로컬 변경은 미커밋 상태다. 관리자 앱 통합·영상·추천 서비스의 미정 사항은 [전체 계획](../software-plan.md)을 따르며 보류 상태다. 시간표·체류·운행 기준은 명세를 사용한다.
