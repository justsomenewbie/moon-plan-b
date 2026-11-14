"""`validate` job bridge (docs/PYTHON_INTEGRATION.md): lunarnav.validate.run_all + render_markdown.
Only IMPORTS lunarnav; never modifies it.

Unlike `lunarnav validate` (exit 1 when a check fails), this exits 0 whenever the report was produced:
a FAILED validation is a successful job whose report says passed = false.

stdin (UTF-8 JSON, built by the server):
  {"quick": bool, "offline": bool, "include_horizons": bool, "terrain": bool,
   "artifacts_dir": <dir>, "summary_out": <file>, "terrain_out": <scratch file>,
   "scrub": [[<absolute path>, <placeholder>], ...]}
writes artifacts_dir/validation_report.json, validation_report.md (+ validate_terrain_report.json when
the terrain hook ran and wrote its report) and the small summary (see summarise()) to summary_out.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from b3_common import collect_checks, jsonable, read_request, scrub, write_json, write_text

BRIDGE_VERSION = 1
MAX_FAILURES = 50


def summarise(rep: dict, req: dict) -> dict:
    eph = rep.get("ephemeris") or {}
    summary_rows = ((eph.get("matrix") or {}).get("summary")) or []
    failed_pairs = [f"{r.get('pair')}/{r.get('body')}" for r in summary_rows if r.get("passed") is False]
    variants = ((eph.get("diagnostics") or {}).get("variants")) or []
    terrain = rep.get("terrain")
    checks = collect_checks(rep)
    sections = {}
    for key in ("apollo11", "lunar_day"):
        if isinstance(eph.get(key), dict):
            sections[key] = eph[key].get("passed")
    if variants:
        sections["negative_controls"] = all(v.get("passed") is not False for v in variants)
    if summary_rows:
        sections["crosscheck_matrix"] = not failed_pairs
    return {
        "bridge_version": BRIDGE_VERSION,
        "passed": bool(rep.get("passed")),
        "mode": "quick" if req.get("quick") else "full",
        "offline": bool(req.get("offline")),
        "providers": [str(p) for p in (eph.get("providers") or [])],
        "n_sites": len(eph.get("sites") or []),
        "n_time_sets": len(eph.get("time_sets") or []),
        "n_pairs": len(summary_rows),
        "failed_pairs": failed_pairs[:MAX_FAILURES],
        "sections": sections,
        "terrain": None if terrain is None else {"status": str(terrain.get("status")), "passed": terrain.get("passed")
                                                 if isinstance(terrain.get("passed"), bool) else None},
        "n_checks": len(checks),
        "n_checks_failed": sum(1 for _, ok in checks if not ok),
        "failed_checks": [p for p, ok in checks if not ok][:MAX_FAILURES],
        "generated_utc": rep.get("generated_utc"),
        "lunarnav_version": rep.get("lunarnav_version"),
    }


def main() -> int:
    req = read_request()
    pairs = req.get("scrub") or []
    art = Path(req["artifacts_dir"])
    terrain = bool(req.get("terrain"))
    terrain_out = Path(req["terrain_out"])

    from lunarnav.validate import render_markdown, run_all

    print(f"validate: {'quick' if req.get('quick') else 'full'}, horizons={bool(req.get('include_horizons'))}, "
          f"offline={bool(req.get('offline'))}, terrain={terrain}", flush=True)
    rep = run_all(include_horizons=bool(req.get("include_horizons")), offline=bool(req.get("offline")),
                  terrain=terrain, quick=bool(req.get("quick")), log=lambda m: print(m, flush=True),
                  terrain_kwargs={"out_path": str(terrain_out)} if terrain else None)
    rep = jsonable(rep)
    t = rep.get("terrain")
    if isinstance(t, dict) and "report_path" in t:
        # the terrain hook returns the full terrain report inline; publish it as its own artifact
        t["report_path"] = "validate_terrain_report.json"
    md = render_markdown(rep)
    rep = scrub(rep, pairs)
    print("validate: writing the report", flush=True)
    write_json(art / "validation_report.json", rep)
    write_text(art / "validation_report.md", scrub(md, pairs))
    if terrain and terrain_out.is_file():
        try:
            raw = json.loads(terrain_out.read_text(encoding="utf-8"))  # Python accepts its own NaN
        except ValueError:
            raw = None
        if raw is not None:
            write_json(art / "validate_terrain_report.json", scrub(jsonable(raw), pairs))
    write_json(req["summary_out"], scrub(summarise(rep, req), pairs), indent=None)
    print(f"validate: overall {'PASS' if rep.get('passed') else 'FAIL'}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
