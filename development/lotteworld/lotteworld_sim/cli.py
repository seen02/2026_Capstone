"""설정 검증·내보내기 전용 CLI. 시뮬레이션 결과로 오인하지 않도록 구분한다."""
import argparse
import json
import sys
from pathlib import Path
from .scenario import load_inputs


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="매직아일랜드 설정 검증")
    parser.add_argument("--config", type=Path, help="매직아일랜드 운영 설정 JSON")
    parser.add_argument("--validate-only", action="store_true", help="설정 검증 및 메타데이터 출력")
    parser.add_argument("--output", type=Path, help="검증된 설정 메타데이터 JSON 저장 위치")
    args = parser.parse_args()
    try:
        data = load_inputs(config_path=args.config).metadata()
    except ValueError as exc:
        parser.error(str(exc))
    if not args.validate_only:
        parser.error("설정 확인에는 --validate-only를 사용하세요. 연속 유입을 실행하려면 서버를 시작하세요.")
    encoded = json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)


if __name__ == "__main__":
    main()
