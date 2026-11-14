"""`compare_runs` job bridge (docs/PYTHON_INTEGRATION.md): compare two imported precompute runs site by site.
Port of lunarnav_runs/compare_A_B.py (run A = Horizons + Moon Trek + raymarch vs run B = SPICE + PGDA +
bruteforce) for any two runs. numpy only; does not import lunarnav.

Per common site:
  * ephemeris: max (and p95) over the common samples of max(|d az| cos(el_A), |d el|), Sun and Earth, arcsec
  * horizon:   |el_A(az) - el_B(az)| (B interpolated on A's azimuths, periodic): p95 / max / mean, deg
  * flags:     % of common samples where sun_visible / earth_visible / both_visible differ
  * metrics:   summary.csv of each run (A - B): pct_sun, pct_earth, pct_both, longest_dark_h,
               longest_comms_gap_h, score, rank  (each over its OWN run range: see same_range)
Differences from compare_A_B.py: the time grids may differ (compared on the common sample instants instead
of failing), files are located through sites.json `files` (never outside the run directory), sites missing in
one run are listed, every number is finite JSON (NaN -> null), p95 of the ephemeris and mean horizon added.

stdin (UTF-8 JSON, built by the server):
  {"run_a": {"run_id": str, "dir": <run directory>}, "run_b": {...},
   "site_ids": [str] | null (null = every common site), "max_sites": int,
   "out_json": <file>, "out_csv": <file>, "summary_out": <file>, "scrub": [[<path>, <placeholder>], ...]}
writes out_json (full result), out_csv (one row per compared site), summary_out (small summary).
exit 0 = written; exit 2 + {"ok": false, "error": {...}} on stdout = bad input for these runs; else traceback.
"""
from __future__ import annotations

import csv
import gzip
import json
import sys
from pathlib import Path

import numpy as np

from b3_common import jsonable, read_request, scrub, write_json

BRIDGE_VERSION = 1
METRICS = ("pct_sun", "pct_earth", "pct_both", "longest_dark_h", "longest_comms_gap_h", "score", "rank")
FLAGS = ("sun_visible", "earth_visible", "both_visible")
CSV_COLUMNS = (
    "site_id", "group", "status", "n_samples_a", "n_samples_b", "n_common",
    "dem_source_a", "dem_source_b", "horizon_method_a", "horizon_method_b",
    "ephem_sun_max_arcsec", "ephem_sun_p95_arcsec", "ephem_earth_max_arcsec", "ephem_earth_p95_arcsec",
    "horizon_p95_abs_deg", "horizon_max_abs_deg", "horizon_mean_abs_deg",
    "sun_flag_mismatch_pct", "earth_flag_mismatch_pct", "both_flag_mismatch_pct",
    *(f"{m}_{s}" for m in METRICS for s in ("a", "b")), *(f"d_{m}" for m in METRICS),
)


class InputError(Exception):
    pass


# ---- readers (as compare_A_B.py) --------------------------------------------------------------------------
def read_csv(path: Path) -> dict[str, np.ndarray]:
    op = gzip.open if path.suffix == ".gz" else open
    with op(path, "rt", newline="", encoding="utf-8") as f:
        rows = list(csv.reader(f))
    if not rows:
        raise InputError(f"{path.name}: empty file")
    head, body = rows[0], rows[1:]
    cols = list(zip(*body)) if body else [[] for _ in head]
    out: dict[str, np.ndarray] = {}
    for h, c in zip(head, cols):
        try:
            out[h] = np.array([float(x) if x != "" else np.nan for x in c], dtype=float)
        except ValueError:
            out[h] = np.array(c)
    return out


