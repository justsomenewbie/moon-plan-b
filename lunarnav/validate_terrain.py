"""Validation of the TERRAIN -> HORIZON -> VISIBILITY chain against independent references.

What is checked (numbers and verdicts go to docs/VALIDATION_TERRAIN.md, produced by :func:`run`):

1. ``mask_method_comparison`` - the two horizon algorithms of :mod:`lunarnav.horizon`
   (``raymarch`` = bilinear rays, ``bruteforce`` = every DEM cell) on REAL LOLA terrain (NASA GSFC
   PGDA product 90, Barker et al. 2023) for a ridge, a crater floor and an Artemis III region.
2. ``illumination_validation`` - our average solar illumination (SPICE DE440 ephemeris + our
   horizon masks + :mod:`lunarnav.visibility`) against NASA's published LOLA-based products:
   PGDA product 69 (Mazarico et al. 2011, updated 2016-08) average solar visibility
   ``AVGVISIB_85S_060M_201608``, Earth visibility ``..._EARTH`` and permanent-shadow map
   ``LPSR_85S_060M_201608`` at ~30 PSR pixels, ~30 well-lit pixels and the literature points of
   the site catalog (``reference_illumination_pct``).
3. ``trek_header_check`` / ``compare_dem_sources`` - Moon Trek (challenge resource) vs PGDA: header
   assumptions (CRS, dtype, half-metre Int16 scale) from the first MB of the Trek files only, and a
   generic height + horizon-mask comparison of two DemSources (run on the Trek ImageServer here,
   on the full downloaded Trek files on Colab).
4. ``sensitivity_mast`` / ``sensitivity_offsets`` - physical sensitivity checks (mast height,
   moving the site by 100-500 m).

Conventions: as :mod:`lunarnav.types` (planetocentric lat / EAST lon in MOON_ME, heights above the
1737.4 km sphere, azimuth clockwise from local north, airless apparent elevations, UTC
datetime64[s]).  Percentages are 0..100.

Terrain model used here ("banded" DEM): the horizon is the maximum terrain elevation over ALL
distances, so it is the element-wise maximum of the masks of disjoint distance bands
``[0, r1), [r1, r2), ...``; each band is computed on its own PGDA product (fine near the site,
coarse far away) with ``min_distance_m`` = inner radius.  This gives 20-40 m detail where it matters
without reading a 20 m grid over 300 km.  The site surface height is taken from the FINEST band and
passed explicitly to every band (``Site.height_m``), so all bands use the same observer point.

Ephemeris used here (:class:`MoonCentreEphemeris`): apparent (LT+S) Sun / Earth position vectors
from the Moon CENTRE in MOON_ME computed once with SPICE (``spkpos``), then made topocentric per site
by subtracting the site vector.  This is the SPICE method B of :mod:`lunarnav.ephem.spice` without
the per-site loop; it is checked against ``SpiceProvider.compute`` (``check_vector_ephemeris``):
the neglected term is the light-time difference between the centre and the surface (<= 5.8 ms) times
the ~30 km/s barycentric target speed: <= 0.18 km along the line of sight / 2.7e-5 deg in direction
(measured), negligible for horizon work (stellar aberration of the 4.6 m/s rotation: 1e-6 deg).

Data volume on the dev machine: PGDA windowed reads only (~40-80 cached 512x512 blocks, each about
1 MB, under data/cache/pgda/), the 60 m illumination rasters around the pole (a few MB, cached under
data/cache/validate_terrain/), the cached first 4-12 MB of the Trek files, a few Trek ImageServer
blocks.  No Moon Trek full file is downloaded.

Run:  python -m lunarnav.validate_terrain [--quick] [--out report.json]
"""
from __future__ import annotations

import argparse
import dataclasses
import functools
import io
import json
import logging
import math
import time
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Mapping, Sequence

import numpy as np

from . import config
from .horizon import (
    compare_masks,
    enu_basis,
    horizon_bruteforce,
    horizon_raymarch,
    moon_polar_stereo_wkt,
    rasterize_height_function,
)
from .types import DemPatch, EphemerisSeries, HorizonMask, Site
from .visibility import VisibilityOptions, VisibilitySeries, compute_visibility

log = logging.getLogger(__name__)

R_M = config.MOON_RADIUS_M

#: 18.6 Julian years (lunar nodal / precession cycle) in days - the averaging period of PGDA product 69.
NODAL_CYCLE_DAYS = 18.6 * 365.25


# ================================================================================================
# Banded terrain model
# ================================================================================================
@dataclass(frozen=True)
class TerrainBand:
    """One distance band of the banded terrain model: ``product`` is used for distances
    [previous band's outer radius, ``outer_radius_m``) from the site (arc distance, metres)."""

    product: str
    outer_radius_m: float


#: Task-1 / sensitivity terrain: PGDA 20 m (Barker 2023, best LOLA product) to 15 km, 120 m to
#: 60 km, 240 m to 150 km.  Resolution beyond 15 km matters little: an error dz of a crest height at
#: distance d changes the horizon by dz/d (30 m at 30 km = 0.06 deg, 1/9 of the solar disc).
BANDS_20M: tuple[TerrainBand, ...] = (
    TerrainBand("LDEM_80S_20MPP_ADJ", 15_000.0),
    TerrainBand("LDEM_60S_120MPP_ADJ", 60_000.0),
    TerrainBand("LDEM_60S_240MPP_ADJ", 150_000.0),
)

#: Illumination validation terrain (many pixels spread over +-45 km): 40 m near field (comparable
#: to the 60 m grid of the PGDA illumination maps and 4x fewer blocks than 20 m).
BANDS_40M: tuple[TerrainBand, ...] = (
    TerrainBand("LDEM_80S_40MPP_ADJ", 20_000.0),
    TerrainBand("LDEM_60S_120MPP_ADJ", 60_000.0),
    TerrainBand("LDEM_60S_240MPP_ADJ", 150_000.0),
)

DemGetter = Callable[[str], object]


@functools.lru_cache(maxsize=None)
def pgda_dem(product: str):
    """Cached PgdaDem instance (remote windowed reads, disk-cached blocks)."""
    from .terrain.pgda import PgdaDem

    return PgdaDem(product)


def _dem_res(dem) -> float:
    """Pixel size (m) of a DemSource: ``grid.res`` (BlockGridDem), ``res_m`` (SyntheticDem) or
    ``patch_resolution_m`` (TrekDem); 1 m if unknown (only used as a patch margin)."""
    for v in (getattr(getattr(dem, "grid", None), "res", None), getattr(dem, "res_m", None),
              getattr(dem, "patch_resolution_m", None)):
        if v:
            return float(v)
    return 1.0


def _check_bands(bands: Sequence[TerrainBand]) -> None:
    if not bands:
        raise ValueError("need at least one terrain band")
    r = [b.outer_radius_m for b in bands]
    if any(x <= 0 for x in r) or any(b <= a for a, b in zip(r, r[1:])):
        raise ValueError(f"band outer radii must be > 0 and strictly increasing: {r}")


def site_with_height(site: Site, bands: Sequence[TerrainBand], get_dem: DemGetter = pgda_dem) -> Site:
    """Copy of ``site`` with ``height_m`` = finest-band DEM height (m above 1737.4 km sphere).

    Keeps an explicit ``site.height_m``.  Raises ValueError if the DEM has no data at the site.
    """
    if site.height_m is not None:
        return site
    h = float(np.asarray(get_dem(bands[0].product).height_at(site.lat_deg, site.lon_deg)).reshape(-1)[0])
    if not np.isfinite(h):
        raise ValueError(f"site {site.id}: no {bands[0].product} height at "
                         f"({site.lat_deg}, {site.lon_deg})")
    return dataclasses.replace(site, height_m=h)


