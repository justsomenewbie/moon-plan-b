"""`validate_terrain` job bridge (docs/PYTHON_INTEGRATION.md): lunarnav.validate_terrain.run(quick, out_path).
Only IMPORTS lunarnav; never modifies it.

lunarnav writes its report with NaN (allow_nan=True), which is not JSON; this bridge rewrites it as strict
JSON (NaN -> null, inf -> "inf") without server paths, and derives a small summary.

stdin (UTF-8 JSON, built by the server):
  {"quick": bool, "raw_out": <scratch file>, "artifacts_dir": <dir>, "summary_out": <file>,
   "scrub": [[<absolute path>, <placeholder>], ...]}
writes artifacts_dir/validate_terrain_report.json and the summary (see summarise()) to summary_out.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

from b3_common import collect_checks, jsonable, read_request, scrub, write_json

BRIDGE_VERSION = 1
MAX_FAILURES = 50


def _num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def summarise(rep: dict, quick: bool) -> dict:
    checks = collect_checks(rep)
    trek = rep.get("trek_header") if isinstance(rep.get("trek_header"), dict) else {}
    methods = []
    for m in rep.get("method_comparison") or []:
        if not isinstance(m, dict):
            continue
        full = m.get("full") if isinstance(m.get("full"), dict) else {}
        methods.append({"site_id": str(m.get("site_id")), "p95_abs_deg": _num(full.get("p95_abs_deg")),
                        "max_abs_deg": _num(full.get("max_abs_deg"))})
    illum = rep.get("illumination") if isinstance(rep.get("illumination"), dict) else {}
    return {
        "bridge_version": BRIDGE_VERSION,
        "mode": "quick" if quick else "full",
        # no overall verdict in the terrain report: only "every pass flag is true"
        "all_checks_passed": bool(checks) and all(ok for _, ok in checks),
        "runtime_s": _num(rep.get("runtime_s")),
        "sections": sorted(k for k in rep if not k.startswith("_")),
        "n_checks": len(checks),
        "n_checks_failed": sum(1 for _, ok in checks if not ok),
        "failed_checks": [p for p, ok in checks if not ok][:MAX_FAILURES],
        "trek_header": {str(k): v.get("pass") for k, v in trek.items() if isinstance(v, dict) and isinstance(v.get("pass"), bool)},
        "method_comparison": methods[:20],
        "illumination": {"n_psr": _num(illum.get("n_psr")), "n_lit": _num(illum.get("n_lit")),
                         "primary": illum.get("primary") if isinstance(illum.get("primary"), str) else None},
    }


def main() -> int:
    req = read_request()
    pairs = req.get("scrub") or []
    quick = bool(req.get("quick"))
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(message)s")
    print(f"validate_terrain: {'quick' if quick else 'full'}", flush=True)

    from lunarnav.validate_terrain import run

    rep = run(quick=quick, out_path=str(req["raw_out"]))
    rep = dict(rep)
    rep.pop("report_path", None)
    clean = scrub(jsonable(rep), pairs)
    print("validate_terrain: writing the report", flush=True)
    write_json(Path(req["artifacts_dir"]) / "validate_terrain_report.json", clean)
    summ = summarise(clean, quick)
    write_json(req["summary_out"], scrub(summ, pairs), indent=None)
    print(f"validate_terrain: {summ['n_checks'] - summ['n_checks_failed']}/{summ['n_checks']} checks passed", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
