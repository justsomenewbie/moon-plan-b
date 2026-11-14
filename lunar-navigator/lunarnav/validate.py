"""Cross-method validation: Method A (JPL Horizons) vs B (NAIF SPICE) vs C (analytic ERFA/IAU).

This module answers "are the Sun/Earth positions right?" by computing the same quantities three
independent ways and quantifying the differences against *justified* thresholds.  It also runs
negative controls (deliberately wrong frame / time scale / aberration / radius / longitude sign /
azimuth convention) to prove that the thresholds are tight enough to catch each error class, checks a
historical fact (Apollo 11 landing Sun elevation) and the lunar-day / time-until-sunset logic.

Sections
--------
* EPHEMERIS (owned here): :func:`run_ephemeris_validation`.
* TERRAIN (owned by the terrain-validation engineer, module ``lunarnav.validate_terrain``):
  called through the clearly marked hook :func:`validate_terrain_hook`.
* :func:`run_all` runs both and returns one JSON-serialisable report; :func:`main` is the CLI
  (``lunarnav validate ...`` delegates here).

Conventions (lunarnav.types): UTC ``datetime64[s]``; planetocentric lat / EAST lon in MOON_ME;
heights above the 1737.4 km sphere; azimuth clockwise from north in [0, 360); airless apparent
elevation; distances in km to the body centre.

Comparison metrics (per method pair, per body, over all samples of a site/time set)
-------------------------------------------------------------------------------------
* ``sep``    : great-circle angle between the two apparent directions (from az/el), the primary,
               well-conditioned metric (deg);
* ``el``     : |delta elevation| (deg);
* ``az_sky`` : |delta azimuth| * cos(el) (deg) - the on-sky azimuth error.  The raw azimuth difference
               (wrapped to [-180, 180)) is ill-conditioned near the zenith (Sun at Apollo 11 reaches
               el ~ 88.7 deg) and is only reported, never thresholded (``az_raw``, plus ``az_raw_lowel``
               restricted to |el| <= 80 deg);
* ``dist``   : |delta distance| (km) and relative difference.
Each reported as max / p95 / rms (and mean signed for el and dist, to expose biases).
"""
from __future__ import annotations

import argparse
import datetime as _dt
import importlib
import json
import math
import sys
import time as _time
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

import numpy as np

from lunarnav import config
from lunarnav.types import EphemerisProvider, EphemerisSeries, Site

ARCSEC = 1.0 / 3600.0  # deg

# =============================================================================================
# Configuration of the ephemeris validation campaign
# =============================================================================================
#: Catalog sites used for the cross-check: every catalog group is represented
#: (reference/pole, south_pole Artemis region, south_pole landed non-polar, apollo x2, far_side).
VALIDATION_SITE_IDS: tuple[str, ...] = (
    "ref_shackleton_rim",     # reference group, 89.78 S - Sun within ~1.6 deg, Earth within ~7 deg
    "a3_de_gerlache_rim_2",   # south_pole group, Artemis III candidate region centre, 88.2 S
    "chandrayaan3_vikram",    # south_pole group, landed, 69.4 S (published elevation 532 m)
    "apollo11",               # apollo group, equatorial near side (Sun reaches the zenith)
    "apollo15",               # apollo group, 26 N (northern hemisphere sign check)
    "change6",                # far_side group, Earth never up (published elevation -5256 m)
)

#: Mast height added to the site surface height (m).
MAST_M = config.DEFAULT_OBSERVER_HEIGHT_M


@dataclass(frozen=True)
class TimeSet:
    """A named set of UTC epochs (datetime64[s])."""

    name: str
    times: np.ndarray
    description: str


def _hourly(start: str, hours: int) -> np.ndarray:
    t0 = np.datetime64(start, "s")
    return t0 + np.arange(hours, dtype=np.int64) * np.timedelta64(3600, "s")


#: One lunar (synodic) month = 29.53 d = 708.7 h; 709 hourly samples cover it.
LUNAR_MONTH_HOURS = 709
RANDOM_SEED = 20261113
N_RANDOM = 24


def default_time_sets() -> list[TimeSet]:
    """Two epochs (2026, 2030) x one lunar month hourly + N_RANDOM seeded random whole-second times
    uniformly distributed over 2026-01-01 .. 2031-01-01 (irregular -> exercises Horizons TLIST)."""
    rng = np.random.default_rng(RANDOM_SEED)
    lo = np.datetime64("2026-01-01T00:00:00", "s").astype(np.int64)
    hi = np.datetime64("2031-01-01T00:00:00", "s").astype(np.int64)
    rnd = np.sort(rng.integers(lo, hi, size=N_RANDOM)).astype("datetime64[s]")
    return [
        TimeSet("2026-03", _hourly("2026-03-01T00:00:00", LUNAR_MONTH_HOURS),
                "2026-03-01 + 709 h hourly (one synodic month)"),
        TimeSet("2030-09", _hourly("2030-09-01T00:00:00", LUNAR_MONTH_HOURS),
                "2030-09-01 + 709 h hourly (one synodic month)"),
        TimeSet("random", rnd, f"{N_RANDOM} random whole-second epochs 2026-2030 (seed {RANDOM_SEED})"),
    ]


def site_height_above_sphere_m(site: Site) -> float:
    """Observer height above the 1737.4 km sphere used for the cross-check (m).

    ``site.height_m`` if set, else the catalog's ``extra.published_elevation_m`` if present, else 0;
    plus :data:`MAST_M`.  The value only needs to be identical for all methods (parallax of the Earth
    changes by ~0.5 arcsec per km of height), but realistic heights also exercise the altitude path.
    """
    if site.height_m is not None:
        return float(site.height_m) + MAST_M
    h = 0.0
    try:
        from lunarnav import sites as _sites

        extra = _sites.get_site_extra(site.id)
        if extra.get("published_elevation_m") is not None:
            h = float(extra["published_elevation_m"])
    except (KeyError, ValueError, FileNotFoundError):
        pass
    return h + MAST_M


# =============================================================================================
# Thresholds (justified in docs/VALIDATION.md section "Thresholds")
# =============================================================================================
@dataclass(frozen=True)
class Threshold:
    """Pass limits for one method pair: maxima over all samples.

    sep_deg / el_deg / az_sky_deg: degrees.  Distance passes if |d1 - d2| <= dist_abs_km +
    dist_rel * d (both terms apply; use 0 to disable one).
    """

    sep_deg: float
    el_deg: float
    az_sky_deg: float
    dist_abs_km: float
    dist_rel: float
    rationale: str


#: A vs B: same JPL DE (DE441 vs DE440, identical to < 1 m over 1950-2050), same MOON_ME
#: (DE421 ME axes realised from DE440 PA), same 1737.4 km sphere.  Remaining known differences:
#: Horizons applies gravitational light deflection (< 0.003" here) and prints 1e-9 deg (0.004 mas);
#: SPICE LT+S includes the surface point's rotation velocity.  Measured max 0.0026" -> 0.02" is a
#: ~8x margin and still below the smallest real error class tested: radius 1738.0 vs 1737.4 km
#: (0.34"), 37 s TAI/UTC slip (19"), IAU_MOON (10"), aberration off (21"), MOON_PA (104"); even the
#: DE421-vs-DE440 libration model choice (~0.05") is resolved.
#: Distance: Horizons prints delta with 11 significant digits (Sun: 10 m quantisation -> +-5 m,
#: Earth: 1 cm).  DE441 - DE440 geocentric Moon differs by 0.14 m radially (measured with a Horizons
#: VECTORS query); with converged light time (SPICE CN+S) the Earth range agrees to 0.15 m and the
#: Sun range to 7.7 m.  Limit = 2 m + 1e-10 * d  ->  Earth 2.04 m, Sun 15 m.  The one-iteration
#: light time of SPICE "LT+S" (Earth range error rho (v_r/c)^2 <= 4.15 m) is therefore detected.
THRESH_AB = Threshold(
    sep_deg=0.02 * ARCSEC, el_deg=0.02 * ARCSEC, az_sky_deg=0.02 * ARCSEC,
    dist_abs_km=0.002, dist_rel=1e-10,
    rationale="same DE + same MOON_ME + same sphere: milli-arcsec agreement expected "
              "(0.02\" = ~8x measured, below every real error class)",
)

