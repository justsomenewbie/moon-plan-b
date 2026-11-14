r"""Reference values for the instant endpoint, computed by the Python package lunarnav.

Usage (from backend/):  ..\.venv\Scripts\python.exe -I tests/routes/b/python_instants.py OUTPUT_DIR SITE=T[,T...] ...
Prints JSON {site_id: {t: {...}}} with, for each instant t:
  * hours_until_state_*  : lunarnav.windows.hours_until_state(...)[k] at the sample k containing t
                           (the semantics of the visibility.csv hours_until_* columns)
  * next_*               : lunarnav.windows.time_until_sunset / next_sunrise / time_until_earthset /
                           next_earthrise(...).to_dict() measured FROM t itself (NextEvent).
"""
import gzip
import json
import math
import sys
from pathlib import Path

import numpy as np

from lunarnav import windows as W


def load(out: Path, site_id: str):
    sites = json.loads((out / "sites.json").read_text())["sites"]
    rec = next(s for s in sites if s["id"] == site_id)
    with gzip.open(out / rec["files"]["visibility"], "rt") as fh:
        header = fh.readline().strip().split(",")
        rows = [line.strip().split(",") for line in fh if line.strip()]
    col = {h: i for i, h in enumerate(header)}
    t = np.array([np.datetime64(r[col["time_utc"]].rstrip("Z"), "s") for r in rows])
    flag = lambda name: np.array([r[col[name]] == "1" for r in rows])
    return t, flag("sun_visible"), flag("earth_visible")


def nan_none(x):
    x = float(x)
    return None if math.isnan(x) else round(x, 6)


def main() -> None:
    out = Path(sys.argv[1])
    result = {}
    for arg in sys.argv[2:]:
        site_id, times = arg.split("=", 1)
        t, sun, earth = load(out, site_id)
        step = W.infer_step_s(t)
        hu = {
            "sunset": W.hours_until_state(t, sun, False, step),
            "sunrise": W.hours_until_state(t, sun, True, step),
            "earthset": W.hours_until_state(t, earth, False, step),
            "earthrise": W.hours_until_state(t, earth, True, step),
        }
        fns = {
            "sunset": (W.time_until_sunset, sun),
            "sunrise": (W.next_sunrise, sun),
            "earthset": (W.time_until_earthset, earth),
            "earthrise": (W.next_earthrise, earth),
        }
        per = {}
        for ts in times.split(","):
            when = W.parse_utc(ts)
            k = int(np.searchsorted(t, when, side="right") - 1)
            per[ts] = {
                "sample_utc": W.iso_utc(t[k]),
                "sun_visible": bool(sun[k]),
                "earth_visible": bool(earth[k]),
                "hours_until_state": {name: nan_none(arr[k]) for name, arr in hu.items()},
                "next": {name: fn(t, flags, when, step).to_dict() for name, (fn, flags) in fns.items()},
            }
        result[site_id] = per
    json.dump(result, sys.stdout, indent=1, sort_keys=True)


if __name__ == "__main__":
    main()
