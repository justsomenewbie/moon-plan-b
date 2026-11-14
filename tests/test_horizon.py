"""Tests for lunarnav.horizon: projection / azimuth conventions and two independent horizon algorithms.

All terrain here is synthetic with an analytically known horizon; the projection itself is verified
against pyproj first, and the azimuth convention against pyproj.Geod (independent geodesic code).
"""
from __future__ import annotations

import math
import time
import warnings

import numpy as np
import pyproj
import pytest

from lunarnav import config
from lunarnav.horizon import (
    NORTH_POLAR,
    SOUTH_POLAR,
    PolarStereographic,
    compare_masks,
    compute_horizon,
    enu_basis,
    geometric_dip_deg,
    horizon_bruteforce,
    horizon_distance_m,
    horizon_flat,
    horizon_raymarch,
    latlon_to_unit,
    local_north_grid_direction,
    moon_polar_stereo_wkt,
    rasterize_height_function,
    ray_distances_m,
    sample_patch_bilinear,
)
from lunarnav.types import DemPatch, HorizonMask, Site

R = config.MOON_RADIUS_M
GEOD = pyproj.Geod(a=R, b=R)


# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------
def make_patch(lat: float, lon: float, half_m: float, res_m: float, hfun,
               proj: PolarStereographic = SOUTH_POLAR, dtype=float) -> DemPatch:
    """Square patch centred (grid-wise) on (lat, lon); hfun(u (...,3)) -> heights (m)."""
    xs, ys = proj.latlon_to_xy(lat, lon)
    n = int(round(half_m / res_m))
    x = float(xs) + res_m * np.arange(-n, n + 1)
    y = float(ys) + res_m * np.arange(-n, n + 1)
    xx, yy = np.meshgrid(x, y)
    z = np.asarray(hfun(proj.inverse_unit(xx, yy)), dtype=dtype)
    wkt = moon_polar_stereo_wkt(pole=proj.pole, lon0_deg=proj.lon0_deg, k0=proj.k0)
    return DemPatch(x_m=x, y_m=y, z_m=z, crs_wkt=wkt, source="synthetic", resolution_m=res_m)


def arc_m(u: np.ndarray, lat: float, lon: float) -> np.ndarray:
    """Great-circle distance (m on the 1737.4 km sphere) from (lat, lon) to unit vectors u."""
    c = latlon_to_unit(lat, lon)
    return R * np.arctan2(np.linalg.norm(np.cross(u, c), axis=-1), u @ c)


def exact_el_deg(h_target: np.ndarray, d_m: np.ndarray, h_obs_above_sphere: float) -> np.ndarray:
    """Exact elevation of a point at height h_target, arc distance d, seen from radius R+h_obs."""
    th = np.asarray(d_m, float) / R
    rt = R + np.asarray(h_target, float)
    return np.degrees(np.arctan2(rt * np.cos(th) - (R + h_obs_above_sphere), rt * np.sin(th)))


def fractal_patch(lat: float, lon: float, seed: int, res: float = 50.0, half: float = 20_000.0,
                  rms_slope_deg: float = 6.0) -> DemPatch:
    """Isotropic fractal terrain (amplitude spectrum ~ k^-2, Hurst ~1) with a given RMS slope."""
    xs, ys = SOUTH_POLAR.latlon_to_xy(lat, lon)
    n = int(round(half / res))
    x = float(xs) + res * np.arange(-n, n + 1)
    y = float(ys) + res * np.arange(-n, n + 1)
    rng = np.random.default_rng(seed)
    k = np.fft.fftfreq(x.size, res)
    kk = np.hypot(*np.meshgrid(k, k))
    kk[0, 0] = 1.0
    spec = (rng.normal(size=kk.shape) + 1j * rng.normal(size=kk.shape)) * kk ** -2.0
    spec[0, 0] = 0.0
    z = np.real(np.fft.ifft2(spec))
    gy, gx = np.gradient(z, res)
    z *= math.tan(math.radians(rms_slope_deg)) / np.sqrt(np.mean(gx ** 2 + gy ** 2))
    return DemPatch(x_m=x, y_m=y, z_m=z, crs_wkt=moon_polar_stereo_wkt(), source="fractal",
                    resolution_m=res)