#: A/B vs C: budget of method C (lunarnav.ephem.analytic docstring): IAU_MOON vs MOON_ME
#: <= 0.0051 deg, moon98 (truncated ELP2000-82) Earth direction <= 0.0051 deg, epv00 negligible
#: -> worst ~0.011 deg (Earth), ~0.006 deg (Sun).  0.02 deg gives ~2x margin over the worst case
#: (measured max ~0.005 deg -> 4x).  A sign / frame / azimuth-convention / east-west error is
#: degrees; a 69 s UTC/TDB slip is 0.0098 deg on the Sun -> caught by the tighter A-B test.
#: Distance: moon98 worst 31.7 km / 356 000 km = 9e-5 -> 2e-4 relative.
THRESH_C = Threshold(
    sep_deg=0.02, el_deg=0.02, az_sky_deg=0.02, dist_abs_km=0.0, dist_rel=2e-4,
    rationale="analytic method budget ~0.011 deg (IAU_MOON frame + moon98 theory), 2x margin",
)

PAIRS: tuple[tuple[str, str, Threshold], ...] = (
    ("horizons", "spice", THRESH_AB),
    ("horizons", "analytic", THRESH_C),
    ("spice", "analytic", THRESH_C),
)


# =============================================================================================
# Elementary comparison maths
# =============================================================================================
def wrap180(d_deg: np.ndarray | float) -> np.ndarray:
    """Wrap an angle difference into [-180, 180) degrees (handles the 359.9 / 0.1 wrap-around)."""
    return np.mod(np.asarray(d_deg, dtype=float) + 180.0, 360.0) - 180.0


def azel_unit(az_deg: np.ndarray, el_deg: np.ndarray) -> np.ndarray:
    """Unit vectors (n, 3) in the local (East, North, Up) frame from azimuth (clockwise from north)
    and elevation, both in degrees."""
    az = np.radians(np.asarray(az_deg, dtype=float))
    el = np.radians(np.asarray(el_deg, dtype=float))
    ce = np.cos(el)
    return np.stack([ce * np.sin(az), ce * np.cos(az), np.sin(el)], axis=-1)


def angular_separation_deg(az1: np.ndarray, el1: np.ndarray, az2: np.ndarray, el2: np.ndarray) -> np.ndarray:
    """Great-circle angle (deg) between two (az, el) directions.

    Uses the chord formula 2 asin(|u1 - u2| / 2), numerically stable for milli-arcsecond angles
    (acos of a dot product would lose everything below ~1e-4 arcsec... and worse near 0).
    """
    u1, u2 = azel_unit(az1, el1), azel_unit(az2, el2)
    chord = np.linalg.norm(u1 - u2, axis=-1)
    return np.degrees(2.0 * np.arcsin(np.clip(chord / 2.0, 0.0, 1.0)))


def _stats(x: np.ndarray) -> dict[str, float]:
    a = np.abs(np.asarray(x, dtype=float))
    if a.size == 0:
        return {"max": float("nan"), "p95": float("nan"), "rms": float("nan"), "n": 0}
    return {"max": float(a.max()), "p95": float(np.percentile(a, 95)),
            "rms": float(np.sqrt(np.mean(a * a))), "n": int(a.size)}


def compare_body(az1, el1, d1, az2, el2, d2) -> dict[str, Any]:
    """Difference statistics between two series of one body (degrees, km). See module docstring."""
    az1, el1, d1 = (np.asarray(v, dtype=float) for v in (az1, el1, d1))
    az2, el2, d2 = (np.asarray(v, dtype=float) for v in (az2, el2, d2))
    if not (az1.shape == el1.shape == d1.shape == az2.shape == el2.shape == d2.shape):
        raise ValueError("compare_body: all arrays must have the same shape")
    sep = angular_separation_deg(az1, el1, az2, el2)
    d_el = el1 - el2
    d_az = wrap180(az1 - az2)
    el_mean = 0.5 * (el1 + el2)
    az_sky = d_az * np.cos(np.radians(el_mean))
    low = np.abs(el_mean) <= 80.0
    dd = d1 - d2
    return {
        "sep": _stats(sep),
        "el": {**_stats(d_el), "mean": float(np.mean(d_el)) if d_el.size else float("nan")},
        "az_sky": _stats(az_sky),
        "az_raw": _stats(d_az),
        "az_raw_lowel": _stats(d_az[low]),
        "dist_km": {**_stats(dd), "mean": float(np.mean(dd)) if dd.size else float("nan")},
        "dist_rel": _stats(dd / d2),
        "el_range": [float(np.min(el2)), float(np.max(el2))] if el2.size else [float("nan")] * 2,
    }


def compare_series(a: EphemerisSeries, b: EphemerisSeries) -> dict[str, dict[str, Any]]:
    """Compare two EphemerisSeries sample by sample (same times required)."""
    if a.times_utc.shape != b.times_utc.shape or not np.array_equal(a.times_utc, b.times_utc):
        raise ValueError(f"time grids differ between {a.method} and {b.method}")
    if abs(a.observer_height_m - b.observer_height_m) > 1e-9:
        raise ValueError(f"observer heights differ: {a.observer_height_m} vs {b.observer_height_m} m")
    out = {}
    for body in ("sun", "earth"):
        el1, el2 = getattr(a, f"{body}_el_deg"), getattr(b, f"{body}_el_deg")
        d1, d2 = getattr(a, f"{body}_dist_km"), getattr(b, f"{body}_dist_km")
        st = compare_body(getattr(a, f"{body}_az_deg"), el1, d1, getattr(b, f"{body}_az_deg"), el2, d2)
        # Presence flag above the airless sphere horizon: Sun = upper limb (el + semidiameter > 0,
        # Horizons '*' rule), Earth = centre (el > 0).  Flags may differ only within the angular
        # disagreement of the two methods from the boundary; g = signed distance to the boundary.
        if body == "sun":
            g1 = el1 + np.degrees(np.arcsin(config.SUN_RADIUS_KM / d1))
            g2 = el2 + np.degrees(np.arcsin(config.SUN_RADIUS_KM / d2))
        else:
            g1, g2 = np.asarray(el1, float), np.asarray(el2, float)
        mism = (g1 > 0) != (g2 > 0)
        st["flag_mismatches"] = int(mism.sum())
        st["flag_mismatch_max_margin_deg"] = float(np.max(np.abs(g2[mism]))) if mism.any() else 0.0
        out[body] = st
    return out


def check_threshold(stats: Mapping[str, Any], thr: Threshold, dist_ref_km: float) -> dict[str, Any]:
    """Apply a Threshold to compare_body() stats of one body. ``dist_ref_km`` = max distance of
    the body over the set (for the relative distance term). Returns {passed, failures}."""
    fails: list[str] = []
    for key, lim in (("sep", thr.sep_deg), ("el", thr.el_deg), ("az_sky", thr.az_sky_deg)):
        v = stats[key]["max"]
        if not (v <= lim):  # also fails on NaN
            fails.append(f"{key} max {v * 3600:.4f}\" > {lim * 3600:.4f}\"")
    dlim = thr.dist_abs_km + thr.dist_rel * dist_ref_km
    v = stats["dist_km"]["max"]
    if not (v <= dlim):
        fails.append(f"dist max {v:.4f} km > {dlim:.4f} km")
    if "flag_mismatch_max_margin_deg" in stats and stats["flag_mismatch_max_margin_deg"] > thr.el_deg:
        # a presence flag differs although the sample is farther from the horizon than the allowed
        # elevation disagreement -> unexplained
        fails.append(f"presence flag differs {stats['flag_mismatch_max_margin_deg']:.6f} deg from the boundary")
    return {"passed": not fails, "failures": fails}


