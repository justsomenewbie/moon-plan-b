"""Reproducible local QA gate with terminal output and exact-input hashes."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time

from qa.verify_json_contract import ROOT, sha


def run(command, expected=0):
    start = time.perf_counter()
    try:
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=120)
        output = (result.stdout + result.stderr).replace(str(ROOT), "<repo>")
        code = result.returncode
    except (OSError, subprocess.TimeoutExpired) as exc:
        output, code = str(exc).replace(str(ROOT), "<repo>"), None
    display_command = list(command)
    display_command[0] = "python" if command[0] == sys.executable else Path(command[0]).stem
    return {"command": display_command,
            "expectedExit": expected, "actualExit": code,
            "status": "PASS" if code == expected else "FAIL",
            "elapsedSeconds": round(time.perf_counter()-start, 4), "output": output}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "qa/evidence/latest")
    args = parser.parse_args()
    checks = [run([sys.executable, "-B", "-m", "qa.generate_fixtures", "--check"]),
              run([sys.executable, "-B", "-m", "unittest", "qa.test_edge_cases", "-v"])]
    for name in ("normal", "crossing_wrap", "partial", "missing"):
        command = [sys.executable, "-B", "-m", "qa.verify_json_contract", f"qa/fixtures/{name}.json",
                   "--manifest", f"qa/fixtures/{name}.manifest.json"]
        checks.append(run(command))
    checks.append(run([sys.executable, "-B", "-m", "qa.verify_json_contract", "qa/fixtures/normal.json",
                       "--manifest", "qa/fixtures/normal.manifest.json", "--release"], expected=1))
    node = shutil.which("node") or "node"
    checks.append(run([node, "--experimental-strip-types", "--test", "qa/frontend_integration.test.ts",
                       "frontend/tests/dataset.test.ts", "frontend/tests/moon-globe.test.ts",
                       "frontend/tests/i18n.test.ts", "frontend/tests/theme.test.ts"]))
    files = [p for p in (ROOT / "qa").rglob("*") if p.is_file() and
             not any(part in ("evidence", "__pycache__") for part in p.relative_to(ROOT / "qa").parts)]
    files += [ROOT / "contracts/openapi.draft.json", *list((ROOT / "frontend/lib").rglob("*.ts")),
              *list((ROOT / "frontend/tests").glob("*.ts"))]
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    node_version = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    report = {"generatedAtUtc": datetime.now(timezone.utc).isoformat(), "baseHeadAtRun": head,
              "python": platform.python_version(), "node": node_version,
              "scope": "QA artifacts plus dependency-free frontend source smoke tests",
              "releaseApproval": "NOT_GRANTED",
              "limitations": ["This offline runner does not install frontend dependencies, typecheck, or build the application.",
                              "Synthetic fixtures do not verify astronomical accuracy.",
                              "Browser testing, network traces, user sessions and contract acceptance require separate evidence."],
              "inputsSha256": {p.relative_to(ROOT).as_posix(): sha(p.read_bytes()) for p in sorted(set(files))},
              "checks": checks, "status": "PASS" if all(c["status"] == "PASS" for c in checks) else "FAIL"}
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "results.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    log = "\n\n".join("$ " + " ".join(c["command"]) + "\n" + c["output"] +
                        f"\nExpected exit {c['expectedExit']}; actual {c['actualExit']}; {c['status']}" for c in checks)
    (args.output / "terminal.txt").write_text(log + "\n", encoding="utf-8", newline="\n")
    for c in checks:
        print(c["status"], " ".join(c["command"]), f"({c['elapsedSeconds']}s)")
    print(f"QA gate: {report['status']}; product release: NOT_GRANTED")
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
