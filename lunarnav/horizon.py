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
* :func:`horizon_bruteforce` - converts EVERY DEM cell to 3-D, computes its exact azimuth/elevation
  and takes the per-bin maximum; a cell whose footprint spans several bins contributes to all of them
  (footprint from the azimuths of its 4 corners).  Completely separate code path (inverse projection,
  full vector arithmetic, no interpolation, no rays).
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
    "horizon_raymarch",
    "horizon_bruteforce",
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
    s = ray_distances_m(smax, step_factor * res, step_growth_km * 1000.0,
                        min_distance_m if min_distance_m is not None else 0.5 * res)
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


def horizon_bruteforce(patch: DemPatch, site: Site,
                       observer_height_m: float = config.DEFAULT_OBSERVER_HEIGHT_M,
                       az_step_deg: float = config.DEFAULT_AZ_STEP_DEG,
                       max_radius_km: float = config.DEFAULT_HORIZON_RADIUS_KM, *,
                       projection: PolarStereographic | None = None,
                       footprint_fraction: float = 0.25,
                       min_distance_m: float = 0.0,
                       row_chunk: int = 256,
                       dem_source: str | None = None) -> HorizonMask:
    """Horizon mask from ALL DEM cells: exact 3-D az/el of each cell centre, max per azimuth bin.

    Every valid (finite) cell within ``max_radius_km`` (arc distance) is converted with the INVERSE
    projection to ``(R + z) u``; az/el are taken from the observer's ENU frame.  Cells whose
    estimated angular width exceeds ``footprint_fraction * az_step`` get their footprint from the
    azimuths of their 4 corners and contribute their (centre) elevation to every bin it overlaps.
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
    width_lim_rad = math.radians(footprint_fraction * w)
    half_diag = 0.5 * math.hypot(dx, dy)
    if cols.size and rows.size:
        c0, c1 = int(cols[0]), int(cols[-1]) + 1
        xc = x[c0:c1]
        for r0 in range(int(rows[0]), int(rows[-1]) + 1, row_chunk):
            r1 = min(r0 + row_chunk, int(rows[-1]) + 1)
            z = np.asarray(patch.z_m[r0:r1, c0:c1], dtype=float)
            X, Y = np.meshgrid(xc, y[r0:r1])
            own = (np.abs(X - xs) < 0.5 * dx) & (np.abs(Y - ys) < 0.5 * dy)
            ok = np.isfinite(z) & ~own
            if not ok.any():
                continue
            X, Y, z = X[ok], Y[ok], z[ok]
            u = proj.inverse_unit(X, Y)
            cosd = u @ U
            inr = cosd >= cos_max
            if not inr.any():
                continue
            X, Y, z, u, cosd = X[inr], Y[inr], z[inr], u[inr], cosd[inr]
            arc = R_M * np.arctan2(np.linalg.norm(np.cross(u, U), axis=-1), cosd)
            if min_distance_m > 0:
                far = arc >= min_distance_m
                X, Y, z, u, arc = X[far], Y[far], z[far], u[far], arc[far]
                if not arc.size:
                    continue
            P = (R_M + z)[:, None] * u
            az, el, hor = _az_el_from_observer(P, O, E, N, U)
            b = np.floor((az + 0.5 * w) / w).astype(np.int64) % nbin
            np.maximum.at(elmax, b, el)
            np.maximum.at(eff, b, arc)
            np.add.at(count, b, 1)
            n_cells += az.size
            # wide cells: spread over all bins overlapped by the footprint (corner azimuths)
            k = proj.scale_factor(unit_to_latlon(u)[0])
            wide = (2.0 * half_diag / k) / np.maximum(hor, 1e-9) > width_lim_rad
            if wide.any():
                Xw, Yw, zw, azw, elw = X[wide], Y[wide], z[wide], az[wide], el[wide]
                rel = []
                for sx, sy in ((-1, -1), (-1, 1), (1, -1), (1, 1)):
                    uc = proj.inverse_unit(Xw + sx * 0.5 * dx, Yw + sy * 0.5 * dy)
                    azc, _, _ = _az_el_from_observer((R_M + zw)[:, None] * uc, O, E, N, U)
                    rel.append((azc - azw + 180.0) % 360.0 - 180.0)
                rel = np.stack(rel)
                lo = azw + np.minimum(rel.min(axis=0), 0.0)
                hi = azw + np.maximum(rel.max(axis=0), 0.0)
                blo = np.floor((lo + 0.5 * w) / w).astype(np.int64)
                bhi = np.floor((hi + 0.5 * w) / w).astype(np.int64)
                nspan = np.minimum(bhi - blo, nbin - 1) + 1
                start = np.repeat(blo, nspan)
                offs = np.arange(int(nspan.sum())) - np.repeat(np.cumsum(nspan) - nspan, nspan)
                bins = (start + offs) % nbin
                np.maximum.at(elmax, bins, np.repeat(elw, nspan))
                n_footprint += int(wide.sum())
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
            "missing_bins": missing,
            "resolution_m": float(dx),
            "min_distance_m": float(min_distance_m),
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
    """Dispatcher: method in {"raymarch", "bruteforce", "flat"}."""
    if method == "raymarch":
        return horizon_raymarch(terrain, site, **kwargs)
    if method == "bruteforce":
        if not isinstance(terrain, DemPatch):
            raise TypeError("bruteforce needs a DemPatch (use rasterize_height_function)")
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