def combine_masks(masks: Sequence[HorizonMask], method: str, dem_source: str) -> HorizonMask:
    """Element-wise maximum of masks of disjoint distance bands (same azimuth grid, same observer).

    ``meta['band_of_max']`` = index of the band that sets the horizon in each azimuth bin.
    """
    if not masks:
        raise ValueError("no masks to combine")
    az = masks[0].az_deg
    for m in masks[1:]:
        if m.az_deg.shape != az.shape or not np.allclose(m.az_deg, az):
            raise ValueError("band masks must share the azimuth grid")
        if abs(m.surface_height_m - masks[0].surface_height_m) > 1e-9 or \
                abs(m.observer_height_m - masks[0].observer_height_m) > 1e-9:
            raise ValueError("band masks must share the observer point (surface height + mast)")
    stack = np.vstack([np.asarray(m.el_deg, float) for m in masks])
    k = np.argmax(stack, axis=0)
    meta: dict = {"band_of_max": k, "band_el_deg": stack,
                  "band_sources": [m.dem_source for m in masks]}
    if all("horizon_distance_km" in m.meta for m in masks):
        dist = np.vstack([np.asarray(m.meta["horizon_distance_km"], float) for m in masks])
        meta["horizon_distance_km"] = dist[k, np.arange(az.size)]
        meta["band_dist_km"] = dist
    return HorizonMask(site_id=masks[0].site_id, az_deg=az, el_deg=stack.max(axis=0), method=method,
                       dem_source=dem_source, radius_km=max(m.radius_km for m in masks),
                       observer_height_m=masks[0].observer_height_m,
                       surface_height_m=masks[0].surface_height_m, meta=meta)


def banded_mask(site: Site, bands: Sequence[TerrainBand] = BANDS_20M, method: str = "raymarch",
                observer_height_m: float = config.DEFAULT_OBSERVER_HEIGHT_M,
                az_step_deg: float = config.DEFAULT_AZ_STEP_DEG, *,
                near_exclusion_m: float = 0.0, get_dem: DemGetter = pgda_dem,
                patches: dict | None = None) -> HorizonMask:
    """Horizon mask of ``site`` on the banded terrain model (module docstring).

    method: "raymarch" (constant along-ray step = half a pixel of each band, 3 rays per bin) or
    "bruteforce".  near_exclusion_m: ignore terrain closer than this (both methods) - used to
    separate the near-field DEM-model effect when comparing the two methods.
    ``patches`` (optional dict) caches the per-band DemPatch between calls for the same site.
    """
    _check_bands(bands)
    if method not in ("raymarch", "bruteforce"):
        raise ValueError(f"method must be raymarch or bruteforce, got {method!r}")
    site_h = site_with_height(site, bands, get_dem)
    masks = []
    inner = 0.0
    for b in bands:
        dem = get_dem(b.product)
        key = (site.id, site.lat_deg, site.lon_deg, b.product, b.outer_radius_m)
        patch = patches.get(key) if patches is not None else None
        if patch is None:
            res = _dem_res(dem)
            patch = dem.patch(site.lat_deg, site.lon_deg, b.outer_radius_m + 3.0 * max(res, 1.0))
            if patches is not None:
                patches[key] = patch
        lo = max(inner, near_exclusion_m)
        if lo >= b.outer_radius_m:
            inner = b.outer_radius_m
            continue
        with warnings.catch_warnings():
            # coverage warnings refer to the band radius; real coverage problems show up as
            # missing bins, which are checked below
            warnings.simplefilter("ignore", RuntimeWarning)
            if method == "raymarch":
                m = horizon_raymarch(patch, site_h, observer_height_m, az_step_deg,
                                     b.outer_radius_m / 1000.0,
                                     min_distance_m=lo if lo > 0 else None,
                                     step_growth_km=1.0e6, dem_source=patch.source)
            else:
                m = horizon_bruteforce(patch, site_h, observer_height_m, az_step_deg,
                                       b.outer_radius_m / 1000.0, min_distance_m=lo,
                                       dem_source=patch.source)
        if np.any(m.meta["missing_bins"]):
            raise RuntimeError(f"{method} band {b.product} for {site.id}: "
                               f"{int(np.sum(m.meta['missing_bins']))} azimuth bins without data")
        if m.meta["min_effective_radius_km"] < 0.97 * b.outer_radius_m / 1000.0 - 3 * patch.resolution_m / 1000:
            raise RuntimeError(f"{method} band {b.product} for {site.id}: DEM covers only "
                               f"{m.meta['min_effective_radius_km']:.2f} km of "
                               f"{b.outer_radius_m / 1000:.1f} km")
        masks.append(m)
        inner = b.outer_radius_m
    src = "+".join(f"{b.product}<{b.outer_radius_m / 1000:g}km" for b in bands)
    return combine_masks(masks, method, "pgda-bands:" + src)


# ================================================================================================
# Ephemeris: SPICE vectors from the Moon centre (method B, vectorised over sites)
# ================================================================================================
def make_times(start_utc: str, days: float, step_hours: float) -> np.ndarray:
    """Uniform UTC grid [start, start + days) with ``step_hours`` spacing, datetime64[s]."""
    step_s = int(round(step_hours * 3600))
    n = int(math.floor(days * 86400 / step_s))
    return np.datetime64(start_utc, "s") + np.arange(n) * np.timedelta64(step_s, "s")


@dataclass
class MoonCentreEphemeris:
    """Apparent (LT+S) Sun and Earth vectors (km) from the Moon centre in MOON_ME, per time."""

    times_utc: np.ndarray
    sun_km: np.ndarray    # (n, 3)
    earth_km: np.ndarray  # (n, 3)
    meta: dict

    @classmethod
    def compute(cls, times_utc: np.ndarray, lunar_set: str = "de440",
                cache: bool = True) -> "MoonCentreEphemeris":
        """SPICE ``spkpos(target, et, 'MOON_ME', 'LT+S', 'MOON')``; cached as .npz in
        data/cache/validate_terrain/ (keyed by the time grid and kernel set)."""
        import spiceypy as sp

        from .ephem import kernels
        from .ephem.kernels import SPICE_LOCK
        from .ephem.spice import utc_to_et

        t = np.asarray(times_utc).astype("datetime64[s]")
        from .terrain.common import cache_key

        key = cache_key("mce", lunar_set, str(t[0]), str(t[-1]), t.size,
                        int(np.sum((t - t[0]).astype(np.int64) % 104729)))
        f = config.cache_dir("validate_terrain") / f"ephem_{key}.npz"
        if cache and f.exists():
            with np.load(f) as d:
                if d["t"].shape == t.shape and np.all(d["t"] == t.astype(np.int64)):
                    return cls(t, d["sun"], d["earth"], {"source": "cache", "lunar_set": lunar_set,
                                                         "frame": "MOON_ME", "abcorr": "LT+S"})
        t0 = time.perf_counter()
        with SPICE_LOCK:
            paths = kernels.load_kernels(lunar_set)
            et = utc_to_et(t)
            sun, _ = sp.spkpos("SUN", et, "MOON_ME", "LT+S", "MOON")
            earth, _ = sp.spkpos("EARTH", et, "MOON_ME", "LT+S", "MOON")
        sun = np.asarray(sun, float).reshape(-1, 3)
        earth = np.asarray(earth, float).reshape(-1, 3)
        if cache:
            buf = io.BytesIO()
            np.savez_compressed(buf, t=t.astype(np.int64), sun=sun, earth=earth)
            from .terrain.common import atomic_write_bytes

            atomic_write_bytes(f, buf.getvalue())
        return cls(t, sun, earth, {"source": "spice", "kernels": [p.name for p in paths],
                                   "lunar_set": lunar_set, "frame": "MOON_ME", "abcorr": "LT+S",
                                   "elapsed_s": time.perf_counter() - t0})

    def series(self, site: Site, height_above_sphere_m: float) -> EphemerisSeries:
        """Topocentric az/el/dist for the observer at (lat, lon, R + height) - types.py conventions.

        Azimuth origin at an exact pole: meridian ``site.lon_deg`` (same as horizon.enu_basis)."""
        E, N, U = enu_basis(site.lat_deg, site.lon_deg)
        pos = (config.MOON_RADIUS_KM + height_above_sphere_m / 1000.0) * U
        out = {}
        for name, vec in (("sun", self.sun_km), ("earth", self.earth_km)):
            v = vec - pos[None, :]
            d = np.linalg.norm(v, axis=1)
            out[name + "_az"] = np.mod(np.degrees(np.arctan2(v @ E, v @ N)), 360.0)
            out[name + "_el"] = np.degrees(np.arcsin(np.clip((v @ U) / d, -1.0, 1.0)))
            out[name + "_d"] = d
        return EphemerisSeries(site_id=site.id, method="spice-moon-centre", times_utc=self.times_utc,
                               sun_az_deg=out["sun_az"], sun_el_deg=out["sun_el"],
                               sun_dist_km=out["sun_d"], earth_az_deg=out["earth_az"],
                               earth_el_deg=out["earth_el"], earth_dist_km=out["earth_d"],
                               observer_height_m=float(height_above_sphere_m), meta=dict(self.meta))


