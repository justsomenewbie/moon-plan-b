"""LOLA DEMs from NASA Moon Trek (https://trek.nasa.gov/moon) - the challenge Resources-tab source.

Two independent access paths (facts verified 2026-11, details and evidence in docs/DATA_SOURCES.md):

1. ``TrekDem`` - full-file download of the Trek GeoTIFF products (Colab heavy runs).
   * Download: ``https://trek.nasa.gov/moon/TrekWS/rest/cat/data/stream?uuid=<item_UUID>``;
     chunked transfer, NO Content-Length and NO HTTP Range support (a Range request returns 200 and
     the whole file) -> an interrupted download must restart from zero.
   * Despite the polar product names, the ``*_EQ`` files are GEOGRAPHIC (equirectangular lat/lon)
     grids covering lon -180..180, on the 1737.4 km sphere, 128x128 tiles:
       SPole875_5mp:  306098 x 3006 px, 0.0011760941 deg/px (35.7 m in latitude!), Int16
       SPole75_30mp:  125988 x 7382 px, 0.0028574090 deg/px (86.6 m in latitude),  Float32, LZW
       SPole45_100mp:  70111 x 11830 px, 0.0051347455 deg/px (155.7 m in latitude), Int16
     so the radial resolution is coarser than the product name says (the reprojection to a lat/lon
     grid oversamples longitude near the pole but undersamples latitude).
   * Units: Int16 products store HEIGHT IN HALF-METRES (scale 0.5, no scale tag in the file!),
     nodata 32767; the Float32 product stores metres, nodata 1.1754939e-38 (FLT_MIN). Verified by
     comparing raw values with PGDA LDEM_75S_30MPP_ADJ (ratio 0.500 / 1.000) and the PDS LDEM_4
     (fit slope 0.498 for the 100 m Int16 product). Heights refer to the 1737.4 km sphere.
   * The TIFF header's first-IFD pointer points to an IFD at the END of the file, but GDAL left the
     original IFD (with all GeoTIFF tags) right after the header, so the first few MB are enough to
     check CRS/geotransform/dtype (``probe_remote_header``).

2. ``TrekImageServerDem`` - partial reads from the Moon Trek ArcGIS ImageServer that backs the Trek
   web portal (``https://trek.nasa.gov/moon/trekarcgis/rest/services/<name>/ImageServer``).
   The non-``_EQ`` services are the NATIVE south/north polar stereographic LOLA grids
   (5 m: +-75.84 km, 30 m: +-457.44 km, 100 m: +-1440 km), pixelType F32 in METRES. ``exportImage``
   with a pixel-aligned bbox and nearest-neighbour interpolation returns the native pixels as a
   GeoTIFF; outside the data the server returns -3.4028235e38. Blocks are cached on disk.
   This gives native 5 m resolution with a few MB of traffic per site (preferred for the 5 m DEM).
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import shutil
import struct
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .. import config
from ..types import DemPatch
from .common import (BlockGridDem, Hemisphere, RasterGrid, atomic_write_bytes,
                     bilinear_regular, cached_json, check_patch_size, http_get, latlon_to_ps,
                     ps_crs_wkt, ps_to_latlon, to_metres, verify_ps_crs)

log = logging.getLogger(__name__)

TREK_BASE = "https://trek.nasa.gov/moon"
SEARCH_URL = f"{TREK_BASE}/TrekServices/ws/index/eq/searchItems"
DATA_STREAM_URL = f"{TREK_BASE}/TrekWS/rest/cat/data/stream"
METADATA_URL = f"{TREK_BASE}/TrekWS/rest/cat/metadata/stream"
IMAGESERVER_URL = f"{TREK_BASE}/trekarcgis/rest/services/{{name}}/ImageServer"
WMTS_CAPABILITIES_URL = "https://trek.nasa.gov/tiles/Moon/EQ/{label}/1.0.0/WMTSCapabilities.xml"

#: Downloads above this size are refused unless allowed (this dev machine must not pull 2 GB files).
LARGE_DOWNLOAD_BYTES = 100 * 1024 * 1024


@dataclass(frozen=True)
class TrekProduct:
    """Verified facts about one Moon Trek LOLA DEM GeoTIFF (geographic grid)."""

    label: str
    uuid: str
    file_size: int            # bytes, from the search API "fileSize"
    dtype: str                # numpy dtype of the stored band
    scale_to_m: float         # metres = raw * scale_to_m (0.5 = half-metres for Int16)
    nodata: float
    width: int
    height: int
    pixel_deg: float          # square pixels (lat and lon spacing)
    left_lon_deg: float
    top_lat_deg: float
    nominal_mpp: float        # resolution in the product name (of the original polar product)
    imageserver: str          # native polar stereographic twin on the Trek ImageServer
    hemisphere: Hemisphere = "south"

    @property
    def lat_spacing_m(self) -> float:
        """Ground spacing of rows (latitude direction), metres."""
        return math.radians(self.pixel_deg) * config.MOON_RADIUS_M

    @property
    def bottom_lat_deg(self) -> float:
        return self.top_lat_deg - self.height * self.pixel_deg


TREK_PRODUCTS: dict[str, TrekProduct] = {p.label: p for p in [
    TrekProduct("LRO_LOLA_DEM_SPole875_5mp_v04_EQ", "52bac771-64e8-4db8-8614-b28c40cd1366",
                1_882_525_028, "int16", 0.5, 32767.0, 306098, 3006, 0.0011760941003603, -180.0,
                -86.46411384641813, 5.0, "LRO_LOLA_DEM_SPole875_5mp_v04"),
    TrekProduct("LRO_LOLA_DEM_SPole75_30mp_v04_EQ", "df2e71f5-2c33-4e9d-80fc-d82d41ede253",
                1_026_486_758, "float32", 1.0, 1.1754939304327482e-38, 125988, 7382,
                0.00285740904194023, -180.0, -68.90749860552876, 30.0,
                "LRO_LOLA_DEM_SPole75_30mp_v04"),
    TrekProduct("LRO_LOLA_DEM_SPole45_100mp_v04_EQ", "80402dbf-a89e-4188-ad99-559106cb948b",
                1_671_213_380, "int16", 0.5, 32767.0, 70111, 11830, 0.00513474545017597, -180.0,
                -29.253632629011033, 100.0, "LRO_LOLA_DEM_SPole45_100mp_v04"),
]}

#: Native polar stereographic ImageServer services (F32 metres), verified service metadata.
TREK_IMAGESERVER_SERVICES: dict[str, dict] = {
    "LRO_LOLA_DEM_SPole875_5mp_v04": {"res_m": 5.0, "half_extent_m": 75_840.0, "hemisphere": "south"},
    "LRO_LOLA_DEM_SPole75_30mp_v04": {"res_m": 30.0, "half_extent_m": 457_440.0, "hemisphere": "south"},
    "LRO_LOLA_DEM_SPole45_100mp_v04": {"res_m": 100.0, "half_extent_m": 1_440_000.0, "hemisphere": "south"},
    "LRO_LOLA_DEM_NPole875_5mp_v04": {"res_m": 5.0, "half_extent_m": float("nan"), "hemisphere": "north"},
    "LRO_LOLA_DEM_NPole75_30mp_v04": {"res_m": 30.0, "half_extent_m": float("nan"), "hemisphere": "north"},
    "LRO_LOLA_DEM_NPole45_100mp_v04": {"res_m": 100.0, "half_extent_m": float("nan"), "hemisphere": "north"},
}


def _trek_cache() -> Path:
    return config.cache_dir("trek")


# ================================================================================================
# Catalogue
# ================================================================================================
def search_products(key: str, rows: int = 50) -> list[dict]:
    """Moon Trek catalogue search (cached 30 days); returns the list of product docs."""
    fname = "search_" + "".join(c if c.isalnum() or c in "-_" else "_" for c in key)[:80] + ".json"
    data = cached_json(SEARCH_URL, {"start": 0, "rows": rows, "key": key}, _trek_cache() / fname)
    if isinstance(data, dict):
        docs = data.get("response", {}).get("docs", [])
    else:
        docs = data
    if not isinstance(docs, list):
        raise RuntimeError(f"unexpected Trek search response for {key!r}: {str(data)[:200]}")
    return docs


def product_record(label: str) -> dict:
    """Exact-label catalogue record (item_UUID, fileSize, PIXEL_DEPTH, bbox, ...)."""
    key = label[:-3] if label.endswith("_EQ") else label
    for d in search_products(key):
        if d.get("productLabel") == label:
            return d
    raise KeyError(f"Moon Trek product {label!r} not found in the catalogue")


def _file_size_of(rec: dict) -> int:
    fs = rec.get("fileSize")
    if isinstance(fs, list):
        fs = fs[0] if fs else None
    if fs is None:
        raise RuntimeError(f"catalogue record of {rec.get('productLabel')} has no fileSize")
    return int(fs)


# ================================================================================================
# Header probe (first few MB only)
# ================================================================================================
@dataclass
class TrekHeaderInfo:
    """GeoTIFF facts parsed from the first bytes of a Trek file."""

    label: str
    bigtiff: bool
    header_ifd_offset: int
    width: int
    height: int
    dtype: str
    nodata: float | None
    transform: tuple[float, float, float, float, float, float]
    crs_wkt: str
    compression: str | None
    block_shape: tuple[int, int]
    scales: tuple[float, ...]
    offsets: tuple[float, ...]
    meta: dict = field(default_factory=dict)


def _patch_tiff_header(buf: bytearray) -> tuple[bool, int]:
    """Point the TIFF header at the IFD stored right after it (GDAL's initial IFD).

    Returns (bigtiff, original first-IFD offset).  Raises ValueError if no IFD follows the header.
    """
    if buf[:2] != b"II":
        raise ValueError("not a little-endian TIFF")
    magic = struct.unpack_from("<H", buf, 2)[0]
    if magic == 42:
        orig = struct.unpack_from("<I", buf, 4)[0]
        n = struct.unpack_from("<H", buf, 8)[0]
        if not 3 <= n <= 200:
            raise ValueError(f"no IFD right after the classic TIFF header (count {n})")
        if orig >= len(buf):
            struct.pack_into("<I", buf, 4, 8)
        return False, orig
    if magic == 43:
        orig = struct.unpack_from("<Q", buf, 8)[0]
        n = struct.unpack_from("<Q", buf, 16)[0]
        if not 3 <= n <= 200:
            raise ValueError(f"no IFD right after the BigTIFF header (count {n})")
        if orig >= len(buf):
            struct.pack_into("<Q", buf, 8, 16)
        return True, orig
    raise ValueError(f"unknown TIFF magic {magic}")


def probe_remote_header(label: str, nbytes: int = 4 * 1024 * 1024, uuid: str | None = None
                        ) -> TrekHeaderInfo:
    """Stream ONLY the first ``nbytes`` of a Trek product and parse its GeoTIFF tags.

    The stream is closed after ``nbytes`` (the server has no Range support, so this is the only way
    to look inside a 1-2 GB file without downloading it).  Cached under data/cache/trek/.
    """
    import rasterio
    from rasterio.io import MemoryFile

    if uuid is None:
        uuid = TREK_PRODUCTS[label].uuid if label in TREK_PRODUCTS else product_record(label)["item_UUID"]
    cache = _trek_cache() / f"head_{label}_{nbytes}.bin"
    if cache.exists() and cache.stat().st_size == nbytes:
        buf = bytearray(cache.read_bytes())
    else:
        buf = bytearray()
        r = http_get(DATA_STREAM_URL, params={"uuid": uuid}, stream=True, timeout=120)
        try:
            for chunk in r.iter_content(1 << 16):
                buf += chunk
                if len(buf) >= nbytes:
                    break
        finally:
            r.close()
        if len(buf) < nbytes:
            raise RuntimeError(f"{label}: stream ended after {len(buf)} bytes (< {nbytes})")
        buf = buf[:nbytes]
        atomic_write_bytes(cache, bytes(buf))
    big, orig = _patch_tiff_header(buf)
    with MemoryFile(bytes(buf)) as mf, mf.open() as ds:
        t = ds.transform
        return TrekHeaderInfo(
            label=label, bigtiff=big, header_ifd_offset=orig, width=ds.width, height=ds.height,
            dtype=ds.dtypes[0], nodata=ds.nodata, transform=(t.a, t.b, t.c, t.d, t.e, t.f),
            crs_wkt=ds.crs.to_wkt() if ds.crs else "",
            compression=ds.compression.value if ds.compression else None,
            block_shape=tuple(ds.block_shapes[0]), scales=tuple(ds.scales),
            offsets=tuple(ds.offsets), meta={"nbytes_read": nbytes, "tags": ds.tags()})


def read_head_window(label: str, row0: int, col0: int, nrows: int, ncols: int,
                     nbytes: int = 12 * 1024 * 1024) -> np.ndarray:
    """RAW pixel values of a window that lies inside the first ``nbytes`` of a Trek file.

    Only useful for the first tile rows (tiles are stored row-major after the IFD); used to verify
    the units (half-metres) of Int16 products without downloading the file.  Raises RuntimeError if
    the window's tiles are beyond the downloaded bytes.
    """
    from rasterio.io import MemoryFile
    from rasterio.windows import Window

    probe_remote_header(label, nbytes=nbytes)
    buf = bytearray((_trek_cache() / f"head_{label}_{nbytes}.bin").read_bytes())
    _patch_tiff_header(buf)
    with MemoryFile(bytes(buf)) as mf, mf.open() as ds:
        try:
            return ds.read(1, window=Window(col0, row0, ncols, nrows))
        except Exception as e:
            raise RuntimeError(f"{label}: window rows {row0}+{nrows}, cols {col0}+{ncols} is not "
                               f"inside the first {nbytes} bytes: {e}") from e


# ================================================================================================
# Full-file download
# ================================================================================================
def _large_downloads_allowed(allow_large: bool | None) -> bool:
    if allow_large is not None:
        return bool(allow_large)
    if os.environ.get("LUNARNAV_ALLOW_LARGE_DOWNLOADS", "").strip() in ("1", "true", "yes"):
        return True
    return "google.colab" in sys.modules or "COLAB_RELEASE_TAG" in os.environ


def download_product(label: str, dest_dir: str | Path | None = None, allow_large: bool | None = None,
                     chunk_bytes: int = 4 * 1024 * 1024, verify: bool = True,
                     cross_check: bool = True) -> Path:
    """Download a full Moon Trek product to ``config.dem_dir()`` (or dest_dir); return its path.

    * Size check: the final size must equal the catalogue ``fileSize`` (else the file is kept as
      ``.part`` and RuntimeError is raised).
    * Resume: if ``<file>.part`` exists we send ``Range: bytes=<n>-``; Moon Trek ignores Range (HTTP
      200, full body), in which case we log a warning and RESTART FROM ZERO.  A 206 reply is appended.
    * Integrity: Trek publishes no checksum, so SHA-256 is computed and written to ``<file>.json``
      (with uuid, size, url, UTC time) for reproducibility; re-runs skip files whose size and
      sidecar match.
    * Safety: files > 100 MB are refused unless ``allow_large=True``, env
      LUNARNAV_ALLOW_LARGE_DOWNLOADS=1, or running on Google Colab.
    """
    import requests

    prod = TREK_PRODUCTS.get(label)
    if prod is not None:
        uuid, size = prod.uuid, prod.file_size
    else:
        rec = product_record(label)
        uuid, size = rec["item_UUID"], _file_size_of(rec)
    if size > LARGE_DOWNLOAD_BYTES and not _large_downloads_allowed(allow_large):
        raise RuntimeError(f"{label} is {size / 1e9:.2f} GB; large downloads are disabled on this "
                           "machine. Use TrekImageServerDem for partial reads, or run on Colab / pass "
                           "allow_large=True / set LUNARNAV_ALLOW_LARGE_DOWNLOADS=1.")
    if prod is not None and cross_check:
        try:  # cross-check the registry against the live catalogue (non-fatal if offline)
            rec = product_record(label)
            changed = rec.get("item_UUID") != uuid or _file_size_of(rec) != size
        except (requests.RequestException, RuntimeError, KeyError) as e:
            log.warning("could not cross-check %s against the Trek catalogue: %s", label, e)
            changed = False
        if changed:
            raise RuntimeError(f"{label}: catalogue changed (uuid {rec.get('item_UUID')}, size "
                               f"{_file_size_of(rec)}) vs registry ({uuid}, {size}); re-verify "
                               "units/grid and update TREK_PRODUCTS")
    dest = Path(dest_dir) if dest_dir is not None else config.dem_dir()
    dest.mkdir(parents=True, exist_ok=True)
    out = dest / f"{label}.tif"
    side = dest / f"{label}.tif.json"
    if out.exists() and out.stat().st_size == size and side.exists():
        meta = json.loads(side.read_text(encoding="utf-8"))
        if meta.get("uuid") == uuid and meta.get("size") == size:
            log.info("%s already downloaded (%s)", label, out)
            return out
    free = shutil.disk_usage(dest).free
    if free < size * 1.05:
        raise RuntimeError(f"not enough disk space in {dest}: {free / 1e9:.2f} GB free, need "
                           f"{size / 1e9:.2f} GB")
    part = dest / f"{label}.tif.part"
    have = part.stat().st_size if part.exists() else 0
    headers = {"User-Agent": "lunarnav/0.1 (NASA Space Apps)"}
    if have:
        headers["Range"] = f"bytes={have}-"
    url = DATA_STREAM_URL
    for attempt in range(4):
        try:
            with requests.get(url, params={"uuid": uuid}, stream=True, timeout=300,
                              headers=headers) as r:
                r.raise_for_status()
                if have and r.status_code != 206:
                    log.warning("%s: server ignored Range (HTTP %d, no range support) - restarting "
                                "the %d-byte download from zero", label, r.status_code, size)
                    have = 0
                mode = "ab" if have else "wb"
                h = hashlib.sha256()
                if have:  # hash what we already have
                    with open(part, "rb") as f:
                        for blk in iter(lambda: f.read(1 << 24), b""):
                            h.update(blk)
                t0, done = time.time(), have
                with open(part, mode) as f:
                    for chunk in r.iter_content(chunk_bytes):
                        f.write(chunk)
                        h.update(chunk)
                        done += len(chunk)
                        if done > size:
                            raise RuntimeError(f"{label}: received more than fileSize={size} bytes")
                log.info("%s: %d bytes in %.0f s", label, done - have, time.time() - t0)
            break
        except (requests.RequestException, OSError) as e:
            have = part.stat().st_size if part.exists() else 0
            headers["Range"] = f"bytes={have}-"
            log.warning("%s: download interrupted at %d bytes (%s); retry %d", label, have, e,
                        attempt + 1)
            time.sleep(5 * 2 ** attempt)
    else:
        raise RuntimeError(f"{label}: download failed after retries ({part} kept)")
    got = part.stat().st_size
    if got != size:
        raise RuntimeError(f"{label}: size mismatch, got {got} bytes, catalogue fileSize {size} "
                           f"({part} kept)")
    os.replace(part, out)
    meta = {"label": label, "uuid": uuid, "size": size, "sha256": h.hexdigest(),
            "url": f"{url}?uuid={uuid}", "downloaded_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                                                         time.gmtime())}
    side.write_text(json.dumps(meta, indent=1), encoding="utf-8")
    if verify:
        TrekDem(label=label, path=out).close()  # opens + checks CRS/geotransform/dtype
    return out


# ================================================================================================
# TrekDem: local full file, geographic grid
# ================================================================================================
class TrekDem:
    """DemSource over a downloaded Moon Trek LOLA GeoTIFF (geographic lat/lon grid).

    Parameters
    ----------
    label : Trek productLabel (looked up in TREK_PRODUCTS for scale/nodata/grid checks).
    path : local file (default ``config.dem_dir()/<label>.tif``).
    scale_to_m : override the raw->metre factor (required for products not in TREK_PRODUCTS).
    patch_resolution_m : grid spacing of ``patch`` (default: nominal product resolution). Note the
        file's own latitude spacing (``product.lat_spacing_m``) is the real radial resolution.
    band_rows : rows read per I/O band (memory ~ band_rows * width * itemsize).
    product : explicit TrekProduct facts (overrides the TREK_PRODUCTS lookup; used for synthetic
        test files that mimic a real product).

    Within the last half pixel next to the pole (35 m for the 5 m product) heights are
    interpolated radially between the edge row and the pole value (mean of the edge row).

    height_at: bilinear in (lat, lon) with periodic longitude.  patch: bilinear resampling onto a
    south/north polar stereographic grid aligned to multiples of ``patch_resolution_m``.
    """

    def __init__(self, label: str | None = None, path: str | Path | None = None,
                 scale_to_m: float | None = None, patch_resolution_m: float | None = None,
                 band_rows: int = 128, max_pixels: int = 200_000_000,
                 product: TrekProduct | None = None):
        import rasterio

        if label is None and path is None and product is None:
            raise ValueError("give a Trek label and/or a path")
        self.label = label or (product.label if product else Path(path).stem)
        self.product = product or TREK_PRODUCTS.get(self.label)
        self._pole_cache: dict[int, float] = {}
        self.path = Path(path) if path is not None else config.dem_dir() / f"{self.label}.tif"
        if not self.path.exists():
            raise FileNotFoundError(f"{self.path} (download it first with download_product)")
        self.name = f"trek:{self.label}"
        self._ds = rasterio.open(self.path)
        ds = self._ds
        if ds.crs is None or not ds.crs.is_geographic:
            raise ValueError(f"{self.path}: expected a geographic CRS, got {ds.crs}")
        import pyproj
        ell = pyproj.CRS.from_user_input(ds.crs.to_wkt()).ellipsoid
        if ell is None or abs(ell.semi_major_metre - config.MOON_RADIUS_M) > 0.5 \
                or abs(ell.semi_minor_metre - config.MOON_RADIUS_M) > 0.5:
            raise ValueError(f"{self.path}: CRS is not on the 1737.4 km sphere ({ell})")
        t = ds.transform
        if abs(t.b) > 1e-12 or abs(t.d) > 1e-12 or not (t.a > 0 and t.e < 0):
            raise ValueError(f"{self.path}: unexpected geotransform {t}")
        if abs(t.a + t.e) > 1e-9 * t.a:
            raise ValueError(f"{self.path}: non-square pixels {t.a} x {-t.e}")
        self.dx, self.dy = float(t.a), float(-t.e)
        self.left, self.top = float(t.c), float(t.f)
        self.width, self.height = ds.width, ds.height
        self.dtype = ds.dtypes[0]
        file_scale = float(ds.scales[0] or 1.0)
        file_offset = float(ds.offsets[0] or 0.0)
        p = self.product
        if p is not None:
            if self.dtype != p.dtype:
                raise ValueError(f"{self.label}: dtype {self.dtype} != expected {p.dtype}")
            if (self.width, self.height) != (p.width, p.height):
                raise ValueError(f"{self.label}: size {self.width}x{self.height} != expected "
                                 f"{p.width}x{p.height}")
        if scale_to_m is None:
            if p is None:
                raise ValueError(f"{self.label} is not in TREK_PRODUCTS: pass scale_to_m explicitly "
                                 "(Trek Int16 LOLA DEMs are half-metres -> 0.5; verify!)")
            scale_to_m = p.scale_to_m
        if file_scale != 1.0 and abs(file_scale - scale_to_m) > 1e-12:
            raise ValueError(f"{self.label}: file scale tag {file_scale} conflicts with {scale_to_m}")
        if file_offset not in (0.0,):
            raise ValueError(f"{self.label}: unexpected offset tag {file_offset}")
        self.scale_to_m = float(scale_to_m)
        self.nodata_values = {v for v in (ds.nodata, p.nodata if p else None) if v is not None}
        span = self.width * self.dx
        self.wrap = abs(span - 360.0) < 2 * self.dx
        self.hemisphere: Hemisphere = (p.hemisphere if p else
                                       ("south" if self.top - self.height * self.dy < 0 else "north"))
        bottom = self.top - self.height * self.dy
        # clamp the last half pixel next to the pole (constant extrapolation <= 1 px)
        self.clamp_bottom = bottom <= -90.0 + 1.5 * self.dy
        self.clamp_top = self.top >= 90.0 - 1.5 * self.dy
        self.patch_resolution_m = float(patch_resolution_m or (p.nominal_mpp if p else
                                                               math.radians(self.dy) * config.MOON_RADIUS_M))
        self.band_rows = int(band_rows)
        self.max_pixels = int(max_pixels)

    # -- raw access --------------------------------------------------------------------------
    def _read(self, row0: int, col0: int, nrows: int, ncols: int) -> np.ndarray:
        from rasterio.windows import Window

        raw = self._ds.read(1, window=Window(col0, row0, ncols, nrows))
        return to_metres(raw, self.scale_to_m, 0.0, sorted(self.nodata_values))

    def sample(self, lat_deg: np.ndarray, lon_deg: np.ndarray) -> np.ndarray:
        """Bilinear height (m) at (lat, lon) arrays; NaN outside coverage or at nodata."""
        lat, lon = np.broadcast_arrays(np.asarray(lat_deg, float), np.asarray(lon_deg, float))
        shape = lat.shape
        lat = lat.reshape(-1)
        lon = lon.reshape(-1)
        out = np.full(lat.shape, np.nan)
        rf_raw = (self.top - lat) / self.dy - 0.5
        H, W = self.height, self.width
        # polar cap between the outermost row centre and the pole: sample the edge row at the
        # point's longitude, then interpolate radially towards the pole value (= mean of edge row,
        # whose pixels all lie on one small circle around the pole)
        cap_s = (rf_raw > H - 1) & (lat >= -90.0) if self.clamp_bottom else np.zeros(lat.shape, bool)
        cap_n = (rf_raw < 0) & (lat <= 90.0) if self.clamp_top else np.zeros(lat.shape, bool)
        rf = np.where(cap_s, H - 1.0, np.where(cap_n, 0.0, rf_raw))
        xq = self.left + np.mod(lon - self.left, 360.0)          # in [left, left + 360)
        cf = (xq - self.left) / self.dx - 0.5
        ok = np.isfinite(rf) & (rf >= 0) & (rf <= H - 1)
        if not self.wrap:
            ok &= (cf >= 0) & (cf <= W - 1)
        if not np.any(ok):
            return out.reshape(shape)
        idx = np.nonzero(ok)[0]
        r0 = np.clip(np.floor(rf[idx]).astype(np.int64), 0, max(H - 2, 0))
        bands = r0 // self.band_rows
        for b in np.unique(bands):
            sel = idx[bands == b]
            rows0 = int(b) * self.band_rows
            nrows = min(self.band_rows + 1, H - rows0)
            c0 = np.floor(cf[sel]).astype(np.int64)
            if self.wrap:
                cm = np.mod(c0, W)
                full = bool(np.any(c0 < 0) or np.any(cm + 1 >= W)
                            or (cm.max() - cm.min() + 2) > W // 2)
            else:
                cm = np.clip(c0, 0, max(W - 2, 0))
                full = bool((cm.max() - cm.min() + 2) > W // 2)
            if full:
                col0, ncols = 0, W
            else:
                col0 = int(cm.min())
                ncols = min(int(cm.max()) - col0 + 2, W - col0)
            z = self._read(rows0, col0, nrows, ncols)
            x0c = self.left + (col0 + 0.5) * self.dx
            y0c = self.top - (rows0 + 0.5) * self.dy
            yq = self.top - (rf[sel] + 0.5) * self.dy  # clamped latitude
            out[sel] = bilinear_regular(z, x0c, y0c, self.dx, -self.dy, xq[sel], yq,
                                        wrap_cols=(full and self.wrap and ncols == W))
        for cap, row, rf_pole in ((cap_s, H - 1, (self.top + 90.0) / self.dy - 0.5),
                                  (cap_n, 0, (self.top - 90.0) / self.dy - 0.5)):
            k = cap & ok
            if np.any(k):
                w = np.clip((rf_raw[k] - row) / (rf_pole - row), 0.0, 1.0)
                out[k] = (1.0 - w) * out[k] + w * self._pole_value(row)
        return out.reshape(shape)

    def _pole_value(self, row: int) -> float:
        """Mean height of an edge row next to a pole (NaN if all nodata), cached."""
        if row not in self._pole_cache:
            z = self._read(row, 0, 1, self.width)
            self._pole_cache[row] = float(np.nanmean(z)) if np.any(np.isfinite(z)) else float("nan")
        return self._pole_cache[row]

    # -- DemSource API -------------------------------------------------------------------------
    def height_at(self, lat_deg: np.ndarray | float, lon_deg: np.ndarray | float) -> np.ndarray:
        """Bilinear terrain height (m above 1737.4 km sphere); NaN outside coverage/nodata."""
        return self.sample(np.asarray(lat_deg, float), np.asarray(lon_deg, float))

    def patch(self, lat_deg: float, lon_deg: float, half_size_m: float) -> DemPatch:
        """Polar stereographic patch (resampled bilinearly from the geographic grid)."""
        if half_size_m <= 0:
            raise ValueError("half_size_m must be > 0")
        res = self.patch_resolution_m
        xc, yc = latlon_to_ps(lat_deg, lon_deg, self.hemisphere)
        x = np.arange(math.floor((float(xc) - half_size_m) / res),
                      math.ceil((float(xc) + half_size_m) / res) + 1) * res
        y = np.arange(math.floor((float(yc) - half_size_m) / res),
                      math.ceil((float(yc) + half_size_m) / res) + 1) * res
        check_patch_size(len(y), len(x), self.max_pixels)
        z = np.full((len(y), len(x)), np.nan, dtype=np.float32)
        step = max(1, 2_000_000 // len(x))  # ~2 M points per chunk
        for i0 in range(0, len(y), step):
            yy = y[i0:i0 + step]
            X, Y = np.meshgrid(x, yy)
            lat, lon = ps_to_latlon(X, Y, self.hemisphere)
            z[i0:i0 + step] = self.sample(lat, lon).astype(np.float32)
        if np.all(np.isnan(z)):
            raise ValueError(f"{self.name}: no data around lat={lat_deg}, lon={lon_deg}")
        return DemPatch(x_m=x, y_m=y, z_m=z, crs_wkt=ps_crs_wkt(self.hemisphere), source=self.name,
                        resolution_m=res)

    def close(self) -> None:
        self._ds.close()

    def __repr__(self) -> str:
        return f"TrekDem({self.label}, {self.width}x{self.height}, {self.dx:.7f} deg/px)"


# ================================================================================================
# TrekImageServerDem: remote native polar stereographic grids
# ================================================================================================
class TrekImageServerDem(BlockGridDem):
    """DemSource reading native polar stereographic LOLA grids from the Moon Trek ImageServer.

    Each ``block`` x ``block`` pixel block (<= 4100, the server's maxImageHeight) is fetched once
    with ``exportImage`` (bbox exactly on pixel edges, nearest-neighbour -> native pixels, F32
    metres) and cached as .npz under data/cache/trek_imageserver/<service>/.
    """

    def __init__(self, service: str = "LRO_LOLA_DEM_SPole875_5mp_v04", block: int = 1024,
                 cache: bool = True, timeout_s: float = 180.0):
        if block > 4096:
            raise ValueError("block must be <= 4096 (server maxImageHeight is 4100)")
        self.service = service
        self.name = f"trek-imageserver:{service}"
        self.block = int(block)
        self.timeout_s = float(timeout_s)
        cdir = config.cache_dir("trek_imageserver") / service
        info = cached_json(IMAGESERVER_URL.format(name=service), {"f": "json"}, cdir / "service.json")
        if not isinstance(info, dict) or "extent" not in info:
            raise RuntimeError(f"{service}: unexpected ImageServer metadata: {str(info)[:200]}")
        if info.get("pixelType") != "F32":
            raise ValueError(f"{service}: pixelType {info.get('pixelType')} (expected F32 metres)")
        res = float(info["pixelSizeX"])
        if abs(res - float(info["pixelSizeY"])) > 1e-9:
            raise ValueError(f"{service}: non-square pixels")
        wkt = info["extent"]["spatialReference"].get("wkt", "")
        hemi: Hemisphere = "north" if ("North_Pole" in wkt or "NPole" in service) else "south"
        verify_ps_crs(wkt, hemi)
        ext = info["extent"]
        w = (ext["xmax"] - ext["xmin"]) / res
        h = (ext["ymax"] - ext["ymin"]) / res
        if abs(w - round(w)) > 1e-6 or abs(h - round(h)) > 1e-6:
            raise ValueError(f"{service}: extent is not a whole number of pixels")
        self.grid = RasterGrid(x_left=float(ext["xmin"]), y_top=float(ext["ymax"]), res=res,
                               width=int(round(w)), height=int(round(h)), hemisphere=hemi)
        exp = TREK_IMAGESERVER_SERVICES.get(service)
        if exp is not None:
            if abs(exp["res_m"] - res) > 1e-9:
                raise ValueError(f"{service}: res {res} != expected {exp['res_m']}")
            if np.isfinite(exp["half_extent_m"]) and abs(-ext["xmin"] - exp["half_extent_m"]) > 1e-6:
                raise ValueError(f"{service}: extent {ext} != expected +-{exp['half_extent_m']}")
        self.service_info = info
        self._init_cache(cdir if cache else None)

    def _fetch_block(self, bi: int, bj: int) -> np.ndarray:
        from rasterio.io import MemoryFile

        g, B = self.grid, self.block
        h = min(B, g.height - bi * B)
        w = min(B, g.width - bj * B)
        xmin = g.x_left + bj * B * g.res
        ymax = g.y_top - bi * B * g.res
        bbox = (xmin, ymax - h * g.res, xmin + w * g.res, ymax)
        params = {"bbox": ",".join(f"{v:.3f}" for v in bbox), "size": f"{w},{h}",
                  "format": "tiff", "pixelType": "F32", "interpolation": "RSP_NearestNeighbor",
                  "f": "image"}
        r = http_get(IMAGESERVER_URL.format(name=self.service) + "/exportImage", params=params,
                     timeout=self.timeout_s)
        if not r.content[:4] in (b"II*\x00", b"MM\x00*"):
            raise RuntimeError(f"{self.service}: exportImage did not return a TIFF: "
                               f"{r.content[:200]!r}")
        with MemoryFile(r.content) as mf, mf.open() as ds:
            t = ds.transform
            if (ds.width, ds.height) != (w, h) or abs(t.a - g.res) > 1e-9 or abs(t.e + g.res) > 1e-9 \
                    or abs(t.c - bbox[0]) > 1e-3 or abs(t.f - bbox[3]) > 1e-3:
                raise RuntimeError(f"{self.service}: server returned grid {ds.width}x{ds.height} "
                                   f"{t} for bbox {bbox} - not pixel-aligned")
            raw = ds.read(1)
        log.debug("%s: fetched block (%d, %d)", self.name, bi, bj)
        return to_metres(raw, 1.0, 0.0, None)

    def __repr__(self) -> str:
        return f"TrekImageServerDem({self.service}, res={self.grid.res} m)"


__all__ = ["TREK_BASE", "SEARCH_URL", "DATA_STREAM_URL", "METADATA_URL", "IMAGESERVER_URL",
           "WMTS_CAPABILITIES_URL", "LARGE_DOWNLOAD_BYTES", "TrekProduct", "TREK_PRODUCTS",
           "TREK_IMAGESERVER_SERVICES", "search_products", "product_record", "TrekHeaderInfo",
           "probe_remote_header", "read_head_window", "download_product", "TrekDem", "TrekImageServerDem"]
