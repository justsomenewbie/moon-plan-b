"""Tests for lunarnav.terrain (LOLA DEM readers: projection, sampling, Trek, PGDA, nesting).

Offline tests use synthetic GeoTIFFs that reproduce the metadata of the real products (CRS WKT
copied verbatim from the real file headers, dtype, nodata, tiling, half-metre storage).
Network tests (``-m network``) read only small windows / the first MB of the real files.
"""
from __future__ import annotations

import hashlib
import json
import math

import numpy as np
import pytest

from lunarnav import config
from lunarnav.terrain.common import (LocalPolarGeoTiffDem, NestedDem, RasterGrid, bilinear_regular,
                                     latlon_to_ps, ps_crs_wkt, ps_to_latlon, pyproj_ps_transformers,
                                     sample_patch, to_metres, verify_ps_crs)
from lunarnav.types import DemPatch, DemSource

R = config.MOON_RADIUS_M

#: CRS WKT exactly as found in the PGDA LDEM_80S_20MPP_ADJ.TIF header (note the odd AXIS tags).
PGDA_WKT = (
    'PROJCS["Moon (2015) - Sphere / Ocentric / South Polar",GEOGCS["Moon (2015) - Sphere / Ocentric",'
    'DATUM["Moon (2015) - Sphere",SPHEROID["Moon (2015) - Sphere",1737400,0,AUTHORITY["IAU","30100"]],'
    'AUTHORITY["IAU","30100"]],PRIMEM["Reference Meridian",0,AUTHORITY["IAU","30100"]],'
    'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["IAU","30100"]],'
    'PROJECTION["Polar_Stereographic"],PARAMETER["latitude_of_origin",-90],'
    'PARAMETER["central_meridian",0],PARAMETER["false_easting",0],PARAMETER["false_northing",0],'
    'UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",NORTH],AXIS["Northing",NORTH],'
    'AUTHORITY["IAU","30135"]]')

#: ESRI WKT returned by the Moon Trek ImageServer for LRO_LOLA_DEM_SPole875_5mp_v04.
TREK_IMAGESERVER_WKT = (
    'PROJCS["Moon2000_spole",GEOGCS["GCS_Moon",DATUM["D_Moon_2000",SPHEROID["Moon_2000_IAU_IAG",'
    '1737400.0,0.0]],PRIMEM["Reference_Meridian",0.0],UNIT["Degree",0.0174532925199433]],'
    'PROJECTION["Stereographic_South_Pole"],PARAMETER["false_easting",0.0],'
    'PARAMETER["false_northing",0.0],PARAMETER["central_meridian",0.0],'
    'PARAMETER["standard_parallel_1",-90.0],UNIT["Meter",1.0]]')

#: Geographic CRS WKT from the header of the real Trek LRO_LOLA_DEM_SPole875_5mp_v04_EQ.tif.
TREK_EQ_WKT = ('GEOGCS["GCS_Moon",DATUM["Moon",SPHEROID["Moon",1737400,0]],'
               'PRIMEM["Reference_Meridian",0],UNIT["degree",0.0174532925199433,'
               'AUTHORITY["EPSG","9122"]],AXIS["Latitude",NORTH],AXIS["Longitude",EAST]]')