def check_vector_ephemeris(site: Site, times_utc: np.ndarray, height_above_sphere_m: float = 1000.0
                           ) -> dict:
    """Max |difference| (deg, km) between :class:`MoonCentreEphemeris` and ``SpiceProvider``."""
    from .ephem.spice import SpiceProvider

    mce = MoonCentreEphemeris.compute(times_utc, cache=False)
    a = mce.series(site, height_above_sphere_m)
    b = SpiceProvider().compute(site, times_utc, height_above_sphere_m)
    out = {}
    for body in ("sun", "earth"):
        daz = (getattr(a, f"{body}_az_deg") - getattr(b, f"{body}_az_deg") + 180.0) % 360.0 - 180.0
        out[f"{body}_az_on_sky_deg"] = float(np.max(np.abs(daz * np.cos(np.radians(getattr(b, f"{body}_el_deg"))))))
        out[f"{body}_el_deg"] = float(np.max(np.abs(getattr(a, f"{body}_el_deg") - getattr(b, f"{body}_el_deg"))))
        out[f"{body}_dist_km"] = float(np.max(np.abs(getattr(a, f"{body}_dist_km") - getattr(b, f"{body}_dist_km"))))
    return out


# ================================================================================================
# Illumination metrics
# ================================================================================================
def longest_run(flags: np.ndarray) -> int:
    """Length (samples) of the longest run of True."""
    f = np.asarray(flags, bool)
    if not f.any():
        return 0
    d = np.diff(np.concatenate([[0], f.astype(np.int8), [0]]))
    return int(np.max(np.nonzero(d == -1)[0] - np.nonzero(d == 1)[0]))


def illumination_metrics(vis: VisibilitySeries) -> dict:
    """Time-averaged percentages from a visibility series (uniform time steps assumed).

    avg_illum_pct  : mean visible fraction of the solar DISC (PGDA AVGVISIB / Mazarico "average
                     illumination" definition), %.
    sun_any_pct    : time with any part of the disc above the terrain (upper limb visible), %.
    earth_any_pct  : time with any part of the Earth disc visible (PGDA Earth-visibility definition).
    earth_center_pct: time with the Earth centre above the terrain horizon, %.
    longest_dark_h : longest continuous period with no part of the Sun visible, hours.
    """
    t = vis.times_utc.astype(np.int64)
    step_h = float(np.median(np.diff(t))) / 3600.0 if t.size > 1 else 0.0
    return {
        "avg_illum_pct": 100.0 * float(np.mean(vis.sun_fraction)),
        "sun_any_pct": 100.0 * float(np.mean(vis.sun_visible)),
        "earth_any_pct": 100.0 * float(np.mean(vis.earth_fraction > 0)),
        "earth_center_pct": 100.0 * float(np.mean(vis.earth_visible)),
        "longest_dark_h": longest_run(~vis.sun_visible) * step_h,
        "n_samples": int(t.size),
        "step_h": step_h,
    }


def site_illumination(site: Site, eph: MoonCentreEphemeris, bands: Sequence[TerrainBand] = BANDS_40M,
                      observer_height_m: float = 0.0, method: str = "raymarch",
                      get_dem: DemGetter = pgda_dem, mask: HorizonMask | None = None,
                      windows: Mapping[str, slice] | None = None, near_exclusion_m: float = 0.0
                      ) -> dict:
    """Illumination metrics of one site (optionally also on sub-periods ``windows``).

    near_exclusion_m: terrain closer than this is ignored (e.g. the 60 m pixel of a reference map,
    see docs/VALIDATION_TERRAIN.md: for a 0 m observer the facet the point sits on otherwise blocks
    half of the horizon)."""
    site_h = site_with_height(site, bands, get_dem)
    if mask is None:
        mask = banded_mask(site_h, bands, method, observer_height_m, get_dem=get_dem,
                           near_exclusion_m=near_exclusion_m)
    e = eph.series(site_h, float(site_h.height_m) + observer_height_m)
    vis = compute_visibility(e, mask, VisibilityOptions(observer_height_m=observer_height_m))
    out = illumination_metrics(vis)
    out.update({"site_id": site.id, "lat_deg": site.lat_deg, "lon_deg": site.lon_deg,
                "surface_height_m": float(site_h.height_m), "observer_height_m": observer_height_m,
                "near_exclusion_m": near_exclusion_m,
                "horizon_max_deg": float(np.max(mask.el_deg)),
                "horizon_mean_deg": float(np.mean(mask.el_deg))})
    if windows:
        out["windows"] = {k: illumination_metrics(vis.slice(sl)) for k, sl in windows.items()}
    return out


# ================================================================================================
# NASA validation rasters (PGDA product 69) around the pole
# ================================================================================================
@dataclass
class ValidationRaster:
    """Window of a PGDA validation raster: ``values[i, j]`` at (x_m[j], y_m[i]), north-up rows
    (y decreasing), scaled values (fraction 0..1 for AVGVISIB, 0/1 for LPSR), NaN = nodata."""

    product: str
    values: np.ndarray
    x_m: np.ndarray
    y_m: np.ndarray
    res_m: float


def read_validation_window(product: str, half_size_m: float) -> ValidationRaster:
    """Read (once; cached as .npz under data/cache/validate_terrain/) the square window
    [-half, half]^2 (polar stereographic m, centred on the south pole) of a PGDA validation raster."""
    import rasterio
    from rasterio.windows import Window

    from .terrain.common import RasterGrid, atomic_write_bytes, verify_ps_crs
    from .terrain.pgda import GDAL_REMOTE_ENV, PGDA_VALIDATION_PRODUCTS

    p = PGDA_VALIDATION_PRODUCTS[product]
    f = config.cache_dir("validate_terrain") / f"{product}_{int(half_size_m)}.npz"
    if f.exists():
        with np.load(f) as d:
            return ValidationRaster(product, d["v"], d["x"], d["y"], float(d["res"]))
    with rasterio.Env(**GDAL_REMOTE_ENV), rasterio.open("/vsicurl/" + p.url) as ds:
        verify_ps_crs(ds.crs.to_wkt(), "south")
        sc, of = float(ds.scales[0] or 1.0), float(ds.offsets[0] or 0.0)
        if abs(sc - p.scale) > 1e-12 or abs(of - p.offset) > 1e-12:
            raise ValueError(f"{product}: scale/offset {sc}/{of} != registry {p.scale}/{p.offset}")
        g = RasterGrid.from_transform(ds.transform, ds.width, ds.height, "south")
        r0, c0, nr, nc = g.window_for_box(-half_size_m, half_size_m, -half_size_m, half_size_m)
        if r0 < 0 or c0 < 0 or r0 + nr > g.height or c0 + nc > g.width:
            raise ValueError(f"{product}: window +-{half_size_m} m exceeds the raster")
        raw = ds.read(1, window=Window(c0, r0, nc, nr)).astype(float)
        nd = ds.nodata
    v = raw * sc + of
    if nd is not None and np.isfinite(nd):
        v[raw == nd] = np.nan
    x = g.col_center(np.arange(c0, c0 + nc))
    y = g.row_center(np.arange(r0, r0 + nr))
    buf = io.BytesIO()
    np.savez_compressed(buf, v=v.astype(np.float32), x=x, y=y, res=g.res)
    atomic_write_bytes(f, buf.getvalue())
    return ValidationRaster(product, v.astype(np.float32), x, y, g.res)


