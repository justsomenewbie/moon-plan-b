"""`check` job bridge (docs/PYTHON_INTEGRATION.md): lunarnav.precompute.check_output on the files of an
imported run, written as JSON. Only IMPORTS lunarnav; never modifies it.

Unlike `lunarnav check <dir>` (exit 1 when there are violations), this exits 0 whenever the check
itself ran, so a run WITH violations is a successful job whose result lists them.

stdin  (UTF-8 JSON, built by the server): {"dir": <run directory>, "out": <result file>,
                                          "scrub": [[<absolute path>, <placeholder>], ...]}
writes {"bridge_version": 1, "violations": [str, ...], "n_violations": int, "n_files": int|null} to "out"
exit 0 = written; anything else (traceback on stderr) = the check could not run.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from b3_common import read_request, scrub, write_json

BRIDGE_VERSION = 1


def main() -> int:
    req = read_request()
    run_dir = Path(req["dir"])
    pairs = req.get("scrub") or []
    n_files = None
    try:
        man = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
        n_files = len(man.get("files") or {})
    except (OSError, ValueError):
        pass  # check_output reports an unreadable manifest itself
    print(f"check: verifying {n_files if n_files is not None else '?'} file(s) of the run", flush=True)

    from lunarnav.precompute import check_output

    viol = [str(v) for v in check_output(str(run_dir))]
    print(f"check: {len(viol)} violation(s)", flush=True)
    write_json(req["out"], scrub({"bridge_version": BRIDGE_VERSION, "violations": viol, "n_violations": len(viol),
                                  "n_files": n_files}, pairs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
