"""Generate the small JSON fixtures used by the stub routes and the OpenAPI examples.

Reads a REAL precompute output directory (docs/OUTPUT_SPEC.md) and writes compact, realistic
fixtures into backend/src/fixtures/ (run, sites, horizons, series = first 48 h, windows, alt-dates). Re-run after a new sample output:

    ..\\.venv\\Scripts\\python.exe scripts\\make-fixtures.py ..\\output\\sample_2026Q1_spice_pgda

Only *reads* lunarnav (alt-dates fixture); never modifies the Python package.
"""

from __future__ import annotations

import csv
import gzip
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "src" / "fixtures"
REPO = HERE.parent.parent
FOCUS_SITE = "ref_connecting_ridge_c1"
SERIES_HOURS = 48
R_MOON_KM = 1737.4

BOOL_COLS = {"sun_visible", "earth_visible", "both_visible"}


def num(v: str) -> float | None:
    if v == "":
        return None
    x = float(v)
    return None if math.isnan(x) or math.isinf(x) else x


def south_polar_xy(lat: float, lon: float) -> dict | None:
    """LOLA south polar stereographic (sphere R=1737.4 km); null outside lat <= -60."""
    if lat > -60:
        return None
    rho = 2 * R_MOON_KM * math.tan(math.radians(45 + lat / 2))
    lam = math.radians(lon)
    return {
        "projection": "south_polar_stereographic_R1737.4km",
        "x_km": round(rho * math.sin(lam), 3),
        "y_km": round(rho * math.cos(lam), 3),
    }


