"""Batch precomputation of Sun/Earth visibility for many sites, and its output checker.

Output directory (format: docs/OUTPUT_SPEC.md, format_version 1)::

    OUT/manifest.json                         run parameters, versions, data sources, checksums
    OUT/sites.json                            sites and per-site inputs actually used
    OUT/summary.csv                           one row per site: metrics + rank
    OUT/sites/<site_id>/horizon_<method>.csv  az_deg, el_deg, covered_radius_km
    OUT/sites/<site_id>/ephemeris_<provider>.csv.gz
    OUT/sites/<site_id>/visibility.csv.gz     every per-step column a UI needs
    OUT/sites/<site_id>/windows.json          Sun / Earth / both windows + metrics

The writer is deterministic: same inputs + same ``run_timestamp_utc`` -> byte-identical files
(fixed float formats, gzip mtime = 0, sorted JSON keys). ``check_output(dir)`` verifies every
invariant listed in docs/OUTPUT_SPEC.md and returns a list of violations ([] = correct output).

The heavy production run (Moon Trek DEMs of 1-2 GB, multi-year hourly ephemerides) is meant for
Google Colab (see docs/ARCHITECTURE.md); ``resume=True`` lets an interrupted Colab run continue
with the sites already finished.
"""
from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
import logging
import math
import re
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Iterable, Mapping, Sequence

import numpy as np

from . import __version__
from .analysis import AnalysisOptions, SiteAnalysis, analyse_site, make_times, rank_sites, resolve_mask
from .config import (
    DEFAULT_AZ_STEP_DEG,
    DEFAULT_HORIZON_RADIUS_KM,
    DEFAULT_OBSERVER_HEIGHT_M,
    MOON_RADIUS_KM,
)
from .types import EphemerisProvider, EphemerisSeries, HorizonMask, Site
from .visibility import (
    AU_KM,
    SOLAR_CONSTANT_WM2,
    VISIBILITY_COLUMNS,
    disc_visible_fraction,
    flat_horizon_mask,
    sun_semidiameter_deg,
)
from .windows import (
    clean_float,
    hours_until_state,
    iso_utc,
    parse_utc,
)

log = logging.getLogger(__name__)

FORMAT_NAME = "lunarnav-precompute"
FORMAT_VERSION = 1
#: Allowed site ids: file-name-safe characters plus ':' (canonical custom ids of
#: ``lunarnav.sites.custom_site``, e.g. ``custom:-89.4500:222.6900``).  The per-site directory is
#: :func:`site_dir_name` (':' -> '_'); directory names must be unique ignoring case, because
#: Windows / macOS file systems (where a Colab output is unzipped for the UI) are case-insensitive.
SITE_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")


def site_dir_name(site_id: str) -> str:
    """Directory name of a site under ``OUT/sites/``: the id with ':' replaced by '_'."""
    if not SITE_ID_RE.match(site_id):
        raise ValueError(f"site id {site_id!r} is not allowed (allowed: {SITE_ID_RE.pattern})")
    return site_id.replace(":", "_")

EPHEMERIS_COLUMNS = (
    "time_utc",
    "sun_az_deg",
    "sun_el_deg",
    "sun_dist_km",
    "earth_az_deg",
    "earth_el_deg",
    "earth_dist_km",
)
#: Extra per-step columns written after VISIBILITY_COLUMNS.
EXTRA_VIS_COLUMNS = (
    "hours_until_sunset",
    "hours_until_sunrise",
    "hours_until_earthset",
    "hours_until_earthrise",
)
VIS_FILE_COLUMNS = tuple(VISIBILITY_COLUMNS) + EXTRA_VIS_COLUMNS

SUMMARY_COLUMNS = (
    "rank",
    "site_id",
    "name",
    "group",
    "lat_deg",
    "lon_deg",
    "surface_height_m",
    "score",
    "pct_sun",
    "pct_earth",
    "pct_both",
    "pct_sun_no_earth",
    "longest_dark_h",
    "longest_dark_truncated",
    "longest_comms_gap_h",
    "longest_comms_gap_truncated",
    "longest_sun_h",
    "longest_earth_h",
    "n_sun_windows",
    "n_dark_windows",
    "n_earth_windows",
    "n_comms_gaps",
    "mean_sun_el_lit_deg",
    "mean_power_horizontal",
    "mean_power_tracking",
    "horizon_min_el_deg",
    "horizon_max_el_deg",
)

# Column formats. Angles 1e-6 deg (3.6 mas), distances 1 m, fractions 1e-6.
_FMT = {
    "sun_az_deg": "%.6f",
    "sun_el_deg": "%.6f",
    "sun_dist_km": "%.3f",
    "sun_semidiam_deg": "%.7f",
    "horizon_el_sun_deg": "%.6f",
    "sun_clearance_deg": "%.6f",
    "sun_fraction": "%.6f",
    "power_horizontal": "%.6f",
    "power_tracking": "%.6f",
    "irradiance_tracking_wm2": "%.3f",
    "earth_az_deg": "%.6f",
    "earth_el_deg": "%.6f",
    "earth_dist_km": "%.3f",
    "earth_semidiam_deg": "%.7f",
    "horizon_el_earth_deg": "%.6f",
    "earth_clearance_deg": "%.6f",
    "earth_fraction": "%.6f",
    "hours_until_sunset": "%.4f",
    "hours_until_sunrise": "%.4f",
    "hours_until_earthset": "%.4f",
    "hours_until_earthrise": "%.4f",
}
_BOOL_COLS = {"sun_visible", "earth_visible", "both_visible"}
_AZ_COLS = {"sun_az_deg", "earth_az_deg", "az_deg"}  # written wrapped to [0, 360)

CONVENTIONS = {
    "time": "UTC, ISO 8601 'YYYY-MM-DDTHH:MM:SSZ'; sample i represents [t_i, t_i + step)",
    "coordinates": "planetocentric latitude, EAST longitude [0,360), MOON_ME (Mean-Earth/Polar-Axis) frame",
    "heights": f"metres above the {MOON_RADIUS_KM} km reference sphere",
    "azimuth": "degrees [0,360) clockwise from local north (N=0, E=90), as JPL Horizons",
    "elevation": "degrees above the plane perpendicular to the local sphere radial, airless, apparent",
    "bodies": "Sun and Earth positions are for the body CENTER",
    "sun_visible": "upper limb above the terrain horizon (visible disc fraction > 0)",
    "earth_visible": "Earth center elevation - terrain horizon elevation > min_earth_clearance_deg",
    "windows": "maximal runs of equal state tiling [start, end); boundaries +- one step",
}

#: Data-source records for the known providers / DEM services (checksums added when known).
KNOWN_SOURCES = {
    "horizons": {"name": "JPL Horizons System API", "url": "https://ssd.jpl.nasa.gov/api/horizons.api"},
    "spice": {"name": "NAIF SPICE generic kernels", "url": "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/"},
    "analytic": {"name": "Analytic low-precision model (astropy + IAU rotation)", "url": None},
    "synthetic": {"name": "Synthetic toy geometry (tests only, NOT physical-grade)", "url": None},
    "trek": {"name": "NASA Moon Trek LOLA DEM", "url": "https://trek.nasa.gov/moon/"},
    "pgda": {"name": "NASA GSFC PGDA LOLA DEM", "url": "https://pgda.gsfc.nasa.gov/"},
}


# --------------------------------------------------------------------------------------------
# Synthetic provider (tests, demos, CI)
# --------------------------------------------------------------------------------------------
def _unit(lat_deg, lon_deg) -> np.ndarray:
    la, lo = np.radians(lat_deg), np.radians(lon_deg)
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], axis=-1)


def topocentric_az_el(site_lat_deg: float, site_lon_deg: float, r_obs_km: float, body_xyz_km: np.ndarray):
    """Topocentric (az, el, dist) of body positions (n,3) in the Moon body-fixed frame (km).

    az clockwise from north, el above the plane perpendicular to the sphere radial (degrees).
    """
    up = _unit(site_lat_deg, site_lon_deg)
    lo, la = np.radians(site_lon_deg), np.radians(site_lat_deg)
    east = np.array([-np.sin(lo), np.cos(lo), 0.0])
    north = np.array([-np.sin(la) * np.cos(lo), -np.sin(la) * np.sin(lo), np.cos(la)])
    v = body_xyz_km - r_obs_km * up
    d = np.linalg.norm(v, axis=-1)
    el = np.degrees(np.arcsin(np.clip(v @ up / d, -1, 1)))
    az = np.mod(np.degrees(np.arctan2(v @ east, v @ north)), 360.0)
    return az, el, d