# =============================================================================================
# Providers
# =============================================================================================
def make_providers(include_horizons: bool = True, offline: bool = False) -> dict[str, EphemerisProvider]:
    """Instantiate the three providers (A only if ``include_horizons``). ``offline`` -> Horizons
    answers from the disk cache only (raises if a request is not cached)."""
    from lunarnav.ephem.analytic import AnalyticProvider
    from lunarnav.ephem.spice import SpiceProvider

    out: dict[str, EphemerisProvider] = {}
    if include_horizons:
        from lunarnav.ephem.horizons import HorizonsProvider

        out["horizons"] = HorizonsProvider(offline=offline)
    out["spice"] = SpiceProvider()
    out["analytic"] = AnalyticProvider()
    return out


def compute_series(provider: EphemerisProvider, site: Site, times: np.ndarray, h_m: float) -> EphemerisSeries:
    """provider.compute with contract checks (times echoed, finite values, az in [0, 360))."""
    s = provider.compute(site, times, h_m)
    if not np.array_equal(s.times_utc, np.asarray(times).astype("datetime64[s]")):
        raise AssertionError(f"{provider.name}: times_utc not echoed")
    for nm in ("sun_az_deg", "earth_az_deg"):
        a = getattr(s, nm)
        if np.any(~np.isfinite(a)) or np.any(a < 0) or np.any(a >= 360):
            raise AssertionError(f"{provider.name}: {nm} outside [0, 360)")
    for nm in ("sun_el_deg", "earth_el_deg"):
        a = getattr(s, nm)
        if np.any(~np.isfinite(a)) or np.any(np.abs(a) > 90):
            raise AssertionError(f"{provider.name}: {nm} outside [-90, 90]")
    return s


