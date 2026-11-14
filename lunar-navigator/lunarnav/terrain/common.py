"""Shared terrain helpers: polar stereographic projection, DEM grids, sampling, caching, nesting.

Conventions (see ``lunarnav/types.py``):
  * lat: planetocentric degrees; lon: EAST degrees (any range accepted, outputs in [0, 360)).
  * Projection: spherical polar stereographic on the R = 1737.4 km LOLA sphere, true scale (k=1)
    at the pole, central meridian 0 E, no false easting/northing - exactly the CRS of the NASA
    GSFC PGDA LOLA products and of the Moon Trek polar ImageServers (verified, docs/DATA_SOURCES.md):
      south:  rho = 2 R tan((90 + lat)/2),  x = rho sin(lon),  y =  rho cos(lon)
      north:  rho = 2 R tan((90 - lat)/2),  x = rho sin(lon),  y = -rho cos(lon)
    i.e. PROJ ``+proj=stere +lat_0=-90 +lon_0=0 +k=1 +x_0=0 +y_0=0 +R=1737400 +units=m``.
    At the south pole +y points along the 0 E meridian and +x along 90 E.
  * Heights: metres above the 1737.4 km sphere; NaN = nodata (never 0).
  * Raster grids: ``RasterGrid`` describes a north-up raster (row 0 = TOP = max y), as stored in
    GeoTIFFs; ``DemPatch`` (types.py) is the opposite: y_m INCREASING, i.e. row 0 = BOTTOM.
    ``patch_from_raster_window`` does the flip.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import time
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Sequence

import numpy as np

from .. import config
from ..types import DemPatch, DemSource

log = logging.getLogger(__name__)

R_M: float = config.MOON_RADIUS_M
Hemisphere = Literal["south", "north"]

#: Physically plausible LOLA heights above the 1737.4 km sphere (global min ~ -9.1 km in
#: SPA basin, max ~ +10.8 km near Engel'gardt).  Values outside this band after unit conversion
#: mean a wrong scale factor / unit, so we raise instead of silently producing garbage.
PLAUSIBLE_HEIGHT_RANGE_M: tuple[float, float] = (-12_000.0, 12_000.0)

#: Values at or below this are treated as nodata sentinels (e.g. -3.4028235e38 from ArcGIS,
#: 1.1754939e-38 is handled via the explicit nodata value of the Trek Float32 file).
_SENTINEL_LOW = -1.0e30


# ================================================================================================
# Projection
# ================================================================================================
def normalize_lon(lon_deg: np.ndarray | float) -> np.ndarray:
    """East longitude normalised to [0, 360)."""
    lon = np.mod(np.asarray(lon_deg, dtype=float), 360.0)
    return np.where(lon >= 360.0, 0.0, lon)  # mod can return 360.0 for tiny negative inputs


def hemisphere_of(lat_deg: float) -> Hemisphere:
    """'south' for lat < 0 else 'north'."""
    return "south" if float(lat_deg) < 0.0 else "north"


def latlon_to_ps(lat_deg: np.ndarray | float, lon_deg: np.ndarray | float,
                 hemisphere: Hemisphere = "south", radius_m: float = R_M
                 ) -> tuple[np.ndarray, np.ndarray]:
    """(lat, lon) degrees -> polar stereographic (x, y) metres (closed form, vectorised).

    Points in the opposite hemisphere are still projected (finite except exactly at the opposite
    pole, which maps to +-inf); callers decide whether they are inside their DEM.
    """
    lat = np.radians(np.asarray(lat_deg, dtype=float))
    lon = np.radians(np.asarray(lon_deg, dtype=float))
    if hemisphere == "south":
        with np.errstate(over="ignore", invalid="ignore"):
            rho = 2.0 * radius_m * np.tan((np.pi / 2 + lat) / 2.0)
        return rho * np.sin(lon), rho * np.cos(lon)
    if hemisphere == "north":
        with np.errstate(over="ignore", invalid="ignore"):
            rho = 2.0 * radius_m * np.tan((np.pi / 2 - lat) / 2.0)
        return rho * np.sin(lon), -rho * np.cos(lon)
    raise ValueError(f"hemisphere must be 'south' or 'north', got {hemisphere!r}")


def ps_to_latlon(x_m: np.ndarray | float, y_m: np.ndarray | float,
                 hemisphere: Hemisphere = "south", radius_m: float = R_M
                 ) -> tuple[np.ndarray, np.ndarray]:
    """Polar stereographic (x, y) metres -> (lat, lon) degrees, lon in [0, 360).

    At the pole itself (x = y = 0) the longitude is undefined and returned as 0.
    """
    x = np.asarray(x_m, dtype=float)
    y = np.asarray(y_m, dtype=float)
    rho = np.hypot(x, y)
    colat = 2.0 * np.arctan2(rho, 2.0 * radius_m)  # angular distance from the projection pole
    if hemisphere == "south":
        lat = -90.0 + np.degrees(colat)
        lon = np.degrees(np.arctan2(x, y))
    elif hemisphere == "north":
        lat = 90.0 - np.degrees(colat)
        lon = np.degrees(np.arctan2(x, -y))
    else:
        raise ValueError(f"hemisphere must be 'south' or 'north', got {hemisphere!r}")
    return lat, normalize_lon(lon)


def ps_proj4(hemisphere: Hemisphere = "south", radius_m: float = R_M) -> str:
    """PROJ string of the LOLA polar stereographic CRS used everywhere in lunarnav.terrain."""
    lat0 = -90 if hemisphere == "south" else 90
    return (f"+proj=stere +lat_0={lat0} +lon_0=0 +k=1 +x_0=0 +y_0=0 +R={radius_m:.1f} "
            f"+units=m +no_defs")


def ps_crs_wkt(hemisphere: Hemisphere = "south") -> str:
    """WKT (pyproj WKT2) of :func:`ps_proj4`; stored in ``DemPatch.crs_wkt``."""
    import pyproj

    return pyproj.CRS.from_proj4(ps_proj4(hemisphere)).to_wkt()


def geographic_proj4(radius_m: float = R_M) -> str:
    """Geographic (planetocentric lat / east lon) CRS on the LOLA sphere."""
    return f"+proj=longlat +R={radius_m:.1f} +no_defs"


def pyproj_ps_transformers(hemisphere: Hemisphere = "south"):
    """Independent second method: pyproj Transformers (geographic->PS, PS->geographic), always_xy."""
    import pyproj

    geo = pyproj.CRS.from_proj4(geographic_proj4())
    ps = pyproj.CRS.from_proj4(ps_proj4(hemisphere))
    return (pyproj.Transformer.from_crs(geo, ps, always_xy=True),
            pyproj.Transformer.from_crs(ps, geo, always_xy=True))


#: Test points (lat, lon) used to verify that a DEM CRS equals our projection.
_CRS_CHECK_LATLON_SOUTH = np.array([[-89.9, 0.0], [-89.0, 45.0], [-88.0, 137.0], [-85.0, 222.5],
                                    [-80.0, 300.0], [-75.0, 10.0], [-89.66, 129.2]])


def verify_ps_crs(crs_wkt_or_proj: str, hemisphere: Hemisphere, tol_m: float = 1e-3) -> None:
    """Raise ValueError unless a DEM's CRS maps lat/lon exactly like :func:`latlon_to_ps`.

    Robust to naming differences in WKT (IAU codes, ESRI "Stereographic_South_Pole", odd AXIS
    tags in the PGDA files): we compare actual transformed coordinates with pyproj, tol 1 mm.
    """
    import pyproj

    crs = pyproj.CRS.from_user_input(crs_wkt_or_proj)
    if not crs.is_projected:
        raise ValueError(f"DEM CRS is not projected: {crs.name}")
    ell = crs.ellipsoid
    if ell is None or abs(ell.semi_major_metre - R_M) > 0.5 or abs(ell.semi_minor_metre - R_M) > 0.5:
        raise ValueError(f"DEM CRS body is not the 1737.4 km sphere: {ell}")
    pts = _CRS_CHECK_LATLON_SOUTH.copy()
    if hemisphere == "north":
        pts[:, 0] = -pts[:, 0]
    geo = pyproj.CRS.from_proj4(geographic_proj4())
    tr = pyproj.Transformer.from_crs(geo, crs, always_xy=True)
    xp, yp = tr.transform(pts[:, 1], pts[:, 0])
    xo, yo = latlon_to_ps(pts[:, 0], pts[:, 1], hemisphere)
    err = float(np.max(np.hypot(np.asarray(xp) - xo, np.asarray(yp) - yo)))
    if not np.isfinite(err) or err > tol_m:
        raise ValueError(f"DEM CRS {crs.name!r} differs from the lunarnav {hemisphere} polar "
                         f"stereographic projection by {err:.3g} m (> {tol_m} m)")


def _hemisphere_of_crs(crs_wkt: str) -> Hemisphere:
    """'south'/'north' from the latitude of origin of a polar stereographic CRS."""
    import pyproj

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        d = pyproj.CRS.from_user_input(crs_wkt).to_dict()
    lat0 = float(d.get("lat_0", 0.0))
    if abs(abs(lat0) - 90.0) > 1e-6:
        raise ValueError(f"CRS is not polar stereographic (lat_0={lat0})")
    return "south" if lat0 < 0 else "north"


# ================================================================================================
# Height unit handling
# ================================================================================================
def to_metres(raw: np.ndarray, scale: float = 1.0, offset: float = 0.0,
              nodata: float | Sequence[float] | None = None, check_range: bool = True) -> np.ndarray:
    """Raw DEM values -> float32 metres above the 1737.4 km sphere with NaN for nodata.

    ``height_m = raw * scale + offset`` (e.g. Trek Int16 LOLA products: scale = 0.5, i.e. stored
    in half-metres).  Nodata: ``raw == nodata`` (one value or a sequence), NaN, and values <= -1e30
    (ArcGIS sentinel).  Raises ValueError if any valid result lies outside
    PLAUSIBLE_HEIGHT_RANGE_M (wrong units).
    """
    a = np.asarray(raw)
    bad = ~np.isfinite(a) if np.issubdtype(a.dtype, np.floating) else np.zeros(a.shape, bool)
    nds = [] if nodata is None else (list(nodata) if isinstance(nodata, (list, tuple, set)) else [nodata])
    for nd in nds:
        if nd is not None and not (isinstance(nd, float) and math.isnan(nd)):
            bad |= a == np.asarray(nd, dtype=a.dtype)
    if np.issubdtype(a.dtype, np.floating):
        bad |= a <= _SENTINEL_LOW
    z = a.astype(np.float32) * np.float32(scale) + np.float32(offset)
    z[bad] = np.nan
    if check_range and z.size and np.any(~bad):
        lo, hi = float(np.nanmin(z)), float(np.nanmax(z))
        if lo < PLAUSIBLE_HEIGHT_RANGE_M[0] or hi > PLAUSIBLE_HEIGHT_RANGE_M[1]:
            raise ValueError(f"DEM heights [{lo:.1f}, {hi:.1f}] m are outside the plausible lunar "
                             f"range {PLAUSIBLE_HEIGHT_RANGE_M}: wrong scale/offset/units?")
    return z


# ================================================================================================
# Regular grids and bilinear sampling
# ================================================================================================
def bilinear_regular(z: np.ndarray, x0c: float, y0c: float, dx: float, dy: float,
                     xq: np.ndarray, yq: np.ndarray, wrap_cols: bool = False,
                     clamp_rows: bool = False) -> np.ndarray:
    """Bilinear interpolation on a regular grid, NaN-aware.

    ``z[i, j]`` is the value at (x0c + j*dx, y0c + i*dy) (dy may be negative, e.g. north-up
    rasters).  Returns NaN where the query is outside the hull of the pixel centres or where any
    neighbour with non-zero weight is NaN (nodata is never averaged with valid data).

    wrap_cols: column index is periodic (geographic grids spanning 360 deg of longitude).
    clamp_rows: rows beyond the outermost centres (by at most 1 px) use the edge row (used for the
    last half pixel next to a pole in geographic grids).
    """
    z = np.asarray(z)
    ny, nx = z.shape
    xq, yq = np.broadcast_arrays(np.asarray(xq, dtype=float), np.asarray(yq, dtype=float))
    shape = xq.shape
    cf = ((xq - x0c) / dx).reshape(-1)
    rf = ((yq - y0c) / dy).reshape(-1)
    out = np.full(cf.shape, np.nan, dtype=np.float64)
    # snap float round-off at the hull edges (e.g. a query exactly on the first/last centre)
    eps = 1e-7
    rf = np.where((rf < 0) & (rf > -eps), 0.0, np.where((rf > ny - 1) & (rf < ny - 1 + eps), ny - 1.0, rf))
    cf = np.where((cf < 0) & (cf > -eps), 0.0, np.where((cf > nx - 1) & (cf < nx - 1 + eps), nx - 1.0, cf))
    if clamp_rows:
        rf = np.where((rf < 0) & (rf >= -1.0), 0.0, rf)
        rf = np.where((rf > ny - 1) & (rf <= ny), ny - 1.0, rf)
    ok = np.isfinite(cf) & np.isfinite(rf) & (rf >= 0) & (rf <= ny - 1)
    if not wrap_cols:
        ok &= (cf >= 0) & (cf <= nx - 1)
    if ny < 2 or (nx < 2 and not wrap_cols):
        # degenerate grid: only exact hits are defined
        ok &= (np.abs(rf - np.round(rf)) < 1e-9)
    if not np.any(ok):
        return out.reshape(shape)
    r = rf[ok]
    c = cf[ok]
    r0 = np.clip(np.floor(r).astype(np.int64), 0, max(ny - 2, 0))
    fr = r - r0
    if wrap_cols:
        c0 = np.floor(c).astype(np.int64)
        fc = c - c0
        c0 = np.mod(c0, nx)
        c1 = np.mod(c0 + 1, nx)
    else:
        c0 = np.clip(np.floor(c).astype(np.int64), 0, max(nx - 2, 0))
        fc = c - c0
        c1 = np.minimum(c0 + 1, nx - 1)
    r1 = np.minimum(r0 + 1, ny - 1)
    acc = np.zeros(r.shape, dtype=np.float64)
    bad = np.zeros(r.shape, dtype=bool)
    for rr, cc, w in ((r0, c0, (1 - fr) * (1 - fc)), (r0, c1, (1 - fr) * fc),
                      (r1, c0, fr * (1 - fc)), (r1, c1, fr * fc)):
        v = z[rr, cc].astype(np.float64)
        nan = np.isnan(v)
        bad |= nan & (w > 1e-12)
        acc += np.where(nan, 0.0, v) * w
    acc[bad] = np.nan
    out[ok] = acc
    return out.reshape(shape)


def sample_patch(patch: DemPatch, x_m: np.ndarray, y_m: np.ndarray) -> np.ndarray:
    """Bilinear height (m) of a DemPatch at projected points; NaN outside / at nodata."""
    x = np.asarray(patch.x_m, float)
    y = np.asarray(patch.y_m, float)
    dx = (x[-1] - x[0]) / (len(x) - 1) if len(x) > 1 else patch.resolution_m
    dy = (y[-1] - y[0]) / (len(y) - 1) if len(y) > 1 else patch.resolution_m
    return bilinear_regular(patch.z_m, x[0], y[0], dx, dy, x_m, y_m)


@dataclass(frozen=True)
class RasterGrid:
    """North-up regular raster in polar stereographic metres (GeoTIFF convention).

    Pixel (row i, col j) has centre (x_left + (j + 0.5) res, y_top - (i + 0.5) res).
    """

    x_left: float
    y_top: float
    res: float
    width: int
    height: int
    hemisphere: Hemisphere = "south"

    @classmethod
    def from_transform(cls, transform, width: int, height: int,
                       hemisphere: Hemisphere = "south") -> "RasterGrid":
        """From a rasterio/affine transform; raises for rotated or non-square pixels."""
        a, b, c, d, e, f = (transform.a, transform.b, transform.c, transform.d, transform.e,
                            transform.f)
        if abs(b) > 1e-9 or abs(d) > 1e-9:
            raise ValueError("rotated rasters are not supported")
        if not (a > 0 and e < 0 and abs(a + e) <= 1e-9 * a):
            raise ValueError(f"expected square north-up pixels, got a={a}, e={e}")
        return cls(x_left=float(c), y_top=float(f), res=float(a), width=int(width),
                   height=int(height), hemisphere=hemisphere)

    @property
    def x_right(self) -> float:
        return self.x_left + self.width * self.res

    @property
    def y_bottom(self) -> float:
        return self.y_top - self.height * self.res

    def col_center(self, j) -> np.ndarray:
        return self.x_left + (np.asarray(j, float) + 0.5) * self.res

    def row_center(self, i) -> np.ndarray:
        return self.y_top - (np.asarray(i, float) + 0.5) * self.res

    def window_for_box(self, xmin: float, xmax: float, ymin: float, ymax: float
                       ) -> tuple[int, int, int, int]:
        """Smallest (row0, col0, nrows, ncols) whose pixel CENTRES cover [xmin,xmax]x[ymin,ymax].

        May extend outside the raster (callers fill NaN there).
        """
        c0 = math.floor((xmin - self.x_left) / self.res - 0.5 + 1e-9)
        c1 = math.ceil((xmax - self.x_left) / self.res - 0.5 - 1e-9)
        r0 = math.floor((self.y_top - ymax) / self.res - 0.5 + 1e-9)
        r1 = math.ceil((self.y_top - ymin) / self.res - 0.5 - 1e-9)
        return r0, c0, r1 - r0 + 1, c1 - c0 + 1


def patch_from_raster_window(z_rows_top_down: np.ndarray, grid: RasterGrid, row0: int, col0: int,
                             source: str, crs_wkt: str | None = None) -> DemPatch:
    """Build a DemPatch (y increasing, row 0 = bottom) from a north-up raster window."""
    nrows, ncols = z_rows_top_down.shape
    x = grid.col_center(np.arange(col0, col0 + ncols))
    y = grid.row_center(np.arange(row0, row0 + nrows))[::-1]
    return DemPatch(x_m=x, y_m=y, z_m=np.ascontiguousarray(z_rows_top_down[::-1, :]),
                    crs_wkt=crs_wkt or ps_crs_wkt(grid.hemisphere), source=source,
                    resolution_m=grid.res)


def check_patch_size(nrows: int, ncols: int, max_pixels: int) -> None:
    """Raise a clear error before allocating a giant patch (use NestedDem for big radii)."""
    if nrows * ncols > max_pixels:
        raise ValueError(f"requested DEM patch of {nrows} x {ncols} px exceeds max_pixels="
                         f"{max_pixels}; use a coarser product or NestedDem.rings() for large radii")


# ================================================================================================
# HTTP helpers (polite: retries with exponential backoff, on-disk caching by callers)
# ================================================================================================
USER_AGENT = "lunarnav/0.1 (NASA Space Apps lunar landing site navigator; python-requests)"


def http_get(url: str, params: dict | None = None, timeout: float = 120.0, retries: int = 4,
             backoff_s: float = 2.0, stream: bool = False, session=None):
    """GET with retry/backoff on network errors and HTTP 429/5xx; raises on final failure.

    Returns the ``requests.Response`` (caller must close it when ``stream=True``).
    """
    import requests

    sess = session or requests
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            r = sess.get(url, params=params, timeout=timeout, stream=stream,
                         headers={"User-Agent": USER_AGENT})
            if r.status_code == 429 or r.status_code >= 500:
                last = RuntimeError(f"HTTP {r.status_code} for {r.url}")
                r.close()
            else:
                r.raise_for_status()
                return r
        except requests.RequestException as e:  # connection errors, 4xx from raise_for_status
            if getattr(e, "response", None) is not None and 400 <= e.response.status_code < 500 \
                    and e.response.status_code != 429:
                raise
            last = e
        if attempt < retries:
            time.sleep(backoff_s * (2 ** attempt))
    raise RuntimeError(f"GET {url} failed after {retries + 1} attempts: {last}")


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write via a temp file + os.replace so concurrent readers never see partial files."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def cached_json(url: str, params: dict | None, cache_file: Path, max_age_s: float = 30 * 86400
                ) -> object:
    """GET a JSON document with an on-disk cache (refetched when older than ``max_age_s``)."""
    if cache_file.exists() and (time.time() - cache_file.stat().st_mtime) < max_age_s:
        return json.loads(cache_file.read_text(encoding="utf-8"))
    r = http_get(url, params=params, timeout=60)
    data = r.json()
    atomic_write_bytes(cache_file, json.dumps(data, indent=1).encode("utf-8"))
    return data


def cache_key(*parts: object) -> str:
    """Short stable hash for cache file names."""
    return hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:16]


# ================================================================================================
# Block-cached gridded polar DEM (base class for PGDA COGs and Trek ImageServer)
# ================================================================================================
class BlockGridDem:
    """Polar stereographic DEM read in fixed square blocks, each cached on disk as .npz.

    Subclasses implement :meth:`_fetch_block` (returns float32 metres, NaN nodata, shape
    (block, block) clipped at the raster edge) and set ``grid`` / ``name`` / ``block``.
    ``height_at`` and ``patch`` then only touch the blocks they need, so a site analysis reads a few
    MB instead of multi-GB files, and a second run works offline from ``data/cache``.
    """

    name: str
    grid: RasterGrid
    block: int
    cache_path: Path | None
    max_pixels: int = 200_000_000  # 800 MB of float32
    _mem: dict

    def _init_cache(self, cache_path: Path | None) -> None:
        self.cache_path = cache_path
        if cache_path is not None:
            cache_path.mkdir(parents=True, exist_ok=True)
        self._mem = {}

    # -- to implement --------------------------------------------------------------------------
    def _fetch_block(self, bi: int, bj: int) -> np.ndarray:  # pragma: no cover - abstract
        raise NotImplementedError

    # -- block cache ---------------------------------------------------------------------------
    @property
    def n_block_rows(self) -> int:
        return -(-self.grid.height // self.block)

    @property
    def n_block_cols(self) -> int:
        return -(-self.grid.width // self.block)

    def get_block(self, bi: int, bj: int) -> np.ndarray:
        """Block (bi, bj) as float32 metres (NaN nodata), from memory, disk cache or remote."""
        key = (bi, bj)
        if key in self._mem:
            return self._mem[key]
        arr = None
        f = self.cache_path / f"b{self.block}_{bi:04d}_{bj:04d}.npz" if self.cache_path else None
        if f is not None and f.exists():
            try:
                with np.load(f) as d:
                    arr = d["z"]
            except Exception as e:  # corrupted cache file: refetch
                log.warning("bad cache file %s (%s), refetching", f, e)
                arr = None
        if arr is None:
            arr = np.ascontiguousarray(self._fetch_block(bi, bj), dtype=np.float32)
            exp = (min(self.block, self.grid.height - bi * self.block),
                   min(self.block, self.grid.width - bj * self.block))
            if arr.shape != exp:
                raise RuntimeError(f"{self.name}: block {key} has shape {arr.shape}, expected {exp}")
            if f is not None:
                import io
                buf = io.BytesIO()
                np.savez_compressed(buf, z=arr)
                atomic_write_bytes(f, buf.getvalue())
        if len(self._mem) > 64:  # bound RAM use (64 blocks of 1024^2 float32 = 256 MB)
            self._mem.pop(next(iter(self._mem)))
        self._mem[key] = arr
        return arr

    def read_window(self, row0: int, col0: int, nrows: int, ncols: int) -> np.ndarray:
        """Float32 metres for raster rows/cols (top-down); NaN outside the raster."""
        out = np.full((nrows, ncols), np.nan, dtype=np.float32)
        g, B = self.grid, self.block
        r_lo, r_hi = max(row0, 0), min(row0 + nrows, g.height)
        c_lo, c_hi = max(col0, 0), min(col0 + ncols, g.width)
        if r_lo >= r_hi or c_lo >= c_hi:
            return out
        for bi in range(r_lo // B, (r_hi - 1) // B + 1):
            for bj in range(c_lo // B, (c_hi - 1) // B + 1):
                blk = self.get_block(bi, bj)
                br0, bc0 = bi * B, bj * B
                rr0, rr1 = max(r_lo, br0), min(r_hi, br0 + blk.shape[0])
                cc0, cc1 = max(c_lo, bc0), min(c_hi, bc0 + blk.shape[1])
                out[rr0 - row0:rr1 - row0, cc0 - col0:cc1 - col0] = blk[rr0 - br0:rr1 - br0,
                                                                        cc0 - bc0:cc1 - bc0]
        return out

    # -- DemSource API -------------------------------------------------------------------------
    def height_at(self, lat_deg: np.ndarray | float, lon_deg: np.ndarray | float) -> np.ndarray:
        """Bilinear terrain height (m above 1737.4 km sphere); NaN outside coverage/nodata."""
        x, y = latlon_to_ps(lat_deg, lon_deg, self.grid.hemisphere)
        return self.height_at_xy(x, y)

    def height_at_xy(self, x_m: np.ndarray | float, y_m: np.ndarray | float) -> np.ndarray:
        """Bilinear height at projected points (vectorised, reads only the blocks needed)."""
        g = self.grid
        x = np.asarray(x_m, float)
        y = np.asarray(y_m, float)
        shape = np.broadcast(x, y).shape
        xf = np.broadcast_to(x, shape).reshape(-1)
        yf = np.broadcast_to(y, shape).reshape(-1)
        out = np.full(xf.shape, np.nan)
        cf = (xf - g.x_left) / g.res - 0.5
        rf = (g.y_top - yf) / g.res - 0.5
        ok = np.isfinite(cf) & np.isfinite(rf) & (cf >= 0) & (cf <= g.width - 1) & (rf >= 0) \
            & (rf <= g.height - 1)
        if not np.any(ok):
            return out.reshape(shape)
        # group points by the block of their top-left neighbour; per group read only the minimal
        # window holding all 2x2 neighbourhoods (touches a neighbour block only when needed)
        r0 = np.floor(rf[ok]).astype(np.int64)
        c0 = np.floor(cf[ok]).astype(np.int64)
        B = self.block
        keys = (r0 // B) * (self.n_block_cols + 1) + (c0 // B)
        idx_ok = np.nonzero(ok)[0]
        for k in np.unique(keys):
            sel = keys == k
            wr0, wc0 = int(r0[sel].min()), int(c0[sel].min())
            win = self.read_window(wr0, wc0, int(r0[sel].max()) - wr0 + 2,
                                   int(c0[sel].max()) - wc0 + 2)
            xc0 = g.col_center(wc0)
            yc0 = g.row_center(wr0)
            out[idx_ok[sel]] = bilinear_regular(win, float(xc0), float(yc0), g.res, -g.res,
                                                xf[idx_ok[sel]], yf[idx_ok[sel]])
        return out.reshape(shape)

    def patch(self, lat_deg: float, lon_deg: float, half_size_m: float) -> DemPatch:
        """Native-resolution square window (pixel centres cover site +- half_size_m)."""
        if half_size_m <= 0:
            raise ValueError("half_size_m must be > 0")
        xc, yc = latlon_to_ps(lat_deg, lon_deg, self.grid.hemisphere)
        xc, yc = float(xc), float(yc)
        r0, c0, nr, nc = self.grid.window_for_box(xc - half_size_m, xc + half_size_m,
                                                  yc - half_size_m, yc + half_size_m)
        check_patch_size(nr, nc, self.max_pixels)
        z = self.read_window(r0, c0, nr, nc)
        if np.all(np.isnan(z)):
            raise ValueError(f"{self.name}: no data around lat={lat_deg}, lon={lon_deg} "
                             f"(outside product coverage)")
        return patch_from_raster_window(z, self.grid, r0, c0, source=self.name)

    def covers(self, lat_deg: float, lon_deg: float, radius_m: float = 0.0) -> bool:
        """True if the square site +- radius_m lies inside the raster extent."""
        x, y = latlon_to_ps(lat_deg, lon_deg, self.grid.hemisphere)
        g = self.grid
        return bool(g.x_left <= x - radius_m and x + radius_m <= g.x_right
                    and g.y_bottom <= y - radius_m and y + radius_m <= g.y_top)


# ================================================================================================
# Local GeoTIFF in polar stereographic (synthetic tests, downloaded PGDA files on Colab)
# ================================================================================================
class LocalPolarGeoTiffDem(BlockGridDem):
    """A local polar stereographic GeoTIFF (whole file on disk) exposed as a DemSource.

    scale/offset convert raw values to metres (defaults: file's own scale/offset tags).
    No disk cache (the file is already local); blocks are only kept in RAM.
    """

    def __init__(self, path: str | Path, name: str | None = None, scale: float | None = None,
                 offset: float | None = None, block: int = 1024, hemisphere: Hemisphere | None = None):
        import rasterio

        self.path = Path(path)
        if not self.path.exists():
            raise FileNotFoundError(self.path)
        self._ds = rasterio.open(self.path)
        crs = self._ds.crs
        if crs is None:
            raise ValueError(f"{self.path}: GeoTIFF has no CRS")
        hemi = hemisphere or _hemisphere_of_crs(crs.to_wkt())
        verify_ps_crs(crs.to_wkt(), hemi)
        self.grid = RasterGrid.from_transform(self._ds.transform, self._ds.width, self._ds.height, hemi)
        self.scale = float(self._ds.scales[0]) if scale is None else float(scale)
        self.offset = float(self._ds.offsets[0]) if offset is None else float(offset)
        self.nodata = self._ds.nodata
        self.block = int(block)
        self.name = name or f"file:{self.path.name}"
        self._init_cache(None)

    def _fetch_block(self, bi: int, bj: int) -> np.ndarray:
        from rasterio.windows import Window

        B = self.block
        h = min(B, self.grid.height - bi * B)
        w = min(B, self.grid.width - bj * B)
        raw = self._ds.read(1, window=Window(bj * B, bi * B, w, h))
        return to_metres(raw, self.scale, self.offset, self.nodata)

    def close(self) -> None:
        self._ds.close()


# ================================================================================================
# Nested (multi-resolution) DEM
# ================================================================================================
@dataclass
class NestedRing:
    """One resolution level of a nested DEM around a site.

    Use ``patch`` for terrain at great-circle-ish (projected) distances in
    [inner_radius_m, outer_radius_m) from the site; the patch itself covers the full square
    site +- outer_radius_m (so its inner part overlaps the finer level and may be ignored).
    """

    patch: DemPatch
    inner_radius_m: float
    outer_radius_m: float
    source: str


@dataclass
class NestedDem:
    """Fine DEM near the site, coarser DEMs farther away.

    levels: sequence of (DemSource, max_distance_m), FINE first, i.e. strictly increasing
    max_distance_m.  Level k is meant for distances up to max_distance_m[k].  Typical south-pole
    setup: Trek ImageServer 5 m (<= 20 km), PGDA 20 m (<= 100 km), PGDA 240 m (<= 600 km).

    * height_at: finest source with valid data at each point (falls back where NaN / uncovered).
    * patch(lat, lon, half_size_m): one DemPatch from the FINEST level whose max_distance_m >=
      half_size_m (else the coarsest level) - satisfies the DemSource protocol.
    * rings(lat, lon, radius_m): per-distance list of NestedRing (what horizon codes should use
      to get 5 m detail nearby without allocating a 5 m grid over 300 km).
    """

    levels: Sequence[tuple[DemSource, float]]
    name: str = ""

    def __post_init__(self) -> None:
        if not self.levels:
            raise ValueError("NestedDem needs at least one level")
        d = [float(m) for _, m in self.levels]
        if any(b <= a for a, b in zip(d, d[1:])):
            raise ValueError(f"max_distance_m must be strictly increasing (fine first): {d}")
        if not self.name:
            self.name = "nested[" + ",".join(f"{getattr(s, 'name', '?')}<={m / 1000:g}km"
                                             for s, m in self.levels) + "]"

    def height_at(self, lat_deg: np.ndarray | float, lon_deg: np.ndarray | float) -> np.ndarray:
        out = None
        for src, _ in self.levels:
            if out is None:
                out = np.asarray(src.height_at(lat_deg, lon_deg), dtype=float).copy()
            else:
                miss = np.isnan(out)
                if not np.any(miss):
                    break
                lat_b, lon_b = np.broadcast_arrays(np.asarray(lat_deg, float), np.asarray(lon_deg, float))
                out[miss] = np.asarray(src.height_at(lat_b[miss], lon_b[miss]), dtype=float)
        return out

    def source_for_radius(self, half_size_m: float) -> DemSource:
        for src, m in self.levels:
            if m >= half_size_m:
                return src
        return self.levels[-1][0]

    def patch(self, lat_deg: float, lon_deg: float, half_size_m: float) -> DemPatch:
        return self.source_for_radius(half_size_m).patch(lat_deg, lon_deg, half_size_m)

    def rings(self, lat_deg: float, lon_deg: float, radius_m: float) -> list[NestedRing]:
        """Patches per distance band out to ``radius_m`` (fine -> coarse, contiguous bands)."""
        rings: list[NestedRing] = []
        inner = 0.0
        for src, m in self.levels:
            outer = min(float(m), float(radius_m))
            if outer <= inner:
                break
            p = src.patch(lat_deg, lon_deg, outer)
            rings.append(NestedRing(patch=p, inner_radius_m=inner, outer_radius_m=outer,
                                    source=getattr(src, "name", p.source)))
            inner = outer
            if inner >= radius_m:
                break
        if inner < radius_m:
            log.warning("NestedDem: levels only reach %.0f m < requested %.0f m", inner, radius_m)
        return rings


__all__ = [
    "R_M", "Hemisphere", "PLAUSIBLE_HEIGHT_RANGE_M", "normalize_lon", "hemisphere_of",
    "latlon_to_ps", "ps_to_latlon", "ps_proj4", "ps_crs_wkt", "geographic_proj4",
    "pyproj_ps_transformers", "verify_ps_crs", "to_metres", "bilinear_regular", "sample_patch",
    "RasterGrid", "patch_from_raster_window", "check_patch_size", "http_get", "atomic_write_bytes",
    "cached_json", "cache_key", "BlockGridDem", "LocalPolarGeoTiffDem", "NestedRing", "NestedDem",
]
