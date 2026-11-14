"""Terrain horizon masks from LOLA-type polar stereographic DEMs - two independent algorithms.

Conventions (see :mod:`lunarnav.types`):

* Heights ``h`` are metres above the 1737.4 km reference sphere; a terrain point is the 3-D vector
  ``(R + h) * u`` where ``u`` is its unit radial direction in the MOON_ME frame.
* The observer is at ``O = (R + h_surface + mast) * U`` where ``U`` is the unit radial at the site.
* Azimuth: degrees clockwise from LOCAL north (towards the lunar north pole along the meridian of
  the site), N=0, E=90, S=180, W=270, like JPL Horizons.  In a south polar stereographic grid local
  north is NOT grid +y: it points radially AWAY from the pole (towards the equator), so it rotates
  with longitude.  We never derive azimuths from grid axes: everything is done with 3-D vectors and
  the local East/North/Up basis computed from (lat, lon), which is smooth even at the pole.
* Elevation: degrees above the plane perpendicular to the observer's radial (sphere) zenith
  ``U``.  Elevations are exact 3-D angles, so the curvature drop of the sphere is included exactly.

Mask semantics
--------------
``HorizonMask.az_deg = i * az_step`` (i = 0..n-1) and ``el_deg[i]`` is the highest terrain elevation
inside the azimuth BIN ``[az_i - step/2, az_i + step/2)`` (a conservative, "blocking" horizon).

* :func:`horizon_raymarch` - marches ``oversample`` great-circle rays per bin (bilinear DEM
  sampling, distance step ~ pixel size growing linearly with distance) and keeps the maximum.
  ``near_exclusion_m="auto"`` ignores terrain closer than 250 m on DEMs of <= 5 m.
* :func:`horizon_bruteforce` - converts EVERY DEM cell to 3-D, computes its exact azimuth/elevation
  and takes the per-bin maximum; a cell whose footprint spans several bins contributes to all of them
  (footprint from the azimuths of its 4 corners).  Completely separate code path (inverse projection,
  full vector arithmetic, no interpolation, no rays).  Within 40 px of the mast the centre elevation
  covers only the cell's central half (``footprint_extent=0.5``, at most 6 deg wide), and each cell
  quadrant adds a bilinear lower bound over its own azimuths so no direction is left uncovered, see
  :func:`horizon_bruteforce`.
* :func:`horizon_flat` - smooth sphere: ``el = -acos((R+h)/(R+h+mast))`` (:func:`geometric_dip_deg`).

Both terrain algorithms report the radius actually covered per azimuth in ``meta`` (patch edges and
nodata shorten it; NaN = nodata is skipped, never treated as zero height).
"""
from __future__ import annotations

import math
import time
import warnings
from dataclasses import dataclass
from typing import Callable, Union

import numpy as np

from . import config
from .types import DemPatch, HorizonMask, Site

R_M: float = config.MOON_RADIUS_M

#: A height function ``h(x_m, y_m) -> metres above the 1737.4 km sphere`` in projected (polar
#: stereographic) coordinates; must accept/return numpy arrays of equal shape, NaN = nodata.
HeightFunction = Callable[[np.ndarray, np.ndarray], np.ndarray]
Terrain = Union[DemPatch, HeightFunction]

__all__ = [
    "PolarStereographic",
    "SOUTH_POLAR",
    "NORTH_POLAR",
    "moon_polar_stereo_wkt",
    "enu_basis",
    "latlon_to_unit",
    "unit_to_latlon",
    "local_north_grid_direction",
    "geometric_dip_deg",
    "horizon_distance_m",
    "sample_patch_bilinear",
    "rasterize_height_function",
    "resolve_near_exclusion_m",
    "horizon_raymarch",
    "horizon_bruteforce",
    "BRUTEFORCE_FOOTPRINT_MODEL",
    "horizon_flat",
    "compute_horizon",
    "compare_masks",
]


# ----------------------------------------------------------------------------------------------
# 3-D geometry helpers
# ----------------------------------------------------------------------------------------------
def latlon_to_unit(lat_deg: np.ndarray | float, lon_deg: np.ndarray | float) -> np.ndarray:
    """Unit radial vector(s) in MOON_ME for planetocentric lat / east lon (deg). Shape (..., 3)."""
    lat = np.radians(np.asarray(lat_deg, dtype=float))
    lon = np.radians(np.asarray(lon_deg, dtype=float))
    cl = np.cos(lat)
    return np.stack([cl * np.cos(lon), cl * np.sin(lon), np.sin(lat)], axis=-1)


def unit_to_latlon(u: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Inverse of :func:`latlon_to_unit`: (lat_deg, east lon_deg in [0, 360)). Robust at the poles."""
    u = np.asarray(u, dtype=float)
    lat = np.degrees(np.arctan2(u[..., 2], np.hypot(u[..., 0], u[..., 1])))
    lon = np.mod(np.degrees(np.arctan2(u[..., 1], u[..., 0])), 360.0)
    return lat, lon


def enu_basis(lat_deg: float, lon_deg: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Local East, North, Up unit vectors (MOON_ME) at (lat, east lon), degrees.

    Uses the closed-form expressions E = (-sin lon, cos lon, 0), N = (-sin lat cos lon,
    -sin lat sin lon, cos lat), U = radial.  They stay well defined at the poles, where the
    azimuth origin is then the meridian ``lon_deg`` (at the south pole, N = (cos lon, sin lon, 0):
    "north" = towards the equator along that meridian).
    """
    la, lo = math.radians(lat_deg), math.radians(lon_deg)
    e = np.array([-math.sin(lo), math.cos(lo), 0.0])
    n = np.array([-math.sin(la) * math.cos(lo), -math.sin(la) * math.sin(lo), math.cos(la)])
    u = np.array([math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)])
    return e, n, u


def geometric_dip_deg(observer_height_m: float, surface_height_m: float = 0.0,
                      radius_m: float = R_M) -> float:
    """Elevation (deg, <= 0) of the horizon of a perfectly smooth sphere.

    Observer at ``observer_height_m`` above a smooth sphere of radius ``radius_m + surface_height_m``:
    ``dip = -acos(r / (r + h_obs))``.  For h_obs = 2 m on the Moon: -0.0869 deg.
    """
    if observer_height_m < 0:
        raise ValueError(f"observer_height_m must be >= 0, got {observer_height_m}")
    r = radius_m + surface_height_m
    return -math.degrees(math.acos(r / (r + observer_height_m)))