def great_circle_m(lat1, lon1, lat2, lon2):
    """Haversine distance on the 1737.4 km sphere (independent of the projection code)."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dl = np.radians(np.asarray(lon2) - np.asarray(lon1))
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * R * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


# ================================================================================================
# Projection
# ================================================================================================
@pytest.mark.parametrize("hemi,sign", [("south", -1), ("north", 1)])
def test_projection_roundtrip_below_1mm(hemi, sign):
    rng = np.random.default_rng(1)
    lat = sign * rng.uniform(55.0, 90.0, 20000)
    lon = rng.uniform(-360.0, 720.0, 20000)  # any input range is accepted
    x, y = latlon_to_ps(lat, lon, hemi)
    lat2, lon2 = ps_to_latlon(x, y, hemi)
    assert np.all((lon2 >= 0) & (lon2 < 360))
    # surface distance between original and round-tripped point: float64 gives ~1e-9 m
    d = great_circle_m(lat, lon, lat2, lon2)
    assert d.max() < 1e-3


@pytest.mark.parametrize("hemi,sign", [("south", -1), ("north", 1)])
def test_projection_matches_pyproj_below_1mm(hemi, sign):
    """Closed form vs pyproj/PROJ (independent implementation of +proj=stere)."""
    rng = np.random.default_rng(2)
    lat = sign * rng.uniform(50.0, 90.0, 5000)
    lon = rng.uniform(0.0, 360.0, 5000)
    fwd, inv = pyproj_ps_transformers(hemi)
    xp, yp = fwd.transform(lon, lat)
    xo, yo = latlon_to_ps(lat, lon, hemi)
    assert np.max(np.hypot(xp - xo, yp - yo)) < 1e-3
    lonp, latp = inv.transform(xo, yo)
    assert great_circle_m(lat, lon, latp, lonp).max() < 1e-3


def test_projection_known_geometry():
    # the pole maps to the origin
    x, y = latlon_to_ps(-90.0, 123.0, "south")
    assert abs(x) < 1e-9 and abs(y) < 1e-9
    x, y = latlon_to_ps(90.0, 17.0, "north")
    assert abs(x) < 1e-9 and abs(y) < 1e-9
    lat, _ = ps_to_latlon(0.0, 0.0, "south")
    assert lat == -90.0
    # axis orientation: south pole +y towards 0E, +x towards 90E; north pole 0E is -y
    rho = 2 * R * math.tan(math.radians(0.5))  # colatitude 1 deg
    for lon, ex, ey in [(0, 0, rho), (90, rho, 0), (180, 0, -rho), (270, -rho, 0)]:
        x, y = latlon_to_ps(-89.0, lon, "south")
        assert abs(x - ex) < 1e-6 and abs(y - ey) < 1e-6
    x, y = latlon_to_ps(89.0, 0.0, "north")
    assert abs(x) < 1e-6 and abs(y + rho) < 1e-6
    # true scale at the pole: projected distance == surface distance for points near the pole.
    # rho = 2R tan(c/2) vs arc R c: relative difference c^2/12 = 2.5e-10 at c=0.1 deg (< 1 mm)
    x, y = latlon_to_ps(-89.9, 37.0, "south")
    assert abs(math.hypot(x, y) - great_circle_m(-90.0, 0.0, -89.9, 37.0)) < 1e-3
    # consistency with the PGDA product extents (square half-width ~ rho at the latitude limit,
    # within one product pixel): 80S -> 304 km (20 m px), 75S -> 457.44 km (30 m), 60S -> 931.2 km
    for lat_lim, half, px in [(-80.0, 304_000.0, 20.0), (-75.0, 457_440.0, 30.0), (-60.0, 931_200.0, 240.0)]:
        rho_lim = float(np.hypot(*latlon_to_ps(lat_lim, 0.0, "south")))
        assert abs(rho_lim - half) < px


def test_projection_cross_check_with_horizon_module():
    """Third, independent implementation (unit-vector form in lunarnav.horizon), if present."""
    horizon = pytest.importorskip("lunarnav.horizon")
    ps = getattr(horizon, "SOUTH_POLAR", None)
    if ps is None:
        pytest.skip("lunarnav.horizon has no SOUTH_POLAR")
    rng = np.random.default_rng(3)
    lat = rng.uniform(-90, -60, 2000)
    lon = rng.uniform(0, 360, 2000)
    xh, yh = ps.latlon_to_xy(lat, lon)
    xo, yo = latlon_to_ps(lat, lon, "south")
    assert np.max(np.hypot(xh - xo, yh - yo)) < 1e-3


def test_verify_ps_crs_accepts_real_product_crs_and_rejects_others():
    verify_ps_crs(PGDA_WKT, "south")             # PGDA COG header
    verify_ps_crs(TREK_IMAGESERVER_WKT, "south")  # Trek ImageServer (ESRI WKT)
    verify_ps_crs(ps_crs_wkt("south"), "south")
    verify_ps_crs(ps_crs_wkt("north"), "north")
    with pytest.raises(ValueError):  # wrong hemisphere
        verify_ps_crs(ps_crs_wkt("north"), "south")
    with pytest.raises(ValueError):  # true scale at 71S instead of the pole (k0 != 1)
        verify_ps_crs("+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +R=1737400 +units=m", "south")
    with pytest.raises(ValueError):  # central meridian rotated
        verify_ps_crs("+proj=stere +lat_0=-90 +lon_0=180 +k=1 +R=1737400 +units=m", "south")
    with pytest.raises(ValueError):  # wrong body radius (1738 km)
        verify_ps_crs("+proj=stere +lat_0=-90 +lon_0=0 +k=1 +R=1738000 +units=m", "south")
    with pytest.raises(ValueError):  # geographic, not projected
        verify_ps_crs(TREK_EQ_WKT, "south")


# ================================================================================================
# Units and sampling
# ================================================================================================
def test_to_metres_half_metres_nodata_and_range_check():
    raw = np.array([[2000, -4000, 32767], [0, 1, -101]], dtype=np.int16)
    z = to_metres(raw, scale=0.5, nodata=32767)
    assert z.dtype == np.float32
    np.testing.assert_array_equal(z[0, :2], [1000.0, -2000.0])
    np.testing.assert_array_equal(z[1], [0.0, 0.5, -50.5])
    assert np.isnan(z[0, 2])
    # ArcGIS float sentinel and NaN are nodata
    zf = to_metres(np.array([-3.4028235e38, np.nan, 12.5], dtype=np.float32))
    assert np.isnan(zf[0]) and np.isnan(zf[1]) and zf[2] == 12.5
    # Int16 read as if metres*2 (forgetting the 0.5) gives > 12 km for real south-pole highs
    with pytest.raises(ValueError):
        to_metres(np.array([30000], dtype=np.int16), scale=1.0)


def test_to_metres_minus32768_not_silently_valid_when_out_of_range():
    # -32768 * 0.5 = -16384 m is outside the plausible lunar range -> must raise, not pass through
    with pytest.raises(ValueError):
        to_metres(np.array([-32768, 10], dtype=np.int16), scale=0.5, nodata=32767)


def test_bilinear_exact_on_planes_and_nan_handling():
    # bilinear interpolation reproduces any bilinear function a + bx + cy + dxy exactly
    xs = 100.0 + 20.0 * np.arange(30)
    ys = -500.0 + 20.0 * np.arange(25)
    X, Y = np.meshgrid(xs, ys)
    f = lambda x, y: 7.0 + 0.3 * x - 0.2 * y + 1e-4 * x * y  # noqa: E731
    p = DemPatch(x_m=xs, y_m=ys, z_m=f(X, Y), crs_wkt=ps_crs_wkt(), source="t", resolution_m=20.0)
    rng = np.random.default_rng(4)
    xq = rng.uniform(xs[0], xs[-1], 1000)
    yq = rng.uniform(ys[0], ys[-1], 1000)
    np.testing.assert_allclose(sample_patch(p, xq, yq), f(xq, yq), atol=1e-9)
    # exact grid corners incl. the last centre
    np.testing.assert_allclose(sample_patch(p, xs[[0, -1]], ys[[0, -1]]), f(xs[[0, -1]], ys[[0, -1]]))
    # outside the hull of pixel centres -> NaN
    assert np.all(np.isnan(sample_patch(p, np.array([xs[0] - 1, xs[-1] + 1]), np.array([ys[3]] * 2))))
    # a NaN neighbour poisons the 4 surrounding cells only (no averaging of nodata into heights)
    z = f(X, Y)
    z[10, 10] = np.nan
    p2 = DemPatch(x_m=xs, y_m=ys, z_m=z, crs_wkt=p.crs_wkt, source="t", resolution_m=20.0)
    assert np.isnan(sample_patch(p2, xs[10] + 5, ys[10] - 5))
    assert np.isnan(sample_patch(p2, xs[10], ys[10]))
    assert np.isfinite(sample_patch(p2, xs[11] + 1, ys[10]))   # weight of the NaN pixel is 0
    np.testing.assert_allclose(sample_patch(p2, xs[12], ys[12]), f(xs[12], ys[12]))


def test_bilinear_periodic_columns():
    z = np.tile(np.arange(10.0), (3, 1))   # value = column index; columns at x = 0.5 .. 9.5
    v = bilinear_regular(z, 0.5, 0.0, 1.0, 1.0, np.array([9.75, 0.25, 0.5]), np.array([1.0] * 3),
                         wrap_cols=True)
    # between last column (9) and first (0): linear in the periodic sense
    np.testing.assert_allclose(v, [9 * 0.75 + 0 * 0.25, 9 * 0.25 + 0 * 0.75, 0.0])


# ================================================================================================
# Synthetic polar stereographic GeoTIFF (PGDA-like)
# ================================================================================================
def terrain_fn(x, y):
    """Smooth synthetic terrain in metres (scales 15-20 km, amplitude 1.5 km)."""
    return 1500.0 * np.sin(np.asarray(x) / 15000.0) * np.cos(np.asarray(y) / 20000.0) - 800.0 \
        + 0.002 * np.asarray(x)


def write_ps_tif(path, res, half, fn=terrain_fn, wkt=PGDA_WKT, dtype="float32", nodata=np.nan,
                 scale=None, holes=()):
    import rasterio
    from rasterio.transform import from_origin

    n = int(round(2 * half / res))
    xc = -half + (np.arange(n) + 0.5) * res
    yc = half - (np.arange(n) + 0.5) * res
    X, Y = np.meshgrid(xc, yc)
    z = fn(X, Y)
    if scale is not None:
        z = np.round(z / scale)
    z = z.astype(dtype)
    for (i, j) in holes:
        z[i, j] = nodata
    prof = dict(driver="GTiff", width=n, height=n, count=1, dtype=dtype, crs=wkt,
                transform=from_origin(-half, half, res, res), nodata=nodata, tiled=True,
                blockxsize=256, blockysize=256, compress="deflate")
    with rasterio.open(path, "w", **prof) as ds:
        ds.write(z, 1)
    return xc, yc[::-1]


@pytest.fixture(scope="module")
def ps_tif(tmp_path_factory):
    p = tmp_path_factory.mktemp("ps") / "synthetic_LDEM_50MPP.tif"
    write_ps_tif(p, res=50.0, half=20_000.0, holes=[(400, 400)])
    return p


def test_local_ps_dem_values_orientation_and_native_grid(ps_tif):
    dem = LocalPolarGeoTiffDem(ps_tif, block=128)  # small blocks -> exercises block stitching
    assert isinstance(dem, DemSource)
    assert dem.grid == RasterGrid(-20000.0, 20000.0, 50.0, 800, 800, "south")
    lat, lon = -89.75, 63.0   # x ~ 6.8 km, y ~ 3.4 km
    p = dem.patch(lat, lon, 3000.0)
    xc, yc = latlon_to_ps(lat, lon)
    # DemPatch contract: 1-D increasing axes, z shape (len(y), len(x)), native pixel centres
    assert np.all(np.diff(p.x_m) == 50.0) and np.all(np.diff(p.y_m) == 50.0)
    assert p.z_m.shape == (len(p.y_m), len(p.x_m))
    assert np.allclose(np.mod(p.x_m - 25.0, 50.0), 0.0) and np.allclose(np.mod(p.y_m - 25.0, 50.0), 0.0)
    assert p.x_m[0] <= xc - 3000 and p.x_m[-1] >= xc + 3000
    assert p.y_m[0] <= yc - 3000 and p.y_m[-1] >= yc + 3000
    assert p.x_m[-1] - p.x_m[0] < 6000 + 2 * 50 and p.resolution_m == 50.0
    X, Y = np.meshgrid(p.x_m, p.y_m)
    # float32 storage: |z| <= 2.4 km -> rounding <= 2.4e3 * 6e-8 = 1.5e-4 m
    np.testing.assert_allclose(p.z_m, terrain_fn(X, Y), atol=1e-3)
    verify_ps_crs(p.crs_wkt, "south")
    # height_at: exact at pixel centres, bilinear error bound elsewhere:
    # |f''| <= 1500/15000^2 = 6.7e-6 /m -> err <= 2 * (50^2/8) * 6.7e-6 = 4e-3 m
    rng = np.random.default_rng(5)
    xs = rng.uniform(-19000, 19000, 3000)
    ys = rng.uniform(-19000, 19000, 3000)
    la, lo = ps_to_latlon(xs, ys)
    h = dem.height_at(la, lo)
    near_hole = np.hypot(xs - (-20000 + 400.5 * 50), ys - (20000 - 400.5 * 50)) < 80
    np.testing.assert_allclose(h[~near_hole], terrain_fn(xs, ys)[~near_hole], atol=5e-3)
    # nodata hole -> NaN at that pixel, never a fake height
    assert np.isnan(dem.height_at_xy(-20000 + 400.5 * 50, 20000 - 400.5 * 50))
    # outside the raster -> NaN
    assert np.isnan(dem.height_at(-85.0, 0.0))
    # queries exactly on pixel centres next to block boundaries (rows/cols 126..130, block 128)
    # return the stored pixel values (no NaN from float round-off at window edges)
    jj, ii = np.meshgrid(np.arange(126, 131), np.arange(126, 131))
    xs_c, ys_c = dem.grid.col_center(jj), dem.grid.row_center(ii)
    np.testing.assert_allclose(dem.height_at_xy(xs_c, ys_c), terrain_fn(xs_c, ys_c), atol=1e-3)
    np.testing.assert_allclose(dem.height_at(*ps_to_latlon(xs_c, ys_c)), terrain_fn(xs_c, ys_c), atol=1e-3)


def test_pgda_dem_on_local_file_equals_local_reader(ps_tif):
    from lunarnav.terrain.pgda import PgdaDem

    a = PgdaDem(product="SYNTH", local_path=ps_tif, block=200)
    b = LocalPolarGeoTiffDem(ps_tif)
    lat = np.array([-89.9, -89.7, -89.5])
    lon = np.array([10.0, 200.0, 300.0])
    # different block layouts -> different window origins -> float64 rounding only (1e-9 m)
    np.testing.assert_allclose(a.height_at(lat, lon), b.height_at(lat, lon), rtol=0, atol=1e-9)
    pa, pb = a.patch(-89.8, 45.0, 2500.0), b.patch(-89.8, 45.0, 2500.0)
    np.testing.assert_array_equal(pa.z_m, pb.z_m)
    np.testing.assert_array_equal(pa.x_m, pb.x_m)


def test_pgda_rejects_wrong_scale_or_crs(tmp_path):
    from lunarnav.terrain.pgda import PgdaDem

    bad = tmp_path / "bad_crs.tif"
    write_ps_tif(bad, 100.0, 5000.0, wkt=ps_crs_wkt("north"))
    with pytest.raises(ValueError):
        PgdaDem(product="SYNTH", local_path=bad)  # north CRS is not the PGDA south projection
    # registry product with mismatching grid
    ok = tmp_path / "LDEM_80S_20MPP_ADJ.tif"
    write_ps_tif(ok, 100.0, 5000.0)
    with pytest.raises(ValueError, match="pixel size"):
        PgdaDem(product="LDEM_80S_20MPP_ADJ", local_path=ok)


def test_block_cache_roundtrip(tmp_path, ps_tif):
    """Disk-cached blocks give identical values to direct reads (and survive a new instance)."""
    class Cached(LocalPolarGeoTiffDem):
        pass

    d1 = Cached(ps_tif, block=256)
    d1._init_cache(tmp_path / "cache")
    v1 = d1.read_window(100, 200, 300, 300)
    files = sorted((tmp_path / "cache").glob("*.npz"))
    assert len(files) == 4  # rows 100..399 x cols 200..499 touch 2 x 2 blocks of 256
    d2 = Cached(ps_tif, block=256)
    d2._init_cache(tmp_path / "cache")
    d2._fetch_block = lambda bi, bj: (_ for _ in ()).throw(AssertionError("must use cache"))
    np.testing.assert_array_equal(d2.read_window(100, 200, 300, 300), v1)


# ================================================================================================
# Synthetic Trek-like geographic GeoTIFF
# ================================================================================================
TREK_SYNTH_PX = 0.02            # deg; real 5 m product: 0.0011760941 deg (same layout, coarser)
TREK_SYNTH_TOP = -86.46411384641813   # real product's top latitude
TREK_SYNTH_H = 176              # bottom edge -89.984 deg: 0.8 px short of the pole, like the real file


@pytest.fixture(scope="module")
def trek_tif(tmp_path_factory):
    """Mimics LRO_LOLA_DEM_SPole875_5mp_v04_EQ: geographic WKT of the real header, Int16 in
    HALF-METRES with no scale tag, nodata 32767, 128x128 tiles, lon -180..180."""
    import rasterio
    from rasterio.transform import from_origin

    W = int(round(360.0 / TREK_SYNTH_PX))
    H = TREK_SYNTH_H
    lat_c = TREK_SYNTH_TOP - (np.arange(H) + 0.5) * TREK_SYNTH_PX
    lon_c = -180.0 + (np.arange(W) + 0.5) * TREK_SYNTH_PX
    LON, LAT = np.meshgrid(lon_c, lat_c)
    X, Y = latlon_to_ps(LAT, LON, "south")
    raw = np.round(terrain_fn(X, Y) / 0.5).astype(np.int16)
    raw[150, 1000] = 32767     # a nodata pixel
    raw[0, :] = 32767          # top row: outside the polar square, like the real corners
    path = tmp_path_factory.mktemp("trek") / "SYNTH_SPole_EQ.tif"
    with rasterio.open(path, "w", driver="GTiff", width=W, height=H, count=1, dtype="int16",
                       crs=TREK_EQ_WKT, transform=from_origin(-180.0, TREK_SYNTH_TOP, TREK_SYNTH_PX,
                                                              TREK_SYNTH_PX),
                       nodata=32767, tiled=True, blockxsize=128, blockysize=128) as ds:
        ds.write(raw, 1)
    from lunarnav.terrain.trek import TrekProduct
    prod = TrekProduct("SYNTH_SPole_EQ", "00000000-0000-0000-0000-000000000000", path.stat().st_size,
                       "int16", 0.5, 32767.0, W, H, TREK_SYNTH_PX, -180.0, TREK_SYNTH_TOP, 600.0,
                       "none")
    return path, prod


# Tolerance for Trek synthetic checks: half-metre quantisation (<= 0.25 m) + bilinear error in the
# lat/lon grid (row spacing 0.02 deg = 606 m: 2 * 606^2/8 * 6.7e-6 = 0.62 m) -> 1.0 m.
TREK_TOL_M = 1.0


def test_trek_synthetic_height_at_matches_terrain(trek_tif):
    from lunarnav.terrain.trek import TrekDem

    path, prod = trek_tif
    dem = TrekDem(path=path, product=prod)
    assert isinstance(dem, DemSource) and dem.wrap and dem.clamp_bottom
    rng = np.random.default_rng(6)
    lat = rng.uniform(-89.97, -86.6, 4000)
    lon = rng.uniform(0, 360, 4000)
    h = dem.height_at(lat, lon)
    x, y = latlon_to_ps(lat, lon)
    truth = terrain_fn(x, y)
    bad = np.isnan(h)
    # only the points next to the single nodata pixel may be NaN
    assert bad.sum() <= 4
    assert np.max(np.abs(h[~bad] - truth[~bad])) < TREK_TOL_M
    # dateline seam: lon 179.999 vs -179.999 are 0.002 deg apart -> same height within tolerance
    hs = dem.height_at([-88.0, -88.0, -88.0], [179.999, -179.999, 180.001])
    xs, ys = latlon_to_ps(-88.0, 180.0)
    assert np.all(np.abs(hs - terrain_fn(xs, ys)) < TREK_TOL_M)
    # half-metre scaling really applied (a wrong scale of 1.0 would double heights)
    assert abs(float(dem.height_at(-88.0, 45.0)) - float(terrain_fn(*latlon_to_ps(-88.0, 45.0)))) < TREK_TOL_M
    # the nodata pixel and the empty top row are NaN, never 16383.5 m
    lat_nd = TREK_SYNTH_TOP - 150.5 * TREK_SYNTH_PX
    lon_nd = -180.0 + 1000.5 * TREK_SYNTH_PX
    assert np.isnan(dem.height_at(lat_nd, lon_nd))
    assert np.isnan(dem.height_at(TREK_SYNTH_TOP - 0.6 * TREK_SYNTH_PX, 10.0))


def test_trek_synthetic_polar_cap(trek_tif):
    """Within the last ~0.8 px around the pole: radial interpolation towards the edge-row mean.
    Error budget: mean over the 785 m ring vs centre value (r^2/4 lap f ~ 1 m) + radial linear
    interpolation (f'' r^2/8 ~ 0.5 m) -> 2 m."""
    from lunarnav.terrain.trek import TrekDem

    path, prod = trek_tif
    dem = TrekDem(path=path, product=prod)
    lat = np.array([-90.0, -89.999, -89.99, -89.98])
    lon = np.array([0.0, 77.0, 200.0, 300.0])
    h = dem.height_at(lat, lon)
    truth = terrain_fn(*latlon_to_ps(lat, lon))
    assert np.all(np.isfinite(h))
    assert np.max(np.abs(h - truth)) < 2.0


def test_trek_synthetic_patch_is_polar_stereographic(trek_tif):
    from lunarnav.terrain.trek import TrekDem

    path, prod = trek_tif
    dem = TrekDem(path=path, product=prod, patch_resolution_m=200.0)
    p = dem.patch(-89.5, 300.0, 12_000.0)
    verify_ps_crs(p.crs_wkt, "south")
    assert np.all(np.diff(p.x_m) > 0) and np.all(np.diff(p.y_m) > 0)
    assert np.allclose(np.diff(p.x_m), 200.0) and p.resolution_m == 200.0
    X, Y = np.meshgrid(p.x_m, p.y_m)
    ok = np.isfinite(p.z_m)
    assert ok.mean() > 0.99
    assert np.max(np.abs(p.z_m[ok] - terrain_fn(X, Y)[ok])) < TREK_TOL_M
    # the patch includes the pole region (site at 0.5 deg colatitude = 15 km, half-size 12 km)
    xc, yc = latlon_to_ps(-89.5, 300.0)
    assert p.x_m[0] <= xc - 12_000 <= xc + 12_000 <= p.x_m[-1]


def test_trek_requires_known_scale(trek_tif):
    from lunarnav.terrain.trek import TrekDem

    path, prod = trek_tif
    with pytest.raises(ValueError, match="scale_to_m"):
        TrekDem(path=path)           # unknown product: refuse to guess half-metres vs metres
    import dataclasses
    with pytest.raises(ValueError, match="size"):
        TrekDem(path=path, product=dataclasses.replace(prod, width=prod.width + 1))
    with pytest.raises(ValueError, match="dtype"):
        TrekDem(path=path, product=dataclasses.replace(prod, dtype="float32"))


def test_trek_registry_is_self_consistent():
    from lunarnav.terrain.trek import TREK_PRODUCTS

    exp_lat_spacing = {"LRO_LOLA_DEM_SPole875_5mp_v04_EQ": 35.66, "LRO_LOLA_DEM_SPole75_30mp_v04_EQ": 86.65,
                       "LRO_LOLA_DEM_SPole45_100mp_v04_EQ": 155.70}
    for label, p in TREK_PRODUCTS.items():
        assert abs(p.width * p.pixel_deg - 360.0) < 2 * p.pixel_deg   # full longitude circle
        assert abs(p.bottom_lat_deg + 90.0) < 1.0 * p.pixel_deg        # reaches the pole within 1 px
        assert abs(p.lat_spacing_m - exp_lat_spacing[label]) < 0.01
        assert (p.dtype == "int16") == (p.scale_to_m == 0.5)            # Int16 = half-metres
        # uncompressed Int16 file size ~ width*height*2 (+ IFD/offset tables), checks registry dims
        if p.dtype == "int16":
            assert 1.0 < p.file_size / (p.width * p.height * 2) < 1.03


# ================================================================================================
# Trek download logic (offline, fake HTTP server)
# ================================================================================================
class _FakeResp:
    def __init__(self, body: bytes, status: int = 200):
        self.body, self.status_code = body, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)

    def iter_content(self, n):
        for i in range(0, len(self.body), n):
            yield self.body[i:i + n]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_download_refuses_large_files_without_permission(monkeypatch, tmp_path):
    from lunarnav.terrain import trek

    monkeypatch.delenv("LUNARNAV_ALLOW_LARGE_DOWNLOADS", raising=False)
    monkeypatch.delenv("COLAB_RELEASE_TAG", raising=False)
    monkeypatch.setattr(trek, "product_record", lambda *a, **k: pytest.fail("no network expected"))
    import requests
    monkeypatch.setattr(requests, "get", lambda *a, **k: pytest.fail("no download expected"))
    with pytest.raises(RuntimeError, match="large downloads are disabled"):
        trek.download_product("LRO_LOLA_DEM_SPole75_30mp_v04_EQ", dest_dir=tmp_path)


def test_download_restarts_when_server_ignores_range(monkeypatch, tmp_path):
    import requests
    from lunarnav.terrain import trek

    body = bytes(np.random.default_rng(7).integers(0, 256, 100_000, dtype=np.uint8))
    prod = trek.TrekProduct("FAKE_EQ", "fake-uuid", len(body), "int16", 0.5, 32767.0, 1, 1, 1.0,
                            -180.0, 0.0, 1.0, "none")
    monkeypatch.setitem(trek.TREK_PRODUCTS, "FAKE_EQ", prod)
    seen = []

    def fake_get(url, params=None, stream=False, timeout=None, headers=None):
        seen.append(dict(headers or {}))
        return _FakeResp(body, 200)          # like Moon Trek: Range ignored, full body

    monkeypatch.setattr(requests, "get", fake_get)
    (tmp_path / "FAKE_EQ.tif.part").write_bytes(b"garbage-from-an-interrupted-run" * 100)
    out = trek.download_product("FAKE_EQ", dest_dir=tmp_path, verify=False, cross_check=False)
    assert out.read_bytes() == body                       # restarted from zero, no garbage prefix
    assert seen[0].get("Range", "").startswith("bytes=")  # resume was attempted
    meta = json.loads((tmp_path / "FAKE_EQ.tif.json").read_text())
    assert meta["sha256"] == hashlib.sha256(body).hexdigest() and meta["size"] == len(body)
    assert not (tmp_path / "FAKE_EQ.tif.part").exists()
    # second call: already complete -> no HTTP request
    monkeypatch.setattr(requests, "get", lambda *a, **k: pytest.fail("should be cached"))
    assert trek.download_product("FAKE_EQ", dest_dir=tmp_path, verify=False, cross_check=False) == out


def test_download_resumes_with_206_and_rejects_truncated(monkeypatch, tmp_path):
    import requests
    from lunarnav.terrain import trek

    body = bytes(range(256)) * 400
    prod = trek.TrekProduct("FAKE2_EQ", "fake-uuid-2", len(body), "int16", 0.5, 32767.0, 1, 1, 1.0,
                            -180.0, 0.0, 1.0, "none")
    monkeypatch.setitem(trek.TREK_PRODUCTS, "FAKE2_EQ", prod)

    def fake_206(url, params=None, stream=False, timeout=None, headers=None):
        start = int(headers["Range"].split("=")[1].rstrip("-"))
        return _FakeResp(body[start:], 206)

    monkeypatch.setattr(requests, "get", fake_206)
    (tmp_path / "FAKE2_EQ.tif.part").write_bytes(body[:12345])
    out = trek.download_product("FAKE2_EQ", dest_dir=tmp_path, verify=False, cross_check=False)
    assert out.read_bytes() == body
    assert json.loads((tmp_path / "FAKE2_EQ.tif.json").read_text())["sha256"] == \
        hashlib.sha256(body).hexdigest()
    # truncated transfer -> size check fails, partial file kept
    prod3 = trek.TrekProduct("FAKE3_EQ", "u3", len(body), "int16", 0.5, 32767.0, 1, 1, 1.0, -180.0,
                             0.0, 1.0, "none")
    monkeypatch.setitem(trek.TREK_PRODUCTS, "FAKE3_EQ", prod3)
    monkeypatch.setattr(requests, "get", lambda *a, **k: _FakeResp(body[:-10], 200))
    with pytest.raises(RuntimeError, match="size mismatch"):
        trek.download_product("FAKE3_EQ", dest_dir=tmp_path, verify=False, cross_check=False)
    assert (tmp_path / "FAKE3_EQ.tif.part").exists()


def test_patch_tiff_header_points_to_leading_ifd():
    """GDAL leaves the original IFD after the header; we re-point the header at it."""
    import struct

    from lunarnav.terrain.trek import _patch_tiff_header

    classic = bytearray(b"II*\x00" + struct.pack("<I", 10**9) + struct.pack("<H", 19) + b"\x00" * 100)
    big, orig = _patch_tiff_header(classic)
    assert not big and orig == 10**9 and struct.unpack_from("<I", classic, 4)[0] == 8
    bt = bytearray(b"II+\x00\x08\x00\x00\x00" + struct.pack("<Q", 10**9) + struct.pack("<Q", 20) + b"\x00" * 100)
    big, orig = _patch_tiff_header(bt)
    assert big and struct.unpack_from("<Q", bt, 8)[0] == 16
    with pytest.raises(ValueError):
        _patch_tiff_header(bytearray(b"II*\x00" + struct.pack("<I", 10**9) + struct.pack("<H", 0) + b"\x00" * 10))


# ================================================================================================
# NestedDem (offline)
# ================================================================================================
def test_nested_dem_picks_best_source_per_distance(tmp_path):
    fine_f = lambda x, y: np.full(np.broadcast(x, y).shape, 100.0)   # noqa: E731
    coarse_f = lambda x, y: np.full(np.broadcast(x, y).shape, -50.0)  # noqa: E731
    fpath, cpath = tmp_path / "fine.tif", tmp_path / "coarse.tif"
    write_ps_tif(fpath, 10.0, 5_000.0, fn=fine_f)
    write_ps_tif(cpath, 100.0, 60_000.0, fn=coarse_f)
    fine, coarse = LocalPolarGeoTiffDem(fpath, name="fine"), LocalPolarGeoTiffDem(cpath, name="coarse")
    nd = NestedDem([(fine, 4_000.0), (coarse, 50_000.0)])
    assert isinstance(nd, DemSource)
    # height_at: fine where it has data, coarse elsewhere
    lat_in, lon_in = ps_to_latlon(1000.0, 1000.0)
    lat_out, lon_out = ps_to_latlon(20_000.0, 0.0)
    np.testing.assert_array_equal(nd.height_at([lat_in, lat_out], [lon_in, lon_out]), [100.0, -50.0])
    # patch for a radius picks the finest source covering that radius
    assert nd.patch(lat_in, lon_in, 3_000.0).resolution_m == 10.0
    assert nd.patch(lat_in, lon_in, 30_000.0).resolution_m == 100.0
    # rings: contiguous distance bands, fine first
    rings = nd.rings(-90.0, 0.0, 30_000.0)
    assert [(r.inner_radius_m, r.outer_radius_m, r.source) for r in rings] == \
        [(0.0, 4_000.0, "fine"), (4_000.0, 30_000.0, "coarse")]
    assert np.all(rings[0].patch.z_m == 100.0) and np.nanmax(rings[1].patch.z_m) == -50.0
    with pytest.raises(ValueError):
        NestedDem([(coarse, 50_000.0), (fine, 4_000.0)])


def test_patch_size_guard(ps_tif):
    dem = LocalPolarGeoTiffDem(ps_tif)
    dem.max_pixels = 1000
    with pytest.raises(ValueError, match="max_pixels"):
        dem.patch(-89.8, 0.0, 5000.0)


# ================================================================================================
# Network tests: real NASA data, small windows only
# ================================================================================================
SHACKLETON = (-89.66, 129.2)   # crater centre (IAU/USGS gazetteer ~89.67S 129.8E; floor min found ~89.63S 118.7E)


@pytest.mark.network
def test_pgda_real_shackleton_window():
    """PGDA LDEM_80S_20MPP_ADJ around Shackleton (21 km wide, ~4 km deep, e.g. Zuber et al. 2012).
    Measured 2026-11: floor (r < 3 km) mean -2718 m, min -2872 m; rim annulus 10-11 km mean
    +1196 m, max +1738 m.  Bands below allow for small changes of centre/products."""
    from lunarnav.terrain.pgda import PgdaDem

    dem = PgdaDem("LDEM_80S_20MPP_ADJ")
    p = dem.patch(*SHACKLETON, 13_000.0)
    assert p.resolution_m == 20.0 and p.z_m.shape[0] > 1250
    z = p.z_m
    assert np.isfinite(z).mean() > 0.999 and np.nanmin(z) > -10_000 and np.nanmax(z) < 10_000
    X, Y = np.meshgrid(p.x_m, p.y_m)
    xc, yc = latlon_to_ps(*SHACKLETON)
    r = np.hypot(X - xc, Y - yc)
    floor = z[r < 3000]
    rim = z[(r >= 10_000) & (r < 11_000)]
    assert -3100 < floor.min() < -2600
    assert -2900 < floor.mean() < -2500
    assert 1400 < rim.max() < 2000
    assert 3500 < rim.mean() - floor.mean() < 4800      # ~4 km deep
    # height_at agrees with the patch (bilinear vs pixel values, < 0.5 m on 20 m pixels nearby)
    h = dem.height_at(*ps_to_latlon(p.x_m[700], p.y_m[650]))
    assert abs(float(h) - float(z[650, 700])) < 1e-3


@pytest.mark.network
def test_three_independent_lola_sources_agree():
    """PGDA (Barker 2023, 20 m) vs Moon Trek ImageServer native 5 m and 30 m polar grids.
    Different LOLA processings; measured agreement at these points < 1.5 m. Tolerance 10 m
    (gentle terrain; LOLA vertical accuracy ~1 m, interpolation between tracks ~ several m)."""
    from lunarnav.terrain.pgda import PgdaDem
    from lunarnav.terrain.trek import TrekImageServerDem

    lat = np.array([-90.0, -89.9, -89.66])
    lon = np.array([0.0, 45.0, 129.2])
    hp = PgdaDem("LDEM_80S_20MPP_ADJ").height_at(lat, lon)
    h5 = TrekImageServerDem("LRO_LOLA_DEM_SPole875_5mp_v04").height_at(lat, lon)
    h30 = TrekImageServerDem("LRO_LOLA_DEM_SPole75_30mp_v04").height_at(lat, lon)
    assert np.all(np.isfinite(hp)) and np.all(np.isfinite(h5)) and np.all(np.isfinite(h30))
    assert 1200 < hp[0] < 1400        # the south pole is on Shackleton's rim, ~ +1.29 km
    assert np.max(np.abs(hp - h5)) < 10 and np.max(np.abs(hp - h30)) < 10
    assert np.max(np.abs(h5 - h30)) < 10


@pytest.mark.network
def test_trek_imageserver_returns_native_pixels():
    """Pixel-aligned NN exportImage must return identical values regardless of the block layout
    (proves no server-side resampling), and the 5 m grid averaged 6x6 must match the 30 m grid."""
    from lunarnav.terrain.trek import TrekImageServerDem

    a = TrekImageServerDem("LRO_LOLA_DEM_SPole75_30mp_v04", block=1024)
    b = TrekImageServerDem("LRO_LOLA_DEM_SPole75_30mp_v04", block=300)
    x0, y0 = 4800.0, -4200.0     # window near Shackleton, on 30 m pixel edges
    r0 = int((a.grid.y_top - y0) / 30.0)
    c0 = int((x0 - a.grid.x_left) / 30.0)
    wa = a.read_window(r0, c0, 160, 160)
    wb = b.read_window(r0, c0, 160, 160)
    assert np.isfinite(wa).all()
    np.testing.assert_array_equal(wa, wb)
    d5 = TrekImageServerDem("LRO_LOLA_DEM_SPole875_5mp_v04", block=1024)
    r5 = int(round((d5.grid.y_top - y0) / 5.0))
    c5 = int(round((x0 - d5.grid.x_left) / 5.0))
    w5 = d5.read_window(r5, c5, 960, 960).reshape(160, 6, 160, 6).mean(axis=(1, 3))
    diff = w5 - wa
    # measured: mean -0.24 m, std 2.05 m (same LOLA v04 data, 5 m vs 30 m gridding)
    assert abs(np.mean(diff)) < 2.0 and np.std(diff) < 5.0


@pytest.mark.network
def test_trek_imageserver_vs_pgda_window():
    """Trek native 30 m vs PGDA 30 m (same grid: both +-457.44 km) - independent processings.
    Measured near Shackleton: mean 0.76 m, std 3.79 m, p99 |d| 16 m."""
    from lunarnav.terrain.pgda import PgdaDem
    from lunarnav.terrain.trek import TrekImageServerDem

    t = TrekImageServerDem("LRO_LOLA_DEM_SPole75_30mp_v04")
    p = PgdaDem("LDEM_75S_30MPP_ADJ")
    assert t.grid.x_left == p.grid.x_left and t.grid.res == p.grid.res
    r0, c0 = int((t.grid.y_top + 4200.0) / 30.0), int((4800.0 - t.grid.x_left) / 30.0)
    d = t.read_window(r0, c0, 160, 160) - p.read_window(r0, c0, 160, 160)
    assert abs(np.nanmean(d)) < 3.0 and np.nanstd(d) < 8.0


@pytest.mark.network
@pytest.mark.parametrize("label", ["LRO_LOLA_DEM_SPole75_30mp_v04_EQ", "LRO_LOLA_DEM_SPole875_5mp_v04_EQ"])
def test_trek_real_file_header(label):
    """First 4 MB of the real Trek files: geographic grid on the 1737.4 km sphere, as registered."""
    import pyproj

    from lunarnav.terrain.trek import TREK_PRODUCTS, probe_remote_header

    prod = TREK_PRODUCTS[label]
    h = probe_remote_header(label, nbytes=4 * 1024 * 1024)
    assert (h.width, h.height, h.dtype) == (prod.width, prod.height, prod.dtype)
    assert h.nodata == pytest.approx(prod.nodata, rel=1e-6)
    a, b, c, d, e, f = h.transform
    assert b == 0 and d == 0 and a == pytest.approx(prod.pixel_deg, rel=1e-12)
    assert e == pytest.approx(-prod.pixel_deg, rel=1e-12)
    assert c == -180.0 and f == pytest.approx(prod.top_lat_deg, abs=1e-12)
    crs = pyproj.CRS.from_wkt(h.crs_wkt)
    assert crs.is_geographic and not crs.is_projected     # NOT polar stereographic despite the name
    assert crs.ellipsoid.semi_major_metre == 1737400.0 and crs.ellipsoid.semi_minor_metre == 1737400.0
    assert h.block_shape == (128, 128)
    assert h.header_ifd_offset > 0.95 * prod.file_size   # the live IFD sits at the end of the file
    assert h.scales == (1.0,) and h.offsets == (0.0,)           # no scale tag: units must be known


@pytest.mark.network
def test_trek_int16_is_half_metres():
    """Raw Int16 values of the real 5 m Trek file (first tile row, 12 MB) vs PGDA 30 m heights:
    ratio must be 0.5. Measured: median 0.50003 (5-95%: 0.4987-0.5016), residual std 3.2 m."""
    from lunarnav.terrain.pgda import PgdaDem
    from lunarnav.terrain.trek import TREK_PRODUCTS, read_head_window

    p = TREK_PRODUCTS["LRO_LOLA_DEM_SPole875_5mp_v04_EQ"]
    raw = read_head_window(p.label, 0, 281 * 128, 128, 36 * 128).astype(float)
    rr, cc = np.nonzero(raw != p.nodata)
    assert rr.size > 10_000
    sel = np.linspace(0, rr.size - 1, 300).astype(int)
    rr, cc = rr[sel], cc[sel]
    lat = p.top_lat_deg - (rr + 0.5) * p.pixel_deg
    lon = p.left_lon_deg + (281 * 128 + cc + 0.5) * p.pixel_deg
    ref = PgdaDem("LDEM_75S_30MPP_ADJ").height_at(lat, lon)
    ratio = ref / raw[rr, cc]
    assert abs(np.nanmedian(ratio) - 0.5) < 0.005
    resid = ref - p.scale_to_m * raw[rr, cc]
    assert abs(np.nanmedian(resid)) < 3.0 and np.nanstd(resid) < 10.0


@pytest.mark.network
def test_trek_catalogue_matches_registry():
    from lunarnav.terrain.trek import TREK_PRODUCTS, _file_size_of, product_record

    for label, p in TREK_PRODUCTS.items():
        rec = product_record(label)
        assert rec["item_UUID"] == p.uuid and _file_size_of(rec) == p.file_size
        assert rec["PIXEL_DEPTH"].lower() == p.dtype


@pytest.mark.network
def test_pgda_illumination_products_readable():
    """Validation rasters (Mazarico et al. 2011 updates): Shackleton floor is a PSR (0 sun, 0 Earth)
    and the 89.9S/45E rim point is partly lit; all fractions within [0, 1]."""
    from lunarnav.terrain.pgda import read_validation_value

    sun = read_validation_value("AVGVISIB_85S_060M_201608", [-89.66, -89.9], [129.2, 45.0], neighborhood=1)
    earth = read_validation_value("AVGVISIB_85S_060M_201608_EARTH", [-89.66, -89.9], [129.2, 45.0],
                                  neighborhood=1)
    assert sun[0] == 0.0 and earth[0] == 0.0
    assert 0.2 < sun[1] < 0.8 and 0.2 < earth[1] < 0.9   # measured 0.41 / 0.56
