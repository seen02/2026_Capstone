# 캡스톤 소프트웨어 개발

최종 결과물은 3D 시뮬레이션, QR 관람객 화면, 영상 기반 인원·밀집도 분석 및 추천 서버, 관리자 대시보드다. 구성·통합 제안·연동 순서는 [최종 소프트웨어 계획](docs/software-plan.md)을 따른다. 현재 구현은 시뮬레이션 기반이며 최종 제품 전체가 실행되는 상태는 아니다.

추천 서버와 시뮬레이션의 연결 형식은 [공통 데이터 계약 v1](docs/contracts/recommendation-v1.md)에 정의했다. 모의/시뮬레이션 입력과 수락·완료·보상 예제는 설계 검증용이며 추천 서버·이동·탑승·보상 API는 아직 구현되지 않았다.

아쿠아리움과 롯데월드를 독립 프로젝트로 분리했다. Python 3.11 이상을 사용하며 추가 Python 패키지는 필요하지 않다. 기존 팀 자료와 상위 작업 공간의 이전 원본은 보존한다.

| 위치 | 실행 상태 | 기본 포트 |
| --- | --- | --- |
| [aquarium/](aquarium/README.md) | 기존 아쿠아리움 시뮬레이션·CLI·정적 시안 | 8765 (정적 시안8766) |
| [lotteworld/](lotteworld/README.md) | 매직아일랜드 지도·시설 표시·설정 검증 서버 | 8767 |
| [docs/](docs/design.md) | 매직아일랜드 명세·운영 조사·체크리스트·인계·검증 기록 | — |

각 프로젝트의 코드·지도·운영·선호·테스트·실행 스크립트는 해당 폴더 안에 있다. 두 폴더는 서로의 런타임을 가져오지 않으며 각 폴더만 복사해도 실행할 수 있다. 기존 아쿠아리움 설계·재사용 기록과 `web-admin` 문서는 모두 `aquarium/` 아래에 있다.

## 시나리오 선택

이 `development/` 폴더에서 실행한다. 루트 진입점은 시나리오를 명시적으로 선택해야 한다.

```powershell
./run.ps1 --scenario aquarium
./run.ps1 --scenario magic-island
./run.ps1 --scenario aquarium --mode cli --visitors 1000 --output aquarium/output/day-report.json
./run.ps1 --scenario magic-island --mode cli --validate-only --output lotteworld/output/scenario-metadata.json
```

`python run.py`에도 같은 인자를 사용할 수 있다. `--mode`의 기본값은 `server`다. `--config 경로`와 `--output 경로`는 호출한 폴더 기준으로 해석하고, 생략한 각 프로젝트의 기본 경로는 해당 프로젝트 폴더를 기준으로 한다. 서버·CLI는 `--validate-only`로 실제 실행 없이 입력 검증을 할 수 있다. 시나리오를 바꾸려면 원하는 시나리오로 별도 실행한다.

아쿠아리움의 기존 `./run.ps1`, `python -m aquarium_sim.server`, CLI 명령은 이제 `aquarium/`에서 사용한다. 롯데월드는 `lotteworld/`의 `./run.ps1`, `python -m lotteworld_sim.server`로 독립 실행한다.

## 매직아일랜드 현재 범위

[체크리스트](docs/implementation-checklist.md)1–2번인 설정 분리와 3D 지도·시설 표시를 완료했다. 회전·확대·이동, 위에서 보기, 가림 줄이기와 시설 가까이 보기를 제공한다. 혜성특급도 지상 모형이며, 섬 내부는 작은 식재·시설 구획을 제외한 넓은 포장 광장이다. 관측10:00–19:00, 계획 유입10,350명, 대기 포함 개인 예정 체류120–240분과6개 시설의 독립 설정을 검증한다. [설정 계약](lotteworld/docs/configuration.md)에 API와 검증 규칙을 정리했다.

6개 시설·다리·성·호수·보행로·대기 구획을 표시하며 시설별 입구 접근·출구 복귀 경로를 확인할 수 있다. 유입·개별 보행·시설 운행·재생은 후속 단계다. 매직아일랜드 서버는 `status: map_ready`, `runnable: false`로 지도 준비 상태를 제공하고 재생 요청은409로 거절한다. CLI의 내보내기는 설정 메타데이터이며 시뮬레이션 보고서가 아니다. 입력 근거·가정은 [개발 명세](docs/design.md)와 [운영 조사](docs/magic-island-research.md)를 따른다. 19시는 관측 종료이며 폐장이 아니다.

## 검증

각 명령은 해당 폴더에서 실행한다.

```powershell
# development/
python -m unittest discover -s tests -v
# development/lotteworld/
python -m unittest discover -s tests -v
# development/aquarium/
python -m unittest discover -s tests -v
Get-ChildItem tests/*.test.mjs | ForEach-Object { node $_.FullName }
```

WindowsApps의 `python` 별칭이 실행되지 않으면 `run.ps1`이 우선 사용하는 `C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe`를 사용한다. 실제 검증 결과는 [검증 기록](docs/verification/scenario-isolation.md)에 있다.

지도 구현의 좌표·연결성·화면 검증 결과는 [3D 지도 검증 기록](docs/verification/magic-island-map3d.md)을 참고한다.
