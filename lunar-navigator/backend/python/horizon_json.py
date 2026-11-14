"""POST /api/v1/tools/horizon bridge. Only IMPORTS lunarnav; never modifies it.

stdin (UTF-8 JSON, built by src/routes/tools.ts):
  {"site": {"kind": "catalog" | "custom_id" | "run" | "coordinates", "site_id", "lat_deg", "lon_deg", "name", "height_m"},
   "dem": "pgda" | "none", "method": "raymarch" | "flat", "radius_km", "az_step_deg", "observer_height_m",
   "near_exclusion_m": "auto" | number | absent, "dem_fallback": "flat" | "error", "rounding": "run_files" | "none"}
stdout: tools_common protocol; result = {"site", "method", "dem_source", "radius_km", "az_step_deg",
  "observer_height_m", "surface_height_m", "near_exclusion_m", "dem_fallback", "az_deg", "el_deg",
  "covered_radius_km", "horizon_distance_km", "elapsed_ms"}.

The mask comes from lunarnav.precompute.make_horizon_fn - the factory `lunarnav precompute` uses - so for
the same options it equals a run's horizon (a run searches 150 km; here <= 60 km, so azimuths whose horizon
lies farther away differ).
"""
from __future__ import annotations

import inspect
import math
import sys

import numpy as np

from tools_common import ToolError, finite, pgda_unreachable, resolve_site, round_column, run_tool, site_json

BRIDGE_VERSION = 1


def compute(req: dict) -> dict:
    from lunarnav.precompute import DemCoverageError, covered_radius_km, make_horizon_fn

    site = resolve_site(req["site"])
    dem = str(req["dem"])
    method = "flat" if dem == "none" else str(req["method"])
    rounding = str(req.get("rounding", "run_files"))
    kw = dict(dem=dem, method=method, radius_km=float(req["radius_km"]), az_step_deg=float(req["az_step_deg"]),
              observer_height_m=float(req["observer_height_m"]), dem_fallback=str(req["dem_fallback"]))
    has_near = "near_exclusion_m" in inspect.signature(make_horizon_fn).parameters
    near = req.get("near_exclusion_m")
    if near is not None:
        if not has_near:
            raise ToolError("capability", "this lunarnav does not support near_exclusion_m")
        kw["near_exclusion_m"] = near
    try:
        fn = make_horizon_fn(**kw)
        mask = fn(site)
    except DemCoverageError as exc:  # dem_fallback = error, or DEM file missing
        raise ToolError("dem_coverage", str(exc)) from exc
    except FileNotFoundError as exc:
        raise ToolError("dem_coverage", f"DEM file not available: {exc}") from exc
    except ValueError as exc:
        raise ToolError("value_error", str(exc)) from exc
    except (RuntimeError, OSError) as exc:  # band coverage problems, PGDA network errors
        if pgda_unreachable(exc):  # the server cannot reach PGDA now: a capability problem, not a bug
            raise ToolError("capability", f"PGDA is not reachable from this server: {exc}") from exc
        raise ToolError("provider_error", f"{type(exc).__name__}: {exc}") from exc

    meta = mask.meta if isinstance(mask.meta, dict) else {}
    az = round_column("az_deg", mask.az_deg, rounding)
    el = round_column("el_deg", mask.el_deg, rounding)
    cov = round_column("covered_radius_km", covered_radius_km(mask), rounding)
    if any(v is None for v in el) or any(v is None for v in az):
        raise ToolError("provider_error", "horizon mask contains non-finite values")
    dist = meta.get("horizon_distance_km")
    dist_out = None
    if dist is not None and np.shape(dist) == np.shape(mask.az_deg):
        dist_out = round_column("horizon_distance_km", dist, rounding)
    near_applied = None if mask.method == "flat" else finite(meta.get("near_exclusion_m"))
    surface = mask.surface_height_m
    if mask.method == "flat" and site.height_m is not None:  # precompute._write_site rule
        surface = site.height_m
    fallback = meta.get("dem_fallback")
    return {
        "site": site_json(site),
        "method": mask.method,
        "dem_source": str(mask.dem_source),
        "radius_km": finite(mask.radius_km) if math.isfinite(float(mask.radius_km)) else float(req["radius_km"]),
        "az_step_deg": float(req["az_step_deg"]),
        "observer_height_m": float(mask.observer_height_m),
        "surface_height_m": finite(surface),
        "near_exclusion_m": near_applied,
        "dem_fallback": None if fallback is None else str(fallback),
        "az_deg": az,
        "el_deg": el,
        "covered_radius_km": [0.0 if v is None else v for v in cov],
        "horizon_distance_km": dist_out,
    }


if __name__ == "__main__":
    sys.exit(run_tool(BRIDGE_VERSION, compute))