def ang_diff(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return np.abs((a - b + 180.0) % 360.0 - 180.0)


def _float(x) -> float | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if np.isfinite(v) else None


class Run:
    def __init__(self, spec: dict, label: str):
        self.label = label
        self.run_id = str(spec["run_id"])
        self.dir = Path(spec["dir"]).resolve()
        try:
            sites = json.loads((self.dir / "sites.json").read_text(encoding="utf-8"))["sites"]
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise InputError(f"run {label}: sites.json unreadable: {type(exc).__name__}") from exc
        self.records = {str(s["id"]): s for s in sites}
        self.order = [str(s["id"]) for s in sites]
        try:
            with open(self.dir / "summary.csv", newline="", encoding="utf-8") as f:
                self.summary = {r["site_id"]: r for r in csv.DictReader(f)}
        except OSError as exc:
            raise InputError(f"run {label}: summary.csv unreadable") from exc

    def file(self, site: str, kind: str) -> Path:
        rel = (self.records[site].get("files") or {}).get(kind)
        if not isinstance(rel, str) or not rel:
            raise InputError(f"run {self.label}: site {site} has no {kind} file")
        p = (self.dir / rel).resolve()
        if self.dir not in p.parents:
            raise InputError(f"run {self.label}: {kind} file of {site} lies outside the run directory")
        if not p.is_file():
            raise InputError(f"run {self.label}: {kind} file of {site} is missing")
        return p


def _stats_arcsec(d: np.ndarray) -> tuple[float | None, float | None]:
    d = d[np.isfinite(d)]
    if d.size == 0:
        return None, None
    return round(float(d.max()) * 3600, 4), round(float(np.percentile(d, 95)) * 3600, 4)


def compare_site(site: str, a: Run, b: Run) -> dict:
    ra, rb = a.records[site], b.records[site]
    row: dict = {"site_id": site, "group": str(ra.get("group") or rb.get("group") or ""), "status": "ok",
                 "dem_source_a": ra.get("dem_source"), "dem_source_b": rb.get("dem_source"),
                 "horizon_method_a": ra.get("horizon_method"), "horizon_method_b": rb.get("horizon_method")}
    ea, eb = read_csv(a.file(site, "ephemeris")), read_csv(b.file(site, "ephemeris"))
    va, vb = read_csv(a.file(site, "visibility")), read_csv(b.file(site, "visibility"))
    row["n_samples_a"], row["n_samples_b"] = int(va["time_utc"].size), int(vb["time_utc"].size)
    # common sample instants (compare_A_B.py required identical grids)
    _, ia, ib = np.intersect1d(ea["time_utc"], eb["time_utc"], assume_unique=True, return_indices=True)
    row["n_common"] = int(ia.size)
    if ia.size == 0:
        row["status"] = "no_common_samples"
    else:
        cos_a = {k: np.cos(np.radians(ea[f"{k}_el_deg"][ia])) for k in ("sun", "earth")}
        for body in ("sun", "earth"):
            d = np.maximum(ang_diff(ea[f"{body}_az_deg"][ia], eb[f"{body}_az_deg"][ib]) * cos_a[body],
                           np.abs(ea[f"{body}_el_deg"][ia] - eb[f"{body}_el_deg"][ib]))
            row[f"ephem_{body}_max_arcsec"], row[f"ephem_{body}_p95_arcsec"] = _stats_arcsec(d)
        _, ja, jb = np.intersect1d(va["time_utc"], vb["time_utc"], assume_unique=True, return_indices=True)
        for fl in FLAGS:
            name = f"{fl.split('_')[0]}_flag_mismatch_pct"
            if fl in va and fl in vb and ja.size:
                row[name] = round(float(np.mean(va[fl][ja] != vb[fl][jb]) * 100), 3)
            else:
                row[name] = None
    ha, hb = read_csv(a.file(site, "horizon")), read_csv(b.file(site, "horizon"))
    hd = np.abs(ha["el_deg"] - np.interp(ha["az_deg"], hb["az_deg"], hb["el_deg"], period=360.0))
    hd = hd[np.isfinite(hd)]
    row["horizon_p95_abs_deg"] = round(float(np.percentile(hd, 95)), 4) if hd.size else None
    row["horizon_max_abs_deg"] = round(float(hd.max()), 4) if hd.size else None
    row["horizon_mean_abs_deg"] = round(float(hd.mean()), 4) if hd.size else None
    sa, sb = a.summary.get(site, {}), b.summary.get(site, {})
    for m in METRICS:
        x, y = _float(sa.get(m)), _float(sb.get(m))
        row[f"{m}_a"], row[f"{m}_b"] = x, y
        row[f"d_{m}"] = None if x is None or y is None else round(x - y, 6 if m == "score" else 3)
    for m in ("rank_a", "rank_b", "d_rank"):
        if row[m] is not None:
            row[m] = int(row[m])
    return row


def _agg(rows: list[dict], key: str, absval: bool = False) -> dict:
    v = np.array([abs(r[key]) if absval else r[key] for r in rows if r.get(key) is not None], dtype=float)
    if v.size == 0:
        return {"n": 0, "max": None, "median": None, "mean": None, "worst_site": None}
    worst = max((r for r in rows if r.get(key) is not None), key=lambda r: abs(r[key]) if absval else r[key])
    return {"n": int(v.size), "max": round(float(v.max()), 6), "median": round(float(np.median(v)), 6),
            "mean": round(float(v.mean()), 6), "worst_site": worst["site_id"]}


def main() -> int:
    req = read_request()
    pairs = req.get("scrub") or []
    try:
        a, b = Run(req["run_a"], "A"), Run(req["run_b"], "B")
        common = [s for s in a.order if s in b.records]
        only_a = [s for s in a.order if s not in b.records]
        only_b = [s for s in b.order if s not in a.records]
        wanted = req.get("site_ids")
        if wanted is not None:
            missing = [s for s in wanted if s not in a.records or s not in b.records]
            if missing:
                raise InputError(f"sites not in both runs: {', '.join(missing[:20])}")
            sites = [s for s in common if s in set(wanted)]
        else:
            sites = common
        if not sites:
            raise InputError("the two runs have no site in common")
        if len(sites) > int(req.get("max_sites", 1000)):
            raise InputError(f"{len(sites)} sites to compare (limit {req.get('max_sites')})")
    except InputError as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": {"type": "input_error", "message": str(exc)}}) + "\n")
        return 2

    rows: list[dict] = []
    for i, site in enumerate(sites):
        print(f"compare: site {i + 1}/{len(sites)} {site}", flush=True)
        try:
            rows.append(compare_site(site, a, b))
        except (InputError, KeyError, ValueError, OSError) as exc:
            msg = str(exc) if isinstance(exc, InputError) else f"{type(exc).__name__}: {exc}"
            rows.append({"site_id": site, "group": "", "status": "error", "error": msg[:300]})
    ok_rows = [r for r in rows if r.get("status") == "ok"]
    summary = {
        "bridge_version": BRIDGE_VERSION,
        "run_a": a.run_id, "run_b": b.run_id,
        "n_sites_compared": len(ok_rows),
        "n_sites_failed": sum(1 for r in rows if r.get("status") == "error"),
        "n_sites_no_common_samples": sum(1 for r in rows if r.get("status") == "no_common_samples"),
        "only_in_a": only_a[:100], "only_in_b": only_b[:100],
        "n_only_in_a": len(only_a), "n_only_in_b": len(only_b),
        "ephem_sun_max_arcsec": _agg(ok_rows, "ephem_sun_max_arcsec"),
        "ephem_earth_max_arcsec": _agg(ok_rows, "ephem_earth_max_arcsec"),
        "horizon_p95_abs_deg": _agg(rows, "horizon_p95_abs_deg"),
        "horizon_max_abs_deg": _agg(rows, "horizon_max_abs_deg"),
        "sun_flag_mismatch_pct": _agg(ok_rows, "sun_flag_mismatch_pct"),
        "earth_flag_mismatch_pct": _agg(ok_rows, "earth_flag_mismatch_pct"),
        "abs_d_pct_sun": _agg(rows, "d_pct_sun", absval=True),
        "abs_d_pct_earth": _agg(rows, "d_pct_earth", absval=True),
        "abs_d_longest_dark_h": _agg(rows, "d_longest_dark_h", absval=True),
        "n_rank_changes": sum(1 for r in rows if r.get("d_rank") not in (None, 0)),
    }
    full = {"bridge_version": BRIDGE_VERSION, "run_a": a.run_id, "run_b": b.run_id, "summary": summary,
            "columns": list(CSV_COLUMNS), "sites": rows}
    write_json(req["out_json"], scrub(jsonable(full), pairs))
    out_csv = Path(req["out_csv"])
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(CSV_COLUMNS) + ["error"], extrasaction="ignore")
        w.writeheader()
        for r in scrub(jsonable(rows), pairs):
            w.writerow({k: ("" if v is None else v) for k, v in r.items()})
    write_json(req["summary_out"], scrub(jsonable(summary), pairs), indent=None)
    print(f"compare: {len(ok_rows)} site(s) compared, |d pct_sun| max {summary['abs_d_pct_sun']['max']}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