# =============================================================================================
# 1. Cross-method matrix
# =============================================================================================
def crosscheck_matrix(
    sites: Sequence[Site],
    time_sets: Sequence[TimeSet],
    providers: Mapping[str, EphemerisProvider],
    pairs: Sequence[tuple[str, str, Threshold]] = PAIRS,
    log: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Compute every provider for every (site, time set) and compare every available pair.

    Returns {"rows": [per site/set/pair/body stats + pass], "summary": [per pair/body aggregate],
    "series": {(site, set, method): EphemerisSeries} (not JSON; dropped by run_all)}.
    """
    rows: list[dict[str, Any]] = []
    series: dict[tuple[str, str, str], EphemerisSeries] = {}
    timing: dict[str, float] = {}
    for site in sites:
        h = site_height_above_sphere_m(site)
        for ts in time_sets:
            for name, prov in providers.items():
                t0 = _time.perf_counter()
                series[(site.id, ts.name, name)] = compute_series(prov, site, ts.times, h)
                timing[name] = timing.get(name, 0.0) + _time.perf_counter() - t0
            for m1, m2, thr in pairs:
                if m1 not in providers or m2 not in providers:
                    continue
                a, b = series[(site.id, ts.name, m1)], series[(site.id, ts.name, m2)]
                cmp = compare_series(a, b)
                for body in ("sun", "earth"):
                    dref = float(np.max(getattr(b, f"{body}_dist_km")))
                    chk = check_threshold(cmp[body], thr, dref)
                    rows.append({"site_id": site.id, "group": site.group, "time_set": ts.name,
                                 "pair": f"{m1}-{m2}", "body": body, "height_m": h,
                                 "n": int(ts.times.size), **cmp[body], **chk})
            if log:
                log(f"  {site.id:24s} {ts.name:8s} done")
    summary = summarise_rows(rows, pairs)
    return {"rows": rows, "summary": summary, "series": series, "timing_s": timing}


def summarise_rows(rows: Sequence[Mapping[str, Any]], pairs: Sequence[tuple[str, str, Threshold]] = PAIRS) -> list[dict]:
    """Aggregate rows per (pair, body): worst max, worst p95, pooled rms (n-weighted)."""
    out = []
    for m1, m2, thr in pairs:
        pname = f"{m1}-{m2}"
        for body in ("sun", "earth"):
            rs = [r for r in rows if r["pair"] == pname and r["body"] == body]
            if not rs:
                continue
            agg: dict[str, Any] = {"pair": pname, "body": body, "n_rows": len(rs),
                                   "n_samples": int(sum(r["n"] for r in rs))}
            for key in ("sep", "el", "az_sky", "az_raw", "az_raw_lowel", "dist_km", "dist_rel"):
                ns = np.array([r[key]["n"] for r in rs], dtype=float)
                rms = np.array([r[key]["rms"] for r in rs], dtype=float)
                ok = ns > 0
                agg[key] = {
                    "max": float(max(r[key]["max"] for r in rs if r[key]["n"] > 0)),
                    "p95_worst": float(max(r[key]["p95"] for r in rs if r[key]["n"] > 0)),
                    "rms": float(np.sqrt(np.sum(ns[ok] * rms[ok] ** 2) / np.sum(ns[ok]))),
                }
            agg["flag_mismatches"] = int(sum(r.get("flag_mismatches", 0) for r in rs))
            worst = max(rs, key=lambda r: r["sep"]["max"])
            agg["worst_site_set"] = f"{worst['site_id']}/{worst['time_set']}"
            agg["threshold"] = {"sep_deg": thr.sep_deg, "el_deg": thr.el_deg, "az_sky_deg": thr.az_sky_deg,
                                "dist_abs_km": thr.dist_abs_km, "dist_rel": thr.dist_rel}
            agg["passed"] = all(r["passed"] for r in rs)
            agg["failures"] = [f"{r['site_id']}/{r['time_set']}: {f}" for r in rs for f in r["failures"]]
            out.append(agg)
    return out


# =============================================================================================
# 2. Negative controls / discrepancy explanations
# =============================================================================================
@dataclass(frozen=True)
class Variant:
    """A deliberately modified computation, compared against the reference series."""

    key: str
    description: str
    expected: str  # expected magnitude (physics), for the report
    must_detect: bool  # True: the A-B threshold must flag it; False: informative only


VARIANTS: tuple[Variant, ...] = (
    Variant("frame_moon_pa", "SPICE in MOON_PA (principal axes) instead of MOON_ME",
            "constant ME->PA rotation 0.0289 deg (~104\") -> ~0.02-0.03 deg", True),
    Variant("frame_iau_moon", "SPICE in IAU_MOON instead of MOON_ME",
            "IAU libration series truncation, <= 0.0051 deg (~18\")", True),
    Variant("lunar_set_de421", "SPICE with DE421 lunar libration (moon_pa_de421 + moon_080317.tf)",
            "DE421 vs DE440 PA libration model: < 1 m at the surface, ~0.05\" (both valid)", False),
    Variant("time_utc_as_tdb", "UTC epochs used as TDB (69.184 s time-scale slip)",
            "Sun: 69 s x 0.508 deg/h = 0.0098 deg (35\"); Earth: libration/rotation rate x 69 s", True),
    Variant("time_utc_as_tai", "UTC epochs used as TAI (37 s slip)",
            "Sun ~0.0052 deg (19\")", True),
    Variant("abcorr_lt_s_1iter", "single-iteration light time (SPICE LT+S, the former default)",
            "Earth range error rho (v_r/c)^2 <= 4.15 m (half-month period), Earth direction ~0.001\"", True),
    Variant("abcorr_lt", "light time only, no stellar aberration (abcorr LT)",
            "Sun: v_moon/c ~ 30 km/s / c = 20.5\"; Earth: < 1\" (Earth and Moon share the 30 km/s)", True),
    Variant("abcorr_none", "geometric directions (abcorr NONE)",
            "Sun: ~20.5\" (aberration); Earth: ~relative velocity 1 km/s / c ~ 0.7\"", True),
    Variant("radius_1738", "observer on a 1738.0 km sphere instead of 1737.4 km (+600 m)",
            "Earth parallax 0.6 km / 384 400 km x cos(el) <= 0.32\"; Sun ~0", True),
    Variant("lon_west_positive", "site longitude interpreted as WEST-positive (lon -> -lon)",
            "tens of degrees (except on the 0/180 meridian)", True),
    Variant("az_counterclockwise", "azimuth measured counter-clockwise (az -> 360 - az)",
            "2 x |az - 180|: tens of degrees", True),
    Variant("analytic_vs_spice_iau", "C vs SPICE-in-IAU_MOON (removes C's frame error, leaves the moon98/epv00 "
            "theory error)", "Earth <= 0.0051 deg, Sun ~0.0002 deg", False),
)


def _variant_series(key: str, site: Site, times: np.ndarray, h: float) -> EphemerisSeries:
    from lunarnav.ephem.spice import SpiceProvider

    if key == "frame_moon_pa":
        return SpiceProvider(frame="MOON_PA").compute(site, times, h)
    if key == "frame_iau_moon":
        return SpiceProvider(frame="IAU_MOON").compute(site, times, h)
    if key == "lunar_set_de421":
        s = SpiceProvider(lunar_set="de421").compute(site, times, h)
        from lunarnav.ephem import kernels

        kernels.load_kernels("de440")  # restore the default pool for everyone else
        return s
    if key in ("time_utc_as_tdb", "time_utc_as_tai"):
        shift = 69 if key == "time_utc_as_tdb" else 37  # whole seconds (datetime64[s])
        s = SpiceProvider().compute(site, times + np.timedelta64(shift, "s"), h)
        s.times_utc = np.asarray(times).astype("datetime64[s]")
        return s
    if key == "abcorr_lt_s_1iter":
        return SpiceProvider(abcorr="LT+S").compute(site, times, h)
    if key == "abcorr_lt":
        return SpiceProvider(abcorr="LT").compute(site, times, h)
    if key == "abcorr_none":
        return SpiceProvider(abcorr="NONE").compute(site, times, h)
    if key == "radius_1738":
        s = SpiceProvider().compute(site, times, h + 600.0)
        s.observer_height_m = h
        return s
    if key == "lon_west_positive":
        s = SpiceProvider().compute(replace(site, lon_deg=float(np.mod(-site.lon_deg, 360.0))), times, h)
        return s
    if key == "az_counterclockwise":
        s = SpiceProvider().compute(site, times, h)
        s.sun_az_deg = np.mod(360.0 - s.sun_az_deg, 360.0)
        s.earth_az_deg = np.mod(360.0 - s.earth_az_deg, 360.0)
        return s
    raise KeyError(key)


def discrepancy_diagnostics(
    reference: Mapping[tuple[str, str], EphemerisSeries],
    sites: Sequence[Site],
    analytic: Mapping[tuple[str, str], EphemerisSeries] | None = None,
    detect: Threshold = THRESH_AB,
) -> list[dict[str, Any]]:
    """Run every :data:`VARIANTS` entry for each (site, set) key of ``reference`` and report the max
    angular separation (arcsec) and Earth range difference from the reference, and whether the
    pass criteria ``detect`` (default: the A-B threshold) would flag the variant at every site.  ``reference`` maps (site_id, time_set) -> correct series
    (Horizons if available, else SPICE ME); ``analytic`` maps the same keys to method C series.
    """
    by_id = {s.id: s for s in sites}
    out: list[dict[str, Any]] = []
    for var in VARIANTS:
        per: list[dict[str, Any]] = []
        for (sid, tsn), ref in reference.items():
            site, h = by_id[sid], ref.observer_height_m
            if var.key == "analytic_vs_spice_iau":
                if analytic is None or (sid, tsn) not in analytic:
                    continue
                from lunarnav.ephem.spice import SpiceProvider

                a = SpiceProvider(frame="IAU_MOON").compute(site, ref.times_utc, h)
                cmp = compare_series(analytic[(sid, tsn)], a)
            else:
                cmp = compare_series(_variant_series(var.key, site, ref.times_utc, h), ref)
            flagged = [f"{body}: {f}" for body in ("sun", "earth")
                       for f in check_threshold(cmp[body], detect,
                                                float(np.max(getattr(ref, f"{body}_dist_km"))))["failures"]]
            per.append({"site_id": sid, "time_set": tsn,
                        "sun_sep_max_arcsec": cmp["sun"]["sep"]["max"] * 3600,
                        "earth_sep_max_arcsec": cmp["earth"]["sep"]["max"] * 3600,
                        "earth_dist_max_m": cmp["earth"]["dist_km"]["max"] * 1000,
                        "flagged_by": flagged})
        if not per:
            continue
        sun_max = max(p["sun_sep_max_arcsec"] for p in per)
        earth_max = max(p["earth_sep_max_arcsec"] for p in per)
        detected = all(bool(p["flagged_by"]) for p in per)
        out.append({"key": var.key, "description": var.description, "expected": var.expected,
                    "must_detect": var.must_detect, "sun_sep_max_arcsec": sun_max,
                    "earth_sep_max_arcsec": earth_max,
                    "earth_dist_max_m": max(p["earth_dist_max_m"] for p in per),
                    "detected_everywhere": detected,
                    "passed": detected if var.must_detect else True, "per_site": per})
    return out


def _moon_error_vs_spice(times_utc: np.ndarray, earth_moon: np.ndarray) -> dict[str, float]:
    """Max |difference| of a geocentric Moon vector series (km, ICRF/J2000, geometric, at the TDB
    epochs of ``times_utc``) against SPICE DE440: total (km), radial (km), lateral (arcsec)."""
    import spiceypy as sp

    from lunarnav.ephem import kernels
    from lunarnav.ephem.spice import utc_to_et

    kernels.load_kernels("de440")
    et = utc_to_et(times_utc)
    with kernels.SPICE_LOCK:
        ref = np.array([sp.spkezr("MOON", e, "J2000", "NONE", "EARTH")[0][:3] for e in et])
    d = earth_moon - ref
    r = np.linalg.norm(ref, axis=1)
    return {"total_km_max": float(np.linalg.norm(d, axis=1).max()),
            "radial_km_max": float(np.abs(np.sum(d * ref, axis=1) / r).max()),
            "lateral_arcsec_max": float((np.linalg.norm(np.cross(d, ref), axis=1) / r**2).max() * 206264.806)}


def analytic_moon_theory_error(time_sets: Sequence[TimeSet]) -> list[dict[str, Any]]:
    """Explain method C's distance and Earth-direction errors: ERFA moon98 geocentric Moon (as used
    inside AnalyticProvider) minus SPICE DE440, per time set.  Offline (SPICE kernels only)."""
    from lunarnav.ephem import analytic as A

    out = []
    for ts in time_sets:
        jd1, jd2 = A.utc_to_tdb_jd(ts.times)
        st = A.earth_sun_moon_bcrs(jd1, jd2)
        out.append({"time_set": ts.name, **_moon_error_vs_spice(ts.times, st["moon"][0] - st["earth"][0])})
    return out


def de441_vs_de440_moon(start: str = "2026-03-01", stop: str = "2026-03-31", steps: int = 30,
                        offline: bool = False) -> dict[str, Any]:
    """Explain the residual A-B Earth difference: Horizons (DE441) geometric geocentric Moon vectors
    (EPHEM_TYPE=VECTORS, ICRF, TDB) minus SPICE de440s.  One cached Horizons request."""
    from lunarnav.ephem.horizons import HorizonsClient, HorizonsError

    c = HorizonsClient(offline=offline)
    p = {"format": "json", "OBJ_DATA": "NO", "MAKE_EPHEM": "YES", "EPHEM_TYPE": "VECTORS",
         "CENTER": "'500@399'", "COMMAND": "'301'", "REF_PLANE": "FRAME", "REF_SYSTEM": "ICRF",
         "VEC_TABLE": "1", "OUT_UNITS": "KM-S", "CSV_FORMAT": "YES", "VEC_CORR": "NONE", "TIME_TYPE": "TDB",
         "START_TIME": f"'{start}'", "STOP_TIME": f"'{stop}'", "STEP_SIZE": f"'{steps}'"}
    txt = c.fetch(p)
    if "$$SOE" not in txt:
        raise HorizonsError("no $$SOE in Horizons VECTORS response")
    if "DE441" not in txt[: txt.index("$$SOE")]:
        raise HorizonsError("Horizons VECTORS response does not state DE441")
    body = txt[txt.index("$$SOE") + 5: txt.index("$$EOE")]
    rows = [ln.split(",") for ln in body.strip().splitlines()]
    jd = np.array([float(r[0]) for r in rows])
    xyz = np.array([[float(r[2]), float(r[3]), float(r[4])] for r in rows])
    # Convert the TDB epochs to the UTC datetime64 grid expected by _moon_error_vs_spice: compute
    # SPICE directly at the TDB epochs instead (no UTC round trip).
    import spiceypy as sp

    from lunarnav.ephem import kernels

    kernels.load_kernels("de440")
    et = (jd - 2451545.0) * 86400.0
    with kernels.SPICE_LOCK:
        ref = np.array([sp.spkezr("MOON", e, "J2000", "NONE", "EARTH")[0][:3] for e in et])
    d = xyz - ref
    r = np.linalg.norm(ref, axis=1)
    return {"span": f"{start}..{stop}", "n": int(jd.size),
            "total_m_max": float(np.linalg.norm(d, axis=1).max() * 1000),
            "radial_m_max": float(np.abs(np.sum(d * ref, axis=1) / r).max() * 1000),
            "lateral_arcsec_max": float((np.linalg.norm(np.cross(d, ref), axis=1) / r**2).max() * 206264.806)}


# =============================================================================================
# 3. Apollo 11 landing Sun elevation (historical fact from the catalog)
# =============================================================================================
def apollo11_fact_check(providers: Mapping[str, EphemerisProvider]) -> dict[str, Any]:
    """Sun elevation at the Apollo 11 LM touchdown (1969-07-20T20:17:40 UTC) and during the EVA,
    from every provider, against the catalog facts ``apollo11_sun_elevation_at_landing`` and
    ``apollo11_eva_sun_elevation_range``.

    Kernel coverage: SPICE de440s.bsp 1849-2150, moon_pa_de440 1550-2650, DE421 PCK 1900-2050 ->
    all cover 1969; Horizons MEAN_ME valid 1550-2650.  Additional SPICE run with the DE421 lunar set
    (the LOLA-native libration model) for comparison.
    """
    from lunarnav import sites as _sites
    from lunarnav.ephem.spice import SpiceProvider

    fact = _sites.get_validation_fact("apollo11_sun_elevation_at_landing")
    eva = _sites.get_validation_fact("apollo11_eva_sun_elevation_range")
    site = _sites.get_site(fact["site_id"])
    h = MAST_M  # Sun elevation is insensitive to height (< 1e-6 deg per km)
    t_land = np.array([fact["time_utc"]], dtype="datetime64[s]")
    t0, t1 = np.datetime64(eva["time_start_utc"], "s"), np.datetime64(eva["time_end_utc"], "s")
    t_eva = t0 + np.arange(0, int((t1 - t0).astype(np.int64)) + 1, 60).astype("timedelta64[s]")

    provs: dict[str, EphemerisProvider] = dict(providers)
    land: dict[str, float] = {}
    eva_rng: dict[str, list[float]] = {}
    for name, p in provs.items():
        land[name] = float(p.compute(site, t_land, h).sun_el_deg[0])
        s = p.compute(site, t_eva, h).sun_el_deg
        eva_rng[name] = [float(s.min()), float(s.max())]
    s421 = SpiceProvider(lunar_set="de421")
    land["spice_de421"] = float(s421.compute(site, t_land, h).sun_el_deg[0])
    s = s421.compute(site, t_eva, h).sun_el_deg
    eva_rng["spice_de421"] = [float(s.min()), float(s.max())]
    from lunarnav.ephem import kernels

    kernels.load_kernels("de440")

    # Sun elevation rate at landing (for converting time-scale differences into angles).
    t_pm = np.array([t_land[0] - np.timedelta64(300, "s"), t_land[0] + np.timedelta64(300, "s")])
    el_pm = SpiceProvider().compute(site, t_pm, h).sun_el_deg
    rate_deg_s = float((el_pm[1] - el_pm[0]) / 600.0)

    tol = float(fact["tolerance_deg"])
    land_ok = {k: abs(v - fact["sun_elevation_deg"]) <= tol for k, v in land.items()}
    etol = float(eva["tolerance_deg"])
    eva_ok = {k: (v[0] >= eva["sun_elevation_min_deg"] - etol and v[1] <= eva["sun_elevation_max_deg"] + etol)
              for k, v in eva_rng.items()}
    spread = max(land.values()) - min(land.values())
    res = {
        "time_utc": fact["time_utc"], "site": site.id,
        "documented_deg": fact["sun_elevation_deg"], "tolerance_deg": tol,
        "catalog_horizons_crosscheck_deg": fact.get("horizons_crosscheck_deg"),
        "sun_el_deg": land, "within_tolerance": land_ok,
        "method_spread_deg": spread,
        "sun_el_rate_deg_per_s": rate_deg_s,
        "eva": {"start": eva["time_start_utc"], "end": eva["time_end_utc"],
                "documented_deg": [eva["sun_elevation_min_deg"], eva["sun_elevation_max_deg"]],
                "tolerance_deg": etol, "sun_el_range_deg": eva_rng, "within_tolerance": eva_ok},
    }
    if "horizons" in land:
        res["horizons_minus_spice_arcsec"] = (land["horizons"] - land["spice"]) * 3600
        res["horizons_minus_analytic_arcsec"] = (land["horizons"] - land["analytic"]) * 3600
    # Methods must agree with each other much better than with the (rounded) documented value:
    # A-B within 2" (pre-1972 UTC definition handled, see docs) and C within 0.02 deg.
    agree = spread <= THRESH_C.sep_deg
    if "horizons" in land:
        agree = agree and abs(land["horizons"] - land["spice"]) <= 2 * ARCSEC
    res["methods_agree"] = bool(agree)
    res["passed"] = bool(all(land_ok.values()) and all(eva_ok.values()) and agree)
    return res


# =============================================================================================
# 4. Lunar day / time-until-sunset at an equatorial site
# =============================================================================================
SYNODIC_MONTH_D = 29.530589
SYNODIC_RATE_DEG_H = 360.0 / (SYNODIC_MONTH_D * 24.0)  # mean Sun hour-angle rate, 0.5079 deg/h
SIDEREAL_ROTATION_DEG_D = 360.0 / 27.321661  # lunar rotation (= sidereal month), 13.17636 deg/d


def solar_day_length_h(when_utc: np.datetime64 | str) -> float:
    """Expected local solar day on the Moon (h) at an instant, from Keplerian theory only.

    P = 360 / (omega_rot - lambda_dot_sun): the Moon rotates uniformly (physical libration
    ~0.03 deg is negligible) while the Sun's direction moves at the Earth's orbital rate
    lambda_dot = n (1 + e cos M)^2 / (1 - e^2)^1.5 (n = 0.9856474 deg/d, e = 0.0167086,
    M = 357.52911 + 0.98560028 d).  Gives 29.61 d at perihelion (January) and 29.45 d in July;
    the time average is the synodic month 29.53 d.  Neglects the Sun's parallax from the Moon's
    orbit (direction offset <= 384 400 / 1.496e8 rad = 0.147 deg -> +-0.6 h on single events).
    """
    d = float((np.datetime64(when_utc, "s") - np.datetime64("2000-01-01T12:00:00", "s")).astype(np.int64)) / 86400.0
    e, n = 0.0167086, 0.9856474
    m = math.radians(357.52911 + 0.98560028 * d)
    lam_dot = n * (1.0 + e * math.cos(m)) ** 2 / (1.0 - e * e) ** 1.5
    return 360.0 / (SIDEREAL_ROTATION_DEG_D - lam_dot) * 24.0


def _crossings(t: np.ndarray, g: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Linear-interpolated zero crossings of g(t) (t datetime64[s]); returns (times as float s since
    epoch, +1 rising / -1 setting)."""
    ts = t.astype(np.int64).astype(float)
    s = np.sign(g)
    idx = np.flatnonzero((s[:-1] <= 0) & (s[1:] > 0) | (s[:-1] > 0) & (s[1:] <= 0))
    frac = g[idx] / (g[idx] - g[idx + 1])
    tc = ts[idx] + frac * (ts[idx + 1] - ts[idx])
    kind = np.where(g[idx + 1] > g[idx], 1, -1)
    return tc, kind