def _window_reduce(a: np.ndarray, n: int, fn) -> np.ndarray:
    """fn (np.min / np.max) over the (2n+1)^2 neighbourhood; borders -> NaN."""
    out = np.full(a.shape, np.nan)
    H, W = a.shape
    stack = [a[n + di:H - n + di, n + dj:W - n + dj] for di in range(-n, n + 1) for dj in range(-n, n + 1)]
    out[n:H - n, n:W - n] = fn(np.stack(stack), axis=0)
    return out


def _pick_spread(cand: np.ndarray, x: np.ndarray, y: np.ndarray, n: int, min_sep_m: float,
                 rng: np.random.Generator, already: Sequence[tuple[int, int]] = ()
                 ) -> list[tuple[int, int]]:
    """Up to n candidate pixels (row, col), random order, at least ``min_sep_m`` apart (also from
    the pixels in ``already``)."""
    rr, cc = np.nonzero(cand)
    order = rng.permutation(rr.size)
    chosen: list[tuple[int, int]] = []
    pts: list[tuple[float, float]] = [(x[c], y[r]) for r, c in already]
    for k in order:
        px, py = x[cc[k]], y[rr[k]]
        if all(math.hypot(px - qx, py - qy) >= min_sep_m for qx, qy in pts):
            chosen.append((int(rr[k]), int(cc[k])))
            pts.append((px, py))
            if len(chosen) >= n:
                break
    return chosen


def select_psr_pixels(avg: ValidationRaster, psr: ValidationRaster, n: int = 30, seed: int = 1,
                      neighborhood: int = 2, min_sep_m: float = 1000.0,
                      max_radius_m: float | None = None) -> list[tuple[int, int]]:
    """Interior PSR pixels: LPSR = 1 AND AVGVISIB = 0 in the whole (2*neighborhood+1)^2 window
    (robust against the 60 m pixel / DEM-version mismatch at PSR edges)."""
    if avg.values.shape != psr.values.shape:
        raise ValueError("rasters must share the window")
    ok = (_window_reduce(np.nan_to_num(psr.values, nan=0.0), neighborhood, np.min) >= 0.999) & \
         (_window_reduce(np.nan_to_num(avg.values, nan=1.0), neighborhood, np.max) <= 0.0)
    if max_radius_m is not None:
        ok &= np.hypot(*np.meshgrid(avg.x_m, avg.y_m)) <= max_radius_m
    return _pick_spread(ok, avg.x_m, avg.y_m, n, min_sep_m, np.random.default_rng(seed))


def select_lit_pixels(avg: ValidationRaster, n: int = 30, seed: int = 2, min_center: float = 0.6,
                      min_nbhd: float = 0.5, max_nbhd_range: float = 0.15, min_sep_m: float = 1000.0,
                      max_radius_m: float | None = None,
                      strata: Sequence[tuple[float, ...]] | None = None) -> list[tuple[int, int]]:
    """Well-lit pixels with a smooth 3x3 neighbourhood (avoids the isolated artefact pixels and the
    steepest gradients, where a 60 m pixel average and a point value legitimately differ).

    Without ``strata``: AVGVISIB >= ``min_center``, 3x3 min >= ``min_nbhd``, 3x3 max - min <=
    ``max_nbhd_range``.  With ``strata`` = [(lo, hi, min3x3, max_range3x3), ...]: ``n`` is split
    evenly over the AVGVISIB ranges [lo, hi) (so the rare, best-lit crest pixels are represented,
    not only the ~50 % ones), each with its own 3x3 minimum / range limits (pixels >= 0.7 always sit
    on narrow crests next to much darker pixels, so only the artefact guard min3x3 is applied)."""
    v = np.nan_to_num(avg.values, nan=-1.0)
    lo3 = _window_reduce(v, 1, np.min)
    hi3 = _window_reduce(v, 1, np.max)
    inside = np.ones(v.shape, bool)
    if max_radius_m is not None:
        inside = np.hypot(*np.meshgrid(avg.x_m, avg.y_m)) <= max_radius_m
    rng = np.random.default_rng(seed)
    if not strata:
        ok = (v >= min_center) & (lo3 >= min_nbhd) & (hi3 - lo3 <= max_nbhd_range) & inside
        return _pick_spread(ok, avg.x_m, avg.y_m, n, min_sep_m, rng)
    chosen: list[tuple[int, int]] = []
    k = len(strata)
    for i, (a, b, mn, rg) in enumerate(strata):
        ni = n // k + (1 if i < n % k else 0)
        ok = (v >= a) & (v < b) & (lo3 >= mn) & (hi3 - lo3 <= rg) & inside
        chosen += _pick_spread(ok, avg.x_m, avg.y_m, ni, min_sep_m, rng, already=chosen)
    return chosen


def pixel_site(r: ValidationRaster, row: int, col: int, prefix: str) -> Site:
    """Site at the centre of raster pixel (row, col)."""
    from .terrain.common import ps_to_latlon

    lat, lon = ps_to_latlon(r.x_m[col], r.y_m[row], "south")
    return Site(id=f"{prefix}_{row}_{col}", name=f"{r.product} pixel ({row},{col})",
                lat_deg=float(lat), lon_deg=float(lon), group="validation",
                source=f"PGDA product 69 {r.product} pixel centre")


def _stats(d: np.ndarray) -> dict:
    d = np.asarray(d, float)
    ad = np.abs(d)
    return {"n": int(d.size), "mean": float(np.mean(d)), "median": float(np.median(d)),
            "std": float(np.std(d)), "mean_abs": float(np.mean(ad)), "p90_abs": float(np.percentile(ad, 90)),
            "max_abs": float(np.max(ad)), "rmse": float(np.sqrt(np.mean(d * d)))}


#: Pass/fail criteria for the illumination comparison (percentage points, pp).  Justification in
#: docs/VALIDATION_TERRAIN.md section 2: different LOLA DEM versions (2016 vs Barker 2023), our 40 m
#: point value vs a 60 m pixel average, different 18.6-yr period start and 1 h vs 6 h sampling.  The
#: literature itself spreads by 10+ pp at the same point (C1: Glaser 76.0 %, Mazarico 89.0 %).
ILLUM_CRITERIA = {
    "psr_max_pct": 1.0,          # every interior PSR pixel: < 1 % average illumination
    "psr_zero_fraction": 0.8,    # >= 80 % of them exactly 0
    "lit_median_abs_pp": 5.0,    # median |ours - PGDA| on well-lit pixels
    "lit_bias_pp": 5.0,          # |mean(ours - PGDA)|
    "lit_p90_abs_pp": 12.0,      # 90 % of the well-lit pixels within 12 pp
    "earth_mean_abs_pp": 10.0,   # Earth visibility (any part of disc), all sampled pixels
}


@dataclass(frozen=True)
class ObserverVariant:
    """How the observer / near field is modelled for a comparison with a reference map."""

    name: str
    observer_height_m: float
    near_exclusion_m: float
    note: str = ""


#: Observer definitions compared with the PGDA maps.  "pixel60" is the PRIMARY one, fixed BEFORE the
#: comparison: surface observer (0 m, as stated for Mazarico 2011 / Glaser 2018) and terrain inside
#: the 60 m reference pixel ignored (a 60 m map cannot represent sub-pixel terrain, and a point
#: exactly ON a tilted bilinear facet is otherwise shadowed by its own facet over half of the
#: horizon).  "excl120" was added AFTER seeing the results (post-hoc sensitivity, labelled as such
#: in docs/VALIDATION_TERRAIN.md): it shows which near-field treatment reproduces the PGDA map.
ILLUM_VARIANTS: tuple[ObserverVariant, ...] = (
    ObserverVariant("pixel60", 0.0, 60.0, "PRIMARY (a priori): 0 m observer, terrain < 60 m (1 reference px) ignored"),
    ObserverVariant("surface0", 0.0, 0.0, "0 m observer on the bilinear DEM surface, no exclusion"),
    ObserverVariant("mast2", 2.0, 0.0, "2 m mast (challenge default), no exclusion"),
    ObserverVariant("excl120", 0.0, 120.0, "POST-HOC: 0 m observer, terrain < 120 m (2 reference px) ignored"),
)


