"""독립 작업 디렉터리에서 선택한 시나리오의 진입점을 실행한다."""
import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
SCENARIOS = {
    "aquarium": ("aquarium", "aquarium_sim"),
    "magic-island": ("lotteworld", "lotteworld_sim"),
}


def main():
    parser = argparse.ArgumentParser(description="시나리오를 선택해 독립 실행합니다.", allow_abbrev=False)
    parser.add_argument("--scenario", choices=SCENARIOS, required=True, help="실행할 시나리오")
    parser.add_argument("--mode", choices=("server", "cli"), default="server", help="서버 또는 CLI")
    args, extra = parser.parse_known_args()
    # 사용자 설정·결과 경로는 호출한 디렉터리 기준으로 유지한다.
    path_options = ("--config", "--output")
    for index, value in enumerate(extra):
        if value in path_options and index + 1 < len(extra):
            extra[index + 1] = str(Path(extra[index + 1]).resolve())
        elif value.partition("=")[0] in path_options and "=" in value:
            key, path = value.split("=", 1)
            extra[index] = f"{key}={Path(path).resolve()}"
    folder, package = SCENARIOS[args.scenario]
    return subprocess.call([sys.executable, "-m", f"{package}.{args.mode}", *extra], cwd=ROOT / folder)


if __name__ == "__main__":
    raise SystemExit(main())