def _refine_crossing(provider: EphemerisProvider, site: Site, h: float, dip: float,
                     lo: np.datetime64, hi: np.datetime64) -> float:
    """Bisection to 1 s of the upper-limb crossing el + sd = -dip between lo and hi (UTC s)."""
    from lunarnav.visibility import sun_semidiameter_deg

    def g(tt: np.ndarray) -> np.ndarray:
        e = provider.compute(site, tt, h)
        return e.sun_el_deg + sun_semidiameter_deg(e.sun_dist_km) + dip

    # 1-minute scan then 1-s scan: deterministic and exact to 1 s on a datetime64[s] grid.
    grid = lo + np.arange(0, int((hi - lo).astype(np.int64)) + 1, 60).astype("timedelta64[s]")
    gv = g(grid)
    k = int(np.flatnonzero(np.sign(gv[:-1]) != np.sign(gv[1:]))[0])
    fine = grid[k] + np.arange(0, 61).astype("timedelta64[s]")
    fv = g(fine)
    j = int(np.flatnonzero(np.sign(fv[:-1]) != np.sign(fv[1:]))[0])
    return float(fine[j].astype(np.int64)) + fv[j] / (fv[j] - fv[j + 1])


def lunar_day_check(
    providers: Mapping[str, EphemerisProvider],
    site_id: str = "apollo11",
    start: str = "2026-01-01T00:00:00",
    hours: int = 24 * 90,
) -> dict[str, Any]:
    """Day length, solar-day period and time-until-sunset at an equatorial site (flat horizon, 2 m mast).

    The reference method (SPICE if present) is evaluated hourly; visibility via
    :func:`lunarnav.visibility.compute_visibility` (upper limb above the flat -dip horizon) and
    windows via :mod:`lunarnav.windows`.  Expected values (justified in docs/VALIDATION.md):

    * solar day P(t) from Keplerian theory, :func:`solar_day_length_h` (29.45 d July .. 29.61 d
      January; mean = synodic month 29.53 d, so half a day = 14.77 d on average);
    * daylight = P/2 + 2 (sd + dip) / (360 deg / P)   (the upper-limb rule and the mast dip lengthen
      the day by ~1.4 h); tolerance 0.75 h = Sun parallax from the Moon's orbit (direction offset
      <= 0.147 deg -> <= 0.6 h on a sunrise-sunset pair) + declination effect at lat 0.67 deg
      (tan(lat) tan(1.54 deg) -> < 0.1 h); +1 h more for hourly window durations;
    * night = P - daylight with the same tolerances; sunset-to-sunset = P +- 0.75 h;
    * ``hours_until_state(t, sun_visible, False)`` ("hours until sunset") for each lit sample minus the
      true time to sunset (1-s bisection on the continuous ephemeris) is in [0, 1 h): the first dark
      sample is reported, i.e. late by less than one step; it decreases by exactly 1 h per hourly
      step; at local noon (max elevation) it is ~ half the daylight (+-1 h sampling, +-1 h
      noon asymmetry from the parallax);
    * sunset/sunrise instants (linear interpolation of el + sd + dip on the hourly grid, identical
      interpolation error for all methods) agree: A-B <= 1 s (0.02" / 0.508 deg/h = 0.04 s, margin
      for interpolation), C <= 142 s (0.02 deg / 0.508 deg/h).
    """
    from lunarnav import sites as _sites
    from lunarnav import windows as W
    from lunarnav.visibility import VisibilityOptions, compute_visibility, flat_horizon_dip_deg, sun_semidiameter_deg

    site = _sites.get_site(site_id)
    h = MAST_M  # flat horizon: surface on the sphere + 2 m mast
    dip = flat_horizon_dip_deg(MAST_M, 0.0)
    t = _hourly(start, hours)
    ref_name = "spice" if "spice" in providers else next(iter(providers))
    eph = {n: p.compute(site, t, h) for n, p in providers.items()}
    vis = compute_visibility(eph[ref_name], None, VisibilityOptions(observer_height_m=MAST_M))
    wins = W.find_windows(t, vis.sun_visible)
    lit = [w for w in wins if w.state and not w.truncated_start and not w.truncated_end]
    dark = [w for w in wins if not w.state and not w.truncated_start and not w.truncated_end]
    hus = W.hours_until_state(t, vis.sun_visible, False)
    sd_mean = float(np.mean(vis.sun_semidiam_deg))

    def expected_daylight_h(mid: np.datetime64) -> float:
        p = solar_day_length_h(mid)
        return p / 2.0 + 2.0 * (sd_mean + dip) / (360.0 / p)

    prov = providers[ref_name]
    per_day: list[dict[str, Any]] = []
    true_sets: list[float] = []
    for w in lit:
        true_set = _refine_crossing(prov, site, h, dip, w.end - np.timedelta64(3600, "s"), w.end)
        true_rise = _refine_crossing(prov, site, h, dip, w.start - np.timedelta64(3600, "s"), w.start)
        true_sets.append(true_set)
        sl = slice(w.start_index, w.end_index)
        ti = t[sl].astype(np.int64).astype(float)
        err_h = hus[sl] - (true_set - ti) / 3600.0  # windows answer minus truth, must be in [0, 1)
        noon = w.start_index + int(np.argmax(vis.sun_el_deg[sl]))
        mid = np.datetime64(int(round(0.5 * (true_rise + true_set))), "s")
        exp_h = expected_daylight_h(mid)
        per_day.append({
            "sunrise_utc": str(np.datetime64(int(round(true_rise)), "s")),
            "sunset_utc": str(np.datetime64(int(round(true_set)), "s")),
            "expected_daylight_h": exp_h,
            "solar_day_theory_h": solar_day_length_h(mid),
            "daylight_true_h": (true_set - true_rise) / 3600.0,
            "daylight_window_h": w.duration_h,
            "hours_until_sunset_at_first_lit": float(hus[w.start_index]),
            "hours_until_sunset_at_noon": float(hus[noon]),
            "noon_utc": str(t[noon]), "noon_sun_el_deg": float(vis.sun_el_deg[noon]),
            "hus_minus_truth_h_min": float(err_h.min()), "hus_minus_truth_h_max": float(err_h.max()),
            "hus_slope_ok": bool(np.allclose(np.diff(hus[sl]), -1.0)),
        })
    nights = []
    for w in dark:
        mid = w.start + (w.end - w.start) // 2
        p = solar_day_length_h(mid)
        nights.append({"start": str(w.start), "window_h": w.duration_h, "expected_h": p - expected_daylight_h(mid)})
    periods = []
    for a, b in zip(true_sets[:-1], true_sets[1:]):
        mid = np.datetime64(int(round(0.5 * (a + b))), "s")
        periods.append({"sunset_to_sunset_h": (b - a) / 3600.0, "theory_h": solar_day_length_h(mid)})

    # Cross-method rise/set instants.
    events: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for n, e in eph.items():
        events[n] = _crossings(t, e.sun_el_deg + sun_semidiameter_deg(e.sun_dist_km) + dip)
    ev_cmp: dict[str, dict[str, float]] = {}
    for m1, m2, _thr in PAIRS:
        if m1 in events and m2 in events:
            (a, ka), (b, kb) = events[m1], events[m2]
            if a.size != b.size or not np.array_equal(ka, kb):
                ev_cmp[f"{m1}-{m2}"] = {"max_abs_s": float("inf"), "n": int(min(a.size, b.size))}
            else:
                ev_cmp[f"{m1}-{m2}"] = {"max_abs_s": float(np.max(np.abs(a - b))), "n": int(a.size)}
    ev_lim = {"horizons-spice": 1.0, "horizons-analytic": 142.0, "spice-analytic": 142.0}

    checks = {
        "at_least_two_full_days": len(per_day) >= 2 and len(periods) >= 1,
        "daylight_true_vs_theory_le_0.75h": all(abs(d["daylight_true_h"] - d["expected_daylight_h"]) <= 0.75
                                               for d in per_day),
        "daylight_window_vs_theory_le_1.75h": all(abs(d["daylight_window_h"] - d["expected_daylight_h"]) <= 1.75
                                                 for d in per_day),
        "night_window_vs_theory_le_1.75h": all(abs(x["window_h"] - x["expected_h"]) <= 1.75 for x in nights),
        "sunset_to_sunset_vs_theory_le_0.75h": all(abs(p["sunset_to_sunset_h"] - p["theory_h"]) <= 0.75
                                                  for p in periods),
        "hours_until_sunset_minus_truth_in_[0,1)h": all(0.0 <= d["hus_minus_truth_h_min"]
                                                         and d["hus_minus_truth_h_max"] < 1.0 for d in per_day),
        "hours_until_sunset_decreases_1h_per_h": all(d["hus_slope_ok"] for d in per_day),
        "hours_until_sunset_at_noon_is_half_day_le_2h": all(
            abs(d["hours_until_sunset_at_noon"] - d["expected_daylight_h"] / 2.0) <= 2.0 for d in per_day),
        "events_agree_across_methods": all(v["max_abs_s"] <= ev_lim[k] for k, v in ev_cmp.items()),
    }
    return {
        "site": site.id, "lat_deg": site.lat_deg, "start": start, "hours": hours, "reference_method": ref_name,
        "flat_dip_deg": dip, "sun_semidiam_mean_deg": sd_mean,
        "half_synodic_month_d": SYNODIC_MONTH_D / 2.0,
        "mean_expected_daylight_h": SYNODIC_MONTH_D * 12.0 + 2.0 * (sd_mean + dip) / SYNODIC_RATE_DEG_H,
        "days": per_day, "nights": nights, "periods": periods,
        "event_time_differences": ev_cmp, "event_limits_s": ev_lim,
        "checks": checks, "passed": bool(all(checks.values())),
    }


