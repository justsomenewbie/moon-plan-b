"""Reference numbers for the group-A route tests, computed by lunarnav itself.

For every site of the sample run and a few sub-ranges, runs `lunarnav.windows.compute_metrics` on
the slice of visibility.csv.gz (exactly what Python would report for that range), serialises the
metrics like the precompute writer (`_metrics_json`, 6 decimals) and ranks them with
`lunarnav.analysis.rank_sites` (default and custom weights).

    ..\\.venv\\Scripts\\python.exe -I tests/routes/a/make_reference.py ../output/sample_2026Q1_spice_pgda

writes tests/routes/a/fixtures/reference.json (committed; the TS tests never call Python).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from lunarnav.analysis import rank_sites
from lunarnav.precompute import _metrics_json, read_table
from lunarnav.sites import Site
from lunarnav.windows import compute_metrics

RANGES = [
    ("2026-01-01T00:00:00", "2026-04-01T00:00:00"),  # full run (recomputed -> must equal windows.json)
    ("2026-02-01T00:00:00", "2026-03-01T00:00:00"),
    ("2026-01-10T05:00:00", "2026-01-24T17:00:00"),
    ("2026-03-15T00:00:00", "2026-04-01T00:00:00"),
]
WEIGHTS = [
    {"pct_sun": 0.4, "pct_earth": 0.3, "pct_both": 0.3},
    {"pct_sun": 1.0},
    {"pct_earth": 0.5, "pct_sun_no_earth": 0.5},
]


class _A:
    def __init__(self, site_id: str, m: dict):
        self.site = Site(id=site_id, name=site_id, lat_deg=0.0, lon_deg=0.0)
        self.metrics = m


def main(run_dir: str) -> None:
    out_dir = Path(run_dir)
    sites = json.loads((out_dir / "sites.json").read_text(encoding="utf-8"))["sites"]
    tables = {s["id"]: read_table(out_dir / s["files"]["visibility"]) for s in sites}
    result = {"run_dir": out_dir.name, "ranges": []}
    for start, end in RANGES:
        t0, t1 = np.datetime64(start, "s"), np.datetime64(end, "s")
        metrics = {}
        for sid, tb in tables.items():
            t = tb["time_utc"]
            sel = (t >= t0) & (t < t1)
            m = compute_metrics(
                t[sel], tb["sun_visible"][sel], tb["earth_visible"][sel],
                sun_el_deg=tb["sun_el_deg"][sel], power_horizontal=tb["power_horizontal"][sel],
                power_tracking=tb["power_tracking"][sel], step_s=3600,
            )
            metrics[sid] = _metrics_json(m)
        rankings = []
        for w in WEIGHTS:
            rows = rank_sites([_A(sid, m) for sid, m in metrics.items()], w)
            rankings.append({"weights": w, "rows": [{"rank": r["rank"], "site_id": r["site_id"], "score": round(r["score"], 6)} for r in rows]})
        result["ranges"].append({"start": start + "Z", "end": end + "Z", "metrics": metrics, "rankings": rankings})
    dest = Path(__file__).parent / "fixtures" / "reference.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(result, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {dest}")


if __name__ == "__main__":
    main(sys.argv[1])
