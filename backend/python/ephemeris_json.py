"""POST /api/v1/tools/ephemeris bridge. Only IMPORTS lunarnav; never modifies it.

stdin (UTF-8 JSON, built by src/routes/tools.ts):
  {"site": {"kind": "catalog" | "custom_id" | "run" | "coordinates", "site_id", "lat_deg", "lon_deg", "name", "height_m"},
   "times": ["YYYY-MM-DDTHH:MM:SSZ", ...],          1..200, whole seconds
   "provider": "spice" | "analytic" | "horizons",
   "height": {"mode": "fixed", "source": "run" | "value" | "sphere", "surface_height_m", "observer_height_m",
              "observer_height_above_sphere_m"}
           | {"mode": "dem", "fallback_sphere": bool, "observer_height_m"},
   "rounding": "run_files" | "none"}
stdout: tools_common protocol; result = {"site", "provider", "provider_config", "height", "rows", "elapsed_ms"}.

Same computation as `lunarnav precompute`: lunarnav.precompute.get_provider(name) with its defaults
(SPICE: de440 / MOON_ME / CN+S / manual - the provider_config of the runs), provider.compute(site, times,
surface + mast). dem heights = lunarnav.precompute.get_dem('pgda', site).height_at(lat, lon), the height
the pgda horizon of a precompute run reports (mask.surface_height_m).
"""
from __future__ import annotations

import math
import sys

import numpy as np

from tools_common import ToolError, finite, jsonable, pgda_unreachable, resolve_site, round_column, run_tool, site_json

BRIDGE_VERSION = 1
COLUMNS = ("sun_az_deg", "sun_el_deg", "sun_dist_km", "earth_az_deg", "earth_el_deg", "earth_dist_km")


def _dem_height(site) -> tuple[float, str]:
    from lunarnav.precompute import DemCoverageError, get_dem

    try:
        src = get_dem("pgda", site)
        h = float(np.asarray(src.height_at(site.lat_deg, site.lon_deg), float).reshape(-1)[0])
    except DemCoverageError as exc:
        raise ToolError("dem_coverage", str(exc)) from exc
    except (ValueError, IndexError) as exc:
        raise ToolError("dem_coverage", f"no PGDA height at the site: {exc}") from exc
    except RuntimeError as exc:
        if pgda_unreachable(exc):
            raise ToolError("capability", f"PGDA is not reachable from this server: {exc}") from exc
        raise ToolError("provider_error", f"{type(exc).__name__}: {exc}") from exc
    if not math.isfinite(h):
        raise ToolError("dem_coverage", f"PGDA has no valid height at ({site.lat_deg}, {site.lon_deg})")
    return h, f"pgda:{getattr(src, 'name', type(src).__name__)}"


def _height(site, spec: dict) -> dict:
    mast = float(spec["observer_height_m"])
    if spec.get("mode") == "fixed":
        surface = float(spec["surface_height_m"])
        above = spec.get("observer_height_above_sphere_m")
        return {"source": spec["source"], "surface_height_m": surface, "observer_height_m": mast,
                "observer_height_above_sphere_m": float(above) if above is not None else surface + mast,
                "dem_source": None, "note": spec.get("note")}
    if spec.get("mode") == "dem":
        try:
            surface, dem_source = _dem_height(site)
        except ToolError as exc:
            if not spec.get("fallback_sphere"):
                raise
            return {"source": "sphere", "surface_height_m": 0.0, "observer_height_m": mast,
                    "observer_height_above_sphere_m": mast, "dem_source": None,
                    "note": f"auto: no PGDA height ({exc}); smooth sphere used"}
        return {"source": "dem", "surface_height_m": surface, "observer_height_m": mast,
                "observer_height_above_sphere_m": surface + mast, "dem_source": dem_source, "note": spec.get("note")}
    raise ToolError("bad_input", f"unknown height mode {spec.get('mode')!r}")


def compute(req: dict) -> dict:
    from lunarnav.precompute import get_provider

    try:
        from lunarnav.precompute import provider_config
    except ImportError:  # older lunarnav
        def provider_config(p):  # type: ignore[no-redef]
            return {k: v for k, v in sorted(vars(p).items()) if not k.startswith("_") and isinstance(v, (str, int, float, bool))}

    site = resolve_site(req["site"])
    name = str(req["provider"])
    if name not in ("spice", "analytic", "horizons"):
        raise ToolError("bad_input", f"unknown provider {name!r}")
    rounding = str(req.get("rounding", "run_files"))
    times = np.array([str(t).rstrip("Z") for t in req["times"]], dtype="datetime64[s]")
    height = _height(site, req["height"])
    try:
        provider = get_provider(name)
    except ImportError as exc:
        raise ToolError("capability", f"provider {name} is not usable on this server: {exc}") from exc
    try:
        eph = provider.compute(site, times, height["observer_height_above_sphere_m"])
    except ValueError as exc:
        raise ToolError("value_error", str(exc)) from exc
    except (RuntimeError, OSError) as exc:  # HorizonsError (RuntimeError), network / kernel download errors
        raise ToolError("provider_error", f"{type(exc).__name__}: {exc}") from exc
    if len(eph) != times.size:
        raise ToolError("provider_error", f"provider returned {len(eph)} rows for {times.size} times")
    cols = {c: round_column(c, getattr(eph, c), rounding) for c in COLUMNS}
    t_out = [str(x) + "Z" for x in np.datetime_as_string(np.asarray(eph.times_utc).astype("datetime64[s]"), unit="s").tolist()]
    rows = []
    for i, t in enumerate(t_out):
        row = {"time_utc": t}
        for c in COLUMNS:
            v = cols[c][i]
            if v is None:
                raise ToolError("provider_error", f"{c} is not finite at {t}")
            row[c] = v
        rows.append(row)
    height["surface_height_m"] = finite(height["surface_height_m"])
    height["observer_height_above_sphere_m"] = finite(height["observer_height_above_sphere_m"])
    return {
        "site": site_json(site),
        "provider": name,
        "provider_config": {k: jsonable(v) for k, v in provider_config(provider).items()},
        "height": height,
        "rows": rows,
    }


if __name__ == "__main__":
    sys.exit(run_tool(BRIDGE_VERSION, compute))
