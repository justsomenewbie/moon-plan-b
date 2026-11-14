"""FAKE lunarnav.validate (B3 tests): run_all + render_markdown (see __init__.py)."""
import json
from pathlib import Path

__version_used__ = "0.0.0-fake-b3"


def run_all(include_horizons=True, offline=False, terrain=True, quick=False, log=None, terrain_kwargs=None):
    log = log or (lambda m: None)
    if offline:
        raise RuntimeError("Horizons response not in the offline cache (fake)")
    provs = (["horizons"] if include_horizons else []) + ["spice", "analytic"]
    log(f"cross-check: 2 sites x 1 time sets x {provs}")
    rows = [{"pair": "spice-analytic", "body": "sun", "passed": True},
            {"pair": "spice-analytic", "body": "earth", "passed": bool(quick)}]
    log("diagnostics against spice")
    log("Apollo 11 landing Sun elevation")
    log("lunar day / time-until-sunset")
    eph = {
        "sites": [{"id": "ref_shackleton_rim"}, {"id": "apollo11"}],
        "time_sets": [{"name": "2026-01"}],
        "providers": provs,
        "matrix": {"summary": rows, "rows": []},
        "diagnostics": {"reference": "spice", "variants": [{"description": "x", "passed": True}]},
        "apollo11": {"passed": True},
        "lunar_day": {"passed": True},
        "kernel_dir": str(Path(__file__).resolve().parents[1] / "data" / "kernels"),
        "passed": all(r["passed"] for r in rows),
    }
    rep = {"generated_utc": "2026-11-14T00:00:00Z", "lunarnav_version": "0.0.0-fake-b3", "ephemeris": eph}
    if terrain:
        out = Path((terrain_kwargs or {})["out_path"])
        out.write_text(json.dumps({"generated_by": "fake", "quick": quick, "x": float("nan")}, allow_nan=True))
        rep["terrain"] = {"status": "ran", "quick": quick, "report_path": str(out), "nan_value": float("nan")}
    rep["passed"] = bool(eph["passed"])
    return rep


def render_markdown(report):
    return f"Generated {report['generated_utc']} - overall: **{'PASS' if report['passed'] else 'FAIL'}**\n" \
           f"kernels {report['ephemeris']['kernel_dir']}\n"
