"""Bridge of the 'alt_dates_python' job type (backend/src/jobs/types/alt_dates_python.ts). Only IMPORTS lunarnav.

argv: the arguments of `lunarnav alt-dates` (built by the backend, each `--flag=value`; `--json=<file>` is
mandatory and points into the job's artifacts dir).

Runs `lunarnav.cli.main(["alt-dates", *argv])` in-process (same parsing, DEM pre-flight and computation
as the CLI) and maps its return code:
  0                      candidates found                                     -> exit 0
  2 and the JSON exists  no feasible landing time (the CLI's "empty" result)  -> exit 0 (a valid result)
  anything else          argparse / SystemExit / exception                    -> unchanged (job fails)
"""
from __future__ import annotations

import os
import sys


def _json_path(argv: list[str]) -> str | None:
    for a in argv:
        if a.startswith("--json="):
            return a[len("--json="):]
    return None


def main() -> int:
    argv = sys.argv[1:]
    out = _json_path(argv)
    if not out:
        sys.stderr.write("alt_dates_python_job: --json=<file> is required\n")
        return 64
    if os.path.exists(out):
        os.remove(out)
    from lunarnav import cli

    rc = int(cli.main(["alt-dates", *argv]) or 0)
    if rc == 2 and os.path.isfile(out):
        print("alt-dates: no feasible landing time (see rejected_by)", flush=True)
        return 0
    return rc


if __name__ == "__main__":
    sys.exit(main())