def _variant_stats(rows: list[dict], vname: str) -> dict:
    """PSR / lit / Earth statistics of one observer variant (pp = ours - PGDA)."""
    out: dict = {}
    psr_rows = [m for m in rows if m["kind"] == "psr"]
    lit_rows = [m for m in rows if m["kind"] == "lit"]
    if psr_rows:
        v = np.array([m["variants"][vname]["avg_illum_pct"] for m in psr_rows])
        out["psr"] = {"max_avg_illum_pct": float(v.max()), "mean_avg_illum_pct": float(v.mean()),
                      "zero_fraction": float(np.mean(v == 0.0)),
                      "max_sun_any_pct": float(max(m["variants"][vname]["sun_any_pct"] for m in psr_rows))}
        out["psr"]["pass"] = bool(v.max() < ILLUM_CRITERIA["psr_max_pct"]
                                  and np.mean(v == 0.0) >= ILLUM_CRITERIA["psr_zero_fraction"])
    if lit_rows:
        a = np.array([m["variants"][vname]["avg_illum_pct"] for m in lit_rows])
        b = np.array([m["pgda_avg_illum_pct"] for m in lit_rows])
        d = a - b
        st = _stats(d)
        st["median_abs"] = float(np.median(np.abs(d)))
        st["corr"] = float(np.corrcoef(a, b)[0, 1]) if a.size > 2 else float("nan")
        st["vs_sun_any"] = _stats(np.array([m["variants"][vname]["sun_any_pct"] for m in lit_rows]) - b)
        st["by_pgda_range"] = {}
        for lo, hi in ((50, 60), (60, 70), (70, 101)):
            k = (b >= lo) & (b < hi)
            if k.any():
                st["by_pgda_range"][f"{lo}-{min(hi, 100)}"] = _stats(d[k])
        st["pass"] = bool(st["median_abs"] <= ILLUM_CRITERIA["lit_median_abs_pp"]
                          and abs(st["mean"]) <= ILLUM_CRITERIA["lit_bias_pp"]
                          and st["p90_abs"] <= ILLUM_CRITERIA["lit_p90_abs_pp"])
        out["lit"] = st
    if rows:
        de = np.array([m["variants"][vname]["earth_any_pct"] - m["pgda_earth_pct"] for m in rows])
        out["earth"] = _stats(de)
        out["earth"]["pass"] = bool(out["earth"]["mean_abs"] <= ILLUM_CRITERIA["earth_mean_abs_pp"])
    return out


def site_variants(site: Site, eph: MoonCentreEphemeris, bands: Sequence[TerrainBand],
                  variants: Sequence[ObserverVariant] = ILLUM_VARIANTS,
                  windows: Mapping[str, slice] | None = None, get_dem: DemGetter = pgda_dem) -> dict:
    """{variant name: site_illumination(...)} sharing the DEM patches between variants."""
    s = site_with_height(site, bands, get_dem)
    patches: dict = {}
    res = {}
    for v in variants:
        m = banded_mask(s, bands, "raymarch", v.observer_height_m, get_dem=get_dem, patches=patches,
                        near_exclusion_m=v.near_exclusion_m)
        res[v.name] = site_illumination(s, eph, bands, v.observer_height_m, get_dem=get_dem, mask=m,
                                        windows=windows, near_exclusion_m=v.near_exclusion_m)
    return res


def illumination_validation(eph: MoonCentreEphemeris, n_psr: int = 30, n_lit: int = 30,
                            half_window_m: float = 45_000.0, bands: Sequence[TerrainBand] = BANDS_40M,
                            variants: Sequence[ObserverVariant] = ILLUM_VARIANTS,
                            catalog_points: bool = True,
                            windows: Mapping[str, slice] | None = None,
                            lit_selection: Mapping[str, float] | None = None) -> dict:
    """Our average illumination vs PGDA AVGVISIB / LPSR at sampled pixels and catalog points.

    Pixels: ``n_psr`` interior PSR pixels and ``n_lit`` well-lit pixels (AVGVISIB >= 0.5, split
    evenly over [0.5, 0.6), [0.6, 0.7), [0.7, 1], 3x3 guards, >= 300 m apart) within
    ``half_window_m`` - 2 km of the pole, fixed seeds.
    Every pixel / point is evaluated for every observer ``variant``; statistics per variant.
    """
    from . import sites as sites_mod

    t0 = time.perf_counter()
    avg = read_validation_window("AVGVISIB_85S_060M_201608", half_window_m)
    avg_e = read_validation_window("AVGVISIB_85S_060M_201608_EARTH", half_window_m)
    psr = read_validation_window("LPSR_85S_060M_201608", half_window_m)
    lim = half_window_m - 2000.0
    sel = {"strata": ((0.5, 0.6, 0.4, 0.25), (0.6, 0.7, 0.45, 0.3), (0.7, 1.01, 0.4, 1.0)),
           "min_sep_m": 300.0}
    sel.update(lit_selection or {})
    psr_px = select_psr_pixels(avg, psr, n_psr, max_radius_m=lim)
    lit_px = select_lit_pixels(avg, n_lit, max_radius_m=lim, **sel)
    rows = []
    for kind, pix in (("psr", psr_px), ("lit", lit_px)):
        for (r, c) in pix:
            s = pixel_site(avg, r, c, kind)
            rows.append({"kind": kind, "site_id": s.id, "lat_deg": s.lat_deg, "lon_deg": s.lon_deg,
                         "pgda_avg_illum_pct": 100.0 * float(avg.values[r, c]),
                         "pgda_earth_pct": 100.0 * float(avg_e.values[r, c]),
                         "pgda_psr": float(psr.values[r, c]),
                         "variants": site_variants(s, eph, bands, variants, windows)})
    res: dict = {"pixels": rows, "n_psr": len(psr_px), "n_lit": len(lit_px),
                 "variants": [dataclasses.asdict(v) for v in variants], "primary": variants[0].name,
                 "lit_selection": sel,
                 "bands": [dataclasses.asdict(b) for b in bands],
                 "period": [str(eph.times_utc[0]), str(eph.times_utc[-1])],
                 "criteria": dict(ILLUM_CRITERIA),
                 "stats": {v.name: _variant_stats(rows, v.name) for v in variants}}
    if windows:
        res["stats_windows"] = {}
        for wname in windows:
            sub = []
            for m in rows:
                mm = dict(m)
                mm["variants"] = {k: v["windows"][wname] for k, v in m["variants"].items()}
                sub.append(mm)
            res["stats_windows"][wname] = {v.name: _variant_stats(sub, v.name) for v in variants}
    if catalog_points:
        pts = []
        for s in sites_mod.load_catalog(group="reference"):
            ex = sites_mod.get_site_extra(s.id)
            if "reference_illumination_pct" not in ex:
                continue
            pts.append({"site_id": s.id, "lat_deg": s.lat_deg, "lon_deg": s.lon_deg,
                        "variants": site_variants(s, eph, bands, variants, None),
                        "references": ex.get("reference_illumination", []),
                        "reference_illumination_pct": ex["reference_illumination_pct"],
                        "pgda_at_point": ex.get("pgda_avg_illumination_at_point", {})})
        res["catalog_points"] = pts
    res["runtime_s"] = time.perf_counter() - t0
    return res