def dump(name: str, obj: object) -> None:
    p = OUT / name
    p.write_text(json.dumps(obj, indent=1, sort_keys=False, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {p} ({p.stat().st_size} bytes)")


def summary_rows(src: Path) -> dict[str, dict]:
    out: dict[str, dict] = {}
    with open(src / "summary.csv", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            out[row["site_id"]] = row
    return out


def main(src: Path) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    sites_json = json.loads((src / "sites.json").read_text(encoding="utf-8"))
    catalog = json.loads((REPO / "lunarnav" / "catalog" / "sites.json").read_text(encoding="utf-8"))
    extra_by_id = {s["id"]: s.get("extra") for s in catalog["sites"]}
    summ = summary_rows(src)
    run_id = f"pf_{manifest['params_fingerprint']}"
    p = manifest["parameters"]

    # ---- run -------------------------------------------------------------------------------
    run = {
        "run_id": run_id,
        "kind": "precompute",
        "is_default": True,
        "label": "Sample 2026-Q1, SPICE + PGDA raymarch (6 sites)",
        "status": "ready",
        "imported_at": "2026-11-14T09:00:00Z",
        "expires_at": None,
        "params_fingerprint": manifest["params_fingerprint"],
        "code_version": manifest["code_version"],
        "git_commit": manifest["git_commit"],
        "run_timestamp_utc": manifest["run_timestamp_utc"],
        "provider": p["provider"],
        "dem": p["dem"],
        "horizon_method": p["horizon_method"],
        "start_utc": p["start_utc"],
        "end_utc": p["end_utc"],
        "step_s": p["step_s"],
        "n_samples": p["n_samples"],
        "observer_height_m": p["observer_height_m"],
        "min_earth_clearance_deg": p["min_earth_clearance_deg"],
        "rank_weights": p["rank_weights"],
        "site_ids": p["site_ids"],
        "n_sites": len(p["site_ids"]),
        "manifest": {
            "format": manifest["format"],
            "format_version": manifest["format_version"],
            "parameters": p,
            "data_sources": manifest["data_sources"],
            "conventions": manifest["conventions"],
            "files": [{"path": k, "sha256": v} for k, v in sorted(manifest["files"].items())],
        },
    }
    dump("run.json", run)

    # ---- sites (record + extra + metrics + summary row) ------------------------------------
    sites = []
    for rec in sites_json["sites"]:
        sid = rec["id"]
        win = json.loads((src / rec["files"]["windows"]).read_text(encoding="utf-8"))
        row = summ[sid]
        record = {k: v for k, v in rec.items() if k != "files"}
        sites.append(
            {
                "record": record,
                "files": rec["files"],
                "extra": extra_by_id.get(sid),
                "map": south_polar_xy(rec["lat_deg"], rec["lon_deg"]),
                "metrics": win["metrics"],
                "rank": int(row["rank"]),
                "score": float(row["score"]),
            }
        )
    dump("sites.json", {"run_id": run_id, "step_s": p["step_s"], "sites": sites})

    focus = next(r for r in sites_json["sites"] if r["id"] == FOCUS_SITE)
    horizons: dict[str, dict] = {}
    series: dict[str, dict] = {}
    windows: dict[str, dict] = {}
    for rec in sites_json["sites"]:
        sid = rec["id"]
        # ---- horizon (full resolution) ---------------------------------------------------
        az, el, cov = [], [], []
        with open(src / rec["files"]["horizon"], newline="", encoding="ascii") as f:
            for row in csv.DictReader(f):
                az.append(float(row["az_deg"]))
                el.append(float(row["el_deg"]))
                cov.append(float(row["covered_radius_km"]))
        horizons[sid] = {
            "method": rec["horizon_method"],
            "dem_source": rec["dem_source"],
            "az_step_deg": round(az[1] - az[0], 6),
            "az_deg": az,
            "el_deg": el,
            "covered_radius_km": cov,
            "min_el_deg": rec["horizon_min_el_deg"],
            "max_el_deg": rec["horizon_max_el_deg"],
        }
        # ---- series: first SERIES_HOURS samples, columnar ---------------------------------
        cols: dict[str, list] = {}
        times: list[str] = []
        with gzip.open(src / rec["files"]["visibility"], "rt", newline="", encoding="ascii") as f:
            for i, row in enumerate(csv.DictReader(f)):
                if i >= SERIES_HOURS:
                    break
                times.append(row["time_utc"])
                for k, v in row.items():
                    if k != "time_utc":
                        cols.setdefault(k, []).append(v == "1" if k in BOOL_COLS else num(v))
        series[sid] = {"start": times[0], "n": len(times), "columns": cols}
        # ---- windows (full run) ----------------------------------------------------------
        win = json.loads((src / rec["files"]["windows"]).read_text(encoding="utf-8"))
        windows[sid] = {k: win[k] for k in ("range_start_utc", "range_end_utc", "step_s", "sun", "earth", "both")}
    dump("horizons.json", horizons)
    dump("series.json", {"step_s": p["step_s"], "hours": SERIES_HOURS, "sites": series})
    dump("windows.json", windows)

    # ---- alt-dates (real lunarnav call on the stored visibility file) -----------------------
    sys.path.insert(0, str(REPO))
    from lunarnav.analysis import DateConstraints, find_alternative_dates
    from lunarnav.precompute import read_table
    from lunarnav.visibility import VisibilitySeries

    tab = read_table(src / focus["files"]["visibility"])
    kw = {k: v for k, v in tab.items() if k != "time_utc" and not k.startswith("hours_until")}
    vis = VisibilitySeries(
        site_id=FOCUS_SITE, times_utc=tab["time_utc"], min_earth_clearance_deg=p["min_earth_clearance_deg"], **kw
    )
    req = {
        "earliest": "2026-01-05T00:00:00Z",
        "latest": "2026-02-20T00:00:00Z",
        "mission_h": 336,
        "max_results": 3,
        "constraints": {
            "min_sun_pct": 70.0,
            "min_earth_pct": 0.0,
            "min_both_pct": 0.0,
            "require_sun_at_landing": True,
            "require_earth_at_landing": True,
            "min_continuous_sun_h": 0.0,
            "min_continuous_earth_h": 0.0,
            "max_dark_gap_h": None,
            "max_comms_gap_h": None,
            "min_sun_el_at_landing_deg": None,
            "objective": "balanced",
            "min_separation_h": 12.0,
        },
    }
    res = find_alternative_dates(
        vis,
        req["earliest"].rstrip("Z"),
        req["latest"].rstrip("Z"),
        req["mission_h"],
        DateConstraints(**req["constraints"]),
        max_results=req["max_results"],
    )
    dump("alt_dates.json", {"request": req, "result": res.to_dict()})


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: make-fixtures.py <precompute_output_dir>")
    main(Path(sys.argv[1]).resolve())
