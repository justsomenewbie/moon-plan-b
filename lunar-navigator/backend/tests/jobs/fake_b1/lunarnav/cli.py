"""FAKE `lunarnav.cli` for the B1 job-type tests (precompute / analyse / alt_dates_python).

Same sub-commands and long options as the real CLI (parsed with argparse, so the backend's
`--flag=value` argv must be accepted by a parser like the real one). `build_parser()` exists for the
capabilities probe; `--near-exclusion-m` is left out when the file $LUNARNAV_DATA/no_near_exclusion exists.

Behaviour is chosen by --observer-height:
  7  SystemExit with a DEM pre-flight message (exit 1)
  8  hangs 120 s after writing $LUNARNAV_OUTPUT/pid.txt (cancel tests)
  9  "succeeds" with a bad result: precompute writes a manifest only, analyse invalid JSON,
     alt-dates a result for another site
  otherwise success:
     precompute  copies tests/importer/fixtures/run_small (REAL lunarnav output: apollo11,
                 custom:-89.4500:222.6900, ref_shackleton_rim) to --out
     analyse     one ranking row per --sites id
     alt-dates   one candidate; none (and return code 2, like the real CLI) when --min-sun-pct 99
Every call writes {"argv", "env", "cwd"} to $LUNARNAV_OUTPUT/fake_call_<command>.json.
"""
import argparse
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.normpath(os.path.join(HERE, "..", "..", "..", "importer", "fixtures", "run_small"))


def _common(p, period=True):
    p.add_argument("--sites")
    p.add_argument("--custom-site", action="append", default=[])
    if period:
        p.add_argument("--start", required=True)
        p.add_argument("--end", required=True)
    p.add_argument("--step-min", type=float, default=60)
    p.add_argument("--provider", default="horizons", choices=["horizons", "spice", "analytic", "synthetic"])
    p.add_argument("--dem", default="none", choices=["trek", "pgda", "none"])
    p.add_argument("--horizon-method", default="raymarch", choices=["raymarch", "bruteforce", "flat"])
    p.add_argument("--radius-km", type=float, default=150.0)
    p.add_argument("--dem-label")
    p.add_argument("--dem-path")
    p.add_argument("--dem-res-m", type=float)
    p.add_argument("--az-step", type=float, default=0.5)
    p.add_argument("--observer-height", type=float, default=2.0)
    p.add_argument("--min-clearance", type=float, default=0.0)
    p.add_argument("--dem-fallback", default="error", choices=["error", "flat"])
    data = os.environ.get("LUNARNAV_DATA", "")
    if not (data and os.path.exists(os.path.join(data, "no_near_exclusion"))):
        p.add_argument("--near-exclusion-m", default="auto")


def build_parser():
    ap = argparse.ArgumentParser(prog="lunarnav")
    sub = ap.add_subparsers(dest="command", required=True)
    p = sub.add_parser("precompute")
    _common(p)
    p.add_argument("--out", required=True)
    p.add_argument("--run-timestamp")
    p.add_argument("--resume", action="store_true")
    p.add_argument("--no-check", action="store_true")
    p = sub.add_parser("analyse", aliases=["analyze"])
    _common(p)
    p.add_argument("--json")
    p = sub.add_parser("alt-dates")
    _common(p, period=False)
    p.add_argument("--earliest", required=True)
    p.add_argument("--latest", required=True)
    p.add_argument("--mission-h", type=float, required=True)
    p.add_argument("--min-sun-pct", type=float, default=0.0)
    p.add_argument("--min-earth-pct", type=float, default=0.0)
    p.add_argument("--min-both-pct", type=float, default=0.0)
    p.add_argument("--allow-dark-landing", action="store_true")
    p.add_argument("--require-earth-at-landing", action="store_true")
    p.add_argument("--min-continuous-sun-h", type=float, default=0.0)
    p.add_argument("--min-continuous-earth-h", type=float, default=0.0)
    p.add_argument("--max-dark-gap-h", type=float, default=None)
    p.add_argument("--max-comms-gap-h", type=float, default=None)
    p.add_argument("--min-sun-el", type=float, default=None)
    p.add_argument("--objective", default="balanced", choices=["balanced", "sun", "earth", "both", "energy", "earliest"])
    p.add_argument("--min-separation-h", type=float, default=12.0)
    p.add_argument("--max-results", type=int, default=10)
    p.add_argument("--json")
    p = sub.add_parser("check")
    p.add_argument("dir")
    return ap


def _record(command, argv):
    job_dir = os.environ.get("LUNARNAV_OUTPUT", ".")
    os.makedirs(job_dir, exist_ok=True)
    env = {k: os.environ.get(k) for k in ("LUNARNAV_DATA", "LUNARNAV_OUTPUT", "PYTHONPATH", "MONGODB_URI")}
    with open(os.path.join(job_dir, f"fake_call_{command}.json"), "w", encoding="utf-8") as f:
        json.dump({"argv": list(argv), "env": env, "cwd": os.getcwd(), "script": sys.argv[0]}, f)


