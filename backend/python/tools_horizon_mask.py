"""Job type 'horizon_mask' bridge (async POST /tools/horizon). Only IMPORTS lunarnav; never modifies it.

stdin (UTF-8 JSON, built by src/jobs/types/horizon_mask.ts): the horizon_json.py request
  ({"site", "dem", "method", "radius_km", "az_step_deg", "observer_height_m", "near_exclusion_m"?,
    "dem_fallback", "rounding"}) plus "out_path" = a file in the job directory (computed by the server,
never taken from the client request), and "scrub" = [[absolute server path, placeholder], ...] replaced in
error messages (the runner cannot sanitize paths inside the JSON-escaped protocol line).
The full horizon_json.py result is written to out_path (strict JSON); stdout carries progress lines and,
last, the tools_common protocol line with a small summary ({"ok": false, "error"} + exit 2 on bad input /
coverage problems, traceback + exit 1 on bugs).
dem may also be 'trek' (local Moon Trek GeoTIFFs only - lunarnav never downloads them) and method
'bruteforce' here; everything else is horizon_json.compute.
"""
from __future__ import annotations

import json
import os
import sys
import time

from horizon_json import compute
from tools_common import ToolError, run_tool

BRIDGE_VERSION = 1
_PROGRESS = sys.stdout  # run_tool redirects sys.stdout to stderr while the tool runs


def _say(msg: str) -> None:
    _PROGRESS.write(f"horizon_mask: {msg}\n")
    _PROGRESS.flush()


def _scrub(msg: str, pairs) -> str:
    for p, label in pairs:
        for v in {p, p.replace("\\", "/"), p.replace("/", "\\")}:
            if v:
                msg = msg.replace(v, label)
    return msg


def job(req: dict) -> dict:
    pairs = [(str(a), str(b)) for a, b in req.pop("scrub", [])]
    try:
        return _job(req)
    except ToolError as exc:
        raise ToolError(exc.kind, _scrub(str(exc), pairs)) from exc


def _job(req: dict) -> dict:
    out_path = req.pop("out_path", None)
    if not isinstance(out_path, str) or not out_path:
        raise ToolError("bad_input", "out_path missing")
    if str(req.get("dem")) not in ("pgda", "trek", "none"):
        raise ToolError("bad_input", f"unknown dem {req.get('dem')!r}")
    if str(req.get("method")) not in ("raymarch", "bruteforce", "flat"):
        raise ToolError("bad_input", f"unknown method {req.get('method')!r}")
    _say(f"computing dem={req['dem']} method={req['method']} radius_km={req['radius_km']} az_step_deg={req['az_step_deg']}")
    t0 = time.perf_counter()
    res = compute(req)
    res["elapsed_ms"] = int(round((time.perf_counter() - t0) * 1000))
    _say("writing")
    tmp = out_path + ".part"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(res, fh, allow_nan=False, ensure_ascii=True)
    os.replace(tmp, out_path)
    el = res["el_deg"]
    return {"n_az": len(el), "min_el_deg": min(el), "max_el_deg": max(el), "method": res["method"], "dem_source": res["dem_source"]}


if __name__ == "__main__":
    sys.exit(run_tool(BRIDGE_VERSION, job))