# ================================================================================================
# Task 1: raymarch vs bruteforce on real terrain
# ================================================================================================
def mask_method_comparison(sites: Sequence[Site], bands: Sequence[TerrainBand] = BANDS_20M,
                           observer_height_m: float = config.DEFAULT_OBSERVER_HEIGHT_M,
                           near_exclusion_m: float = 2000.0, get_dem: DemGetter = pgda_dem,
                           n_outliers: int = 3) -> list[dict]:
    """Raymarch vs bruteforce banded masks per site: full masks and with terrain closer than
    ``near_exclusion_m`` ignored; per-band statistics; top outliers with the horizon distance and the
    band that sets the horizon there (to explain them)."""
    out = []
    for site in sites:
        s = site_with_height(site, bands, get_dem)
        patches: dict = {}
        t0 = time.perf_counter()
        ray = banded_mask(s, bands, "raymarch", observer_height_m, get_dem=get_dem, patches=patches)
        t1 = time.perf_counter()
        bf = banded_mask(s, bands, "bruteforce", observer_height_m, get_dem=get_dem, patches=patches)
        t2 = time.perf_counter()
        ray_f = banded_mask(s, bands, "raymarch", observer_height_m, get_dem=get_dem,
                            patches=patches, near_exclusion_m=near_exclusion_m)
        bf_f = banded_mask(s, bands, "bruteforce", observer_height_m, get_dem=get_dem,
                           patches=patches, near_exclusion_m=near_exclusion_m)
        d = bf.el_deg - ray.el_deg
        idx = np.argsort(-np.abs(d))[:n_outliers]
        outl = [{"az_deg": float(ray.az_deg[i]), "bruteforce_minus_raymarch_deg": float(d[i]),
                 "raymarch_el_deg": float(ray.el_deg[i]),
                 "horizon_distance_km": float(ray.meta["horizon_distance_km"][i]),
                 "band": bands[int(ray.meta["band_of_max"][i])].product} for i in idx]
        per_band = []
        inner = 0.0
        for k, b in enumerate(bands):
            db = bf.meta["band_el_deg"][k] - ray.meta["band_el_deg"][k]
            # bins whose band maximum lies at the band's INNER edge (terrain falling away from the
            # site): there raymarch samples exactly at the edge, bruteforce only cell centres beyond
            # it, so the two differ by the cut-off itself, not by the algorithms
            res_b = _dem_res(get_dem(b.product))
            edge = (ray.meta["band_dist_km"][k] * 1000.0 < inner + 2.0 * res_b) if inner > 0 else                 np.zeros(db.shape, bool)
            row = {"product": b.product, "inner_km": inner / 1000, "outer_km": b.outer_radius_m / 1000,
                   "p95_abs_deg": float(np.percentile(np.abs(db), 95)),
                   "max_abs_deg": float(np.max(np.abs(db))), "mean_deg": float(np.mean(db)),
                   "frac_bins_max_at_inner_edge": float(np.mean(edge))}
            if np.any(~edge):
                row["p95_abs_deg_not_edge"] = float(np.percentile(np.abs(db[~edge]), 95))
                row["mean_deg_not_edge"] = float(np.mean(db[~edge]))
            per_band.append(row)
            inner = b.outer_radius_m
        out.append({
            "site_id": site.id, "lat_deg": site.lat_deg, "lon_deg": site.lon_deg,
            "surface_height_m": float(s.height_m), "observer_height_m": observer_height_m,
            "full": compare_masks(bf, ray),
            "beyond_near_exclusion": compare_masks(bf_f, ray_f),
            "near_exclusion_m": near_exclusion_m,
            "per_band": per_band, "outliers": outl,
            "horizon_raymarch_max_deg": float(ray.el_deg.max()),
            "horizon_raymarch_min_deg": float(ray.el_deg.min()),
            "frac_bins_set_by_band": [float(np.mean(ray.meta["band_of_max"] == k)) for k in range(len(bands))],
            "runtime_raymarch_s": t1 - t0, "runtime_bruteforce_s": t2 - t1,
            "_masks": {"raymarch": ray, "bruteforce": bf},
        })
    return out


# ================================================================================================
# Task 3: Moon Trek vs PGDA
# ================================================================================================
def trek_header_check(n_points: int = 300) -> dict:
    """Trek full-file header facts (first 4/12 MB only, cached) + raw values vs PGDA heights.

    For each Trek product: dtype, CRS (geographic on the 1737.4 km sphere), scale/offset tags, and
    the least-squares ratio PGDA_height / raw on ``n_points`` valid pixels of the first tile row
    (expected 0.5 for the Int16 products = half-metres, 1.0 for the Float32 product = metres).
    """
    import pyproj

    from .terrain.pgda import PgdaDem
    from .terrain.trek import TREK_PRODUCTS, probe_remote_header, read_head_window

    out = {}
    cases = {
        # label: (head bytes, col0, ncols, PGDA product) - windows whose PGDA blocks are small to read
        "LRO_LOLA_DEM_SPole875_5mp_v04_EQ": (12 * 1024 * 1024, 281 * 128, 36 * 128, "LDEM_75S_30MPP_ADJ"),
        "LRO_LOLA_DEM_SPole75_30mp_v04_EQ": (4 * 1024 * 1024, 15385, 2000, "LDEM_60S_120MPP_ADJ"),
    }
    for label, (nb, col0, ncols, ref_prod) in cases.items():
        p = TREK_PRODUCTS[label]
        hdr = probe_remote_header(label, nbytes=4 * 1024 * 1024)
        crs = pyproj.CRS.from_wkt(hdr.crs_wkt)
        ell = crs.ellipsoid
        raw = read_head_window(label, 0, col0, 128, ncols, nbytes=nb).astype(float)
        valid = (raw != np.float64(np.float32(p.nodata))) & np.isfinite(raw)
        rr, cc = np.nonzero(valid)
        if rr.size < n_points:
            raise RuntimeError(f"{label}: only {rr.size} valid pixels in the head window")
        sel = np.linspace(0, rr.size - 1, n_points).astype(int)
        rr, cc = rr[sel], cc[sel]
        lat = p.top_lat_deg - (rr + 0.5) * p.pixel_deg
        lon = p.left_lon_deg + (col0 + cc + 0.5) * p.pixel_deg
        ref = PgdaDem(ref_prod).height_at(lat, lon)
        x = raw[rr, cc]
        ok = np.isfinite(ref)
        slope = float(np.sum(ref[ok] * x[ok]) / np.sum(x[ok] ** 2))
        resid = ref[ok] - p.scale_to_m * x[ok]
        out[label] = {
            "dtype": hdr.dtype, "registry_dtype": p.dtype, "is_geographic": bool(crs.is_geographic),
            "semi_major_m": float(ell.semi_major_metre), "inv_flattening": float(ell.inverse_flattening),
            "scales": list(hdr.scales), "offsets": list(hdr.offsets), "nodata": hdr.nodata,
            "pixel_deg": float(hdr.transform[0]), "registry_pixel_deg": p.pixel_deg,
            "n_points": int(ok.sum()), "pgda_product": ref_prod,
            "ratio_pgda_over_raw_lsq": slope, "assumed_scale_to_m": p.scale_to_m,
            "resid_median_m": float(np.median(resid)), "resid_std_m": float(np.std(resid)),
            "pass": bool(abs(slope - p.scale_to_m) < 0.01 * p.scale_to_m and abs(np.median(resid)) < 5.0
                         and hdr.dtype == p.dtype and crs.is_geographic
                         and abs(ell.semi_major_metre - R_M) < 1e-3),
        }
    return out


