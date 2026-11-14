r"""Python reference values for tests/crosscheck/api_vs_python.test.ts, computed with lunarnav itself.

Usage (from backend/):  ..\.venv\Scripts\python.exe -I tests/crosscheck/python_reference.py < request.json
request.json: {"run_dir": "...", "sites": {"<site_id>": {"rows": [k, ...], "instants": ["<iso>", ...]}}}

Prints JSON {site_id: {...}} with, per site, everything derived from the site's visibility.csv.gz read by
lunarnav.precompute.read_table (NOT from windows.json / summary.csv, so the API is checked against an
independent recomputation):
  rows      {k: {column: value}}        raw sample k (NaN -> null, bool columns -> bool)
  windows   {sun|earth|both: [...]}     lunarnav.windows.find_windows(...).to_dict()
  metrics   {...}                       lunarnav.windows.compute_metrics(...) rounded with clean_float
  instants  {t: {...}}                  sample containing t, hours_until_state[k] and the NextEvent
                                        functions (time_until_sunset, next_sunrise, ...) from t
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

from lunarnav import windows as W
from lunarnav.precompute import read_table


def plain(v):
    if isinstance(v, (bool, np.bool_)):
        return bool(v)
    if isinstance(v, (float, np.floating)):
        f = float(v)
        return None if math.isnan(f) else f
    if isinstance(v, (int, np.integer)):
        return int(v)
    return v


def site_reference(run_dir: Path, rec: dict, req: dict) -> dict:
    tab = read_table(run_dir / rec["files"]["visibility"])
    t = tab["time_utc"]
    sun = tab["sun_visible"]
    earth = tab["earth_visible"]
    step = W.infer_step_s(t)
    cols = [c for c in tab if c != "time_utc"]

    rows = {}
    for k in req.get("rows", []):
        row = {"time_utc": W.iso_utc(t[k])}
        row.update({c: plain(tab[c][k]) for c in cols})
        rows[str(k)] = row

    windows = {
        "sun": [w.to_dict() for w in W.find_windows(t, sun, step)],
        "earth": [w.to_dict() for w in W.find_windows(t, earth, step)],
        "both": [w.to_dict() for w in W.find_windows(t, sun & earth, step)],
    }
    raw = W.compute_metrics(t, sun, earth, tab["sun_el_deg"], tab["power_horizontal"], tab["power_tracking"], step)
    metrics = {k: (W.clean_float(v) if isinstance(v, float) else plain(v)) for k, v in raw.items()}

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
    instants = {}
    for ts in req.get("instants", []):
        when = W.parse_utc(ts)
        k = int(np.searchsorted(t, when, side="right") - 1)
        instants[ts] = {
            "sample_index": k,
            "sample_utc": W.iso_utc(t[k]),
            "sun_visible": bool(sun[k]),
            "earth_visible": bool(earth[k]),
            "hours_until_state": {n: (None if math.isnan(float(a[k])) else round(float(a[k]), 6)) for n, a in hu.items()},
            "next": {n: fn(t, flags, when, step).to_dict() for n, (fn, flags) in fns.items()},
        }
    return {"n": int(t.size), "step_s": int(step), "rows": rows, "windows": windows, "metrics": metrics, "instants": instants}


def main() -> None:
    req = json.load(sys.stdin)
    run_dir = Path(req["run_dir"])
    records = {s["id"]: s for s in json.loads((run_dir / "sites.json").read_text(encoding="utf-8"))["sites"]}
    out = {sid: site_reference(run_dir, records[sid], r) for sid, r in req["sites"].items()}
    json.dump(out, sys.stdout, allow_nan=False)


if __name__ == "__main__":
    main()