def _hang():
    with open(os.path.join(os.environ.get("LUNARNAV_OUTPUT", "."), "pid.txt"), "w") as f:
        f.write(str(os.getpid()))
    print("fake: hanging 120 s", flush=True)
    time.sleep(120)


def _precompute(a):
    sites = a.sites.split(",")
    for k, s in enumerate(sites, 1):
        print(f"[{k}/{len(sites)}] {s}: horizon + ephemeris + visibility", flush=True)
    time.sleep(0.1)
    if a.observer_height == 9:
        os.makedirs(a.out, exist_ok=True)
        with open(os.path.join(a.out, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump({"format": "lunarnav-precompute", "broken": True}, f)
    else:
        shutil.copytree(FIXTURE, a.out, dirs_exist_ok=True)
    print(f"wrote {a.out}", flush=True)
    print("check_output: 0 violation(s)", flush=True)
    return 0


def _analyse(a):
    sites = a.sites.split(",")
    print(f"{'rank':>4} {'site':<24} {'score':>7}", flush=True)
    if a.observer_height == 9:
        with open(a.json, "w", encoding="utf-8") as f:
            f.write("{not json")
        return 0
    rows = []
    for i, s in enumerate(sites):
        rows.append({"rank": i + 1, "site_id": s, "score": 90.0 - i, "pct_sun": 80.0, "pct_earth": 50.0 - i,
                     "pct_both": 40.0, "longest_dark_h": 10.0 + i, "longest_comms_gap_h": 20.0})
    with open(a.json, "w", encoding="utf-8") as f:
        json.dump({"ranking": rows[::-1]}, f, indent=1, sort_keys=True)
    return 0


def _iso(s):
    s = s.rstrip("Z")
    return (s.split(".")[0]) + "Z"


def _alt_dates(a):
    c = {
        "min_sun_pct": a.min_sun_pct, "min_earth_pct": a.min_earth_pct, "min_both_pct": a.min_both_pct,
        "require_sun_at_landing": not a.allow_dark_landing, "require_earth_at_landing": a.require_earth_at_landing,
        "min_continuous_sun_h": a.min_continuous_sun_h, "min_continuous_earth_h": a.min_continuous_earth_h,
        "max_dark_gap_h": a.max_dark_gap_h, "max_comms_gap_h": a.max_comms_gap_h,
        "min_sun_el_at_landing_deg": a.min_sun_el, "objective": a.objective, "min_separation_h": a.min_separation_h,
    }
    none = a.min_sun_pct == 99
    cand = {
        "rank": 1, "landing_utc": _iso(a.earliest), "mission_end_utc": _iso(a.earliest), "slip_h": 0.0, "score": 77.5,
        "sun_pct": 90.0, "earth_pct": 60.0, "both_pct": 55.0, "longest_dark_h": 3.0, "longest_comms_gap_h": 7.0,
        "continuous_sun_h": 40.0, "continuous_sun_lower_bound": False, "continuous_earth_h": 12.0,
        "continuous_earth_lower_bound": False, "sun_at_landing": True, "earth_at_landing": True,
        "sun_el_at_landing_deg": 1.5, "earth_el_at_landing_deg": 4.2, "mean_power_horizontal": 0.02,
        "mean_power_tracking": 0.8,
    }
    res = {
        "site_id": "apollo11" if a.observer_height == 9 else a.sites,
        "earliest_utc": _iso(a.earliest), "latest_utc": _iso(a.latest), "mission_duration_h": a.mission_h,
        "constraints": c, "n_evaluated": 25, "n_feasible": 0 if none else 4,
        "rejected_by": {"min_sun_pct": 25 if none else 21}, "candidates": [] if none else [cand],
    }
    print(f"site {a.sites}: {res['n_feasible']}/{res['n_evaluated']} landing times feasible; rejected_by={res['rejected_by']}", flush=True)
    with open(a.json, "w", encoding="utf-8") as f:
        json.dump(res, f, indent=1, sort_keys=True)
    return 0 if res["candidates"] else 2


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    a = build_parser().parse_args(argv)
    _record(a.command, argv)
    if a.command in ("precompute", "analyse", "alt-dates"):
        if a.observer_height == 7:
            raise SystemExit("--dem pgda cannot serve 1 site(s):\n  x: fake missing DEM file")
        if a.observer_height == 8:
            _hang()
            return 0
    if a.command == "precompute":
        return _precompute(a)
    if a.command in ("analyse", "analyze"):
        return _analyse(a)
    if a.command == "alt-dates":
        return _alt_dates(a)
    print(f"{a.dir}: 0 violation(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
