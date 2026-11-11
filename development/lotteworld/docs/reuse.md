# 매직아일랜드 3D 지도 재사용 내역

기준일: 2026-11-11.

- [아쿠아리움 map3d.js](../../aquarium/web/map3d.js)의 Three.js·직교 카메라·OrbitControls·모형 선택 방식을 참고했다. 새 `web/map3d.js`, `geometry.mjs`, `rides.mjs`는 매직아일랜드 좌표·넓은 포장 광장·시설 모형·장면 검증에 맞춰 독립 작성했다. 아쿠아리움 엔진·화면·설정을 직접 import하지 않는다.
- [아쿠아리움의 로컬 Three.js 사본](../../aquarium/web/vendor/three/LICENSE)에서 `three.module.js`, `three.core.js`, `OrbitControls.js`, `LICENSE`를 `web/vendor/three/`에 복사했다. 라이브러리 소스는 수정하지 않고 MIT 라이선스 고지를 함께 보존한다. 외부 CDN 요청 없이 해당 프로젝트 폴더만으로 실행한다.
- 시설·섬·성 모형은 기본 기하 형상으로 작성했다. 안내도 PDF의 이미지·로고를 자원으로 복제하거나 저장소에 포함하지 않았다. 상대 배치·시설 특징을 참고한 가상 공간이며 실측 도면·운영 사양을 재현한 디지털 트윈이 아니다.
- 혜성특급 지상 표시는 현재 시각화 요구에 따른 추상화다. 다른 시설과 동일한 지면에 열차·굽은 코스를 표시한다.
