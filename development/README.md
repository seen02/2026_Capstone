# 캡스톤 소프트웨어 개발

최종 결과물은 시뮬레이션과 운영자 대시보드를 통합한 운영 앱, QR 관람객 화면, 영상 기반 인원·밀집도 분석 및 추천 서버다. 현재 매직아일랜드 3D 시뮬레이션, 운영자 대시보드, QR 사용자 진입·선호 입력·실시간 추천 및 수락을 실행할 수 있다. 시뮬레이션과 운영자 대시보드는 같은 앱의 두 탭이다. [전체 구성과 연동 순서](docs/software-plan.md)

QR 추천은 세션의 선호·현재 위치와 시뮬레이션의 시설 상태·대기열을 사용한다. 추천을 수락하면 캐릭터 이동이 시작된다. 보상 지급은 후속 범위다. [QR 실행 안내](lotteworld/README.md#qr-사용자-진입과-선호-입력) · [공통 데이터 계약 v1](docs/contracts/recommendation-v1.md)

현장 시연은 종료 없는 연속 실행을 목표로 하며 사용자 웹과 시뮬레이션 웹에서 기존 3D 지도를 재사용한다. 시뮬레이션 기본 화면에는 시간 표시·재생바 없이 3D 지도를 배치한다. AWS 서비스는 계정 권한을 확인한 뒤 정한다. 기능별 진행 상태는 [체크리스트](docs/implementation-checklist.md)를 따른다.

아쿠아리움과 롯데월드를 독립 프로젝트로 분리했다. Python 3.11 이상을 사용하며 추가 Python 패키지는 필요하지 않다. 기존 팀 자료와 상위 작업 공간의 이전 원본은 보존한다.

| 위치 | 실행 상태 | 기본 포트 |
| --- | --- | --- |
| [aquarium/](aquarium/README.md) | 기존 아쿠아리움 시뮬레이션·CLI·정적 시안 | 8765 (정적 시안8766) |
| [lotteworld/](lotteworld/README.md) | 매직아일랜드 3D 시뮬레이션·설정 검증·운영자 대시보드·[QR 진입 및 선호 입력](lotteworld/README.md#qr-사용자-진입과-선호-입력) | 3000 |
| [docs/](docs/design.md) | 매직아일랜드 명세·운영 조사·체크리스트·검증 기록 | — |

각 프로젝트의 코드·지도·운영·선호·테스트·실행 스크립트는 해당 폴더 안에 있다. 두 폴더는 서로의 런타임을 가져오지 않으며 각 폴더만 복사해도 실행할 수 있다. 기존 아쿠아리움 설계·재사용 기록과 `web-admin` 문서는 모두 `aquarium/` 아래에 있다.

## 문서 안내

| 확인할 내용 | 문서 |
| --- | --- |
| 기능별 구현 범위·완료 기준·진행 상태 | [개발 체크리스트](docs/implementation-checklist.md) |
| 사용자 웹: QR·추천 수락·보상·자기 위치 3D 지도 | [사용자 웹](docs/user-web.md) |
| 시뮬레이션 웹: 전체 공간의 연속 3D 시연 | [시뮬레이션 웹](docs/simulation-web.md) |
| 전체 방향·공통 서버·배포 순서 | [소프트웨어 계획](docs/software-plan.md) |
| 공유 데이터의 필드·단위·상태 | [공통 데이터 계약](docs/contracts/recommendation-v1.md) |

## 시나리오 선택

이 `development/` 폴더에서 실행한다. 루트 진입점은 시나리오를 명시적으로 선택해야 한다.

```powershell
./run.ps1 --scenario aquarium
./run.ps1 --scenario magic-island
./run.ps1 --scenario aquarium --mode cli --visitors 1000 --output aquarium/output/day-report.json
./run.ps1 --scenario magic-island --mode cli --validate-only --output lotteworld/output/scenario-metadata.json
```

`python run.py`에도 같은 인자를 사용할 수 있다. `--mode`의 기본값은 `server`다. `--config 경로`와 `--output 경로`는 호출한 폴더 기준으로 해석한다. 매직아일랜드에서 `--config`는 연속 시연 설정을 지정한다. 생략한 경로는 각 프로젝트 폴더의 기본값을 사용한다. 서버·CLI는 `--validate-only`로 시나리오 입력을 검증할 수 있다. 시나리오를 바꾸려면 원하는 시나리오로 별도 실행한다.

아쿠아리움의 기존 `./run.ps1`, `python -m aquarium_sim.server`, CLI 명령은 이제 `aquarium/`에서 사용한다. 롯데월드는 `lotteworld/`의 `./run.ps1`, `python -m lotteworld_sim.server`로 독립 실행한다.

## 매직아일랜드 현재 범위

[체크리스트](docs/implementation-checklist.md) 1–6번인 설정 분리, 3D 지도·시설 표시, 연속 유입·개인 체류·퇴장, 물리적 대기열과 승하차 보행, 회차·차량 운행을 구현했다. 지도에서 6개 시설과 다리·성·호수·보행로·대기 구획을 확인하고, 연속 시연 상태 API에서 방문객 위치와 대기열·차량 운행을 조회할 수 있다.

매직아일랜드 서버는 수동 종료까지 배경 방문객과 시설 운행을 순환시킨다. CLI는 지도·연속 시연·시설 운행·선호 설정을 검증하고 메타데이터를 내보낸다. [설정 계약](lotteworld/docs/configuration.md) · [연속 시연 검증](docs/verification/magic-island-continuous-arrivals.md) · [회차·차량 운행 검증](docs/verification/magic-island-ride-operations.md)

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
