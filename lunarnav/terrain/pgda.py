"""LOLA south-pole DEMs from the NASA GSFC Planetary Geodesy Data Archive (PGDA), product 90.

Barker, M. K. et al. (2023), "A New View of the Lunar South Pole from the Lunar Orbiter Laser
Altimeter (LOLA)", Planet. Sci. J. 4, 183, doi:10.3847/PSJ/acf3e1; data doi:10.60903/gsfcpgda-lola-spole
Product page: https://pgda.gsfc.nasa.gov/products/90

Facts verified against the files (2026-11, see docs/DATA_SOURCES.md):
  * Cloud-optimised GeoTIFFs, Float32, DEFLATE, 512x512 internal tiles, overviews x2..x64.
  * Height in METRES above the 1737.4 km sphere (GMT history "... 1000.0 MUL"), nodata = NaN.
  * CRS: polar stereographic, sphere R = 1737400 m, latitude of origin -90, central meridian 0,
    k = 1 at the pole, no false origin (identical to lunarnav.terrain.common.latlon_to_ps; checked
    to < 1 mm on open).  MOON_ME frame of DE421.
  * Grids are pixel-edge aligned to multiples of the pixel size, e.g. LDEM_80S_20MPP_ADJ:
    30400 x 30400 px, x/y in [-304000, 304000] m.

Remote access uses GDAL /vsicurl/ HTTP range requests; every block read is cached on disk under
``data/cache/pgda/<product>/`` so a second run is offline and the server is hit only once.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .. import config
from .common import BlockGridDem, RasterGrid, to_metres, verify_ps_crs

log = logging.getLogger(__name__)

PGDA_BASE_URL = "https://pgda.gsfc.nasa.gov/data/LOLA_20mpp"

#: GDAL options for polite, efficient remote COG reads.
GDAL_REMOTE_ENV: dict[str, str] = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",       # do not list the server directory
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif,.TIF",
    "GDAL_HTTP_MULTIRANGE": "YES",
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
    "GDAL_HTTP_MAX_RETRY": "4",
    "GDAL_HTTP_RETRY_DELAY": "2",
    "VSI_CACHE": "TRUE",
    "GDAL_HTTP_USERAGENT": "lunarnav/0.1 (NASA Space Apps; GDAL vsicurl)",
}


@dataclass(frozen=True)
class PgdaProduct:
    """A PGDA product-90 LDEM (heights in metres, south polar stereographic)."""

    name: str
    res_m: float
    half_extent_m: float  # raster covers [-half, +half] in x and y
    size_human: str       # size quoted on the product page
    min_lat_deg: float    # nominal latitude limit (circle inscribed in the square)

    @property
    def url(self) -> str:
        return f"{PGDA_BASE_URL}/{self.name}.TIF"

    @property
    def width(self) -> int:
        return int(round(2 * self.half_extent_m / self.res_m))


#: LDEM height products of PGDA product 90. half_extent_m values are from the file headers
#: (20/40/80 MPP: 304 km; 240/120/60 MPP: 931.2 km; 30 MPP: 457.44 km; 10 MPP see note).
PGDA_PRODUCTS: dict[str, PgdaProduct] = {p.name: p for p in [
    PgdaProduct("LDEM_80S_20MPP_ADJ", 20.0, 304_000.0, "2.6G", -80.0),
    PgdaProduct("LDEM_80S_40MPP_ADJ", 40.0, 304_000.0, "685M", -80.0),
    PgdaProduct("LDEM_80S_80MPP_ADJ", 80.0, 304_000.0, "181M", -80.0),
    PgdaProduct("LDEM_75S_30MPP_ADJ", 30.0, 457_440.0, "2.7G", -75.0),
    PgdaProduct("LDEM_60S_60MPP_ADJ", 60.0, 931_200.0, "2.9G", -60.0),
    PgdaProduct("LDEM_60S_120MPP_ADJ", 120.0, 931_200.0, "785M", -60.0),
    PgdaProduct("LDEM_60S_240MPP_ADJ", 240.0, 931_200.0, "210M", -60.0),
    # LDEM_83S_10MPP_ADJ (10 m/px, 4.8G) exists too; its extent is read from the header at open.
    PgdaProduct("LDEM_83S_10MPP_ADJ", 10.0, float("nan"), "4.8G", -83.0),
]}


class PgdaDem(BlockGridDem):
    """DemSource for a PGDA product-90 LDEM, read remotely (COG range requests) or from a local copy.

    Parameters
    ----------
    product : one of PGDA_PRODUCTS (default the 20 m/px 80S-90S DEM).
    local_path : read this local GeoTIFF instead of the URL (e.g. a file downloaded on Colab).
    url : override the remote URL.
    block : read/cache block size in pixels (512 = the COG's internal tile size).
    cache : cache each block as .npz under data/cache/pgda/<product>/ (default True for remote).

    ``height_at`` = bilinear; ``patch`` = native pixels, no resampling (DemPatch grid is a sub-grid
    of the product grid, ``resolution_m`` = product pixel size).
    """

    def __init__(self, product: str = "LDEM_80S_20MPP_ADJ", local_path: str | Path | None = None,
                 url: str | None = None, block: int = 512, cache: bool | None = None):
        import rasterio

        if product not in PGDA_PRODUCTS and local_path is None and url is None:
            raise ValueError(f"unknown PGDA product {product!r}; known: {sorted(PGDA_PRODUCTS)}")
        self.product = PGDA_PRODUCTS.get(product)
        self.name = f"pgda:{product}"
        self.block = int(block)
        if local_path is not None:
            self.path = str(Path(local_path))
            if not Path(self.path).exists():
                raise FileNotFoundError(self.path)
            remote = False
        else:
            self.path = "/vsicurl/" + (url or self.product.url)
            remote = True
        self.remote = remote
        if cache is None:
            cache = remote
        self._env = GDAL_REMOTE_ENV if remote else {}
        with rasterio.Env(**self._env):
            try:
                self._ds = rasterio.open(self.path)
            except Exception as e:
                raise RuntimeError(f"cannot open PGDA product {product} at {self.path}: {e}") from e
        ds = self._ds
        if ds.count != 1:
            raise ValueError(f"{product}: expected 1 band, got {ds.count}")
        if ds.crs is None:
            raise ValueError(f"{product}: GeoTIFF has no CRS")
        verify_ps_crs(ds.crs.to_wkt(), "south")
        self.grid = RasterGrid.from_transform(ds.transform, ds.width, ds.height, "south")
        if self.product is not None:
            p = self.product
            if abs(self.grid.res - p.res_m) > 1e-6:
                raise ValueError(f"{product}: pixel size {self.grid.res} != expected {p.res_m}")
            if np.isfinite(p.half_extent_m) and (abs(self.grid.x_left + p.half_extent_m) > 1e-3
                                                 or abs(self.grid.y_top - p.half_extent_m) > 1e-3):
                raise ValueError(f"{product}: extent {self.grid} != expected +-{p.half_extent_m}")
        self.scale = float(ds.scales[0] or 1.0)
        self.offset = float(ds.offsets[0] or 0.0)
        if self.scale != 1.0 or self.offset != 0.0:
            raise ValueError(f"{product}: unexpected scale/offset {self.scale}/{self.offset} "
                             "(PGDA LDEMs are float metres)")
        self.nodata = ds.nodata
        cache_path = config.cache_dir("pgda") / product if cache else None
        self._init_cache(cache_path)

    def _fetch_block(self, bi: int, bj: int) -> np.ndarray:
        import rasterio
        from rasterio.windows import Window

        B = self.block
        h = min(B, self.grid.height - bi * B)
        w = min(B, self.grid.width - bj * B)
        with rasterio.Env(**self._env):
            raw = self._ds.read(1, window=Window(bj * B, bi * B, w, h))
        log.debug("%s: fetched block (%d, %d)", self.name, bi, bj)
        return to_metres(raw, 1.0, 0.0, self.nodata)

    def close(self) -> None:
        self._ds.close()

    def __repr__(self) -> str:
        return f"PgdaDem({self.name}, res={self.grid.res} m, {self.path})"


# ================================================================================================
# Validation products (average solar illumination, Earth visibility, PSRs) - for validate.py
# ================================================================================================
@dataclass(frozen=True)
class PgdaRasterProduct:
    """A non-DEM PGDA raster (values = raw * scale + offset), south/north polar stereographic."""

    name: str
    url: str
    description: str
    scale: float
    offset: float
    nodata: float


PGDA_ILLUM_BASE = "https://pgda.gsfc.nasa.gov/data/MoonIllumination"
#: Mazarico et al. (2011, Icarus 211, 1066) updated 2016-08: averages over 18.6 yr hourly.
#: Values verified from GeoTIFF tags: Int16, nodata -32768, scale 4e-5 (fraction 0..1).
#: NOTE: the *_COG.TIF links on the product-69 page return 404 (2026-11); the plain .TIF files are
#: tiled GeoTIFFs that support remote windowed reads.
PGDA_VALIDATION_PRODUCTS: dict[str, PgdaRasterProduct] = {p.name: p for p in [
    PgdaRasterProduct("AVGVISIB_85S_060M_201608", f"{PGDA_ILLUM_BASE}/AVGVISIB_85S_060M_201608.TIF",
                      "average solar visibility fraction (fraction of solar disc), 85S-90S, 60 m",
                      4e-5, 0.0, -32768),
    PgdaRasterProduct("AVGVISIB_85S_060M_201608_EARTH",
                      f"{PGDA_ILLUM_BASE}/AVGVISIB_85S_060M_201608_EARTH.TIF",
                      "average Earth visibility fraction (any part of disc visible), 85S-90S, 60 m",
                      4e-5, 0.0, -32768),
    PgdaRasterProduct("AVGVISIB_75S_120M_201608", f"{PGDA_ILLUM_BASE}/AVGVISIB_75S_120M_201608.TIF",
                      "average solar visibility, 75S-90S, 120 m", 4e-5, 0.0, -32768),
    PgdaRasterProduct("AVGVISIB_75S_120M_201608_EARTH",
                      f"{PGDA_ILLUM_BASE}/AVGVISIB_75S_120M_201608_EARTH.TIF",
                      "average Earth visibility, 75S-90S, 120 m", 4e-5, 0.0, -32768),
    PgdaRasterProduct("LPSR_85S_060M_201608", f"{PGDA_ILLUM_BASE}/LPSR_85S_060M_201608.TIF",
                      "permanently shadowed regions, 85S-90S, 60 m (scale 2.5e-5, offset 0.5 from tags)",
                      2.5e-5, 0.5, -32768),
    PgdaRasterProduct("LPSR_80S_20MPP_ADJ", f"{PGDA_BASE_URL}/LPSR_80S_20MPP_ADJ.TIF",
                      "Barker 2023 PSR map, 80S-90S, 20 m, Float32 (NaN nodata)", 1.0, 0.0,
                      float("nan")),
]}


def read_validation_value(product: str, lat_deg: np.ndarray | float, lon_deg: np.ndarray | float,
                          neighborhood: int = 0, reducer=np.nanmedian) -> np.ndarray:
    """Value(s) of a PGDA validation raster at (lat, lon), scaled; NaN = nodata.

    neighborhood = 0: nearest pixel.  neighborhood = n: ``reducer`` (default nan-median) over the
    (2n+1)^2 pixels around it - recommended, because the 60 m illumination maps contain isolated
    0-valued pixels (e.g. at 89.45S 222.69E the pixel is 0 while all 8 neighbours are 0.24-0.86).
    Uses the file's own scale/offset tags (cross-checked against the registry; mismatch raises).
    Remote windowed reads (one small window per point) - intended for a handful of sites.
    """
    import rasterio
    from rasterio.windows import Window

    from .common import latlon_to_ps

    p = PGDA_VALIDATION_PRODUCTS[product]
    lat = np.atleast_1d(np.asarray(lat_deg, float))
    lon = np.atleast_1d(np.asarray(lon_deg, float))
    hemi = "south" if np.all(lat < 0) else "north"
    x, y = latlon_to_ps(lat, lon, hemi)
    out = np.full(lat.shape, np.nan)
    with rasterio.Env(**GDAL_REMOTE_ENV), rasterio.open("/vsicurl/" + p.url) as ds:
        verify_ps_crs(ds.crs.to_wkt(), hemi)
        sc, of = float(ds.scales[0] or 1.0), float(ds.offsets[0] or 0.0)
        if abs(sc - p.scale) > 1e-12 or abs(of - p.offset) > 1e-12:
            raise ValueError(f"{product}: file scale/offset {sc}/{of} != registry {p.scale}/{p.offset}")
        n = int(neighborhood)
        for k in range(lat.size):
            r, c = ds.index(x[k], y[k])
            if n <= r < ds.height - n and n <= c < ds.width - n:
                v = ds.read(1, window=Window(c - n, r - n, 2 * n + 1, 2 * n + 1)).astype(float)
                if ds.nodata is not None and not np.isnan(ds.nodata):
                    v[v == ds.nodata] = np.nan
                v = v * sc + of
                if np.any(np.isfinite(v)):
                    out[k] = float(v[n, n]) if n == 0 else float(reducer(v))
    return out


__all__ = ["PGDA_BASE_URL", "GDAL_REMOTE_ENV", "PgdaProduct", "PGDA_PRODUCTS", "PgdaDem",
           "PgdaRasterProduct", "PGDA_VALIDATION_PRODUCTS", "read_validation_value"]
