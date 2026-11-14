"""Alt-dates bridge for the web backend (plan section 7.1). Only IMPORTS lunarnav; never modifies it.

stdin  (UTF-8 JSON): {"visibility_path", "site_id", "earliest", "latest", "mission_h", "max_results",
                      "constraints": {...DateConstraints fields...}, "min_earth_clearance_deg"}
stdout (ASCII JSON, one line):
  {"ok": true,  "result": AltDateResult.to_dict()}                      exit 0
  {"ok": false, "error": {"type": "value_error", "message": "..."}}     exit 2  (bad request for this series)
Anything else (traceback on stderr)                                       exit 1

Reads the stored visibility.csv.gz of an imported run (no ephemeris recomputation, unlike the
`lunarnav alt-dates` CLI) and calls lunarnav.analysis.find_alternative_dates.
"""
from __future__ import annotations

import json
import sys

BRIDGE_VERSION = 1


def _fail(kind: str, message: str) -> int:
    sys.stdout.write(json.dumps({"ok": False, "error": {"type": kind, "message": message}}) + "\n")
    return 2


def main() -> int:
    try:
        req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except ValueError as exc:
        return _fail("bad_input", f"stdin is not JSON: {exc}")

    from lunarnav.analysis import DateConstraints, find_alternative_dates
    from lunarnav.precompute import read_table
    from lunarnav.visibility import VisibilitySeries

    try:
        constraints = DateConstraints(**req["constraints"])
    except (TypeError, ValueError) as exc:
        return _fail("value_error", f"constraints: {exc}")

    tab = read_table(req["visibility_path"])
    kw = {k: v for k, v in tab.items() if k != "time_utc" and not k.startswith("hours_until")}
    vis = VisibilitySeries(
        site_id=req["site_id"],
        times_utc=tab["time_utc"],
        min_earth_clearance_deg=float(req.get("min_earth_clearance_deg", 0.0)),
        **kw,
    )
    try:
        res = find_alternative_dates(
            vis,
            str(req["earliest"]).rstrip("Z"),
            str(req["latest"]).rstrip("Z"),
            float(req["mission_h"]),
            constraints,
            max_results=int(req["max_results"]),
        )
    except ValueError as exc:
        return _fail("value_error", str(exc))
    sys.stdout.write(json.dumps({"ok": True, "bridge_version": BRIDGE_VERSION, "result": res.to_dict()}, allow_nan=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