# =============================================================================================
# 5. Terrain validation hook (owned by the terrain-validation engineer)
# =============================================================================================
# >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
def validate_terrain_hook(**kwargs: Any) -> dict[str, Any]:
    """TERRAIN VALIDATION HOOK - do not put terrain checks in this file.

    Imports ``lunarnav.validate_terrain`` if it exists and calls its ``run_all(**kwargs)`` (or
    ``run(**kwargs)``).  The returned mapping should contain at least ``passed`` (bool).
    Returns {"status": "absent"} when the module is not installed, {"status": "error", ...} if it
    raised (the exception text is kept, never swallowed silently: the overall report then fails).
    """
    try:
        mod = importlib.import_module("lunarnav.validate_terrain")
    except ModuleNotFoundError as exc:
        if exc.name == "lunarnav.validate_terrain":
            return {"status": "absent", "passed": None,
                    "note": "lunarnav.validate_terrain not present; terrain section skipped"}
        raise
    fn = getattr(mod, "run_all", None) or getattr(mod, "run", None)
    if fn is None:
        return {"status": "error", "passed": False, "error": "lunarnav.validate_terrain has no run_all()/run()"}
    import inspect

    params = inspect.signature(fn).parameters
    if not any(p.kind == p.VAR_KEYWORD for p in params.values()):
        kwargs = {k: v for k, v in kwargs.items() if k in params}  # pass only what it accepts
    try:
        res = fn(**kwargs)
    except Exception as exc:  # report, do not hide
        return {"status": "error", "passed": False, "error": f"{type(exc).__name__}: {exc}"}
    res = dict(res) if isinstance(res, Mapping) else {"result": res}
    res.setdefault("status", "ran")
    return res
