# 시나리오 선택과 실행 분리 검증

검증일: 2026-11-11. 체크리스트1번 구현 상태를 대상으로 했다. 시작 커밋은 `1ccc6cfebf3fec4ce978b3b18eeab720e5f8e6c1`이며 이 기록은 해당 구현과 함께 커밋한다.

## 실행 결과

Python은 `C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe`를 사용했다. 아래 `python`은 이 실행 파일을 가리킨다.

| 작업 폴더 | 실제 명령 | 결과 |
| --- | --- | --- |
| `development/aquarium/` | `python -m unittest discover -s tests -v` | 기존 회귀37개 통과, 358.682초 |
| `development/aquarium/` | `python -m unittest discover -s tests -p test_scenario_isolation.py -v` | 전체 회귀 실행 시작 후 추가한 선호·분리 검사2개 통과 |
| `development/lotteworld/` | `python -m unittest discover -s tests -v` | 설정·CLI·HTTP 검사5개 통과 |
| `development/` | `python -m unittest discover -s tests -v` | 선택 진입점·단독 복사·교차 설정 거절·동시 서버 검사5개 통과 |
| `development/aquarium/` | `Get-ChildItem tests/*.test.mjs \| ForEach-Object { node $_.FullName }` | JavaScript4개 파일 통과 |
| `development/` | `./run.ps1 --scenario magic-island --validate-only` | 전용 설정 메타데이터 출력, 종료 코드0 |
| `development/` | `./run.ps1 --scenario aquarium --validate-only` | 기존1,000명 설정 검증, 종료 코드0 |

Python 검사 합계49개가 통과했다. JavaScript는 geometry·playback·programs·spatial의4개 파일을 각각 실행했다. 문서 내부 링크와 `git diff --check`도 검사했다.

## 확인한 범위

- 아쿠아리움 기존 하루 흐름·시드 재현·인원/정원 보존·공연·대기열·이동·되감기·경량 재생 API가 유지된다. 기존 선호4종 ID·가중치를 JSON으로 옮기고 누락 태그 기본값1.0을 유지했다.
- 루트에서 시나리오를 필수로 선택하며 알 수 없는 이름·경로 형태는 거절한다. 서버/CLI 모두 선택할 수 있고 다른 작업 폴더에서 호출해도 올바른 프로젝트로 연결된다.
- `--config`·`--output` 상대 경로는 호출 위치 기준이다. `--config=...` 형식도 검사했다. 다른 시나리오의 운영 설정은 양쪽 서버·CLI에서 거절한다.
- 각 폴더를 임시 경로에 단독 복사하고 다른 시나리오 폴더 없이 검증 진입점이 실행되는 것을 확인했다.
- 두 서버를 동시에 실행해 시나리오 ID·기본 인원·실행 가능 상태와 각자의 응답이 구분되는 것을 확인했다. 아쿠아리움의 기존 HTML·상태 API는 정상 제공되고 매직아일랜드의 상태 요청은409다.
- 매직아일랜드 기본값9구간 합10,350명, 13~16시4,600명, 피크1,610명, 체류120~240분·관측19시 종료를 확인했다. 지도·선호 태그의 교차 참조, 인원·비중 합계, 시간 중복·공백, 잘못된 형식·자료형·음수·NaN·무한대·범위 밖 선호를 검사했다.
- 동일 설정의 해시가 같고 운영 시드 변경 시 운영 해시가 바뀌며 지도 해시는 유지된다. 반복 로드는 새 객체를 읽는다.
- 매직아일랜드는 아쿠아리움 정적 파일을 제공하지 않는다. 재생 API는409로 거절하고 설정 확인 CLI는 `--validate-only`가 없으면 오류로 종료한다. 내보내기는 `configuration_only` 설정 메타데이터다.

초기 통합 검사에서 Windows의 기본 출력 인코딩 때문에 JSON을 UTF-8로 해석할 수 없었다. 롯데월드 서버/CLI의 표준 출력을 UTF-8로 고정한 뒤 통합 검사가 통과했다.

## 후속 검증

실제 매직아일랜드 지도·시간표 생성·보행·대기열·운행·9시간 실행은 아직 구현하지 않았다. 위 입력 검증과 기존 아쿠아리움 검사를 새 시뮬레이션 실행 검증으로 해석하지 않는다. 지도 연결성·대기 공간·차량 보존·관측 종료 상태·대규모 성능은 체크리스트2~9번에서 각각 확인한다.
