"""FAKE lunarnav.validate_terrain (B3 tests): run(quick, out_path) (see __init__.py)."""
import json
import math
from pathlib import Path


def run(quick=False, out_path=None):
    if not quick:
        raise RuntimeError("fake terrain validation: full mode unavailable")
    print("fake terrain: method comparison", flush=True)
    rep = {
        "generated_by": "lunarnav.validate_terrain.run", "quick": True, "runtime_s": 1.5,
        "method_comparison": [{"site_id": "ref_connecting_ridge_c1", "full": {"p95_abs_deg": 0.01, "max_abs_deg": math.nan}}],
        "illumination": {"n_psr": 8, "n_lit": 8, "primary": "LDEM", "psr": {"pass": True}, "lit": {"pass": False}},
        "trek_header": {"LRO_LOLA_DEM_SPole75_30mp_v04": {"pass": True}},
        "step_check": {"avg_illum_pct_1h": math.inf, "cache": str(Path(__file__).resolve().parents[1] / "data" / "cache")},
    }
    Path(out_path).write_text(json.dumps(rep, allow_nan=True))
    rep["report_path"] = str(out_path)
    return rep