# <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<


# =============================================================================================
# Entry points
# =============================================================================================
def _jsonable(o: Any) -> Any:
    if isinstance(o, Mapping):
        return {str(k): _jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_jsonable(v) for v in o]
    if isinstance(o, np.ndarray):
        return _jsonable(o.tolist())
    if isinstance(o, (np.bool_, bool)):
        return bool(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (float, np.floating)):
        f = float(o)
        return None if math.isnan(f) else (str(f) if math.isinf(f) else f)
    if isinstance(o, np.datetime64):
        return str(o)
    return o


def run_ephemeris_validation(
    include_horizons: bool = True,
    offline: bool = False,
    site_ids: Sequence[str] = VALIDATION_SITE_IDS,
    time_sets: Sequence[TimeSet] | None = None,
    diagnostics: bool = True,
    apollo: bool = True,
    lunar_day: bool = True,
    log: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """EPHEMERIS section: cross-method matrix + negative controls + Apollo 11 + lunar day.

    Returns a dict with keys matrix (rows/summary), diagnostics, apollo11, lunar_day, passed,
    and ``_series`` (in-memory EphemerisSeries; removed by :func:`run_all` before serialising).
    """
    from lunarnav import sites as _sites

    sites = [_sites.get_site(s) for s in site_ids]
    tsets = list(time_sets) if time_sets is not None else default_time_sets()
    provs = make_providers(include_horizons, offline)
    if log:
        log(f"cross-check: {len(sites)} sites x {len(tsets)} time sets x {list(provs)}")
    mat = crosscheck_matrix(sites, tsets, provs, log=log)
    out: dict[str, Any] = {
        "sites": [{"id": s.id, "group": s.group, "lat_deg": s.lat_deg, "lon_deg": s.lon_deg,
                   "height_above_sphere_m": site_height_above_sphere_m(s)} for s in sites],
        "time_sets": [{"name": t.name, "n": int(t.times.size), "first": str(t.times[0]),
                       "last": str(t.times[-1]), "description": t.description} for t in tsets],
        "providers": list(provs),
        "thresholds": {f"{a}-{b}": vars(t) for a, b, t in PAIRS},
        "matrix": {"summary": mat["summary"], "rows": mat["rows"], "timing_s": mat["timing_s"]},
    }
    passed = all(s["passed"] for s in mat["summary"])
    if diagnostics:
        ref_name = "horizons" if "horizons" in provs else "spice"
        diag_keys = [(sites[0].id, tsets[0].name)]  # pole site, 2026 month
        apollo_id = next((s.id for s in sites if s.id == "apollo11"), None)
        if apollo_id:
            diag_keys.append((apollo_id, tsets[0].name))
        ref = {k: mat["series"][(k[0], k[1], ref_name)] for k in diag_keys}
        ana = {k: mat["series"][(k[0], k[1], "analytic")] for k in diag_keys}
        if log:
            log(f"diagnostics against {ref_name} for {diag_keys}")
        out["diagnostics"] = {"reference": ref_name, "variants": discrepancy_diagnostics(ref, sites, ana)}
        passed = passed and all(v["passed"] for v in out["diagnostics"]["variants"])
        ex: dict[str, Any] = {"analytic_moon98_vs_de440": analytic_moon_theory_error(
            [t for t in tsets if t.times.size > 1][:2] or tsets)}
        if "horizons" in provs:
            ex["de441_vs_de440_moon"] = de441_vs_de440_moon(offline=offline)
        out["explanations"] = ex
    if apollo:
        if log:
            log("Apollo 11 landing Sun elevation")
        out["apollo11"] = apollo11_fact_check(provs)
        passed = passed and out["apollo11"]["passed"]
    if lunar_day:
        if log:
            log("lunar day / time-until-sunset")
        out["lunar_day"] = lunar_day_check(provs)
        passed = passed and out["lunar_day"]["passed"]
    out["passed"] = bool(passed)
    out["_series"] = mat["series"]
    return out


def run_all(
    include_horizons: bool = True,
    offline: bool = False,
    terrain: bool = True,
    quick: bool = False,
    log: Callable[[str], None] | None = None,
    terrain_kwargs: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Run every validation section and return one JSON-serialisable report.

    Args:
        include_horizons: query Method A (JPL Horizons; responses cached in data/cache/horizons).
        offline: Horizons from cache only (no network); raises if something is not cached.
        terrain: call :func:`validate_terrain_hook`.
        quick: 2 sites (pole + Apollo 11) and only the 2026 month (for smoke tests).
    Report keys: generated_utc, ephemeris, terrain, passed.
    """
    kw: dict[str, Any] = {}
    if quick:
        kw["site_ids"] = ("ref_shackleton_rim", "apollo11")
        kw["time_sets"] = default_time_sets()[:1]
    eph = run_ephemeris_validation(include_horizons=include_horizons, offline=offline, log=log, **kw)
    eph.pop("_series", None)
    report: dict[str, Any] = {
        "generated_utc": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "lunarnav_version": __import__("lunarnav").__version__,
        "ephemeris": eph,
    }
    if terrain:
        report["terrain"] = validate_terrain_hook(**{"quick": quick, **dict(terrain_kwargs or {})})
    t_ok = report.get("terrain", {}).get("passed")
    report["passed"] = bool(eph["passed"] and t_ok is not False)
    return _jsonable(report)


# =============================================================================================
# Text rendering
# =============================================================================================
def _fmt_as(deg: float) -> str:
    return f"{deg * 3600:.4f}\""


def render_markdown(report: Mapping[str, Any]) -> str:
    """Pass/fail tables of a run_all() report (Markdown)."""
    eph = report["ephemeris"]
    L: list[str] = [f"Generated {report.get('generated_utc')} - overall: **{'PASS' if report['passed'] else 'FAIL'}**", ""]
    L += ["| pair | body | samples | sep max | sep p95 | sep rms | \\|d el\\| max | \\|d az\\|cos(el) max | "
          "\\|d az\\| max (\\|el\\|<=80) | \\|d dist\\| max | limit (sep / dist) | worst | result |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for s in eph["matrix"]["summary"]:
        thr = s["threshold"]
        dl = " + ".join(x for x in ((f"{thr['dist_abs_km'] * 1000:g} m" if thr["dist_abs_km"] else ""),
                                    (f"{thr['dist_rel']:.0e} d" if thr["dist_rel"] else "")) if x)
        L.append(f"| {s['pair']} | {s['body']} | {s['n_samples']} | {_fmt_as(s['sep']['max'])} | "
                 f"{_fmt_as(s['sep']['p95_worst'])} | {_fmt_as(s['sep']['rms'])} | {_fmt_as(s['el']['max'])} | "
                 f"{_fmt_as(s['az_sky']['max'])} | {_fmt_as(s['az_raw_lowel']['max'])} | "
                 f"{s['dist_km']['max'] * 1000:.1f} m | {_fmt_as(thr['sep_deg'])} / {dl} | {s['worst_site_set']} | "
                 f"{'PASS' if s['passed'] else 'FAIL'} |")
    if "diagnostics" in eph:
        L += ["", f"Negative controls (reference = {eph['diagnostics']['reference']}):", "",
              "| variant | expected | Sun sep max | Earth sep max | Earth range max | flagged by A-B limits | result |",
              "|---|---|---|---|---|---|---|"]
        for v in eph["diagnostics"]["variants"]:
            L.append(f"| {v['description']} | {v['expected']} | {v['sun_sep_max_arcsec']:.4f}\" | "
                     f"{v['earth_sep_max_arcsec']:.4f}\" | {v['earth_dist_max_m']:.2f} m | {v['detected_everywhere']} | "
                     f"{'PASS' if v['passed'] else 'FAIL'}{'' if v['must_detect'] else ' (info)'} |")
    if "explanations" in eph:
        ex = eph["explanations"]
        L += ["", "Explanations:", ""]
        for x in ex.get("analytic_moon98_vs_de440", []):
            L.append(f"* moon98 - DE440 geocentric Moon, {x['time_set']}: total {x['total_km_max']:.2f} km, "
                     f"radial {x['radial_km_max']:.2f} km, lateral {x['lateral_arcsec_max']:.2f}\"")
        if "de441_vs_de440_moon" in ex:
            x = ex["de441_vs_de440_moon"]
            L.append(f"* DE441 (Horizons) - DE440 (SPICE) geocentric Moon, {x['span']}: total {x['total_m_max']:.2f} m, "
                     f"radial {x['radial_m_max']:.2f} m, lateral {x['lateral_arcsec_max']:.4f}\"")
    if "apollo11" in eph:
        a = eph["apollo11"]
        L += ["", f"Apollo 11 landing {a['time_utc']} UTC, documented {a['documented_deg']} +- {a['tolerance_deg']} deg:", ""]
        for k, v in a["sun_el_deg"].items():
            r = a["eva"]["sun_el_range_deg"][k]
            L.append(f"* {k}: landing {v:.5f} deg; EVA {r[0]:.3f}..{r[1]:.3f} deg")
        L.append(f"* result: {'PASS' if a['passed'] else 'FAIL'}")
    if "lunar_day" in eph:
        d = eph["lunar_day"]
        L += ["", f"Lunar day at {d['site']} (mean expected daylight {d['mean_expected_daylight_h']:.2f} h):", ""]
        for x in d["days"]:
            L.append(f"* {x['sunrise_utc']} -> {x['sunset_utc']}: {x['daylight_true_h']:.2f} h (theory "
                     f"{x['expected_daylight_h']:.2f} h, window {x['daylight_window_h']:.0f} h), "
                     f"hours_until_sunset at noon {x['hours_until_sunset_at_noon']:.0f} h")
        for x in d["nights"]:
            L.append(f"* night from {x['start']}: {x['window_h']:.0f} h (theory {x['expected_h']:.2f} h)")
        for x in d["periods"]:
            L.append(f"* sunset-to-sunset {x['sunset_to_sunset_h']:.2f} h (theory {x['theory_h']:.2f} h)")
        ev = {k: round(v["max_abs_s"], 3) for k, v in d["event_time_differences"].items()}
        L.append(f"* rise/set instant differences, max (s): {ev}")
        L.append(f"* checks {d['checks']} -> {'PASS' if d['passed'] else 'FAIL'}")
    t = report.get("terrain")
    if t is not None:
        L += ["", f"Terrain hook: status {t.get('status')}, passed {t.get('passed')}"]
    return "\n".join(L) + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    """CLI: ``lunarnav validate [--offline] [--no-horizons] [--quick] [--no-terrain] [--out DIR]``.

    Writes validation_report.json and validation_report.md into --out (default
    <output_dir>/validation) and prints the Markdown. Exit code 0 = all passed, 1 = a check failed.
    """
    ap = argparse.ArgumentParser(prog="lunarnav validate", description=__doc__.split("\n")[0])
    ap.add_argument("--offline", action="store_true", help="Horizons from the disk cache only")
    ap.add_argument("--no-horizons", action="store_true", help="skip Method A (SPICE vs analytic only)")
    ap.add_argument("--quick", action="store_true", help="2 sites x 1 month (smoke test)")
    ap.add_argument("--no-terrain", action="store_true", help="skip the terrain hook")
    ap.add_argument("--out", default=None, help="output directory for the report")
    args = list(argv) if argv is not None else sys.argv[1:]
    if args[:1] == ["--"]:  # `lunarnav validate -- --quick ...` (argparse REMAINDER keeps the "--")
        args = args[1:]
    a = ap.parse_args(args)
    rep = run_all(include_horizons=not a.no_horizons, offline=a.offline, terrain=not a.no_terrain,
                  quick=a.quick, log=lambda m: print(m, file=sys.stderr))
    out = Path(a.out) if a.out else config.output_dir() / "validation"
    out.mkdir(parents=True, exist_ok=True)
    (out / "validation_report.json").write_text(json.dumps(rep, indent=1, sort_keys=True), encoding="utf-8")
    md = render_markdown(rep)
    (out / "validation_report.md").write_text(md, encoding="utf-8")
    print(md)
    print(f"report written to {out}", file=sys.stderr)
    return 0 if rep["passed"] else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
