# 기존 프로젝트에서 재사용한 내용

원본: https://github.com/taein0926/ai-persona

확인 기준 커밋: `0c1020709272b978014caaa20aec5a00de6317dd`.

| 원본 | 현재 적용 | 상태 |
|---|---|---|
| `src/persona_evac/hashing.py` | `aquarium_sim/hashing.py` | 결정적 시드·설정 해시 함수 재사용 |
| `src/persona_evac/llm/common.py` | `aquarium_sim/personas.py`의 `JsonCache` | 입력·컨텍스트·모델·설정 해시 기반 캐시 구조 수정. 현재 규칙 실행에는 연결하지 않은 확장 지점 |
| `gaehwasan3d.js` | `web/map3d.js` | CanvasTexture 라벨 및 Three.js 화면 구성 방식 참고 |
| Three.js와 OrbitControls 배포본 | `web/vendor/three/` | 원본 저장소의 배포본 재사용, MIT LICENSE 포함 |

관람 엔진·입퇴장·분별 확률 입장·선호 전시 선택·가상 지도·API·화면은 아쿠아리움 용도로 구성했습니다. 화재·연기·대피 로직과 역 지형은 포함하지 않습니다. 층간 이동 표현 코드는 단층 설계에 맞춰 제거했습니다.

`PreferenceProvider`는 향후 LLM 또는 LLM 결과 캐시를 연결할 인터페이스입니다. 현재는 `RuleProvider`의 4가지 합성 선호 유형을 사용합니다.

실제 아쿠아리움 사례의 안내도, 도면, 조사 문서, 입장 통계, 이전 결과물은 제거했습니다. 전시 구성은 사용자 발표 자료를 참고하며 공간 치수·정원·공연 시간표·입장률은 가상 실험 설정입니다.

UI는 원본 `gaehwasan.html`·`gaehwasan.css`의 3열 편집기 구성(설정/지도/상세), 지도 아래 재생 조작, 차콜 패널과 밝은 뷰포트를 참고했습니다. 기능은 아쿠아리움에 맞춰 구현하며 원본의 화재·대피 기능은 가져오지 않았습니다.

버튼 공통 규칙은 `web/station-controls.css`에서 관리합니다. 원본 `station_base.css`·`gaehwasan.css`의 기본/재생/목록 버튼과 마우스 오버·선택·비활성·키보드 포커스 표현을 따릅니다. 재생 상태 아이콘은 원본 `station_viewer.js`와 같은 `▶` / `❚❚`, 재시작은 `gaehwasan.html`의 `↺`입니다. 설계·시간표는 팝업 창으로 표시하며 닫기에는 × 형태의 선 아이콘만 사용합니다. 패널 글씨 확대와 아쿠아리움의 기능은 유지합니다.