def horizon_distance_m(observer_height_m: float, surface_height_m: float = 0.0,
                       radius_m: float = R_M) -> float:
    """Arc distance (m) from the observer foot point to the smooth-sphere tangent point."""
    r = radius_m + surface_height_m
    return r * math.acos(r / (r + observer_height_m))


# ----------------------------------------------------------------------------------------------
# Polar stereographic projection on a sphere (exact, 3-D vector form - no lat/lon singularity)
# ----------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class PolarStereographic:
    """Spherical polar stereographic projection (Snyder 1987, eqs. 21-5..21-10), unit-vector form.

    pole = -1 (south) or +1 (north).  South: x = 2 R k0 u_y'/(1 - u_z), y = 2 R k0 u_x'/(1 - u_z);
    North: x = 2 R k0 u_y'/(1 + u_z), y = -2 R k0 u_x'/(1 + u_z), where (u_x', u_y') is the unit vector
    rotated by -lon0.  Equivalent to Snyder's rho = 2 R k0 cos(lat) / (1 + pole*sin(lat)),
    x = rho sin(lon - lon0), y = -pole * rho cos(lon - lon0), i.e. PROJ ``+proj=stere +lat_0=+-90``.
    Grid +y at the south pole points along the meridian lon0 (NOT local north in general).
    """

    pole: int = -1
    radius_m: float = R_M
    lon0_deg: float = 0.0
    k0: float = 1.0
    false_easting_m: float = 0.0
    false_northing_m: float = 0.0

    def __post_init__(self) -> None:
        if self.pole not in (-1, 1):
            raise ValueError("pole must be -1 (south) or +1 (north)")

    # -- construction from a CRS --------------------------------------------------------------
    @classmethod
    def from_crs(cls, crs_wkt: str, verify: bool = True) -> "PolarStereographic":
        """Parse a polar stereographic CRS (WKT / PROJ string) with pyproj and verify it.

        Raises ValueError if the CRS is not a spherical polar stereographic projection, or if our
        closed-form inverse disagrees with pyproj by more than 1e-7 deg (~3 mm) on test points.
        """
        import pyproj

        crs = pyproj.CRS.from_user_input(crs_wkt)
        ell = crs.ellipsoid
        if ell is None or abs(ell.semi_major_metre - ell.semi_minor_metre) > 1.0:
            raise ValueError("DEM CRS is not on a sphere; only spherical (LOLA) CRSs are supported")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            d = crs.to_dict()
        if d.get("proj") not in ("stere", "ups"):
            raise ValueError(f"DEM CRS is not polar stereographic: proj={d.get('proj')}")
        lat0 = float(d.get("lat_0", 0.0))
        if abs(abs(lat0) - 90.0) > 1e-9:
            raise ValueError(f"stereographic CRS is not polar (lat_0={lat0})")
        pole = 1 if lat0 > 0 else -1
        if "lat_ts" in d:
            k0 = (1.0 + math.sin(math.radians(abs(float(d["lat_ts"]))))) / 2.0
        else:
            k0 = float(d.get("k", d.get("k_0", 1.0)))
        if d.get("units", "m") != "m":
            raise ValueError(f"DEM CRS units must be metres, got {d.get('units')}")
        proj = cls(pole=pole, radius_m=float(ell.semi_major_metre), lon0_deg=float(d.get("lon_0", 0.0)),
                   k0=k0, false_easting_m=float(d.get("x_0", 0.0)),
                   false_northing_m=float(d.get("y_0", 0.0)))
        if verify:
            proj._verify_against_pyproj(crs)
        return proj

    def _verify_against_pyproj(self, crs) -> None:
        import pyproj

        tr = pyproj.Transformer.from_crs(crs, crs.geodetic_crs, always_xy=True)
        xs = np.array([0.0, 1000.0, -25_000.0, 130_000.0, -310_000.0]) + self.false_easting_m
        ys = np.array([0.0, -7000.0, 42_000.0, -220_000.0, 95_000.0]) + self.false_northing_m
        lon_p, lat_p = tr.transform(xs, ys)
        lat_o, lon_o = unit_to_latlon(self.inverse_unit(xs, ys))
        dlon = (np.asarray(lon_p) - lon_o + 180.0) % 360.0 - 180.0
        dlon = np.where(np.abs(np.asarray(lat_p)) > 90 - 1e-9, 0.0, dlon)  # lon undefined at pole
        if np.max(np.abs(np.asarray(lat_p) - lat_o)) > 1e-7 or np.max(np.abs(dlon)) > 1e-7:
            raise ValueError("closed-form polar stereographic disagrees with pyproj for this CRS")

    def to_proj4(self) -> str:
        lat0 = 90 * self.pole
        return (f"+proj=stere +lat_0={lat0} +lon_0={self.lon0_deg} +k={self.k0!r} "
                f"+x_0={self.false_easting_m} +y_0={self.false_northing_m} +R={self.radius_m} "
                f"+units=m +no_defs")

    # -- transforms --------------------------------------------------------------------------
    def forward_unit(self, u: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Unit vectors (..., 3) -> projected (x_m, y_m).  Singular only at the opposite pole."""
        u = np.asarray(u, dtype=float)
        c, s = math.cos(math.radians(self.lon0_deg)), math.sin(math.radians(self.lon0_deg))
        ux = u[..., 0] * c + u[..., 1] * s
        uy = -u[..., 0] * s + u[..., 1] * c
        f = 2.0 * self.radius_m * self.k0 / (1.0 + self.pole * u[..., 2])
        x = f * uy
        y = (-self.pole) * f * ux
        return x + self.false_easting_m, y + self.false_northing_m

    def inverse_unit(self, x_m: np.ndarray, y_m: np.ndarray) -> np.ndarray:
        """Projected (x, y) metres -> unit vectors (..., 3) in MOON_ME."""
        scale = 2.0 * self.radius_m * self.k0
        a = (np.asarray(x_m, dtype=float) - self.false_easting_m) / scale
        b = (np.asarray(y_m, dtype=float) - self.false_northing_m) / scale
        r2 = a * a + b * b
        g = 2.0 / (1.0 + r2)
        uz = self.pole * (1.0 - r2) / (1.0 + r2)
        uxr = (-self.pole) * b * g
        uyr = a * g
        c, s = math.cos(math.radians(self.lon0_deg)), math.sin(math.radians(self.lon0_deg))
        return np.stack([uxr * c - uyr * s, uxr * s + uyr * c, uz], axis=-1)

    def latlon_to_xy(self, lat_deg, lon_deg) -> tuple[np.ndarray, np.ndarray]:
        return self.forward_unit(latlon_to_unit(lat_deg, lon_deg))

    def xy_to_latlon(self, x_m, y_m) -> tuple[np.ndarray, np.ndarray]:
        return unit_to_latlon(self.inverse_unit(x_m, y_m))

    def scale_factor(self, lat_deg: np.ndarray | float) -> np.ndarray:
        """Point scale factor k = 2 k0 / (1 + pole*sin(lat)) (grid metres per ground metre)."""
        return 2.0 * self.k0 / (1.0 + np.sin(np.radians(np.abs(np.asarray(lat_deg, float)))))


SOUTH_POLAR = PolarStereographic(pole=-1)
NORTH_POLAR = PolarStereographic(pole=1)


def moon_polar_stereo_wkt(pole: int = -1, lon0_deg: float = 0.0, k0: float = 1.0) -> str:
    """WKT2 of the LOLA-style polar stereographic CRS on the 1737.4 km sphere (for synthetic DEMs)."""
    import pyproj

    return pyproj.CRS.from_proj4(
        PolarStereographic(pole=pole, lon0_deg=lon0_deg, k0=k0).to_proj4()).to_wkt()


def local_north_grid_direction(proj: PolarStereographic, lat_deg: float, lon_deg: float
                               ) -> np.ndarray:
    """Unit 2-D vector (dx, dy) in the projected grid pointing to LOCAL north at (lat, lon).

    The projection is conformal, so the image of the 3-D north vector is a pure rotation+scale; we
    push N forward with a centred difference of the exact projection over 1 m.  In south polar
    stereographic this is (x, y)/|(x, y)| - radially away from the pole (towards the equator).
    """
    e, n, u = enu_basis(lat_deg, lon_deg)
    eps = 1.0 / proj.radius_m
    xp, yp = proj.forward_unit(u + eps * n)
    xm, ym = proj.forward_unit(u - eps * n)
    v = np.array([float(xp - xm), float(yp - ym)])
    return v / np.linalg.norm(v)


# ----------------------------------------------------------------------------------------------
# DEM access
# ----------------------------------------------------------------------------------------------
def _grid_params(patch: DemPatch) -> tuple[float, float, float, float]:
    x = np.asarray(patch.x_m, float)
    y = np.asarray(patch.y_m, float)
    if x.ndim != 1 or y.ndim != 1 or x.size < 2 or y.size < 2:
        raise ValueError("DemPatch x_m / y_m must be 1-D with >= 2 points")
    if patch.z_m.shape != (y.size, x.size):
        raise ValueError(f"DemPatch z_m shape {patch.z_m.shape} != (len(y), len(x)) = "
                         f"{(y.size, x.size)}")
    dx = (x[-1] - x[0]) / (x.size - 1)
    dy = (y[-1] - y[0]) / (y.size - 1)
    if dx <= 0 or dy <= 0:
        raise ValueError("DemPatch x_m and y_m must be increasing")
    if (np.max(np.abs(np.diff(x) - dx)) > 1e-6 * dx + 1e-6
            or np.max(np.abs(np.diff(y) - dy)) > 1e-6 * dy + 1e-6):
        raise ValueError("DemPatch grid must be uniformly spaced")
    return float(x[0]), float(y[0]), float(dx), float(dy)


def sample_patch_bilinear(patch: DemPatch, x_m: np.ndarray, y_m: np.ndarray) -> np.ndarray:
    """Bilinear height (m) at projected points; NaN outside the grid or if any corner is NaN."""
    x0, y0, dx, dy = _grid_params(patch)
    z = patch.z_m
    ny, nx = z.shape
    fx = (np.asarray(x_m, float) - x0) / dx
    fy = (np.asarray(y_m, float) - y0) / dy
    inside = (fx >= 0) & (fx <= nx - 1) & (fy >= 0) & (fy <= ny - 1)
    fx = np.where(inside, fx, 0.0)
    fy = np.where(inside, fy, 0.0)
    ix = np.minimum(np.floor(fx).astype(np.int64), nx - 2)
    iy = np.minimum(np.floor(fy).astype(np.int64), ny - 2)
    tx = fx - ix
    ty = fy - iy
    zf = z.reshape(-1)
    i00 = iy * nx + ix
    z00 = zf[i00].astype(float)
    z01 = zf[i00 + 1].astype(float)
    z10 = zf[i00 + nx].astype(float)
    z11 = zf[i00 + nx + 1].astype(float)
    h = (z00 * (1 - tx) * (1 - ty) + z01 * tx * (1 - ty) + z10 * (1 - tx) * ty + z11 * tx * ty)
    return np.where(inside, h, np.nan)


def rasterize_height_function(fn: HeightFunction, x_m: np.ndarray, y_m: np.ndarray,
                              crs_wkt: str | None = None, source: str = "callable") -> DemPatch:
    """Evaluate ``fn`` on a regular grid -> DemPatch (lets bruteforce run on analytic terrain)."""
    x_m = np.asarray(x_m, float)
    y_m = np.asarray(y_m, float)
    xx, yy = np.meshgrid(x_m, y_m)
    z = np.asarray(fn(xx, yy), dtype=float)
    return DemPatch(x_m=x_m, y_m=y_m, z_m=z, crs_wkt=crs_wkt or moon_polar_stereo_wkt(),
                    source=source, resolution_m=float(x_m[1] - x_m[0]))


def _resolve_projection(terrain: Terrain, projection: PolarStereographic | None
                        ) -> PolarStereographic:
    if projection is not None:
        return projection
    if isinstance(terrain, DemPatch):
        return PolarStereographic.from_crs(terrain.crs_wkt)
    return SOUTH_POLAR


def _site_surface_height(terrain: Terrain, site: Site, proj: PolarStereographic) -> float:
    if site.height_m is not None:
        return float(site.height_m)
    xs, ys = proj.latlon_to_xy(site.lat_deg, site.lon_deg)
    if isinstance(terrain, DemPatch):
        h = float(sample_patch_bilinear(terrain, np.atleast_1d(xs), np.atleast_1d(ys))[0])
    else:
        h = float(np.asarray(terrain(np.atleast_1d(xs), np.atleast_1d(ys)), float).reshape(-1)[0])
    if not np.isfinite(h):
        raise ValueError(f"site {site.id}: no valid DEM height at (lat={site.lat_deg}, "
                         f"lon={site.lon_deg}) -> x={float(xs):.1f} y={float(ys):.1f}; "
                         "site outside the patch or nodata; give Site.height_m explicitly")
    return h


def _az_grid(az_step_deg: float) -> np.ndarray:
    n = 360.0 / az_step_deg
    if az_step_deg <= 0 or abs(n - round(n)) > 1e-9:
        raise ValueError(f"az_step_deg must divide 360 exactly, got {az_step_deg}")
    return np.arange(int(round(n))) * az_step_deg


def _warn_coverage(method: str, site: Site, eff_km: np.ndarray, max_radius_km: float,
                   res_m: float) -> None:
    # tolerance: 1 % of the radius plus 2 pixels (the farthest cell centre / sample in a bin can
    # legitimately fall short of the requested radius by about one pixel)
    short = eff_km < max_radius_km - (0.01 * max_radius_km + 2.0 * res_m / 1000.0)
    if np.any(short):
        warnings.warn(
            f"{method} horizon for site {site.id}: terrain covered only to "
            f"{np.nanmin(eff_km):.2f} km (requested {max_radius_km:.1f} km) in {int(short.sum())}"
            f"/{eff_km.size} azimuths (patch edge or nodata); see meta['effective_radius_km']",
            RuntimeWarning, stacklevel=3)


# ----------------------------------------------------------------------------------------------
# Algorithm 1: ray marching along great circles
# ----------------------------------------------------------------------------------------------
def ray_distances_m(max_radius_m: float, step0_m: float, growth_m: float, s0_m: float) -> np.ndarray:
    """Sample distances: ds = step0 * (1 + s/growth), i.e. s_k = g((1+s0/g) e^{k step0/g} - 1)."""
    if not (step0_m > 0 and growth_m > 0 and 0 < s0_m < max_radius_m):
        raise ValueError("need step0 > 0, growth > 0, 0 < s0 < max_radius")
    g = growth_m
    n = int(math.ceil(g / step0_m * math.log((1 + max_radius_m / g) / (1 + s0_m / g)))) + 1
    s = g * ((1 + s0_m / g) * np.exp(np.arange(n) * step0_m / g) - 1)
    s = s[s < max_radius_m]
    return np.append(s, max_radius_m)


def resolve_near_exclusion_m(near_exclusion_m: float | str | None, resolution_m: float) -> float:
    """Near-field exclusion distance (m) actually applied by :func:`horizon_raymarch`.

    ``None`` / ``0`` -> 0 (nothing excluded); a number >= 0 -> that distance; ``"auto"`` ->
    ``config.NEAR_EXCLUSION_AUTO_M`` (250 m) when the finest DEM resolution is <= ``config.
    NEAR_EXCLUSION_AUTO_MAX_RES_M`` (5 m), else 0.  Rationale (docs/VALIDATION_TERRAIN.md §7): the
    Moon Trek LOLA v04 5 m DEM has 4-7 m knobs 12-60 m from rim sites that a 2 m mast cannot see
    over (false horizons up to 19 deg); 20-30 m DEMs smooth them, and there the 250 m cut would
    delete real horizon terrain.
    """
    if near_exclusion_m is None:
        return 0.0
    if isinstance(near_exclusion_m, str):
        if near_exclusion_m.strip().lower() == "auto":
            ok = resolution_m <= config.NEAR_EXCLUSION_AUTO_MAX_RES_M * (1 + 1e-9)
            return float(config.NEAR_EXCLUSION_AUTO_M) if ok else 0.0
        try:
            near_exclusion_m = float(near_exclusion_m)
        except ValueError:
            raise ValueError(f"near_exclusion_m must be 'auto' or a distance in m, got {near_exclusion_m!r}")
    v = float(near_exclusion_m)
    if not (math.isfinite(v) and v >= 0):
        raise ValueError(f"near_exclusion_m must be >= 0, got {near_exclusion_m!r}")
    return v


def horizon_raymarch(terrain: Terrain, site: Site,
                     observer_height_m: float = config.DEFAULT_OBSERVER_HEIGHT_M,
                     az_step_deg: float = config.DEFAULT_AZ_STEP_DEG,
                     max_radius_km: float = config.DEFAULT_HORIZON_RADIUS_KM, *,
                     projection: PolarStereographic | None = None,
                     resolution_m: float | None = None,
                     oversample: int = 3,
                     step_factor: float = 0.5,
                     step_growth_km: float = 20.0,
                     min_distance_m: float | None = None,
                     near_exclusion_m: float | str | None = None,
                     chunk_rays: int = 128,
                     dem_source: str | None = None) -> HorizonMask:
    """Horizon mask by marching great-circle rays from the site (exact 3-D elevation angles).

    Parameters
    ----------
    terrain : DemPatch (bilinear sampling, NaN = nodata) or height function h(x_m, y_m) in the
        projected grid of ``projection`` (default south polar stereographic, 1737.4 km sphere).
    observer_height_m : mast height above the local surface (m).
    az_step_deg : bin width / output spacing (deg); must divide 360.
    max_radius_km : ray length (arc distance on the 1737.4 km sphere, km).
    resolution_m : DEM pixel size (m); defaults to ``patch.resolution_m`` (required for callables).
    oversample : rays per azimuth bin, spread uniformly inside the bin; the bin value is their max.
    step_factor, step_growth_km : along-ray step ds = step_factor*res*(1 + s/growth) (m).
    min_distance_m : first sample distance (default 0.5*res; terrain closer is ignored).
    near_exclusion_m : additionally ignore terrain closer than this (m); ``"auto"`` = 250 m on
        DEMs of <= 5 m, nothing otherwise (:func:`resolve_near_exclusion_m`).  The first sample is
        ``max(min_distance_m or 0.5*res, near exclusion)``; both are recorded in ``meta``.

    Each terrain sample on the ray at arc angle theta has elevation
    ``atan2((R+h) cos(theta) - (R+h_s+mast), (R+h) sin(theta))`` - exact, includes curvature.
    """
    t_start = time.perf_counter()
    proj = _resolve_projection(terrain, projection)
    if isinstance(terrain, DemPatch):
        res = float(resolution_m or terrain.resolution_m)
        sampler = lambda x, y: sample_patch_bilinear(terrain, x, y)  # noqa: E731
        src = dem_source or terrain.source
    else:
        if resolution_m is None:
            raise ValueError("resolution_m is required when terrain is a height function")
        res = float(resolution_m)
        sampler = lambda x, y: np.asarray(terrain(x, y), dtype=float)  # noqa: E731
        src = dem_source or "callable"
    if oversample < 1:
        raise ValueError("oversample must be >= 1")
    hs = _site_surface_height(terrain, site, proj)
    az = _az_grid(az_step_deg)
    nbin = az.size
    E, N, U = enu_basis(site.lat_deg, site.lon_deg)
    smax = max_radius_km * 1000.0
    near_excl = resolve_near_exclusion_m(near_exclusion_m, res)
    min_dist = float(min_distance_m) if min_distance_m is not None else 0.5 * res
    s = ray_distances_m(smax, step_factor * res, step_growth_km * 1000.0, max(min_dist, near_excl))
    theta = s / R_M
    ct, st = np.cos(theta), np.sin(theta)
    half2 = 2.0 * np.sin(theta / 2.0) ** 2  # 1 - cos(theta), cancellation-free
    dh0 = hs + observer_height_m  # observer height above the sphere

    offs = az_step_deg * ((np.arange(oversample) + 0.5) / oversample - 0.5)
    ray_az = (az[:, None] + offs[None, :]).reshape(-1)  # bin-major
    nray = ray_az.size
    el_ray = np.empty(nray)
    dist_ray = np.empty(nray)
    eff_ray = np.empty(nray)
    nvalid_ray = np.empty(nray, dtype=np.int64)
    for i0 in range(0, nray, chunk_rays):
        a = np.radians(ray_az[i0:i0 + chunk_rays])
        d = np.cos(a)[:, None] * N[None, :] + np.sin(a)[:, None] * E[None, :]  # (m, 3)
        p = ct[None, :, None] * U[None, None, :] + st[None, :, None] * d[:, None, :]  # (m, n, 3)
        x, y = proj.forward_unit(p)
        h = sampler(x, y)
        r = R_M + h
        up = (h - dh0) - r * half2[None, :]
        hor = r * st[None, :]
        el = np.arctan2(up, hor)
        valid = np.isfinite(el)
        elm = np.where(valid, el, -np.inf)
        k = np.argmax(elm, axis=1)
        rows = np.arange(k.size)
        el_ray[i0:i0 + k.size] = elm[rows, k]
        dist_ray[i0:i0 + k.size] = s[k]
        eff_ray[i0:i0 + k.size] = np.max(np.where(valid, s[None, :], 0.0), axis=1)
        nvalid_ray[i0:i0 + k.size] = valid.sum(axis=1)

    el_b = el_ray.reshape(nbin, oversample)
    kb = np.argmax(el_b, axis=1)
    el_bin = el_b[np.arange(nbin), kb]
    dist_bin = dist_ray.reshape(nbin, oversample)[np.arange(nbin), kb]
    eff_bin = eff_ray.reshape(nbin, oversample).min(axis=1)
    nvalid_bin = nvalid_ray.reshape(nbin, oversample).sum(axis=1)
    missing = ~np.isfinite(el_bin)
    dip = math.radians(geometric_dip_deg(observer_height_m, hs))
    el_bin = np.where(missing, dip, el_bin)
    dist_bin = np.where(missing, np.nan, dist_bin)
    if np.any(missing):
        warnings.warn(f"raymarch horizon for site {site.id}: {int(missing.sum())} azimuth bins "
                      "have no valid terrain sample; filled with the smooth-sphere dip",
                      RuntimeWarning, stacklevel=2)
    eff_km = eff_bin / 1000.0
    _warn_coverage("raymarch", site, eff_km, max_radius_km, res)
    return HorizonMask(
        site_id=site.id, az_deg=az, el_deg=np.degrees(el_bin), method="raymarch", dem_source=src,
        radius_km=float(max_radius_km), observer_height_m=float(observer_height_m),
        surface_height_m=hs,
        meta={
            "bin_definition": "max terrain elevation in [az - step/2, az + step/2)",
            "effective_radius_km": eff_km,
            "min_effective_radius_km": float(np.min(eff_km)),
            "horizon_distance_km": dist_bin / 1000.0,
            "n_valid_samples": nvalid_bin,
            "missing_bins": missing,
            "oversample": oversample,
            "n_samples_per_ray": int(s.size),
            "resolution_m": res,
            "step_factor": step_factor,
            "step_growth_km": step_growth_km,
            "first_sample_m": float(s[0]),
            "min_distance_m": min_dist,
            "near_exclusion_m": near_excl,
            "near_exclusion_request": (near_exclusion_m if isinstance(near_exclusion_m, (str, type(None)))
                                       else float(near_exclusion_m)),
            "projection": proj.to_proj4(),
            "runtime_s": time.perf_counter() - t_start,
        })


# ----------------------------------------------------------------------------------------------
# Algorithm 2: brute force over every DEM cell
# ----------------------------------------------------------------------------------------------
def _az_el_from_observer(P: np.ndarray, O: np.ndarray, E: np.ndarray, N: np.ndarray,
                         U: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Exact az (deg [0,360)), el (deg) and horizontal distance (m) of 3-D points P from O."""
    v = P - O
    ve = v @ E
    vn = v @ N
    vu = v @ U
    hor = np.hypot(ve, vn)
    az = np.mod(np.degrees(np.arctan2(ve, vn)), 360.0)
    el = np.degrees(np.arctan2(vu, hor))
    return az, el, hor


#: Name of the brute-force footprint model (recorded in the manifest parameters, so that a change
#: of the model changes the resume fingerprint).  "central-half-cap6-floor-40px-v3": within 40 px of
#: the mast a wide cell's centre elevation is spread over the azimuths of its central half, at most
#: 6 deg wide (+-3 deg around the centre azimuth), and each of its 4 quadrants additionally
#: contributes the LOWEST value the bilinear surface takes in that quadrant (a floor, so that every
#: azimuth through the cell is covered); farther away the centre elevation covers the whole cell
#: (docs/VALIDATION_TERRAIN.md §7).  Former models: "whole-cell-v1" (whole cell everywhere,
#: ``footprint_extent=1.0``), "central-half-40px-v2" (central half without cap and floor,
#: ``footprint_floor=False, footprint_max_deg=None``: it left blind azimuth wedges along the grid axes).
BRUTEFORCE_FOOTPRINT_MODEL = "central-half-cap6-floor-40px-v3"


def _spread(elmax: np.ndarray, az: np.ndarray, rel: np.ndarray, el: np.ndarray, w: float,
            nbin: int) -> None:
    """elmax[bin] = max(elmax[bin], el) for every bin overlapped by [az + min(rel), az + max(rel)]."""
    lo = az + np.minimum(rel.min(axis=0), 0.0)
    hi = az + np.maximum(rel.max(axis=0), 0.0)
    blo = np.floor((lo + 0.5 * w) / w).astype(np.int64)
    bhi = np.floor((hi + 0.5 * w) / w).astype(np.int64)
    nspan = np.minimum(bhi - blo, nbin - 1) + 1
    start = np.repeat(blo, nspan)
    offs = np.arange(int(nspan.sum())) - np.repeat(np.cumsum(nspan) - nspan, nspan)
    np.maximum.at(elmax, (start + offs) % nbin, np.repeat(el, nspan))


_QUADRANTS = ((-1, -1), (-1, 1), (1, -1), (1, 1))  # (sign of x offset, sign of y offset)


def _footprint_model_name(extent: float, near_px: float, floor: bool, max_deg: float | None) -> str:
    if extent >= 1.0:
        return "whole-cell-v1"
    cap = None if max_deg is None else float(max_deg)
    key = (float(extent), float(near_px), bool(floor), cap)
    if key == (0.5, 40.0, True, 6.0):
        return BRUTEFORCE_FOOTPRINT_MODEL
    if key == (0.5, 40.0, False, None):
        return "central-half-40px-v2"
    return (f"extent-{extent:g}-within-{near_px:g}px" + ("" if cap is None else f"-cap{cap:g}")
            + ("-floor" if floor else ""))


def _quadrant_floors(zall: np.ndarray, r0: int, r1: int, c0: int, c1: int, ny: int, nx: int) -> np.ndarray:
    """(4, r1-r0, c1-c0): lowest bilinear value in each quadrant of the cells [r0:r1, c0:c1].

    Quadrant order :data:`_QUADRANTS` (sign of the x / y offset from the cell centre; x_m and y_m are
    increasing, so +x is column c+1 and +y row r+1).  In the quadrant towards neighbours x, y and
    xy the bilinear surface is bilinear between the centre z_c, the edge midpoints (z_c+z_x)/2,
    (z_c+z_y)/2 and the corner (z_c+z_x+z_y+z_xy)/4, so its minimum is the lowest of the four.
    Missing (NaN / outside the patch) neighbours are taken as z_c.
    """
    ra, rb, ca, cb = max(r0 - 1, 0), min(r1 + 1, ny), max(c0 - 1, 0), min(c1 + 1, nx)
    zp = np.full((r1 - r0 + 2, c1 - c0 + 2), np.nan)
    zp[ra - (r0 - 1):rb - (r0 - 1), ca - (c0 - 1):cb - (c0 - 1)] = np.asarray(zall[ra:rb, ca:cb], dtype=float)
    zc = zp[1:-1, 1:-1]
    out = np.empty((4,) + zc.shape)

    def nb(dr: int, dc: int) -> np.ndarray:
        v = zp[1 + dr:zp.shape[0] - 1 + dr, 1 + dc:zp.shape[1] - 1 + dc]
        return np.where(np.isfinite(v), v, zc)

    for q, (sx, sy) in enumerate(_QUADRANTS):
        zx, zy, zxy = nb(0, sx), nb(sy, 0), nb(sy, sx)
        out[q] = np.minimum(np.minimum(zc, 0.5 * (zc + zx)),
                            np.minimum(0.5 * (zc + zy), 0.25 * (zc + zx + zy + zxy)))
    return out


def horizon_bruteforce(patch: DemPatch, site: Site,
                       observer_height_m: float = config.DEFAULT_OBSERVER_HEIGHT_M,
                       az_step_deg: float = config.DEFAULT_AZ_STEP_DEG,
                       max_radius_km: float = config.DEFAULT_HORIZON_RADIUS_KM, *,
                       projection: PolarStereographic | None = None,
                       footprint_fraction: float = 0.25,
                       footprint_extent: float = 0.5,
                       footprint_near_px: float = 40.0,
                       footprint_floor: bool = True,
                       footprint_max_deg: float | None = 6.0,
                       min_distance_m: float = 0.0,
                       row_chunk: int = 256,
                       dem_source: str | None = None) -> HorizonMask:
    """Horizon mask from ALL DEM cells: exact 3-D az/el of each cell centre, max per azimuth bin.

    Every valid (finite) cell within ``max_radius_km`` (arc distance) is converted with the INVERSE
    projection to ``(R + z) u``; az/el are taken from the observer's ENU frame.  Cells whose
    estimated angular width exceeds ``footprint_fraction * az_step`` also contribute their centre
    elevation to every bin overlapped by their azimuth FOOTPRINT, taken from the azimuths of 4 corners:
      * cells closer than ``footprint_near_px`` pixels (ground distance, default 40 px = 800 m on a
        20 m DEM): the corners of the cell's CENTRAL part of side ``footprint_extent`` x pixel
        (default 0.5: the central half, where the centre sample carries more than half (>= 0.56)
        of the bilinear weight), clipped to ``footprint_max_deg`` (default 6 deg, i.e. +-3 deg
        around the centre azimuth: a 30 m cell 40 m from the mast would otherwise spread its centre
        elevation over ~20 deg of a slope it only reaches at its centre; im1_odysseus -1.5 pp
        without the cap, -0.15 pp with it).  With ``footprint_floor`` (default) each of the cell's 4 quadrants
        (centre - edge midpoints - corner) also contributes, over its own azimuth range, the
        elevation of the LOWEST value the bilinear surface of the 3x3 neighbourhood takes in it
        (``min(z_c, (z_c+z_x)/2, (z_c+z_y)/2, (z_c+z_x+z_y+z_xy)/4)``, missing neighbours = z_c),
        placed at the cell centre.  This floor does not exceed the surface raymarch samples there,
        and it closes the azimuth gaps the central halves leave between neighbouring cells (without
        it, terrain within ~30 px is invisible in wedges along the grid axes and diagonals);
      * farther cells: the whole cell (flat-topped block), as before.
    Why (docs/VALIDATION_TERRAIN.md §7): near the mast one 20 m cell spans up to 60 deg of azimuth,
    and spreading its centre elevation over the whole cell made brute force conservative against
    the converged (15 rays / bin) raymarch by 0.5-3.4 pp of sunlight at Artemis rim sites (Mons
    Mouton -3.1, Cabeus B -3.4 pp), while no spreading at all overshoots (+10.9 pp at Mons Mouton).
    ``footprint_extent=1.0`` restores the former whole-cell model; ``footprint_floor=False,
    footprint_max_deg=None`` the gap-leaving central-half model "central-half-40px-v2".  Beyond 40 px the whole-cell footprint
    keeps the documented far-field agreement (p95 < 0.1 deg).  The algorithm stays independent of
    raymarch: no rays, no sampling along a ray, every cell centre exact.
    The cell containing the site is skipped (it is the ground under the observer), as are cells
    closer than ``min_distance_m`` (arc distance), to mirror raymarch's ``min_distance_m``.
    Memory is bounded by processing ``row_chunk`` rows at a time.
    """
    t_start = time.perf_counter()
    proj = _resolve_projection(patch, projection)
    x0, y0, dx, dy = _grid_params(patch)
    hs = _site_surface_height(patch, site, proj)
    az_grid = _az_grid(az_step_deg)
    nbin = az_grid.size
    w = az_step_deg
    E, N, U = enu_basis(site.lat_deg, site.lon_deg)
    O = (R_M + hs + observer_height_m) * U
    xs, ys = proj.forward_unit(U)
    xs, ys = float(xs), float(ys)
    smax = max_radius_km * 1000.0
    cos_max = math.cos(smax / R_M)
    x = np.asarray(patch.x_m, float)
    y = np.asarray(patch.y_m, float)
    # rows/cols that can possibly be within range (grid scale k >= 1 near the pole is not assumed:
    # use a generous 2x bound in grid metres, the exact arc-distance test is done per cell)
    k_site = float(proj.scale_factor(site.lat_deg))
    reach = 2.0 * smax * max(k_site, 1.0)
    cols = np.nonzero(np.abs(x - xs) <= reach)[0]
    rows = np.nonzero(np.abs(y - ys) <= reach)[0]
    elmax = np.full(nbin, -np.inf)
    eff = np.zeros(nbin)
    count = np.zeros(nbin, dtype=np.int64)
    n_cells = 0
    n_footprint = 0
    n_near = 0
    n_floor = 0
    width_lim_rad = math.radians(footprint_fraction * w)
    half_diag = 0.5 * math.hypot(dx, dy)
    if not (0.0 <= footprint_extent <= 1.0):
        raise ValueError(f"footprint_extent must be in [0, 1], got {footprint_extent}")
    hx, hy = 0.5 * footprint_extent * dx, 0.5 * footprint_extent * dy  # footprint corner offsets
    if cols.size and rows.size:
        c0, c1 = int(cols[0]), int(cols[-1]) + 1
        xc = x[c0:c1]
        use_floor = bool(footprint_floor) and footprint_extent < 1.0
        ny_all, nx_all = patch.z_m.shape
        for r0 in range(int(rows[0]), int(rows[-1]) + 1, row_chunk):
            r1 = min(r0 + row_chunk, int(rows[-1]) + 1)
            z = np.asarray(patch.z_m[r0:r1, c0:c1], dtype=float)
            X, Y = np.meshgrid(xc, y[r0:r1])
            own = (np.abs(X - xs) < 0.5 * dx) & (np.abs(Y - ys) < 0.5 * dy)
            ok = np.isfinite(z) & ~own
            if not ok.any():
                continue
            qfloor = _quadrant_floors(patch.z_m, r0, r1, c0, c1, ny_all, nx_all)[:, ok] if use_floor else None
            X, Y, z = X[ok], Y[ok], z[ok]
            u = proj.inverse_unit(X, Y)
            cosd = u @ U
            inr = cosd >= cos_max
            if not inr.any():
                continue
            X, Y, z, u, cosd = X[inr], Y[inr], z[inr], u[inr], cosd[inr]
            if use_floor:
                qfloor = qfloor[:, inr]
            arc = R_M * np.arctan2(np.linalg.norm(np.cross(u, U), axis=-1), cosd)
            if min_distance_m > 0:
                far = arc >= min_distance_m
                X, Y, z, u, arc = X[far], Y[far], z[far], u[far], arc[far]
                if use_floor:
                    qfloor = qfloor[:, far]
                if not arc.size:
                    continue
            P = (R_M + z)[:, None] * u
            az, el, hor = _az_el_from_observer(P, O, E, N, U)
            b = np.floor((az + 0.5 * w) / w).astype(np.int64) % nbin
            np.maximum.at(elmax, b, el)
            np.maximum.at(eff, b, arc)
            np.add.at(count, b, 1)
            n_cells += az.size
            # wide cells: spread their centre elevation over every bin overlapped by their footprint
            # = azimuth range of the corners of the cell's central part (side footprint_extent x
            # pixel) for cells closer than footprint_near_px pixels, of the whole cell farther away
            k = proj.scale_factor(unit_to_latlon(u)[0])
            wide = (2.0 * half_diag / k) / np.maximum(hor, 1e-9) > width_lim_rad
            if wide.any():
                Xw, Yw, zw, azw, elw = X[wide], Y[wide], z[wide], az[wide], el[wide]
                near = hor[wide] < footprint_near_px * min(dx, dy) / k[wide]
                ox = np.where(near, hx, 0.5 * dx)
                oy = np.where(near, hy, 0.5 * dy)
                rel = []
                for sx, sy in ((-1, -1), (-1, 1), (1, -1), (1, 1)):
                    uc = proj.inverse_unit(Xw + sx * ox, Yw + sy * oy)
                    azc, _, _ = _az_el_from_observer((R_M + zw)[:, None] * uc, O, E, N, U)
                    rel.append((azc - azw + 180.0) % 360.0 - 180.0)
                rel = np.stack(rel)
                if footprint_max_deg is not None and footprint_extent < 1.0:
                    c = 0.5 * float(footprint_max_deg)
                    rel = np.where(near[None, :], np.clip(rel, -c, c), rel)
                _spread(elmax, azw, rel, elw, w, nbin)
                n_near += int(near.sum())
                n_footprint += int(wide.sum())
                if use_floor and near.any():
                    # quadrant floors of the near cells: lowest bilinear value of each quadrant,
                    # spread over the quadrant's azimuth range (centre, 2 edge midpoints, corner)
                    sel = np.nonzero(wide)[0][near]
                    Xn, Yn, zn, azn, un = X[sel], Y[sel], z[sel], az[sel], u[sel]

                    def rel_az(px, py):
                        uc = proj.inverse_unit(px, py)
                        a, _, _ = _az_el_from_observer((R_M + zn)[:, None] * uc, O, E, N, U)
                        return (a - azn + 180.0) % 360.0 - 180.0

                    ex = {sx: rel_az(Xn + sx * 0.5 * dx, Yn) for sx in (-1, 1)}
                    ey = {sy: rel_az(Xn, Yn + sy * 0.5 * dy) for sy in (-1, 1)}
                    for q, (sx, sy) in enumerate(_QUADRANTS):
                        _, elq, _ = _az_el_from_observer((R_M + qfloor[q, sel])[:, None] * un, O, E, N, U)
                        relq = np.stack([ex[sx], ey[sy], rel_az(Xn + sx * 0.5 * dx, Yn + sy * 0.5 * dy)])
                        _spread(elmax, azn, relq, elq, w, nbin)
                    n_floor += int(sel.size)
    missing = ~np.isfinite(elmax)
    dip = geometric_dip_deg(observer_height_m, hs)
    el_out = np.where(missing, dip, elmax)
    if np.any(missing):
        warnings.warn(f"bruteforce horizon for site {site.id}: {int(missing.sum())} azimuth bins "
                      "contain no valid DEM cell; filled with the smooth-sphere dip",
                      RuntimeWarning, stacklevel=2)
    eff_km = eff / 1000.0
    _warn_coverage("bruteforce", site, eff_km, max_radius_km, dx)
    return HorizonMask(
        site_id=site.id, az_deg=az_grid, el_deg=el_out, method="bruteforce",
        dem_source=dem_source or patch.source, radius_km=float(max_radius_km),
        observer_height_m=float(observer_height_m), surface_height_m=hs,
        meta={
            "bin_definition": "max terrain elevation in [az - step/2, az + step/2)",
            "effective_radius_km": eff_km,
            "min_effective_radius_km": float(np.min(eff_km)),
            "n_cells": n_cells,
            "n_cells_per_bin": count,
            "n_footprint_cells": n_footprint,
            "n_footprint_cells_central": n_near,
            "n_footprint_cells_floor": n_floor,
            "missing_bins": missing,
            "resolution_m": float(dx),
            "min_distance_m": float(min_distance_m),
            "footprint_fraction": float(footprint_fraction),
            "footprint_extent": float(footprint_extent),
            "footprint_near_px": float(footprint_near_px),
            "footprint_floor": bool(footprint_floor and footprint_extent < 1.0),
            "footprint_max_deg": (None if footprint_max_deg is None or footprint_extent >= 1.0
                                  else float(footprint_max_deg)),
            "footprint_model": _footprint_model_name(footprint_extent, footprint_near_px, footprint_floor,
                                                     footprint_max_deg),
            "projection": proj.to_proj4(),
            "runtime_s": time.perf_counter() - t_start,
        })


# ----------------------------------------------------------------------------------------------
# Smooth sphere + helpers
# ----------------------------------------------------------------------------------------------
def horizon_flat(site: Site, observer_height_m: float = config.DEFAULT_OBSERVER_HEIGHT_M,
                 az_step_deg: float = config.DEFAULT_AZ_STEP_DEG,
                 surface_height_m: float | None = None) -> HorizonMask:
    """Mask of a perfectly smooth sphere of radius R + surface height: constant geometric dip."""
    hs = float(surface_height_m if surface_height_m is not None else (site.height_m or 0.0))
    az = _az_grid(az_step_deg)
    dip = geometric_dip_deg(observer_height_m, hs)
    return HorizonMask(site_id=site.id, az_deg=az, el_deg=np.full(az.size, dip), method="flat",
                       dem_source="none", radius_km=float("inf"),
                       observer_height_m=float(observer_height_m), surface_height_m=hs,
                       meta={"horizon_distance_km": horizon_distance_m(observer_height_m, hs) / 1e3})


def compute_horizon(terrain: Terrain | None, site: Site, method: str = "raymarch",
                    **kwargs) -> HorizonMask:
    """Dispatcher: method in {"raymarch", "bruteforce", "flat"}.

    ``near_exclusion_m`` (raymarch near-field exclusion, ``"auto"`` = 250 m on <= 5 m DEMs, see
    :func:`resolve_near_exclusion_m`) is a raymarch option; for bruteforce only ``None`` /
    ``"auto"`` / 0 are accepted (nothing excluded), any other value raises ValueError.
    """
    if method == "raymarch":
        return horizon_raymarch(terrain, site, **kwargs)
    if method == "bruteforce":
        if not isinstance(terrain, DemPatch):
            raise TypeError("bruteforce needs a DemPatch (use rasterize_height_function)")
        ne = kwargs.pop("near_exclusion_m", None)
        if ne is not None and not (isinstance(ne, str) and ne.strip().lower() == "auto") \
                and resolve_near_exclusion_m(ne, 1.0) > 0:
            raise ValueError("near_exclusion_m applies to the raymarch method only")
        return horizon_bruteforce(terrain, site, **kwargs)
    if method == "flat":
        return horizon_flat(site, **kwargs)
    raise ValueError(f"unknown horizon method {method!r}")


def compare_masks(a: HorizonMask, b: HorizonMask) -> dict:
    """Difference statistics (deg) of two masks on the same azimuth grid: a - b."""
    if a.az_deg.shape != b.az_deg.shape or not np.allclose(a.az_deg, b.az_deg):
        raise ValueError("masks must share the same azimuth grid")
    d = np.asarray(a.el_deg, float) - np.asarray(b.el_deg, float)
    ad = np.abs(d)
    i = int(np.argmax(ad))
    return {"max_abs_deg": float(ad[i]), "az_of_max_deg": float(a.az_deg[i]),
            "p95_abs_deg": float(np.percentile(ad, 95)), "rms_deg": float(np.sqrt(np.mean(d * d))),
            "mean_deg": float(np.mean(d))}