def compare_dem_sources(dem_a, dem_b, site: Site, radius_m: float = 10_000.0, *,
                        observer_height_m: float = config.DEFAULT_OBSERVER_HEIGHT_M,
                        az_step_deg: float = config.DEFAULT_AZ_STEP_DEG, n_rings: int = 40,
                        n_az: int = 180, eph: MoonCentreEphemeris | None = None,
                        near_exclusion_m: float = 0.0, far_exclusion_m: float = 1000.0) -> dict:
    """Height and horizon-mask differences of two DemSources (``a - b``) around a site.

    Heights: ``height_at`` on a polar grid of ``n_rings`` x ``n_az`` points out to ``radius_m``.
    Masks: raymarch on each source's own ``patch`` (single band, radius ``radius_m``), the SAME
    observer point (surface height from ``dem_b``) so only the terrain differs; ``mask_diff_deg``
    uses terrain beyond ``near_exclusion_m``, ``mask_diff_beyond_deg`` only terrain beyond
    ``far_exclusion_m`` (separates the near field, where metre-level DEM differences next to the mast
    change the horizon by degrees, from the distant horizon).  If ``eph`` is given
    also the average illumination % on both.  Works with any DemSource (TrekDem / TrekImageServerDem /
    PgdaDem / synthetic); used on Colab with the full Trek files.
    """
    from .terrain.common import latlon_to_ps, ps_to_latlon

    hemi = "south" if site.lat_deg < 0 else "north"
    xs, ys = latlon_to_ps(site.lat_deg, site.lon_deg, hemi)
    rad = np.linspace(radius_m / n_rings, radius_m, n_rings)
    ang = np.linspace(0, 2 * np.pi, n_az, endpoint=False)
    X = float(xs) + rad[:, None] * np.sin(ang)[None, :]
    Y = float(ys) + rad[:, None] * np.cos(ang)[None, :]
    lat, lon = ps_to_latlon(X, Y, hemi)
    ha = np.asarray(dem_a.height_at(lat, lon), float)
    hb = np.asarray(dem_b.height_at(lat, lon), float)
    ok = np.isfinite(ha) & np.isfinite(hb)
    if ok.sum() < 10:
        raise ValueError("fewer than 10 common valid points")
    dh = (ha - hb)[ok]
    h0 = float(np.asarray(dem_b.height_at(site.lat_deg, site.lon_deg)).reshape(-1)[0])
    if not np.isfinite(h0):
        raise ValueError(f"no height at site in {getattr(dem_b, 'name', 'dem_b')}")
    s = dataclasses.replace(site, height_m=h0)
    masks = []
    masks_far = []
    for dem in (dem_a, dem_b):
        res = _dem_res(dem)
        p = dem.patch(site.lat_deg, site.lon_deg, radius_m + 3 * res)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            masks.append(horizon_raymarch(p, s, observer_height_m, az_step_deg, radius_m / 1000.0,
                                          min_distance_m=near_exclusion_m or None,
                                          step_growth_km=1.0e6, dem_source=p.source))
            if 0 < far_exclusion_m < radius_m:
                masks_far.append(horizon_raymarch(p, s, observer_height_m, az_step_deg,
                                                  radius_m / 1000.0, min_distance_m=far_exclusion_m,
                                                  step_growth_km=1.0e6, dem_source=p.source))
    out = {
        "site_id": site.id, "radius_m": radius_m,
        "dem_a": getattr(dem_a, "name", "a"), "dem_b": getattr(dem_b, "name", "b"),
        "height_diff_m": {**_stats(dh), "p99_abs": float(np.percentile(np.abs(dh), 99)),
                          "n_valid_fraction": float(ok.mean())},
        "site_height_a_m": float(np.asarray(dem_a.height_at(site.lat_deg, site.lon_deg)).reshape(-1)[0]),
        "site_height_b_m": h0,
        "observer_height_m": observer_height_m,
        "near_exclusion_m": near_exclusion_m,
        "mask_diff_deg": compare_masks(masks[0], masks[1]),
        "_masks": masks,
    }
    if masks_far:
        out["far_exclusion_m"] = far_exclusion_m
        out["mask_diff_beyond_deg"] = compare_masks(masks_far[0], masks_far[1])
    if eph is not None:
        ill = []
        for m in masks:
            e = eph.series(s, h0 + observer_height_m)
            ill.append(illumination_metrics(compute_visibility(e, m)))
        out["avg_illum_pct_a"] = ill[0]["avg_illum_pct"]
        out["avg_illum_pct_b"] = ill[1]["avg_illum_pct"]
        out["earth_any_pct_a"] = ill[0]["earth_any_pct"]
        out["earth_any_pct_b"] = ill[1]["earth_any_pct"]
    return out


class SyntheticDem:
    """DemSource from an analytic height function h(x_m, y_m) in south polar stereographic metres
    (for tests and Colab dry runs).  ``patch`` rasterises at ``res_m`` (pixel centres on multiples of
    res_m + res_m/2, like the LOLA grids); ``height_at`` evaluates the function exactly."""

    def __init__(self, fn: Callable[[np.ndarray, np.ndarray], np.ndarray], res_m: float, name: str = "synthetic"):
        self.fn = fn
        self.res_m = float(res_m)
        self.name = name

    def height_at(self, lat_deg, lon_deg) -> np.ndarray:
        from .terrain.common import latlon_to_ps

        x, y = latlon_to_ps(lat_deg, lon_deg, "south")
        return np.asarray(self.fn(np.asarray(x, float), np.asarray(y, float)), float)

    def patch(self, lat_deg: float, lon_deg: float, half_size_m: float) -> DemPatch:
        from .terrain.common import latlon_to_ps

        xc, yc = latlon_to_ps(lat_deg, lon_deg, "south")
        r = self.res_m
        x = (np.arange(math.floor((float(xc) - half_size_m) / r), math.ceil((float(xc) + half_size_m) / r)) + 0.5) * r
        y = (np.arange(math.floor((float(yc) - half_size_m) / r), math.ceil((float(yc) + half_size_m) / r)) + 0.5) * r
        return rasterize_height_function(self.fn, x, y, source=self.name, crs_wkt=moon_polar_stereo_wkt())


# ================================================================================================
# Task 4: sensitivity
# ================================================================================================
def sensitivity_mast(site: Site, eph: MoonCentreEphemeris | None, heights_m: Sequence[float] = (2.0, 10.0),
                     bands: Sequence[TerrainBand] = BANDS_20M, get_dem: DemGetter = pgda_dem) -> dict:
    """Horizon masks / illumination at several mast heights (same site surface point).

    Physical expectation: raising the observer lowers every terrain elevation angle
    (el = atan2(h_terrain - h_obs - curvature, dist) decreases with h_obs at fixed samples), so the
    mask must be lower or equal in EVERY bin, and the illumination higher or equal.
    """
    s = site_with_height(site, bands, get_dem)
    patches: dict = {}
    masks = [banded_mask(s, bands, "raymarch", h, get_dem=get_dem, patches=patches) for h in heights_m]
    res: dict = {"site_id": site.id, "heights_m": list(heights_m), "per_height": []}
    for h, m in zip(heights_m, masks):
        row = {"observer_height_m": h, "horizon_mean_deg": float(np.mean(m.el_deg)),
               "horizon_max_deg": float(np.max(m.el_deg))}
        if eph is not None:
            row.update(illumination_metrics(compute_visibility(eph.series(s, s.height_m + h), m)))
        res["per_height"].append(row)
    drops = [masks[i].el_deg - masks[i + 1].el_deg for i in range(len(masks) - 1)]
    res["min_drop_deg"] = float(min(np.min(d) for d in drops)) if drops else 0.0
    res["max_drop_deg"] = float(max(np.max(d) for d in drops)) if drops else 0.0
    res["mean_drop_deg"] = float(np.mean(drops[0])) if drops else 0.0
    res["monotone"] = bool(all(np.all(d >= -1e-9) for d in drops))
    if eph is not None:
        ill = [r["avg_illum_pct"] for r in res["per_height"]]
        res["illum_monotone"] = bool(all(b >= a - 1e-9 for a, b in zip(ill, ill[1:])))
    return res


def offset_site(site: Site, dist_m: float, bearing_deg: float, idx: str = "") -> Site:
    """Site moved by ``dist_m`` along local azimuth ``bearing_deg`` (great circle, 1737.4 km sphere)."""
    E, N, U = enu_basis(site.lat_deg, site.lon_deg)
    a = math.radians(bearing_deg)
    th = dist_m / R_M
    d = math.cos(a) * N + math.sin(a) * E
    v = math.cos(th) * U + math.sin(th) * d
    lat = math.degrees(math.atan2(v[2], math.hypot(v[0], v[1])))
    lon = math.degrees(math.atan2(v[1], v[0])) % 360.0
    return Site(id=f"{site.id}_off{int(dist_m)}m_{int(bearing_deg)}{idx}", name=f"{site.name} +{dist_m:g} m",
                lat_deg=lat, lon_deg=lon, group="sensitivity", source=f"offset of {site.id}")


