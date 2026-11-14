"""Shared helpers of the synchronous tool bridges (ephemeris_json.py, horizon_json.py).

Only IMPORTS lunarnav; never modifies it. Protocol of every tool bridge (same as alt_dates_json.py):
  stdin  UTF-8 JSON request (built by src/routes/tools.ts - never contains a file path)
  stdout ONE line of ASCII JSON, printed last:
    {"ok": true,  "bridge_version": N, "result": {...}}                       exit 0
    {"ok": false, "error": {"type": "<kind>", "message": "..."}}               exit 2
  anything else (traceback on stderr)                                         exit 1
Error kinds: bad_input, site_not_found, value_error, dem_coverage, capability, provider_error.

While the tool runs, sys.stdout is redirected to stderr so library prints (kernel downloads, warnings)
can never corrupt the JSON line.
"""
from __future__ import annotations

import contextlib
import json
import math
import sys
import time
from typing import Any, Callable

import numpy as np


class ToolError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


# lunarnav.terrain.pgda.PgdaDem.__init__ opens the product over /vsicurl/ BEFORE its block cache is used:
# without the network it raises RuntimeError("cannot open PGDA product ...") even for a fully cached product.
PGDA_OPEN_ERROR = "cannot open PGDA product"


def pgda_unreachable(exc: BaseException) -> bool:
    """True for the RuntimeError lunarnav raises when a PGDA product cannot be opened (network down)."""
    return isinstance(exc, RuntimeError) and PGDA_OPEN_ERROR in str(exc)


def resolve_site(ref: dict):
    """lunarnav Site for a request site reference.

    kind 'catalog' / 'custom_id': lunarnav.sites.get_site(site_id) (exactly what precompute uses).
    kind 'run' / 'coordinates': Site built from the given coordinates (and height_m) - the id is the
    request site id, else the canonical custom id of the coordinates.
    """
    from lunarnav.types import Site

    kind = ref.get("kind")
    if kind in ("catalog", "custom_id"):
        from lunarnav.sites import get_site

        try:
            return get_site(str(ref["site_id"]))
        except KeyError as exc:
            raise ToolError("site_not_found", f"unknown site id {ref['site_id']!r}") from exc
        except ValueError as exc:
            raise ToolError("value_error", str(exc)) from exc
    if kind in ("run", "coordinates"):
        lat, lon = float(ref["lat_deg"]), float(ref["lon_deg"])
        sid = ref.get("site_id")
        if not sid:
            from lunarnav.sites import custom_site_id

            sid = custom_site_id(lat, lon)
        h = ref.get("height_m")
        return Site(id=str(sid), name=str(ref.get("name") or sid), lat_deg=lat, lon_deg=lon,
                    origin="catalog" if kind == "run" and not str(sid).startswith("custom:") else "custom",
                    height_m=None if h is None else float(h))
    raise ToolError("bad_input", f"unknown site reference kind {kind!r}")


def site_json(site) -> dict:
    return {"id": site.id, "name": site.name, "lat_deg": float(site.lat_deg), "lon_deg": float(site.lon_deg),
            "height_m": None if site.height_m is None else float(site.height_m)}


# ---- rounding identical to the run files (lunarnav.precompute._fmt_column) ----------------------------
_DIGITS = {"sun_dist_km": 3, "earth_dist_km": 3}
_AZ = {"sun_az_deg", "earth_az_deg", "az_deg"}


def _own_round(name: str, a: np.ndarray) -> np.ndarray:
    nd = _DIGITS.get(name, 6)
    a = np.round(np.asarray(a, float), nd) + 0.0
    if name in _AZ:
        a = np.mod(a, 360.0) + 0.0
        a[a >= 360.0] = 0.0
    return a


def round_column(name: str, arr, rounding: str) -> list:
    """Column as a JSON list: 'none' = float64 as is; 'run_files' = the run-file text value, re-parsed
    (so the number is bit-identical to what the importer reads from the CSV). NaN -> None."""
    a = np.asarray(arr, float)
    if rounding == "none":
        return [None if not math.isfinite(x) else float(x) for x in a.tolist()]
    try:
        from lunarnav.precompute import _fmt_column  # the writer itself: exact parity
    except ImportError:
        _fmt_column = None
    if _fmt_column is not None:
        return [None if s == "" else float(s) for s in _fmt_column(name, a)]
    nan = ~np.isfinite(a)
    r = _own_round(name, np.where(nan, 0.0, a))
    return [None if n else float(x) for x, n in zip(r.tolist(), nan.tolist())]


def finite(x) -> float | None:
    if x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def run_tool(version: int, fn: Callable[[dict], dict]) -> int:
    """Read stdin, call fn(request) with stdout redirected to stderr, print the protocol line."""
    real_stdout = sys.stdout

    def emit(obj: dict) -> None:
        real_stdout.write(json.dumps(obj, allow_nan=False, ensure_ascii=True) + "\n")
        real_stdout.flush()

    try:
        req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        if not isinstance(req, dict):
            raise ValueError("expected a JSON object")
    except ValueError as exc:
        emit({"ok": False, "error": {"type": "bad_input", "message": f"stdin is not a JSON object: {exc}"}})
        return 2
    t0 = time.perf_counter()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = fn(req)
    except ToolError as exc:
        emit({"ok": False, "error": {"type": exc.kind, "message": str(exc)[:2000]}})
        return 2
    result["elapsed_ms"] = int(round((time.perf_counter() - t0) * 1000))
    emit({"ok": True, "bridge_version": version, "result": result})
    return 0


def jsonable(v: Any):
    """Plain JSON value of a provider attribute (provider_config)."""
    if isinstance(v, (str, bool)) or v is None:
        return v
    if isinstance(v, (int, float)):
        return v if math.isfinite(float(v)) else None
    if isinstance(v, (list, tuple)):
        return [jsonable(x) for x in v]
    return str(v)