class SyntheticProvider:
    """Deterministic toy Sun/Earth geometry with realistic amplitudes. For tests/demos ONLY.

    Sub-solar point: latitude 1.543*sin(2 pi t / 346.62 d) (lunar equator vs ecliptic), longitude
    decreasing 360 deg per synodic month (29.5306 d). Sub-Earth point (libration): latitude
    6.7*sin(2 pi t / 27.212 d), longitude 7.9*sin(2 pi t / 27.555 d). Distances: Sun 1 AU with
    annual (2.5e6 km) and monthly (3.84e5 km) terms, Earth 384 400 +- 21 000 km. No light time,
    aberration or physical libration. Accuracy vs reality: degrees - never use for science.
    """

    name = "synthetic"

    def __init__(self, epoch_utc: str = "2026-01-01T00:00:00", sun_lon0_deg: float = 0.0) -> None:
        self.epoch = parse_utc(epoch_utc)
        self.sun_lon0_deg = float(sun_lon0_deg)
        self.data_sources = [dict(KNOWN_SOURCES["synthetic"], sha256=None)]

    def body_vectors(self, times_utc: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """(sun_xyz, earth_xyz) in km, Moon body-fixed, shape (n, 3)."""
        t = (times_utc.astype("datetime64[s]") - self.epoch).astype(np.int64) / 86400.0
        tw = 2 * np.pi
        s_lat = 1.543 * np.sin(tw * t / 346.62)
        s_lon = self.sun_lon0_deg - 360.0 * t / 29.530589
        s_d = AU_KM + 2.5e6 * np.cos(tw * (t - 3.0) / 365.25) + 3.844e5 * np.cos(tw * t / 29.530589)
        e_lat = 6.7 * np.sin(tw * t / 27.212)
        e_lon = 7.9 * np.sin(tw * t / 27.555)
        e_d = 384_400.0 + 21_000.0 * np.cos(tw * t / 27.555)
        return _unit(s_lat, s_lon) * s_d[:, None], _unit(e_lat, e_lon) * e_d[:, None]

    def compute(self, site: Site, times_utc: np.ndarray, height_above_sphere_m: float) -> EphemerisSeries:
        times = np.asarray(times_utc).astype("datetime64[s]")
        sun, earth = self.body_vectors(times)
        r = MOON_RADIUS_KM + height_above_sphere_m / 1000.0
        saz, sel, sd = topocentric_az_el(site.lat_deg, site.lon_deg, r, sun)
        eaz, eel, ed = topocentric_az_el(site.lat_deg, site.lon_deg, r, earth)
        return EphemerisSeries(
            site_id=site.id,
            method="synthetic",
            times_utc=times,
            sun_az_deg=saz,
            sun_el_deg=sel,
            sun_dist_km=sd,
            earth_az_deg=eaz,
            earth_el_deg=eel,
            earth_dist_km=ed,
            observer_height_m=float(height_above_sphere_m),
            meta={"data_sources": self.data_sources},
        )


# --------------------------------------------------------------------------------------------
# Resolvers for other engineers' modules (lazy imports)
# --------------------------------------------------------------------------------------------
def _first_attr(mod, names: Sequence[str]):
    for n in names:
        if hasattr(mod, n):
            return getattr(mod, n)
    raise ImportError(f"{mod.__name__} provides none of {list(names)}")


def get_provider(name: str, **kwargs) -> EphemerisProvider:
    """Instantiate an ephemeris provider by name: horizons | spice | analytic | synthetic."""
    if name == "synthetic":
        return SyntheticProvider(**kwargs)
    table = {
        "horizons": ("lunarnav.ephem.horizons", "HorizonsProvider"),
        "spice": ("lunarnav.ephem.spice", "SpiceProvider"),
        "analytic": ("lunarnav.ephem.analytic", "AnalyticProvider"),
    }
    if name not in table:
        raise ValueError(f"unknown provider {name!r}; choose from {sorted(table) + ['synthetic']}")
    import importlib

    mod_name, cls_name = table[name]
    try:
        mod = importlib.import_module(mod_name)
    except ImportError as exc:  # pragma: no cover - depends on other modules being present
        raise ImportError(f"provider {name!r} needs module {mod_name}: {exc}") from exc
    return getattr(mod, cls_name)(**kwargs)


#: Moon Trek LOLA polar products (label, southern-most coverage limit in deg): finest first.
TREK_SOUTH_PRODUCTS = (
    ("LRO_LOLA_DEM_SPole875_5mp_v04_EQ", -87.5),
    ("LRO_LOLA_DEM_SPole75_30mp_v04_EQ", -75.0),
    ("LRO_LOLA_DEM_SPole45_100mp_v04_EQ", -45.0),
)
#: Distance (m) up to which the 5 m Trek product is used in the default nested DEM.
TREK_FINE_MAX_DISTANCE_M = 60_000.0


class DemCoverageError(ValueError):
    """The requested DEM cannot serve this site (outside the product, file not downloaded, nodata)."""


class DemFileMissingError(DemCoverageError):
    """The DEM product covers the site but its local file is not there (e.g. Moon Trek product not
    downloaded yet). Never replaced by ``dem_fallback='flat'``: that would hide a setup error."""


#: Default PGDA banded terrain (validate_terrain.BANDS_20M, validated in docs/VALIDATION_TERRAIN.md):
#: finest available product to 15 km, 120 m to 60 km, 240 m beyond.  The near-field product is the
#: first of PGDA_NEAR_PRODUCTS whose square covers the site +- the band radius.
PGDA_NEAR_PRODUCTS = ("LDEM_80S_20MPP_ADJ", "LDEM_75S_30MPP_ADJ", "LDEM_60S_60MPP_ADJ")
PGDA_BAND_LAYOUT = ((None, 15_000.0), ("LDEM_60S_120MPP_ADJ", 60_000.0), ("LDEM_60S_240MPP_ADJ", math.inf))


@dataclass(frozen=True)
class PgdaBands:
    """Default ``--dem pgda`` terrain of a site: distance bands of PGDA product-90 DEMs.

    ``layout`` = ((product, outer_radius_m), ...), fine first; the last band extends to the
    requested horizon radius.  The horizon is computed by ``validate_terrain.banded_mask`` (each
    band with its own DEM patch, combined by per-azimuth maximum), for raymarch AND bruteforce, so
    a 150 km bruteforce horizon needs ~3 small patches instead of one 15002 x 15002 px 20 m patch
    (which exceeds max_pixels).  ``height_at`` / ``patch`` (DemSource protocol) use the finest band.
    """

    site_xy_m: tuple[float, float]
    layout: tuple[tuple[str, float], ...]

    @property
    def name(self) -> str:
        return "bands[" + ",".join(f"{p}<{'R' if math.isinf(r) else f'{r / 1000:g}km'}" for p, r in self.layout) + "]"

    def bands(self, radius_m: float):
        """validate_terrain.TerrainBand tuple out to ``radius_m``; DemCoverageError if a product's
        square does not contain the site +- that band's radius."""
        from .terrain.pgda import PGDA_PRODUCTS
        from .validate_terrain import TerrainBand

        out = []
        for prod, outer in self.layout:
            r = min(outer, radius_m)
            meta = PGDA_PRODUCTS[prod]
            if not _pgda_covers(self.site_xy_m, r, meta):
                raise DemCoverageError(f"PGDA {prod} (nominal coverage {meta.min_lat_deg:g} to -90 deg) does "
                                       f"not contain the site +- {r / 1000:g} km")
            out.append(TerrainBand(prod, r))
            if r >= radius_m:
                break
        return tuple(out)

    def _dem(self):
        from .validate_terrain import pgda_dem

        return pgda_dem(self.layout[0][0])

    def height_at(self, lat_deg, lon_deg) -> np.ndarray:
        return self._dem().height_at(lat_deg, lon_deg)

    def patch(self, lat_deg: float, lon_deg: float, half_size_m: float):
        return self._dem().patch(lat_deg, lon_deg, half_size_m)


def _pgda_covers(site_xy_m: tuple[float, float], radius_m: float, product) -> bool:
    """True if the disc of arc radius ``radius_m`` around the site lies inside the product's
    nominal coverage: the polar cap |lat| >= product.min_lat_deg, i.e. the circle of grid radius
    half_extent_m inscribed in the raster square (outside it the corners may be nodata).

    Grid distance = arc distance x polar-stereographic scale k = 2 / (1 + sin|lat|) (k = 1 at the
    pole, 1.07 at 60S), evaluated at the far edge of the disc; + 3 pixels of interpolation margin.
    """
    rho = math.hypot(*site_xy_m)
    lat_site = 90.0 - math.degrees(2.0 * math.atan(rho / (2.0 * MOON_RADIUS_KM * 1000.0)))  # |lat|
    lat_far = max(lat_site - math.degrees(radius_m / (MOON_RADIUS_KM * 1000.0)), 0.0)
    k = 2.0 / (1.0 + math.sin(math.radians(lat_far)))
    return rho + k * radius_m + 3.0 * product.res_m <= product.half_extent_m


def pgda_bands_for_site(site: Site) -> PgdaBands:
    """Default PGDA band layout for a site (south polar products only; DemCoverageError otherwise)."""
    from .horizon import SOUTH_POLAR
    from .terrain.pgda import PGDA_PRODUCTS

    if site.lat_deg >= 0:
        raise DemCoverageError(f"PGDA product-90 DEMs cover the south polar region only (site lat {site.lat_deg})")
    x, y = SOUTH_POLAR.latlon_to_xy(site.lat_deg, site.lon_deg)
    xy = (float(np.asarray(x).reshape(-1)[0]), float(np.asarray(y).reshape(-1)[0]))
    near_r = PGDA_BAND_LAYOUT[0][1]
    near = next((pr for pr in PGDA_NEAR_PRODUCTS if _pgda_covers(xy, near_r, PGDA_PRODUCTS[pr])), None)
    if near is None:
        raise DemCoverageError(f"no PGDA product-90 DEM covers lat {site.lat_deg:.4f} lon {site.lon_deg:.4f} "
                               "(south polar products reach 60S)")
    layout = ((near, near_r),) + tuple(PGDA_BAND_LAYOUT[1:])
    return PgdaBands(xy, layout)


def get_dem(name: str, site: Site, label: str | None = None, path: str | None = None):
    """DemSource for a site: 'trek' (Moon Trek), 'pgda' (GSFC PGDA) or 'none' (-> None).

    * ``label`` / ``path`` given: ``TrekDem(label=, path=)`` or ``PgdaDem(product=, local_path=)``.
    * trek default: by latitude, from the local Moon Trek files in ``config.dem_dir()`` (download
      them first on Colab with ``lunarnav.terrain.trek.download_product``; never downloaded here):
      lat <= -87.5 -> NestedDem(5 m up to 60 km, 30 m beyond); <= -75 -> 30 m; <= -45 -> 100 m.
    * pgda default: :class:`PgdaBands` chosen by the site position (:func:`pgda_bands_for_site`):
      20 m (80S) / 30 m (75S) / 60 m (60S) to 15 km, 120 m to 60 km, 240 m beyond - remote COG
      blocks, cached.  FIX (review): the default used to be one 20 m product for every site, which
      returned NaN north of ~80S (chandrayaan3, 69.4S) and could not serve a 150 km bruteforce patch.
    Raises DemCoverageError when the site is outside every default product.
    """
    if name == "none":
        return None
    import importlib

    if name == "trek":
        mod = importlib.import_module("lunarnav.terrain.trek")
        if label or path:
            return mod.TrekDem(label=label, path=path)
        if site.lat_deg > TREK_SOUTH_PRODUCTS[-1][1]:
            raise DemCoverageError(f"no Moon Trek polar DEM product covers lat {site.lat_deg}; use --dem none, "
                                   "--dem-path or --dem-fallback flat")
        if site.lat_deg <= TREK_SOUTH_PRODUCTS[0][1]:
            from .terrain.common import NestedDem

            fine = mod.TrekDem(label=TREK_SOUTH_PRODUCTS[0][0])
            coarse = mod.TrekDem(label=TREK_SOUTH_PRODUCTS[1][0])
            return NestedDem([(fine, TREK_FINE_MAX_DISTANCE_M), (coarse, 1.0e7)], name="trek:nested_5m_30m")
        lab = next(lb for lb, lim in TREK_SOUTH_PRODUCTS if site.lat_deg <= lim)
        return mod.TrekDem(label=lab)
    if name == "pgda":
        if not (label or path):
            return pgda_bands_for_site(site)
        mod = importlib.import_module("lunarnav.terrain.pgda")
        kw = {}
        if label:
            kw["product"] = label
        if path:
            kw["local_path"] = path
        return mod.PgdaDem(**kw)
    raise ValueError(f"unknown dem {name!r}; choose trek | pgda | none")


def _dem_resolution_m(dem) -> float | None:
    """Finest pixel size (m) of a DemSource if it can be found (BlockGridDem.grid.res, NestedDem)."""
    for obj in (dem, *(lv[0] for lv in getattr(dem, "levels", ())[:1])):
        for attr in ("resolution_m", "patch_resolution_m"):
            if isinstance(getattr(obj, attr, None), (int, float)):
                return float(getattr(obj, attr))
        grid = getattr(obj, "grid", None)
        if grid is not None and isinstance(getattr(grid, "res", None), (int, float)):
            return float(grid.res)
    return None


def _dem_for_site(dem: str, site: Site, radius_km: float, label: str | None, path: str | None):
    """(DemSource, bands-or-None) for a site, or DemCoverageError naming why it cannot be served.

    Coverage = the DEM can be opened for this site (product chosen, local file present) and has a
    finite height at the site; for PgdaBands also every band's product contains its distance band.
    """
    try:
        src = get_dem(dem, site, label, path)
    except DemCoverageError:
        raise
    except FileNotFoundError as exc:
        raise DemFileMissingError(f"DEM file not available: {exc}") from exc
    bands = src.bands(radius_km * 1000.0) if isinstance(src, PgdaBands) else None
    if site.height_m is None:
        try:
            h = float(np.asarray(src.height_at(site.lat_deg, site.lon_deg), float).reshape(-1)[0])
        except (ValueError, IndexError) as exc:  # outside the raster
            raise DemCoverageError(f"no DEM height at the site: {exc}") from exc
        if not math.isfinite(h):
            raise DemCoverageError(f"DEM {getattr(src, 'name', dem)} has no valid height at "
                                   f"({site.lat_deg}, {site.lon_deg})")
    return src, bands


def dem_coverage_problems(sites: Iterable[Site], dem: str, radius_km: float = DEFAULT_HORIZON_RADIUS_KM,
                          label: str | None = None, path: str | None = None) -> dict[str, DemCoverageError]:
    """{site_id: error} for every site the DEM cannot serve ({} = all covered). Cheap pre-flight
    check (opens the DEM and reads one height per site); 'none' -> {}. A
    :class:`DemFileMissingError` means a product file must be downloaded first."""
    if dem == "none":
        return {}
    probs: dict[str, DemCoverageError] = {}
    for s in sites:
        try:
            _dem_for_site(dem, s, radius_km, label, path)
        except DemCoverageError as exc:
            probs[s.id] = exc
    return probs


def make_horizon_fn(
    dem: str = "none",
    method: str = "raymarch",
    radius_km: float = DEFAULT_HORIZON_RADIUS_KM,
    az_step_deg: float = DEFAULT_AZ_STEP_DEG,
    observer_height_m: float = DEFAULT_OBSERVER_HEIGHT_M,
    resolution_m: float | None = None,
    dem_label: str | None = None,
    dem_path: str | None = None,
    dem_fallback: str = "error",
) -> Callable[[Site], HorizonMask]:
    """Callable(site) -> HorizonMask. dem='none' or method='flat' -> smooth-sphere horizon.

    Terrain methods use ``lunarnav.horizon`` (lazy import):
      * default ``--dem pgda`` (:class:`PgdaBands`): ``validate_terrain.banded_mask`` with the
        site's band layout, method 'raymarch' or 'bruteforce' (both band-wise, exact max).
      * 'raymarch': terrain given as a height function h(x, y) built on ``DemSource.height_at``
        (works with NestedDem: fine DEM near the site, coarse far away, without allocating one
        huge grid); ``resolution_m`` = finest DEM pixel (auto-detected, or pass it).
      * 'bruteforce': terrain given as ``DemSource.patch(lat, lon, radius_km * 1000)``.
    ``dem_fallback``: 'error' -> a site outside the DEM coverage raises DemCoverageError;
    'flat' -> it gets the smooth-sphere mask (never for a missing DEM file: DemFileMissingError), with ``dem_source = 'none:outside-<dem>-coverage'``
    and the reason in ``meta['dem_fallback']`` (explicit, never silent).
    The DEM name (and url / sha256 attributes when the DemSource has them) is recorded in
    ``mask.meta['data_sources']`` for the manifest.
    """
    if dem_fallback not in ("error", "flat"):
        raise ValueError(f"dem_fallback must be 'error' or 'flat', got {dem_fallback!r}")
    if dem == "none" or method == "flat":
        def flat(site: Site) -> HorizonMask:
            return flat_horizon_mask(site.id, observer_height_m, site.height_m or 0.0, az_step_deg)

        return flat
    if method not in ("raymarch", "bruteforce"):
        raise ValueError(f"unknown horizon method {method!r}")

    def terrain(site: Site) -> HorizonMask:
        from . import horizon as hz  # lazy: owned by another module

        try:
            src, bands = _dem_for_site(dem, site, radius_km, dem_label, dem_path)
        except DemCoverageError as exc:
            if isinstance(exc, DemFileMissingError):
                raise DemFileMissingError(f"site {site.id}: {exc}") from exc
            if dem_fallback == "error":
                raise DemCoverageError(f"site {site.id}: {exc} (use --dem-fallback flat to give it a "
                                       "smooth-sphere horizon)") from exc
            m = flat_horizon_mask(site.id, observer_height_m, site.height_m or 0.0, az_step_deg)
            m.dem_source = f"none:outside-{dem}-coverage"
            m.meta = dict(m.meta, dem_fallback=str(exc))
            return m
        kw = dict(observer_height_m=observer_height_m, az_step_deg=az_step_deg, max_radius_km=radius_km,
                  dem_source=f"{dem}:{getattr(src, 'name', type(src).__name__)}")
        if bands is not None:
            from .validate_terrain import banded_mask

            mask = banded_mask(site, bands, method, observer_height_m, az_step_deg)
            mask.dem_source = kw["dem_source"]
            mask.radius_km = float(radius_km)
        elif method == "bruteforce":
            mask = hz.compute_horizon(src.patch(site.lat_deg, site.lon_deg, radius_km * 1000.0), site,
                                      method="bruteforce", **kw)
        else:
            res = resolution_m or _dem_resolution_m(src)
            if res is None:
                raise ValueError(f"cannot determine the DEM resolution of {dem!r}: pass resolution_m")
            proj = hz.SOUTH_POLAR if site.lat_deg < 0 else hz.NORTH_POLAR

            def height_fn(x_m: np.ndarray, y_m: np.ndarray) -> np.ndarray:
                lat, lon = proj.xy_to_latlon(x_m, y_m)
                return np.asarray(src.height_at(lat, lon), dtype=float)

            mask = hz.compute_horizon(height_fn, site, method="raymarch", projection=proj, resolution_m=res, **kw)
        rec = {"name": f"DEM {dem}: {getattr(src, 'name', type(src).__name__)}",
               "url": getattr(src, "url", None) or KNOWN_SOURCES[dem]["url"],
               "sha256": getattr(src, "sha256", None)}
        mask.meta = dict(mask.meta)
        mask.meta["data_sources"] = list(mask.meta.get("data_sources", [])) + [rec]
        return mask

    return terrain


# --------------------------------------------------------------------------------------------
# Deterministic writers
# --------------------------------------------------------------------------------------------
def _fmt_column(name: str, arr: np.ndarray) -> list[str]:
    if name == "time_utc":
        return [s + "Z" for s in np.datetime_as_string(arr.astype("datetime64[s]"), unit="s").tolist()]
    if name in _BOOL_COLS:
        return np.where(np.asarray(arr, bool), "1", "0").tolist()
    fmt = _FMT.get(name, "%.6f")
    nd = int(fmt[2:-1])
    a = np.asarray(arr, float)
    nan = np.isnan(a)
    # round first and add 0.0 so that tiny negatives never print as "-0.000000" (determinism)
    a = np.round(np.where(nan, 0.0, a), nd) + 0.0
    if name in _AZ_COLS:
        # FIX (review): azimuths in [360 - 0.5e-nd, 360) (or np.mod(-1e-13, 360)) rounded to "360.000000",
        # outside the spec range [0, 360). Wrap AFTER rounding; 360 -> 0.
        a = np.mod(a, 360.0) + 0.0
        a[a >= 360.0] = 0.0
    s = np.where(nan, "", np.char.mod(fmt, a))
    return s.tolist()


def _table_bytes(columns: Mapping[str, np.ndarray], order: Sequence[str]) -> bytes:
    cols = [_fmt_column(c, columns[c]) for c in order]
    lines = [",".join(order)] + [",".join(r) for r in zip(*cols)]
    return ("\n".join(lines) + "\n").encode("ascii")


def _write_bytes(path: Path, data: bytes, gz: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if gz:
        buf = io.BytesIO()
        with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0, compresslevel=6) as g:
            g.write(data)
        data = buf.getvalue()
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def _json_bytes(obj) -> bytes:
    return (json.dumps(obj, indent=1, sort_keys=True, ensure_ascii=True, allow_nan=False) + "\n").encode("ascii")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git_commit() -> str | None:
    """Current git commit of the package checkout, or None (no repo / no commits / no git)."""
    try:
        r = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=Path(__file__).resolve().parent,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    out = r.stdout.strip()
    return out if r.returncode == 0 and re.fullmatch(r"[0-9a-f]{40}", out) else None


def _site_dir(out: Path, site_id: str) -> Path:
    return out / "sites" / site_dir_name(site_id)


def _metrics_json(m: Mapping) -> dict:
    out = {}
    for k, v in m.items():
        if isinstance(v, (bool, np.bool_)):
            out[k] = bool(v)
        elif isinstance(v, (int, np.integer)):
            out[k] = int(v)
        else:
            out[k] = clean_float(v)
    return out


def _collect_sources(*objs) -> list[dict]:
    seen: dict[str, dict] = {}
    for o in objs:
        if o is None:
            continue
        lst = o if isinstance(o, list) else [o]
        for d in lst:
            if not isinstance(d, Mapping):
                continue
            rec = {k: (v if isinstance(v, (str, int, float, bool)) or v is None else str(v)) for k, v in d.items()}
            rec.setdefault("sha256", None)
            seen[json.dumps(rec, sort_keys=True)] = rec
    return [seen[k] for k in sorted(seen)]


def covered_radius_km(mask: HorizonMask) -> np.ndarray:
    """Per-azimuth radius (km) up to which terrain was actually searched.

    Priority: meta['effective_radius_km'] (horizon.py terrain methods), meta['covered_radius_km'],
    the finite mask.radius_km, the smooth-sphere horizon distance (flat masks), else 0.
    """
    meta = mask.meta if isinstance(mask.meta, Mapping) else {}
    for key in ("effective_radius_km", "covered_radius_km"):
        v = meta.get(key)
        if v is not None and np.shape(v) == mask.az_deg.shape:
            return np.nan_to_num(np.asarray(v, float), nan=0.0, posinf=0.0)
    r = float(mask.radius_km)
    if not math.isfinite(r):
        r = float(meta.get("horizon_distance_km", 0.0))
    return np.full(mask.az_deg.shape, r)


def _write_site(out: Path, sa: SiteAnalysis, provider_name: str, fingerprint: str) -> dict:
    """Write the per-site files; return its sites.json record."""
    sd = _site_dir(out, sa.site.id)
    mask, vis, eph = sa.mask, sa.visibility, sa.ephemeris
    rel = lambda p: p.relative_to(out).as_posix()  # noqa: E731

    cov_arr = covered_radius_km(mask)
    hz_path = sd / f"horizon_{mask.method}.csv"
    _write_bytes(
        hz_path,
        _table_bytes(
            {"az_deg": mask.az_deg, "el_deg": mask.el_deg, "covered_radius_km": cov_arr},
            ("az_deg", "el_deg", "covered_radius_km"),
        ),
    )
    eph_path = sd / f"ephemeris_{provider_name}.csv.gz"
    _write_bytes(
        eph_path,
        _table_bytes({c: (eph.times_utc if c == "time_utc" else getattr(eph, c)) for c in EPHEMERIS_COLUMNS}, EPHEMERIS_COLUMNS),
        gz=True,
    )
    cols = vis.columns()
    t = vis.times_utc
    cols["hours_until_sunset"] = hours_until_state(t, vis.sun_visible, False, sa.step_s)
    cols["hours_until_sunrise"] = hours_until_state(t, vis.sun_visible, True, sa.step_s)
    cols["hours_until_earthset"] = hours_until_state(t, vis.earth_visible, False, sa.step_s)
    cols["hours_until_earthrise"] = hours_until_state(t, vis.earth_visible, True, sa.step_s)
    vis_path = sd / "visibility.csv.gz"
    _write_bytes(vis_path, _table_bytes(cols, VIS_FILE_COLUMNS), gz=True)

    surface = sa.mask.surface_height_m if not (mask.method == "flat" and sa.site.height_m is not None) else sa.site.height_m
    record = {
        "id": sa.site.id,
        "name": sa.site.name,
        "lat_deg": float(sa.site.lat_deg),
        "lon_deg": float(sa.site.lon_deg),
        "origin": sa.site.origin,
        "group": sa.site.group,
        "source": sa.site.source,
        "note": sa.site.note,
        "height_m_input": None if sa.site.height_m is None else float(sa.site.height_m),
        "surface_height_m": clean_float(surface, 3),
        "observer_height_m": float(mask.observer_height_m),
        "observer_height_above_sphere_m": clean_float(eph.observer_height_m, 3),
        "horizon_method": mask.method,
        "dem_source": mask.dem_source,
        "horizon_radius_km": clean_float(mask.radius_km, 3) if math.isfinite(mask.radius_km) else None,
        "horizon_min_el_deg": clean_float(float(np.min(mask.el_deg))),
        "horizon_max_el_deg": clean_float(float(np.max(mask.el_deg))),
        "files": {
            "horizon": rel(hz_path),
            "ephemeris": rel(eph_path),
            "visibility": rel(vis_path),
            "windows": rel(sd / "windows.json"),
        },
    }
    win = {
        "site_id": sa.site.id,
        "step_s": sa.step_s,
        "n_samples": len(vis),
        "range_start_utc": iso_utc(t[0]),
        "range_end_utc": iso_utc(t[-1] + np.timedelta64(sa.step_s, "s")),
        "min_earth_clearance_deg": float(vis.min_earth_clearance_deg),
        "sun": [w.to_dict() for w in sa.sun_windows],
        "earth": [w.to_dict() for w in sa.earth_windows],
        "both": [w.to_dict() for w in sa.both_windows],
        "metrics": _metrics_json(sa.metrics),
        "params_fingerprint": fingerprint,
        "site_record": record,
        "data_sources": _collect_sources(eph.meta.get("data_sources"), mask.meta.get("data_sources")),
    }
    _write_bytes(sd / "windows.json", _json_bytes(win))
    return record


#: Site fields that must be identical for ``resume`` to reuse a stored site (sites.json record keys).
_RESUME_SITE_FIELDS = ("id", "name", "lat_deg", "lon_deg", "origin", "group", "height_m_input")


def _site_input_record(site: Site) -> dict:
    """The inputs of a site as stored in its sites.json record (for resume comparisons)."""
    return {
        "id": site.id,
        "name": site.name,
        "lat_deg": float(site.lat_deg),
        "lon_deg": float(site.lon_deg),
        "origin": site.origin,
        "group": site.group,
        "height_m_input": None if site.height_m is None else float(site.height_m),
    }


def _try_resume(out: Path, site: Site, fingerprint: str) -> dict | None:
    """Return the stored windows.json of a finished site if it can be reused, else None.

    Reused only if (a) the parameter fingerprint matches (run parameters, code version, git
    commit, provider configuration) and (b) the stored site record has exactly the requested
    site inputs (id, name, lat/lon, origin, group, input height) - FIX (review): a corrected
    catalog coordinate or a custom id reused for another place used to reuse stale files - and
    (c) all its files exist.
    """
    wp = _site_dir(out, site.id) / "windows.json"
    if not wp.exists():
        return None
    try:
        w = json.loads(wp.read_text())
    except (OSError, ValueError):
        return None
    if w.get("params_fingerprint") != fingerprint:
        return None
    rec = w.get("site_record", {})
    want = _site_input_record(site)
    if any(rec.get(k) != want[k] for k in _RESUME_SITE_FIELDS):
        return None
    if any(not (out / p).exists() for p in rec.get("files", {}).values()):
        return None
    return w


def provider_config(provider) -> dict:
    """Plain-valued public attributes of an ephemeris provider (e.g. SPICE lunar_set / frame /
    abcorr), recorded in the manifest and in the resume fingerprint."""
    cfg: dict = {}
    for k, v in sorted(vars(provider).items()):
        if k.startswith("_"):
            continue
        if isinstance(v, (str, bool, int, float)) or v is None:
            cfg[k] = v
        elif isinstance(v, np.datetime64):
            cfg[k] = str(v)
    return cfg


def run_precompute(
    sites: Iterable[Site],
    start: str,
    end: str,
    step_minutes: float,
    provider: EphemerisProvider,
    horizon_fn: Callable[[Site], HorizonMask] | Mapping[str, HorizonMask] | str,
    out_dir: str | Path,
    run_timestamp_utc: str,
    options: AnalysisOptions | None = None,
    dem_name: str = "none",
    horizon_method: str | None = None,
    extra_parameters: Mapping | None = None,
    resume: bool = False,
    progress: Callable[[str], None] | None = None,
) -> Path:
    """Compute and write a precompute directory (docs/OUTPUT_SPEC.md). Returns ``out_dir``.

    ``run_timestamp_utc`` is written verbatim into the manifest (passed in, so that the output is
    reproducible byte for byte). ``horizon_fn`` is a HorizonSpec (see analysis.resolve_mask).
    With ``resume=True`` sites whose files exist with the same parameter fingerprint are reused.
    """
    opt = options or AnalysisOptions()
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    sites = list(sites)
    if not sites:
        raise ValueError("no sites")
    for s in sites:
        if not SITE_ID_RE.match(s.id):
            raise ValueError(f"site id {s.id!r} is not file-name safe (allowed: {SITE_ID_RE.pattern})")
    if len({s.id for s in sites}) != len(sites):
        raise ValueError("duplicate site ids")
    dirs: dict[str, str] = {}
    for s in sites:  # 'X' and 'x' (or 'a:b' and 'a_b') would share one directory on Windows/macOS
        key = site_dir_name(s.id).lower()
        if key in dirs:
            raise ValueError(f"site ids {dirs[key]!r} and {s.id!r} map to the same directory "
                             f"sites/{site_dir_name(s.id)} on a case-insensitive file system; rename one")
        dirs[key] = s.id
    ts = iso_utc(parse_utc(run_timestamp_utc))
    times = make_times(start, end, step_minutes)
    step_s = int(round(step_minutes * 60))
    pname = str(getattr(provider, "name", type(provider).__name__))
    params = {
        "start_utc": iso_utc(times[0]),
        "end_utc": iso_utc(times[-1] + np.timedelta64(step_s, "s")),
        "step_minutes": float(step_minutes),
        "step_s": step_s,
        "n_samples": int(times.size),
        "provider": pname,
        "dem": dem_name,
        "horizon_method": horizon_method,
        "observer_height_m": float(opt.observer_height_m),
        "min_earth_clearance_deg": float(opt.min_earth_clearance_deg),
        "rank_weights": {k: float(v) for k, v in sorted(opt.rank_weights.items())},
        "site_ids": [s.id for s in sites],
        "provider_config": provider_config(provider),
    }
    if extra_parameters:
        params.update({k: v for k, v in extra_parameters.items() if k not in params})
    commit = git_commit()
    # fingerprint: every parameter except the site list, plus the code identity, so that a resumed
    # run never mixes files written by different code (a code fix forces recomputation)
    fp_obj = {k: v for k, v in params.items() if k != "site_ids"}
    fp_obj["_code"] = {"version": __version__, "git_commit": commit}
    fingerprint = hashlib.sha256(json.dumps(fp_obj, sort_keys=True).encode()).hexdigest()[:16]
    say = progress or (lambda msg: log.info(msg))

    records: list[dict] = []
    metrics: dict[str, dict] = {}
    sources: list = [dict(KNOWN_SOURCES.get(pname, {"name": pname, "url": None}), sha256=None)]
    if dem_name in KNOWN_SOURCES:
        sources.append(dict(KNOWN_SOURCES[dem_name], sha256=None))
    sources += list(getattr(provider, "data_sources", []) or [])
    for k, s in enumerate(sites, 1):
        prev = _try_resume(out, s, fingerprint) if resume else None
        if prev is not None:
            say(f"[{k}/{len(sites)}] {s.id}: reused (resume)")
            records.append(prev["site_record"])
            metrics[s.id] = prev["metrics"]
            sources += prev.get("data_sources", [])
            continue
        say(f"[{k}/{len(sites)}] {s.id}: horizon + ephemeris + visibility")
        mask = resolve_mask(s, horizon_fn, opt)
        if (horizon_method is not None and mask.method != horizon_method and horizon_method != "flat"
                and not mask.meta.get("dem_fallback")):
            raise ValueError(f"horizon for {s.id} has method {mask.method!r}, expected {horizon_method!r}")
        sa = analyse_site(s, times, provider, mask, opt)
        records.append(_write_site(out, sa, pname, fingerprint))
        metrics[s.id] = _metrics_json(sa.metrics)
        sources += _collect_sources(sa.ephemeris.meta.get("data_sources"), mask.meta.get("data_sources"))

    # Ranking from stored (rounded) metrics so that resumed and fresh runs rank identically.
    class _A:  # minimal adapter for rank_sites
        def __init__(self, site_id: str, m: dict):
            self.site = Site(id=site_id, name=site_id, lat_deg=0.0, lon_deg=0.0)
            self.metrics = m

    ranking = rank_sites([_A(r["id"], metrics[r["id"]]) for r in records], opt.rank_weights)
    rank_of = {r["site_id"]: r for r in ranking}
    rows = []
    for rec in records:
        m = metrics[rec["id"]]
        row = {
            "rank": rank_of[rec["id"]]["rank"],
            "site_id": rec["id"],
            "name": rec["name"],
            "group": rec["group"],
            "lat_deg": rec["lat_deg"],
            "lon_deg": rec["lon_deg"],
            "surface_height_m": rec["surface_height_m"],
            "score": round(rank_of[rec["id"]]["score"], 6),
            "horizon_min_el_deg": rec["horizon_min_el_deg"],
            "horizon_max_el_deg": rec["horizon_max_el_deg"],
        }
        for c in SUMMARY_COLUMNS:
            if c not in row:
                row[c] = m.get(c)
        rows.append(row)
    rows.sort(key=lambda r: r["rank"])
    buf = io.StringIO()
    wr = csv.writer(buf, lineterminator="\n")
    wr.writerow(SUMMARY_COLUMNS)
    for r in rows:
        wr.writerow(["" if r[c] is None else (int(r[c]) if isinstance(r[c], bool) else r[c]) for c in SUMMARY_COLUMNS])
    _write_bytes(out / "summary.csv", buf.getvalue().encode("utf-8"))
    _write_bytes(out / "sites.json", _json_bytes({"format_version": FORMAT_VERSION, "sites": records}))

    files = sorted({"summary.csv", "sites.json"} | {f for r in records for f in r["files"].values()})
    manifest = {
        "format": FORMAT_NAME,
        "format_version": FORMAT_VERSION,
        "code_version": __version__,
        "git_commit": commit,
        "run_timestamp_utc": ts,
        "parameters": params,
        "params_fingerprint": fingerprint,
        "data_sources": _collect_sources(sources),
        "conventions": CONVENTIONS,
        "files": {f: sha256_file(out / f) for f in files},
    }
    _write_bytes(out / "manifest.json", _json_bytes(manifest))
    say(f"wrote {out}")
    return out


# --------------------------------------------------------------------------------------------
# Readers
# --------------------------------------------------------------------------------------------
def read_table(path: str | Path) -> dict[str, np.ndarray]:
    """Read a CSV / CSV.gz written by this module: time_utc -> datetime64[s], bool columns ->
    bool, other columns -> float (empty -> NaN)."""
    p = Path(path)
    opener = gzip.open if p.suffix == ".gz" else open
    with opener(p, "rt", newline="", encoding="ascii") as f:
        rd = csv.reader(f)
        header = next(rd)
        rows = list(rd)
    cols = list(zip(*rows)) if rows else [()] * len(header)
    out: dict[str, np.ndarray] = {}
    for name, vals in zip(header, cols):
        if name == "time_utc":
            out[name] = np.array([v[:-1] if v.endswith("Z") else v for v in vals], dtype="datetime64[s]")
        elif name in _BOOL_COLS:
            out[name] = np.array([v == "1" for v in vals], dtype=bool)
        else:
            out[name] = np.array([float(v) if v != "" else np.nan for v in vals], dtype=float)
    return out


# --------------------------------------------------------------------------------------------
# Output checker
# --------------------------------------------------------------------------------------------
# Tolerances for comparisons between columns that were each rounded when written:
_TOL_ANGLE = 3e-6  # deg: two %.6f roundings (0.5e-6 each) plus float noise
_TOL_FRAC = 2e-5  # fraction recomputed from rounded angles: df/dh <= 2/(pi r) ~ 2.4 /deg -> 7e-6, x2 margin
_TOL_PCT = 1e-6  # percent, recomputed exactly from the booleans
_TOL_H = 1e-3  # hours: %.4f roundings

POLAR_LAT_DEG = 80.0
SUN_DEC_MAX_DEG = 1.65  # 1.543 deg lunar equator-ecliptic tilt + physical libration + parallax, margin
EARTH_LIB_LAT_MAX_DEG = 7.3  # 6.85 deg optical libration in latitude + 0.29 deg max parallax, margin
FAR_SIDE_NO_EARTH_DEG = 105.0  # angular distance from (0N, 0E) beyond which Earth el < 0 always
FAR_SIDE_NO_EARTH_PCT_DEG = 110.0  # ... and Earth el < -9 deg: no terrain dip can reveal it -> 0 %
POLE_EARTH_AZ_LAT_DEG = 85.0
POLE_EARTH_AZ_TOL_DEG = 15.0
SUN_DIST_RANGE_KM = (1.46e8, 1.53e8)
EARTH_DIST_RANGE_KM = (3.50e5, 4.10e5)


def great_circle_deg(lat1, lon1, lat2, lon2) -> float:
    """Angular distance (deg) between two points on the sphere."""
    a, b = _unit(lat1, lon1), _unit(lat2, lon2)
    return float(np.degrees(np.arccos(np.clip(np.dot(a, b), -1, 1))))


def bearing_deg(lat1, lon1, lat2, lon2) -> float:
    """Initial great-circle bearing (deg, clockwise from north) from point 1 to point 2."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dl = np.radians(lon2 - lon1)
    y = np.sin(dl) * np.cos(p2)
    x = np.cos(p1) * np.sin(p2) - np.sin(p1) * np.cos(p2) * np.cos(dl)
    return float(np.mod(np.degrees(np.arctan2(y, x)), 360.0))


def _circ_diff(a, b) -> np.ndarray:
    return np.abs((np.asarray(a) - np.asarray(b) + 180.0) % 360.0 - 180.0)


def _check_windows(name: str, wins: list, t: np.ndarray, step_s: int, flags: np.ndarray, v: list[str]) -> None:
    pre = f"{name}:"
    if not wins:
        v.append(f"{pre} no windows")
        return
    r0, r1 = t[0], t[-1] + np.timedelta64(step_s, "s")
    if parse_utc(wins[0]["start"]) != r0:
        v.append(f"{pre} first window does not start at range start (gap)")
    if parse_utc(wins[-1]["end"]) != r1:
        v.append(f"{pre} last window does not end at range end (gap)")
    for k, w in enumerate(wins):
        s, e = parse_utc(w["start"]), parse_utc(w["end"])
        if e <= s:
            v.append(f"{pre} window {k} has end <= start")
        if abs(w["duration_h"] - (e - s).astype(np.int64) / 3600.0) > 1e-5:
            v.append(f"{pre} window {k} duration_h inconsistent with start/end")
        if w["truncated_start"] != (k == 0):
            v.append(f"{pre} window {k} truncated_start flag wrong")
        if w["truncated_end"] != (k == len(wins) - 1):
            v.append(f"{pre} window {k} truncated_end flag wrong")
        if k + 1 < len(wins):
            nxt = wins[k + 1]
            if parse_utc(nxt["start"]) != e:
                v.append(f"{pre} windows {k} and {k + 1} do not tile (gap or overlap)")
            if nxt["state"] == w["state"]:
                v.append(f"{pre} windows {k} and {k + 1} have the same state (not maximal)")
        i, j = w["start_index"], w["end_index"]
        if not (0 <= i < j <= t.size) or t[i] != s or (j < t.size and t[j] != e):
            v.append(f"{pre} window {k} indices inconsistent with times")
            continue
        if np.any(flags[i:j] != bool(w["state"])):
            v.append(f"{pre} window {k} state disagrees with the visibility series")
    if sum(w["end_index"] - w["start_index"] for w in wins) != t.size:
        v.append(f"{pre} windows do not cover every sample exactly once")


def check_output(out_dir: str | Path) -> list[str]:
    """Verify a precompute directory against docs/OUTPUT_SPEC.md. Returns violations ([] = OK)."""
    out = Path(out_dir)
    v: list[str] = []
    try:
        man = json.loads((out / "manifest.json").read_text())
    except (OSError, ValueError) as exc:
        return [f"manifest.json unreadable: {exc}"]
    for k in ("format", "format_version", "code_version", "run_timestamp_utc", "parameters", "data_sources", "conventions", "files"):
        if k not in man:
            v.append(f"manifest: missing key {k!r}")
    if v:
        return v
    if man["format"] != FORMAT_NAME or man["format_version"] != FORMAT_VERSION:
        v.append("manifest: unknown format/version")
    for f, h in sorted(man["files"].items()):
        p = out / f
        if not p.exists():
            v.append(f"manifest: listed file missing: {f}")
        elif sha256_file(p) != h:
            v.append(f"checksum mismatch: {f}")
    P = man["parameters"]
    try:
        int(P["step_s"]), parse_utc(P["start_utc"]), parse_utc(P["end_utc"])
        min_clear = float(P["min_earth_clearance_deg"])
    except (KeyError, TypeError, ValueError) as exc:
        return v + [f"manifest: bad parameters: {exc}"]
    if not (0.0 <= min_clear <= 10.0):
        v.append("manifest: min_earth_clearance_deg outside [0, 10]")
    try:
        sites = json.loads((out / "sites.json").read_text())["sites"]
    except (OSError, ValueError, KeyError) as exc:
        return v + [f"sites.json unreadable: {exc}"]
    if [s["id"] for s in sites] != list(P["site_ids"]):
        v.append("sites.json ids differ from manifest parameters.site_ids")
    try:
        summary = read_summary(out / "summary.csv")
    except (OSError, ValueError, KeyError) as exc:
        summary = {}
        v.append(f"summary.csv unreadable: {exc}")
    if summary:
        ranks = sorted(int(r["rank"]) for r in summary.values())
        if ranks != list(range(1, len(summary) + 1)):
            v.append("summary: ranks are not 1..N")
        by_rank = sorted(summary.values(), key=lambda r: int(r["rank"]))
        if any(float(a["score"]) < float(b["score"]) - 1e-6 for a, b in zip(by_rank, by_rank[1:])):
            v.append("summary: ranks not sorted by descending score")
        if set(summary) != {s["id"] for s in sites}:
            v.append("summary: site ids differ from sites.json")

    for rec in sites:
        try:
            _check_site(out, rec, P, summary, v)
        except Exception as exc:  # corrupted content must give a violation, never a crash
            v.append(f"site {rec.get('id', '?') if isinstance(rec, dict) else '?'}: checker error {type(exc).__name__}: {exc}")
    return v


def _ref_hours_until(ti_s: np.ndarray, flags: np.ndarray, target: bool) -> np.ndarray:
    """Reference "hours until flags == target" per sample, written independently of windows.py.

    0 where flags[i] == target; else (t_j - t_i) / 3600 for the first j > i with flags[j] ==
    target; NaN if there is none.  ``ti_s`` = sample times as integer seconds.
    """
    f = np.asarray(flags, bool)
    hit = np.flatnonzero(f == target)
    idx = np.arange(f.size)
    k = np.searchsorted(hit, idx, side="left")  # first hit index >= i
    out = np.full(f.size, np.nan)
    ok = k < hit.size
    j = hit[np.minimum(k, max(hit.size - 1, 0))] if hit.size else idx
    out[ok] = (ti_s[j[ok]] - ti_s[idx[ok]]) / 3600.0
    return out


def _ref_runs(flags: np.ndarray) -> list[tuple[bool, int]]:
    """Run-length encoding of a boolean series: [(state, n_samples), ...] (independent of windows.py)."""
    f = np.asarray(flags, bool)
    if f.size == 0:
        return []
    edges = np.flatnonzero(np.diff(f.astype(np.int8)) != 0) + 1
    starts = np.concatenate([[0], edges])
    lens = np.diff(np.concatenate([starts, [f.size]]))
    return [(bool(f[a]), int(n)) for a, n in zip(starts, lens)]


def _ref_metrics(sv, ev, sun_el, p_h, p_t, step_s: int) -> dict:
    """Reference window metrics for check_output, re-implemented from the boolean columns.

    Assumes the uniform time axis that check_output verifies separately: each sample stands for
    ``step_s`` seconds, a run of n samples lasts n * step_s.  Deliberately does NOT call
    windows.compute_metrics / find_windows (the writer's code), so a bug there is caught.
    """
    n = sv.size
    h = step_s / 3600.0
    out: dict = {
        "pct_sun": 100.0 * np.count_nonzero(sv) / n,
        "pct_earth": 100.0 * np.count_nonzero(ev) / n,
        "pct_both": 100.0 * np.count_nonzero(sv & ev) / n,
        "pct_sun_no_earth": 100.0 * np.count_nonzero(sv & ~ev) / n,
    }
    for name, flags in (("sun", sv), ("earth", ev)):
        runs = _ref_runs(flags)
        on = [k for st, k in runs if st]
        off = [k for st, k in runs if not st]
        if name == "sun":
            out["longest_sun_h"], out["longest_dark_h"] = max(on, default=0) * h, max(off, default=0) * h
            out["n_sun_windows"], out["n_dark_windows"] = len(on), len(off)
        else:
            out["longest_earth_h"], out["longest_comms_gap_h"] = max(on, default=0) * h, max(off, default=0) * h
            out["n_earth_windows"], out["n_comms_gaps"] = len(on), len(off)
    out["mean_sun_el_lit_deg"] = float(np.mean(sun_el[sv])) if np.any(sv) else None
    out["mean_power_horizontal"] = float(np.mean(p_h))
    out["mean_power_tracking"] = float(np.mean(p_t))
    return out


def _check_site(out: Path, rec: dict, P: dict, summary: dict, v: list[str]) -> None:
    """Per-site part of check_output (appends violations to ``v``)."""
    step_s = int(P["step_s"])
    r0, r1 = parse_utc(P["start_utc"]), parse_utc(P["end_utc"])
    min_clear = float(P["min_earth_clearance_deg"])
    sid = rec["id"]
    pre = f"site {sid}:"
    try:
        vis = read_table(out / rec["files"]["visibility"])
        eph = read_table(out / rec["files"]["ephemeris"])
        hz = read_table(out / rec["files"]["horizon"])
        win = json.loads((out / rec["files"]["windows"]).read_text())
    except (OSError, ValueError, KeyError, StopIteration) as exc:
        v.append(f"{pre} file unreadable: {exc}")
        return
    missing = [c for c in VIS_FILE_COLUMNS if c not in vis]
    if missing:
        v.append(f"{pre} visibility missing columns {missing}")
        return
    t = vis["time_utc"]
    n = t.size
    # --- time axis
    ti = t.astype(np.int64)
    if n != int(P["n_samples"]):
        v.append(f"{pre} n_samples {n} != manifest {P['n_samples']}")
    if n == 0:
        return
    if n > 1 and np.any(np.diff(ti) != step_s):
        v.append(f"{pre} time axis not uniform with step {step_s} s")
    if t[0] != r0 or t[-1] + np.timedelta64(step_s, "s") != r1:
        v.append(f"{pre} time axis does not cover [start, end)")
    if eph["time_utc"].shape != t.shape or np.any(eph["time_utc"] != t):
        v.append(f"{pre} ephemeris and visibility times differ")
    else:
        for c in ("sun_az_deg", "sun_el_deg", "earth_az_deg", "earth_el_deg"):
            if np.any(_circ_diff(eph[c], vis[c]) > _TOL_ANGLE):
                v.append(f"{pre} {c} differs between ephemeris and visibility files")
    # --- ranges
    for c in ("sun_az_deg", "earth_az_deg"):
        if np.any((vis[c] < 0) | (vis[c] >= 360)):
            v.append(f"{pre} {c} outside [0, 360)")
    for c in ("sun_el_deg", "earth_el_deg", "horizon_el_sun_deg", "horizon_el_earth_deg"):
        if np.any(np.abs(vis[c]) > 90) or np.any(~np.isfinite(vis[c])):
            v.append(f"{pre} {c} outside [-90, 90]")
    for c in ("sun_fraction", "earth_fraction", "power_horizontal", "power_tracking"):
        if np.any((vis[c] < 0) | (vis[c] > 1)):
            v.append(f"{pre} {c} outside [0, 1]")
    lo, hi = SUN_DIST_RANGE_KM
    if np.any((vis["sun_dist_km"] < lo) | (vis["sun_dist_km"] > hi)):
        v.append(f"{pre} sun_dist_km outside [{lo:.3g}, {hi:.3g}] km")
    lo, hi = EARTH_DIST_RANGE_KM
    if np.any((vis["earth_dist_km"] < lo) | (vis["earth_dist_km"] > hi)):
        v.append(f"{pre} earth_dist_km outside [{lo:.3g}, {hi:.3g}] km")
    # --- horizon file and horizon columns
    az, hel = hz.get("az_deg"), hz.get("el_deg")
    if az is None or hel is None or "covered_radius_km" not in hz:
        v.append(f"{pre} horizon file missing columns")
    else:
        if az.size < 2 or np.any(np.diff(az) <= 0) or az[0] < 0 or az[-1] >= 360:
            v.append(f"{pre} horizon az_deg not strictly increasing within [0, 360)")
        elif np.any(np.abs(np.diff(np.append(az, az[0] + 360)) - 360.0 / az.size) > 1e-5):
            v.append(f"{pre} horizon az_deg not uniform over [0, 360)")
        if np.any(np.abs(hel) > 90):
            v.append(f"{pre} horizon el_deg outside [-90, 90]")
        if np.any(hz["covered_radius_km"] < 0):
            v.append(f"{pre} covered_radius_km negative")
        m = HorizonMask(sid, az, hel, "check", "", 0.0, 0.0, 0.0)
        if np.any(np.abs(m.at(vis["sun_az_deg"]) - vis["horizon_el_sun_deg"]) > 1e-5):
            v.append(f"{pre} horizon_el_sun_deg does not match the horizon file at sun_az")
        if np.any(np.abs(m.at(vis["earth_az_deg"]) - vis["horizon_el_earth_deg"]) > 1e-5):
            v.append(f"{pre} horizon_el_earth_deg does not match the horizon file at earth_az")
    # --- Sun rules
    sd = vis["sun_semidiam_deg"]
    if np.any(np.abs(sd - sun_semidiameter_deg(np.clip(vis["sun_dist_km"], 1e6, None))) > 1e-6):
        v.append(f"{pre} sun_semidiam_deg != asin(R_sun / sun_dist_km)")
    clr = vis["sun_el_deg"] - vis["horizon_el_sun_deg"]
    if np.any(np.abs(clr - vis["sun_clearance_deg"]) > _TOL_ANGLE):
        v.append(f"{pre} sun_clearance_deg != sun_el - horizon_el_sun")
    upper = clr + sd
    sv = vis["sun_visible"]
    if np.any(sv & (upper < -_TOL_ANGLE)):
        v.append(f"{pre} sun_visible but upper limb below horizon (sun_el + semidiam <= horizon)")
    if np.any(~sv & (upper > _TOL_ANGLE)):
        v.append(f"{pre} sun not visible but upper limb above horizon")
    frac = disc_visible_fraction(vis["sun_el_deg"], vis["horizon_el_sun_deg"], np.clip(sd, 1e-9, None))
    if np.any(np.abs(frac - vis["sun_fraction"]) > _TOL_FRAC):
        v.append(f"{pre} sun_fraction inconsistent with the circular-segment formula")
    if np.any(~sv & (vis["sun_fraction"] > 1e-6)):
        v.append(f"{pre} sun_fraction > 0 while sun not visible")
    ph = vis["sun_fraction"] * np.maximum(0, np.sin(np.radians(vis["sun_el_deg"])))
    if np.any(np.abs(ph - vis["power_horizontal"]) > 2e-6):
        v.append(f"{pre} power_horizontal != fraction * max(0, sin(el))")
    if np.any(np.abs(vis["power_tracking"] - vis["sun_fraction"]) > 1e-6):
        v.append(f"{pre} power_tracking != sun_fraction")
    irr = SOLAR_CONSTANT_WM2 * (AU_KM / vis["sun_dist_km"]) ** 2 * vis["sun_fraction"]
    if np.any(np.abs(irr - vis["irradiance_tracking_wm2"]) > 0.01):
        v.append(f"{pre} irradiance_tracking_wm2 != 1361 (AU/d)^2 fraction")
    # --- Earth rules
    ec = vis["earth_el_deg"] - vis["horizon_el_earth_deg"]
    if np.any(np.abs(ec - vis["earth_clearance_deg"]) > _TOL_ANGLE):
        v.append(f"{pre} earth_clearance_deg != earth_el - horizon_el_earth")
    ev = vis["earth_visible"]
    c = vis["earth_clearance_deg"]
    if np.any(ev & (c < min_clear - _TOL_ANGLE)) or np.any(~ev & (c > min_clear + _TOL_ANGLE)):
        v.append(f"{pre} earth_visible inconsistent with clearance > min_earth_clearance_deg")
    if np.any(vis["both_visible"] != (sv & ev)):
        v.append(f"{pre} both_visible != sun_visible & earth_visible")
    # --- time-until columns
    for col, flags, target in (
        ("hours_until_sunset", sv, False),
        ("hours_until_sunrise", sv, True),
        ("hours_until_earthset", ev, False),
        ("hours_until_earthrise", ev, True),
    ):
        exp = _ref_hours_until(ti, flags, target)
        got = vis[col]
        if np.any(np.isnan(exp) != np.isnan(got)) or np.any(np.abs(np.nan_to_num(exp) - np.nan_to_num(got)) > _TOL_H):
            v.append(f"{pre} {col} inconsistent with the visibility flags")
    # --- physics sanity
    lat, lon = float(rec["lat_deg"]), float(rec["lon_deg"])
    if not (-90 <= lat <= 90) or not (0 <= lon < 360):
        v.append(f"{pre} lat/lon outside convention ranges")
    if abs(lat) >= POLAR_LAT_DEG:
        colat = 90.0 - abs(lat)
        if np.max(np.abs(vis["sun_el_deg"])) > colat + SUN_DEC_MAX_DEG:
            v.append(f"{pre} polar site: |sun_el| exceeds colatitude + {SUN_DEC_MAX_DEG} deg")
        if np.max(np.abs(vis["earth_el_deg"])) > colat + EARTH_LIB_LAT_MAX_DEG:
            v.append(f"{pre} polar site: |earth_el| exceeds colatitude + {EARTH_LIB_LAT_MAX_DEG} deg")
    if POLE_EARTH_AZ_LAT_DEG <= abs(lat) < 89.99:
        b = bearing_deg(lat, lon, 0.0, 0.0)
        if np.max(_circ_diff(vis["earth_az_deg"], b)) > POLE_EARTH_AZ_TOL_DEG:
            v.append(f"{pre} polar site: earth_az deviates > {POLE_EARTH_AZ_TOL_DEG} deg from the bearing to (0N,0E)")
    dist0 = great_circle_deg(lat, lon, 0.0, 0.0)
    if dist0 > FAR_SIDE_NO_EARTH_DEG and np.max(vis["earth_el_deg"]) >= 0:
        v.append(f"{pre} far-side site but Earth elevation >= 0")
    if dist0 > FAR_SIDE_NO_EARTH_PCT_DEG and np.any(ev):
        v.append(f"{pre} far-side site but Earth visible")
    # --- windows + metrics
    if win.get("step_s") != step_s or win.get("n_samples") != n:
        v.append(f"{pre} windows.json step/n_samples mismatch")
    if abs(float(win.get("min_earth_clearance_deg", -1)) - min_clear) > 1e-9:
        v.append(f"{pre} windows.json min_earth_clearance_deg mismatch")
    for key, flags in (("sun", sv), ("earth", ev), ("both", vis["both_visible"])):
        _check_windows(f"{pre} {key} windows", win.get(key, []), t, step_s, flags, v)
    exp = _ref_metrics(sv, ev, vis["sun_el_deg"], vis["power_horizontal"], vis["power_tracking"], step_s)
    got = win.get("metrics", {})
    for k in ("pct_sun", "pct_earth", "pct_both", "pct_sun_no_earth"):
        g = got.get(k)
        if g is None or not (0.0 <= g <= 100.0):
            v.append(f"{pre} metric {k} missing or outside [0, 100]")
        elif abs(g - exp[k]) > _TOL_PCT + 1e-6:
            v.append(f"{pre} metric {k} = {g} disagrees with the visibility series ({exp[k]:.6f})")
    if got.get("pct_both", 0) > min(got.get("pct_sun", 100), got.get("pct_earth", 100)) + 1e-6:
        v.append(f"{pre} pct_both > min(pct_sun, pct_earth)")
    for k in ("longest_dark_h", "longest_comms_gap_h", "longest_sun_h", "longest_earth_h"):
        g = got.get(k)
        if g is None or abs(g - exp[k]) > 1e-5 or g < 0 or g > (r1 - r0).astype(np.int64) / 3600 + 1e-9:
            v.append(f"{pre} metric {k} inconsistent with windows / range")
    for k in ("n_sun_windows", "n_dark_windows", "n_earth_windows", "n_comms_gaps"):
        if got.get(k) != exp[k]:
            v.append(f"{pre} metric {k} inconsistent with windows")
    for k in ("mean_sun_el_lit_deg", "mean_power_horizontal", "mean_power_tracking"):
        # 1e-5: the means are recomputed from %.6f-rounded columns (error <= 5e-7) and the metric
        # itself is rounded to 1e-6 in windows.json
        g = got.get(k)
        if (g is None) != (exp[k] is None) or (g is not None and abs(g - exp[k]) > 1e-5):
            v.append(f"{pre} metric {k} inconsistent with the visibility series")
    row = summary.get(sid)
    if row is not None:
        for k in ("pct_sun", "pct_earth", "pct_both", "longest_dark_h", "longest_comms_gap_h"):
            try:
                if abs(float(row[k]) - float(got.get(k))) > 1e-5:
                    v.append(f"{pre} summary.csv {k} != windows.json metrics")
            except (TypeError, ValueError):
                v.append(f"{pre} summary.csv {k} unreadable")
        for k in ("pct_sun", "pct_earth", "pct_both"):
            try:
                if not (0.0 <= float(row[k]) <= 100.0):
                    v.append(f"{pre} summary.csv {k} outside [0, 100]")
            except (TypeError, ValueError):
                pass


def read_summary(path: str | Path) -> dict[str, dict]:
    """summary.csv as {site_id: row dict of strings}."""
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        if set(SUMMARY_COLUMNS) - set(r):
            raise KeyError("summary.csv missing columns")
    return {r["site_id"]: r for r in rows}


def options_dict(opt: AnalysisOptions) -> dict:
    """AnalysisOptions as a plain dict (for logs / JSON)."""
    d = asdict(opt)
    d["rank_weights"] = dict(d["rank_weights"])
    return d


__all__ = [
    "SyntheticProvider",
    "run_precompute",
    "check_output",
    "read_table",
    "read_summary",
    "get_provider",
    "get_dem",
    "make_horizon_fn",
    "topocentric_az_el",
    "great_circle_deg",
    "bearing_deg",
]