def sensitivity_offsets(site: Site, eph: MoonCentreEphemeris, distances_m: Sequence[float] = (100.0, 250.0, 500.0),
                        n_dirs: int = 8, bands: Sequence[TerrainBand] = BANDS_20M,
                        observer_height_m: float = config.DEFAULT_OBSERVER_HEIGHT_M,
                        get_dem: DemGetter = pgda_dem) -> dict:
    """Illumination / Earth visibility when the site is moved by each distance in ``n_dirs``
    directions (each moved site gets its own DEM surface height and horizon mask)."""
    base = site_illumination(site, eph, bands, observer_height_m, get_dem=get_dem)
    res: dict = {"site_id": site.id, "base": base, "observer_height_m": observer_height_m, "rings": []}
    for dist in distances_m:
        vals = []
        for k in range(n_dirs):
            s = offset_site(site, dist, 360.0 * k / n_dirs)
            m = site_illumination(s, eph, bands, observer_height_m, get_dem=get_dem)
            vals.append({"bearing_deg": 360.0 * k / n_dirs, "avg_illum_pct": m["avg_illum_pct"],
                         "earth_any_pct": m["earth_any_pct"], "longest_dark_h": m["longest_dark_h"],
                         "surface_height_m": m["surface_height_m"]})
        il = np.array([v["avg_illum_pct"] for v in vals])
        ea = np.array([v["earth_any_pct"] for v in vals])
        res["rings"].append({"distance_m": dist, "points": vals,
                             "illum_min_pct": float(il.min()), "illum_max_pct": float(il.max()),
                             "illum_max_abs_change_pp": float(np.max(np.abs(il - base["avg_illum_pct"]))),
                             "earth_min_pct": float(ea.min()), "earth_max_pct": float(ea.max()),
                             "earth_max_abs_change_pp": float(np.max(np.abs(ea - base["earth_any_pct"])))})
    return res


# ================================================================================================
# Orchestration
# ================================================================================================
def _strip_private(obj):
    if isinstance(obj, dict):
        return {k: _strip_private(v) for k, v in obj.items() if not str(k).startswith("_")}
    if isinstance(obj, (list, tuple)):
        return [_strip_private(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, (np.floating, np.integer, np.bool_)):
        return obj.item()
    return obj


def default_method_sites() -> list[Site]:
    """Task-1 sites: a ridge (Shackleton-de Gerlache ridge C1), a crater (Shackleton floor PSR) and
    an Artemis III region (de Gerlache Rim 2), all from the site catalog."""
    from .sites import get_site

    return [get_site("ref_connecting_ridge_c1"), get_site("psr_shackleton_floor"),
            get_site("a3_de_gerlache_rim_2")]


def run(quick: bool = False, out_path: str | Path | None = None) -> dict:
    """Run all terrain/horizon/visibility validations and return a JSON-serialisable report.

    quick=True: fewer pixels (8 + 8), 5-yr period, fewer offsets - for smoke tests (~minutes cold).
    Writes the report to ``out_path`` (default data/cache/validate_terrain/report[_quick].json).
    """
    from .sites import get_site

    t_start = time.perf_counter()
    rep: dict = {"generated_by": "lunarnav.validate_terrain.run", "quick": quick}
    start = "2026-01-01T00:00:00"
    days = 5 * 365.25 if quick else NODAL_CYCLE_DAYS
    times = make_times(start, days, 6.0)
    eph = MoonCentreEphemeris.compute(times)
    n5 = int(np.searchsorted(times, np.datetime64("2031-01-01T00:00:00")))
    windows = {"2026-2030": slice(0, n5)}
    rep["ephemeris"] = {"start": str(times[0]), "end": str(times[-1]), "n": int(times.size),
                        "step_h": 6.0, **{k: v for k, v in eph.meta.items() if k != "elapsed_s"}}
    # vector ephemeris vs SpiceProvider at one polar site, 2026 6-hourly
    chk_t = make_times(start, 30.0, 6.0)
    rep["ephemeris_check"] = check_vector_ephemeris(get_site("ref_connecting_ridge_c1"), chk_t)

    # 1. methods on real terrain
    msites = default_method_sites()
    mc = mask_method_comparison(msites)
    rep["method_comparison"] = mc

    # 4a. mast
    rep["sensitivity_mast"] = [sensitivity_mast(s, eph) for s in msites]

    # 2. illumination validation
    rep["illumination"] = illumination_validation(eph, n_psr=8 if quick else 30, n_lit=8 if quick else 30,
                                                  windows=windows)
    # resolution sensitivity of the illumination (20 m vs 40 m near field) at the task-1 sites
    rep["illum_resolution"] = []
    for s in msites:
        v20 = site_variants(s, eph, BANDS_20M)
        v40 = site_variants(s, eph, BANDS_40M)
        rep["illum_resolution"].append({
            "site_id": s.id,
            "avg_illum_pct_20m": {n: v20[n]["avg_illum_pct"] for n in v20},
            "avg_illum_pct_40m": {n: v40[n]["avg_illum_pct"] for n in v40},
            "earth_any_pct_20m": {n: v20[n]["earth_any_pct"] for n in v20},
            "earth_any_pct_40m": {n: v40[n]["earth_any_pct"] for n in v40}})
    # sampling step check (1 h vs 6 h over 2026-2027) at the ridge
    t1 = make_times(start, 2 * 365.25, 1.0)
    e1 = MoonCentreEphemeris.compute(t1)
    s = get_site("ref_connecting_ridge_c1")
    m20 = banded_mask(site_with_height(s, BANDS_40M), BANDS_40M, "raymarch", 0.0, near_exclusion_m=60.0)
    a1 = site_illumination(s, e1, BANDS_40M, 0.0, mask=m20)
    a6 = site_illumination(s, MoonCentreEphemeris(e1.times_utc[::6], e1.sun_km[::6], e1.earth_km[::6], e1.meta),
                           BANDS_40M, 0.0, mask=m20)
    rep["step_check"] = {"site_id": s.id, "avg_illum_pct_1h": a1["avg_illum_pct"],
                         "avg_illum_pct_6h": a6["avg_illum_pct"],
                         "earth_any_pct_1h": a1["earth_any_pct"], "earth_any_pct_6h": a6["earth_any_pct"]}

    # 3. Trek vs PGDA
    rep["trek_header"] = trek_header_check()
    from .terrain.pgda import PgdaDem
    from .terrain.trek import TrekImageServerDem

    trek30 = TrekImageServerDem("LRO_LOLA_DEM_SPole75_30mp_v04")
    pgda30 = PgdaDem("LDEM_75S_30MPP_ADJ")
    rep["trek_vs_pgda"] = [compare_dem_sources(trek30, pgda30, get_site(i), 10_000.0, eph=eph)
                           for i in ("ref_shackleton_rim", "ref_connecting_ridge_c1")]

    # 4b. offsets
    off_sites = [get_site("ref_connecting_ridge_c1"), get_site("ref_shackleton_rim"),
                 get_site("a3_de_gerlache_rim_2")]
    rep["sensitivity_offsets"] = [
        sensitivity_offsets(s, eph, distances_m=(100.0, 250.0, 500.0), n_dirs=4 if quick else 8)
        for s in off_sites]
    rep["runtime_s"] = time.perf_counter() - t_start
    clean = _strip_private(rep)
    path = Path(out_path) if out_path else config.cache_dir("validate_terrain") / (
        "report_quick.json" if quick else "report.json")
    path.write_text(json.dumps(clean, indent=1, sort_keys=True, allow_nan=True))
    clean["report_path"] = str(path)
    return clean


def main(argv: Iterable[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--out", default=None)
    a = ap.parse_args(list(argv) if argv is not None else None)
    logging.basicConfig(level=logging.INFO)
    rep = run(quick=a.quick, out_path=a.out)
    print(json.dumps({k: rep[k] for k in ("report_path", "runtime_s")}, indent=1))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