def peak_az(mask: HorizonMask) -> float:
    """Azimuth of the mask maximum; for a plateau of tied bins (brute-force block cells spread
    over 2-3 bins) the circular mean of the tied bins."""
    top = mask.el_deg >= mask.el_deg.max() - 1e-9
    a = np.radians(mask.az_deg[top])
    return float(np.degrees(np.arctan2(np.sin(a).mean(), np.cos(a).mean())) % 360.0)


def az_diff(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


# ---------------------------------------------------------------------------------------------
# projection & conventions
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("pole", [-1, 1])
@pytest.mark.parametrize("lon0,k0,fe,fn", [(0.0, 1.0, 0.0, 0.0), (37.5, 0.994, 1500.0, -250.0)])
def test_projection_matches_pyproj(pole, lon0, k0, fe, fn):
    proj = PolarStereographic(pole=pole, lon0_deg=lon0, k0=k0, false_easting_m=fe,
                              false_northing_m=fn)
    crs = pyproj.CRS.from_proj4(proj.to_proj4())
    to_xy = pyproj.Transformer.from_crs(crs.geodetic_crs, crs, always_xy=True)
    rng = np.random.default_rng(0)
    lat = pole * rng.uniform(75.0, 89.999, 200)
    lon = rng.uniform(0.0, 360.0, 200)
    x, y = proj.latlon_to_xy(lat, lon)
    xp, yp = to_xy.transform(lon, lat)
    # 1 mm: both are closed-form double-precision evaluations at |x| < 500 km (expect ~1e-9 m).
    assert np.max(np.abs(x - xp)) < 1e-3 and np.max(np.abs(y - yp)) < 1e-3
    lat2, lon2 = proj.xy_to_latlon(x, y)
    assert np.max(np.abs(lat2 - lat)) < 1e-9
    assert np.max(np.abs((lon2 - lon + 180) % 360 - 180)) < 1e-7
    # round trip through from_crs (parsing + built-in pyproj verification)
    assert PolarStereographic.from_crs(crs.to_wkt()) == proj


def test_from_crs_esri_wkt_and_rejections():
    esri = ('PROJCS["Moon_SP",GEOGCS["Moon 2000",DATUM["D_Moon_2000",SPHEROID["Moon_2000_IAU_IAG",'
            '1737400.0,0.0]],PRIMEM["Greenwich",0],UNIT["Decimal_Degree",0.0174532925199433]],'
            'PROJECTION["Stereographic"],PARAMETER["False_Easting",0],PARAMETER["False_Northing",0],'
            'PARAMETER["Central_Meridian",0],PARAMETER["Scale_Factor",1],'
            'PARAMETER["Latitude_Of_Origin",-90],UNIT["Meter",1]]')
    assert PolarStereographic.from_crs(esri) == SOUTH_POLAR
    with pytest.raises(ValueError, match="not polar"):
        PolarStereographic.from_crs("+proj=stere +lat_0=-60 +lon_0=0 +R=1737400 +units=m")
    with pytest.raises(ValueError, match="sphere"):
        PolarStereographic.from_crs("+proj=stere +lat_0=-90 +lon_0=0 +ellps=WGS84 +units=m")
    with pytest.raises(ValueError, match="not polar stereographic"):
        PolarStereographic.from_crs("+proj=eqc +R=1737400 +units=m")


def test_local_north_in_south_polar_grid_points_away_from_pole():
    # Exact expectations: at lon 0 grid +y is the meridian lon=0, so north (away from the pole)
    # is +y; at lon 180 it is -y; at lon 90 it is +x (x = rho sin lon); at lon 270 -x.
    for lon, expect in [(0.0, (0, 1)), (180.0, (0, -1)), (90.0, (1, 0)), (270.0, (-1, 0))]:
        v = local_north_grid_direction(SOUTH_POLAR, -88.0, lon)
        assert np.allclose(v, expect, atol=1e-9), (lon, v)
    # North polar grid: north points TOWARDS the pole, i.e. -(x, y)/|(x, y)|.
    x, y = NORTH_POLAR.latlon_to_xy(87.0, 33.0)
    v = local_north_grid_direction(NORTH_POLAR, 87.0, 33.0)
    assert np.allclose(v, -np.array([x, y]) / np.hypot(x, y), atol=1e-9)
    # Independent check with pyproj: grid displacement of a 1e-5 deg step north.
    crs = pyproj.CRS.from_proj4(SOUTH_POLAR.to_proj4())
    tr = pyproj.Transformer.from_crs(crs.geodetic_crs, crs, always_xy=True)
    for lat, lon in [(-89.3, 12.0), (-85.0, 222.2), (-80.5, 301.0)]:
        x0, y0 = tr.transform(lon, lat)
        x1, y1 = tr.transform(lon, lat + 1e-5)
        d = np.array([x1 - x0, y1 - y0])
        # 1e-6: finite-difference truncation over 0.3 m is ~1e-7 in direction.
        assert np.allclose(local_north_grid_direction(SOUTH_POLAR, lat, lon),
                           d / np.linalg.norm(d), atol=1e-6)


def test_enu_azimuth_matches_geodesic_bearing():
    """Azimuth of a 3-D point in our ENU frame == great-circle initial bearing (pyproj.Geod)."""
    rng = np.random.default_rng(3)
    for lat, lon in [(-89.9, 10.0), (-87.2, 200.0), (-45.0, 300.0), (12.0, 5.0), (88.5, 140.0)]:
        e, n, u = enu_basis(lat, lon)
        tlat = np.clip(lat + rng.uniform(-1.5, 1.5, 50), -89.99, 89.99)
        tlon = lon + rng.uniform(-30, 30, 50)
        v = latlon_to_unit(tlat, tlon) - u
        az = np.degrees(np.arctan2(v @ e, v @ n)) % 360.0
        az_g, _, _ = GEOD.inv(np.full(50, lon), np.full(50, lat), tlon, tlat)
        # 1e-6 deg: both exact spherical formulas; Geod (Karney) converges to ~1e-12.
        assert np.max([az_diff(a, b) for a, b in zip(az, np.mod(az_g, 360))]) < 1e-6


def test_enu_at_exact_south_pole_uses_site_meridian():
    # Documented convention: at lat=-90 "north" is along the meridian of Site.lon_deg.
    e, n, u = enu_basis(-90.0, 30.0)
    assert np.allclose(n, [math.cos(math.radians(30)), math.sin(math.radians(30)), 0], atol=1e-15)
    assert np.allclose(e, [-math.sin(math.radians(30)), math.cos(math.radians(30)), 0], atol=1e-15)
    assert np.allclose(u, [0, 0, -1], atol=1e-15)
    assert np.allclose(np.cross(e, n), u, atol=1e-15)  # right-handed E,N,U


def test_geometric_dip_formula():
    # Small-angle approximation dip ~ -sqrt(2h/R) rad has relative error ~h/R; exact value known.
    for h in (0.0, 2.0, 10.0, 100.0):
        exact = geometric_dip_deg(h)
        approx = -math.degrees(math.sqrt(2 * h / R))
        assert abs(exact - approx) <= abs(approx) * 1e-4 + 1e-12
    assert geometric_dip_deg(2.0) == pytest.approx(-0.086937, abs=1e-6)
    assert horizon_distance_m(2.0) == pytest.approx(math.sqrt(2 * 2.0 * R), rel=1e-5)
    with pytest.raises(ValueError):
        geometric_dip_deg(-1.0)


def test_ray_distances_schedule():
    s = ray_distances_m(150_000.0, 12.5, 20_000.0, 12.5)
    assert s[0] == pytest.approx(12.5) and s[-1] == 150_000.0
    ds = np.diff(s)
    assert np.all(ds > 0)
    # step law ds = step0 (1 + s/g) (exact for the exponential schedule up to O(step0/g)).
    assert np.allclose(ds[:-1], 12.5 * (1 + s[:-2] / 20_000.0), rtol=1e-3)


# ---------------------------------------------------------------------------------------------
# HorizonMask.at
# ---------------------------------------------------------------------------------------------
def test_horizon_mask_at_wraps_around_360():
    az = np.arange(720) * 0.5
    el = np.sin(np.radians(az)) + 0.001 * az  # discontinuity 359.5 -> 0 tests the wrap segment
    m = HorizonMask("s", az, el, "test", "none", 1.0, 2.0, 0.0)
    a, b = el[-1], el[0]
    assert m.at(359.75) == pytest.approx(0.5 * (a + b), abs=1e-12)
    assert m.at(-0.25) == pytest.approx(0.5 * (a + b), abs=1e-12)
    assert m.at(360.0) == pytest.approx(b, abs=1e-12)
    assert m.at(720.5) == pytest.approx(el[1], abs=1e-12)
    assert np.allclose(m.at(az), el)
    assert np.allclose(m.at(np.array([359.9, -0.1, 0.1])),
                       [a + 0.8 * (b - a), a + 0.8 * (b - a), b + 0.2 * (el[1] - b)])


# ---------------------------------------------------------------------------------------------
# synthetic DEMs with analytic answers
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("mast", [2.0, 10.0])
def test_flat_sphere_equals_geometric_dip(mast):
    site = Site("flat", "flat", -89.0, 45.0)
    patch = make_patch(site.lat_deg, site.lon_deg, 12_000.0, 100.0, lambda u: np.zeros(u.shape[:-1]))
    dip = geometric_dip_deg(mast)
    for fn in (horizon_raymarch, horizon_bruteforce):
        m = fn(patch, site, mast, max_radius_km=11.0)
        # 0.01 deg is the spec; the only error is the discrete sampling around the tangent
        # point where d(el)/ds = 0 (second order): expected < 1e-4 deg.  This also holds for the
        # default brute-force footprint (docs/VALIDATION_TERRAIN.md §7): its quadrant floor covers
        # the azimuths between lattice columns that the central half alone left open (0.0035 deg).
        assert np.max(np.abs(m.el_deg - dip)) < 0.01
        assert np.max(np.abs(m.el_deg - dip)) < 1e-4
        assert m.surface_height_m == 0.0 and m.observer_height_m == mast
    flat = horizon_flat(site, mast)
    assert np.all(flat.el_deg == dip) and flat.method == "flat"
    assert flat.az_deg.size == int(360 / config.DEFAULT_AZ_STEP_DEG)


def test_constant_plateau_reads_surface_height_from_dem():
    site = Site("plat", "plat", -88.5, 300.0)
    patch = make_patch(site.lat_deg, site.lon_deg, 8_000.0, 100.0,
                       lambda u: np.full(u.shape[:-1], 1500.0))
    m = horizon_raymarch(patch, site, 2.0, max_radius_km=7.0)
    assert m.surface_height_m == pytest.approx(1500.0, abs=1e-9)
    assert np.max(np.abs(m.el_deg - geometric_dip_deg(2.0, 1500.0))) < 1e-4


def test_gaussian_crater_rim_gives_uniform_exact_mask():
    """Circular rim h = H exp(-((d-D)/sigma)^2) around the site: el = max_d exact_el(h(d), d)."""
    site = Site("rim", "rim", -89.6, 77.0)  # 12 km from the pole: the rim crosses the pole
    H, D, sig = 800.0, 8_000.0, 1_000.0
    hfun = lambda u: H * np.exp(-((arc_m(u, site.lat_deg, site.lon_deg) - D) / sig) ** 2)  # noqa
    patch = make_patch(site.lat_deg, site.lon_deg, 14_000.0, 50.0, hfun)
    d = np.arange(1.0, 13_000.0, 0.5)
    expected = float(np.max(exact_el_deg(H * np.exp(-((d - D) / sig) ** 2), d, 2.0)))
    assert 4.0 < expected < 6.0  # sanity: ~atan(800/8000) minus geometry
    for fn in (horizon_raymarch, horizon_bruteforce):
        m = fn(patch, site, 2.0, max_radius_km=13.0)
        # 0.02 deg: bilinear error of the Gaussian <= res^2/8 * |h''| ~ 0.6 m -> 0.004 deg at
        # 8 km; cell-centre / along-ray sampling near the (quadratic) maximum adds < 0.005 deg.
        assert np.max(np.abs(m.el_deg - expected)) < 0.02, fn.__name__
        assert np.std(m.el_deg) < 0.005  # uniform in azimuth
        assert np.all(m.meta["effective_radius_km"] > 12.9)


def test_distant_wall_includes_curvature_drop():
    """Plateau ring of height H starting at D = 100 km: the curvature drop D^2/2R ~ 2.9 km makes
    the wall nearly invisible, while flat-earth atan(H/D) would give 1.7 deg."""
    site = Site("wall", "wall", -89.5, 200.0)  # ring passes over the pole
    H, D, W, res = 3000.0, 100_000.0, 4_000.0, 200.0

    def hfun(u):
        d = arc_m(u, site.lat_deg, site.lon_deg)
        return np.where((d >= D) & (d <= D + W), H, 0.0)

    patch = make_patch(site.lat_deg, site.lon_deg, D + W + 1_000.0, res, hfun)
    # The bilinear ramp of the step spans <= res*sqrt(2) on either side of d = D, and el(d) on
    # the plateau decreases monotonically with d, so the answer is bracketed by the exact
    # elevation of the plateau top at D -/+ 1.5 res (bracket width ~0.02 deg).
    hi = float(exact_el_deg(H, D - 1.5 * res, 2.0))
    lo = float(exact_el_deg(H, D + 1.5 * res, 2.0))
    flat_earth = math.degrees(math.atan2(H - 2.0, D))
    assert flat_earth - hi > 1.5  # curvature matters by > 1.5 deg here
    assert hi - lo < 0.03
    for fn in (horizon_raymarch, horizon_bruteforce):
        m = fn(patch, site, 2.0, max_radius_km=D / 1000 + W / 1000 - 0.5)
        lo_m = lo
        if fn is horizon_raymarch:
            # the first ray sample on the plateau can lie up to one along-ray step behind the
            # ramp: ds = step_factor * res * (1 + D / growth)
            step = m.meta["step_factor"] * res * (1 + D / (m.meta["step_growth_km"] * 1e3))
            lo_m = float(exact_el_deg(H, D + 1.5 * res + step, 2.0))
        assert np.all(m.el_deg <= hi + 1e-6) and np.all(m.el_deg >= lo_m - 1e-6), fn.__name__
        assert np.std(m.el_deg) < 0.01
    rm = horizon_raymarch(patch, site, 2.0, max_radius_km=103.5)
    assert np.allclose(rm.meta["horizon_distance_km"], D / 1000, atol=0.5)


@pytest.mark.parametrize("dx_km,dy_km", [(0.0, -6.0), (0.0, 6.0), (-6.0, 0.0), (4.0, 4.0)])
def test_hill_in_grid_direction_appears_at_geodesic_azimuth(dx_km, dy_km):
    """Site at lon 180 in the south polar grid: grid -y is local NORTH (away from the pole),
    grid +y is SOUTH (towards the pole), grid -x is ~EAST.  Expected az from pyproj.Geod."""
    site = Site("az", "az", -88.0, 180.0)
    xs, ys = SOUTH_POLAR.latlon_to_xy(site.lat_deg, site.lon_deg)
    hx, hy = float(xs) + dx_km * 1e3, float(ys) + dy_km * 1e3
    hlat, hlon = SOUTH_POLAR.xy_to_latlon(hx, hy)
    expected = float(GEOD.inv(site.lon_deg, site.lat_deg, float(hlon), float(hlat))[0]) % 360.0
    grid_expect = {(0.0, -6.0): 0.0, (0.0, 6.0): 180.0, (-6.0, 0.0): 90.0}
    if (dx_km, dy_km) in grid_expect:  # radial grid lines are meridians: exact; -x is ~east
        assert az_diff(expected, grid_expect[(dx_km, dy_km)]) < (3.0 if dx_km else 1e-6)
    hfun = lambda u: 600.0 * np.exp(-(arc_m(u, float(hlat), float(hlon)) / 400.0) ** 2)  # noqa
    patch = make_patch(site.lat_deg, site.lon_deg, 9_000.0, 50.0, hfun)
    for fn in (horizon_raymarch, horizon_bruteforce):
        m = fn(patch, site, 2.0, max_radius_km=8.5)
        # symmetric hill -> peak in the bin containing its direction: |error| <= 1 bin (0.5 deg)
        assert az_diff(peak_az(m), expected) <= 0.5, (fn.__name__, peak_az(m), expected)
        assert m.el_deg.max() > 4.0  # 600 m at 6-8.5 km: clearly visible


@pytest.mark.parametrize("hill_lon,expected_az", [(0.0, 0.0), (90.0, 90.0), (270.0, 270.0),
                                                   (180.0, 180.0)])
def test_site_exactly_at_south_pole(hill_lon, expected_az):
    """At lat=-90 the azimuth origin is the meridian Site.lon_deg (=0 here); E = increasing lon."""
    site = Site("pole", "pole", -90.0, 0.0)
    hlat = -90.0 + math.degrees(5_000.0 / R)
    hfun = lambda u: 500.0 * np.exp(-(arc_m(u, hlat, hill_lon) / 400.0) ** 2)  # noqa: E731
    patch = make_patch(site.lat_deg, site.lon_deg, 7_000.0, 50.0, hfun)
    for fn in (horizon_raymarch, horizon_bruteforce):
        m = fn(patch, site, 2.0, max_radius_km=6.5)
        assert az_diff(peak_az(m), expected_az) <= 0.5, (fn.__name__, peak_az(m))


def test_north_polar_grid_and_lon0():
    proj = PolarStereographic(pole=1, lon0_deg=-60.0)
    site = Site("np", "np", 87.5, 10.0)
    targets = [(87.5 + math.degrees(5e3 / R), 10.0, 0.0)]  # due north along the meridian
    lon_e, lat_e, _ = GEOD.fwd(10.0, 87.5, 90.0, 6e3)  # due east along the great circle
    targets.append((lat_e, lon_e % 360, 90.0))
    for tlat, tlon, expected in targets:
        hfun = lambda u: 500.0 * np.exp(-(arc_m(u, tlat, tlon) / 400.0) ** 2)  # noqa: E731
        patch = make_patch(site.lat_deg, site.lon_deg, 8_000.0, 50.0, hfun, proj=proj)
        for fn in (horizon_raymarch, horizon_bruteforce):
            m = fn(patch, site, 2.0, max_radius_km=7.5)
            assert az_diff(peak_az(m), expected) <= 0.5, (fn.__name__, expected, peak_az(m))


# ---------------------------------------------------------------------------------------------
# cross-check of the two algorithms on random rough terrain
# ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("seed,lat,lon", [(1, -89.2, 120.0), (2, -89.2, 120.0), (7, -88.6, 15.0)])
def test_raymarch_vs_bruteforce_fractal_terrain(seed, lat, lon):
    """Fractal terrain (RMS slope 6 deg at 50 m, like lunar highlands at the pixel baseline).

    The two methods discretise the DEM differently: raymarch reads the bilinear surface, brute
    force treats each cell as a flat-topped block (centre height over its whole azimuth
    footprint).  Their elevation difference for terrain at distance d is bounded by
    ~ slope * (res/2) / d: tan(6 deg)*25 m / 2 km = 0.075 deg (RMS slope), so for terrain beyond
    40 pixels (2 km) we require the 95th percentile < 0.1 deg and a mean bias < 0.03 deg.
    Real LOLA south-pole horizons are set 10-100 km (500-5000 px) away, where the bound is
    < 0.01 deg.  Near-field terrain is checked separately below.
    """
    patch = fractal_patch(lat, lon, seed)
    site = Site(f"f{seed}", "fractal", lat, lon)
    a = horizon_raymarch(patch, site, 2.0, max_radius_km=18.0, min_distance_m=2000.0)
    b = horizon_bruteforce(patch, site, 2.0, max_radius_km=18.0, min_distance_m=2000.0)
    st = compare_masks(a, b)
    assert st["p95_abs_deg"] < 0.1, st
    assert abs(st["mean_deg"]) < 0.03, st
    assert st["max_abs_deg"] < 0.5, st
    # the masks are informative: the terrain horizon varies by > 0.3 deg with azimuth
    assert np.std(a.el_deg) > 0.3


def test_near_field_block_model_is_upper_envelope():
    """Including the near field, the whole-cell brute-force footprint (flat-topped blocks,
    ``footprint_extent=1.0``) is >= raymarch (bilinear) on average and an upper envelope in 95 % of
    the bins: the conservative near-field bias that made brute force 0.5-3.4 pp darker at Artemis
    rim sites.  The default footprint (central half within 40 px, capped at 6 deg, plus a bilinear
    quadrant floor; docs/VALIDATION_TERRAIN.md §7) removes most of it: the mean bias is near zero
    (measured +0.009 deg = bf marginally lower, vs -0.215), the spread much smaller (p95 0.28 vs
    1.46 deg) and no bin lies more than 1 deg below the converged raymarch (measured 0.52)."""
    patch = fractal_patch(-89.2, 120.0, 2)
    site = Site("nf", "nf", -89.2, 120.0)
    a = horizon_raymarch(patch, site, 2.0, max_radius_km=18.0)
    b = horizon_bruteforce(patch, site, 2.0, max_radius_km=18.0, footprint_extent=1.0)
    st = compare_masks(a, b)
    assert st["mean_deg"] < 0.0  # raymarch - bruteforce < 0: block model is higher
    # oversampled raymarch exceeds the block value only by sub-bin/bilinear effects (<0.1 deg)
    assert np.percentile(a.el_deg - b.el_deg, 95) < 0.1
    a15 = horizon_raymarch(patch, site, 2.0, max_radius_km=18.0, oversample=15)
    c = horizon_bruteforce(patch, site, 2.0, max_radius_km=18.0)  # default footprint
    old, new = a15.el_deg - b.el_deg, a15.el_deg - c.el_deg
    assert abs(np.mean(new)) < 0.05 and abs(np.mean(new)) < 0.2 * abs(np.mean(old))  # +0.009 vs -0.215
    assert np.percentile(np.abs(new), 95) < 0.5 < np.percentile(np.abs(old), 95)  # 0.28 vs 1.46 deg
    assert np.max(new) < 1.0  # no blind azimuth wedge (measured 0.52 deg)


# ---------------------------------------------------------------------------------------------
# nodata, patch edges, inputs
# ---------------------------------------------------------------------------------------------
def test_nodata_is_missing_not_zero():
    """Terrain at -500 m everywhere with a NaN block 3-6 km north: if NaN were read as 0 m the
    block would be a 500 m wall (el ~ +5 deg).  Missing data must leave the smooth-sphere dip."""
    site = Site("nan", "nan", -88.0, 180.0)  # local north = grid -y here

    def hfun(u):
        return np.full(u.shape[:-1], -500.0)

    patch = make_patch(site.lat_deg, site.lon_deg, 8_000.0, 50.0, hfun)
    xs, ys = SOUTH_POLAR.latlon_to_xy(site.lat_deg, site.lon_deg)
    xx, yy = np.meshgrid(patch.x_m - float(xs), patch.y_m - float(ys))
    patch.z_m[(np.abs(xx) < 1500) & (yy < -3000) & (yy > -6000)] = np.nan
    dip = geometric_dip_deg(2.0, -500.0)
    for fn in (horizon_raymarch, horizon_bruteforce):
        m = fn(patch, site, 2.0, max_radius_km=7.5)
        assert np.max(np.abs(m.el_deg - dip)) < 1e-3, fn.__name__  # same 2nd-order bound as flat
        assert m.surface_height_m == pytest.approx(-500.0)
    # bilinear sampling: any NaN corner -> NaN, outside -> NaN
    v = sample_patch_bilinear(patch, np.array([float(xs), float(xs), 1e9]),
                              np.array([float(ys), float(ys) - 4500.0, 0.0]))
    assert v[0] == pytest.approx(-500.0) and np.isnan(v[1]) and np.isnan(v[2])


def test_patch_edge_effective_radius_reported_and_warned():
    """Site at the pole (lon 0): az 0 -> grid +y, az 90 -> grid +x.  The square patch of half
    size L ends at ground distance ~L / max(|cos az|, |sin az|) (grid scale 1 + 1e-5 here)."""
    site = Site("edge", "edge", -90.0, 0.0)
    L = 10_000.0
    patch = make_patch(site.lat_deg, site.lon_deg, L, 50.0, lambda u: np.zeros(u.shape[:-1]))
    with pytest.warns(RuntimeWarning, match="covered only to"):
        m = horizon_raymarch(patch, site, 2.0, max_radius_km=30.0, oversample=1)
    with pytest.warns(RuntimeWarning, match="covered only to"):
        b = horizon_bruteforce(patch, site, 2.0, max_radius_km=30.0)
    a = np.radians(m.az_deg)
    expect_km = L / np.maximum(np.abs(np.cos(a)), np.abs(np.sin(a))) / 1000.0
    # raymarch: last valid sample lies within one step (25 m*(1+s/20 km) <= 45 m) of the edge
    assert np.all(m.meta["effective_radius_km"] <= expect_km + 1e-3)
    assert np.all(m.meta["effective_radius_km"] >= expect_km - 0.06)
    # bruteforce: farthest cell centre in each 0.5 deg bin, within ~ one bin width of the edge
    assert np.all(np.abs(b.meta["effective_radius_km"] - expect_km) < 0.15)
    assert m.meta["min_effective_radius_km"] == pytest.approx(10.0, abs=0.06)
    assert np.allclose(m.el_deg, geometric_dip_deg(2.0), atol=1e-4)


def test_callable_terrain_matches_rasterized_patch():
    site = Site("cal", "cal", -89.1, 250.0)
    xs, ys = SOUTH_POLAR.latlon_to_xy(site.lat_deg, site.lon_deg)

    def h(x, y):  # smooth terrain in projected coordinates (wavelengths >= 6 km)
        return 400.0 * np.sin((x - xs) / 3000.0 + 0.3) * np.cos((y - ys) / 2000.0) + 0.02 * (x - xs)

    res = 50.0
    n = 180
    x = float(xs) + res * np.arange(-n, n + 1)
    y = float(ys) + res * np.arange(-n, n + 1)
    patch = rasterize_height_function(h, x, y)
    a = horizon_raymarch(h, site, 2.0, max_radius_km=8.5, resolution_m=res)
    b = horizon_raymarch(patch, site, 2.0, max_radius_km=8.5)
    c = horizon_bruteforce(patch, site, 2.0, max_radius_km=8.5, min_distance_m=3000.0)
    a1 = horizon_raymarch(h, site, 2.0, max_radius_km=8.5, resolution_m=res, min_distance_m=3000.0)
    # bilinear error of this smooth surface <= res^2/8 |h''| = 312*400/2000^2 m = 0.03 m -> tiny
    assert compare_masks(a, b)["max_abs_deg"] < 0.01
    # block-vs-bilinear bound slope*res/2/d: max slope here ~0.2, 0.2*25 m/3 km = 0.095 deg
    assert compare_masks(a1, c)["p95_abs_deg"] < 0.1
    assert a.dem_source == "callable"
    with pytest.raises(ValueError, match="resolution_m"):
        horizon_raymarch(h, site, 2.0, max_radius_km=8.0)


def test_inputs_validation_and_dispatch():
    site = Site("v", "v", -89.0, 0.0)
    patch = make_patch(site.lat_deg, site.lon_deg, 5_000.0, 100.0, lambda u: np.zeros(u.shape[:-1]))
    far = Site("far", "far", -80.0, 0.0)
    with pytest.raises(ValueError, match="no valid DEM height"):
        horizon_raymarch(patch, far, 2.0, max_radius_km=2.0)
    with pytest.raises(ValueError, match="divide 360"):
        horizon_raymarch(patch, site, 2.0, az_step_deg=0.7, max_radius_km=2.0)
    with pytest.raises(TypeError):
        compute_horizon(lambda x, y: x * 0, site, method="bruteforce")
    with pytest.raises(ValueError):
        compute_horizon(patch, site, method="magic")
    # explicit Site.height_m overrides the DEM value
    s2 = Site("v2", "v2", -89.0, 0.0, height_m=0.0)
    m = compute_horizon(patch, s2, "raymarch", observer_height_m=5.0, max_radius_km=4.8)
    assert m.method == "raymarch" and m.observer_height_m == 5.0
    assert np.allclose(m.el_deg, geometric_dip_deg(5.0), atol=1e-4)
    assert compute_horizon(None, s2, "flat").method == "flat"


def test_float32_dem_supported():
    site = Site("f32", "f32", -89.0, 10.0)
    patch = make_patch(site.lat_deg, site.lon_deg, 5_000.0, 50.0,
                       lambda u: np.zeros(u.shape[:-1]), dtype=np.float32)
    m = horizon_raymarch(patch, site, 2.0, max_radius_km=4.5)
    assert np.max(np.abs(m.el_deg - geometric_dip_deg(2.0))) < 1e-4


# ---------------------------------------------------------------------------------------------
# performance
# ---------------------------------------------------------------------------------------------
@pytest.mark.slow
def test_raymarch_performance_150km_25m():
    """Spec: 720 azimuths out to 150 km on a ~25 m grid in < ~10 s (CPU).  Measured on the dev
    machine: ~0.6 s with oversample=1, ~1.7 s with the default oversample=3."""
    res, half = 25.0, 151_000.0
    x = np.arange(-half, half + 1, res)
    z = (300.0 * np.sin(x / 7e3)[None, :] * np.cos(x / 5e3)[:, None]).astype(np.float32)
    patch = DemPatch(x, x.copy(), z, moon_polar_stereo_wkt(), "perf", res)
    site = Site("perf", "perf", -90.0, 0.0)
    t = time.perf_counter()
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # full coverage expected: no edge warning
        m = horizon_raymarch(patch, site, 2.0, 0.5, 150.0)
    dt = time.perf_counter() - t
    print(f"raymarch 720 az x {m.meta['n_samples_per_ray']} samples x 3 rays: {dt:.2f} s")
    assert m.az_deg.size == 720 and m.meta["min_effective_radius_km"] == pytest.approx(150.0)
    assert dt < 10.0
