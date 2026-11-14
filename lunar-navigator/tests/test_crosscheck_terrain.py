"""Cross-checks of terrain -> horizon -> visibility (lunarnav.validate_terrain).

Offline tests use synthetic terrain with analytic answers (and the local SPICE kernels when present).
Network tests read small windows of NASA products (PGDA product 69 / 90, first MB of Moon Trek files);
all reads are cached under data/cache, so later runs are offline.  Measured numbers of the full run
are in docs/VALIDATION_TERRAIN.md.
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from lunarnav import config
from lunarnav.horizon import geometric_dip_deg
from lunarnav.types import Site
from lunarnav.validate_terrain import (
    BANDS_20M,
    BANDS_40M,
    ILLUM_CRITERIA,
    MoonCentreEphemeris,
    SyntheticDem,
    TerrainBand,
    ValidationRaster,
    banded_mask,
    check_vector_ephemeris,
    combine_masks,
    compare_dem_sources,
    illumination_metrics,
    longest_run,
    make_times,
    offset_site,
    select_lit_pixels,
    select_psr_pixels,
    sensitivity_mast,
    site_illumination,
)
from lunarnav.visibility import compute_visibility

R = config.MOON_RADIUS_M


def _kernels_present() -> bool:
    k = config.kernels_dir()
    return all((k / f).exists() for f in ("naif0012.tls", "de440s.bsp", "moon_pa_de440_200625.bpc",
                                          "moon_de440_250416.tf", "pck00011.tpc"))


needs_kernels = pytest.mark.skipif(not _kernels_present(), reason="SPICE kernels not downloaded")

SITE = Site(id="syn", name="synthetic", lat_deg=-89.5, lon_deg=30.0)


def _ps(site: Site):
    from lunarnav.terrain.common import latlon_to_ps

    x, y = latlon_to_ps(site.lat_deg, site.lon_deg, "south")
    return float(x), float(y)


def _hill_fn(centres, heights, sigma_m):
    def fn(x, y):
        z = np.zeros(np.broadcast(x, y).shape)
        for (cx, cy), h in zip(centres, heights):
            z = z + h * np.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma_m ** 2))
        return z
    return fn


def _getter(dems):
    return lambda name: dems[name]


# ---------------------------------------------------------------------------------------------
# banded terrain model
# ---------------------------------------------------------------------------------------------
def test_banded_mask_flat_sphere_matches_geometric_dip_and_mast_monotone():
    """Flat sphere (h = 0): every bin must equal the smooth-sphere dip -acos(R/(R+h)), and the 10 m
    mast must lower the horizon by exactly dip(10) - dip(2) = 0.1075 deg in every bin.
    Tolerance 1e-3 deg: the tangent point (2.6 / 5.9 km) is sampled every 0.5 px = 10 m, the
    elevation error of the nearest sample is ~ (ds/2)^2 / (2 R d) << 1e-4 deg."""
    dem = SyntheticDem(lambda x, y: np.zeros(np.broadcast(x, y).shape), 20.0, "flat")
    bands = (TerrainBand("near", 8_000.0), TerrainBand("far", 20_000.0))
    get = _getter({"near": dem, "far": SyntheticDem(dem.fn, 100.0, "flat100")})
    res = sensitivity_mast(SITE, None, (2.0, 10.0), bands, get)
    exp2, exp10 = geometric_dip_deg(2.0, 0.0), geometric_dip_deg(10.0, 0.0)
    assert res["monotone"]
    assert res["per_height"][0]["horizon_max_deg"] == pytest.approx(exp2, abs=1e-3)
    assert res["min_drop_deg"] == pytest.approx(exp2 - exp10, abs=1e-3)
    assert res["max_drop_deg"] == pytest.approx(exp2 - exp10, abs=1e-3)
    assert exp2 - exp10 == pytest.approx(0.1075, abs=2e-4)


def test_banded_mask_equals_single_band_and_bands_pick_the_right_hill():
    """Two hills, one in each distance band. The banded mask (near 20 m + far 60 m DEM of the SAME
    function) must agree with a single 20 m band over the whole radius within 0.02 deg (60 m vs 20 m
    rasterisation of a sigma = 600 m Gaussian changes its crest by < 1 m -> < 0.01 deg at 6 km),
    and band_of_max must name the near band at the near hill's azimuth and the far band at the far one."""
    x0, y0 = _ps(SITE)
    s_near = offset_site(SITE, 3000.0, 90.0)
    s_far = offset_site(SITE, 9000.0, 200.0)
    fn = _hill_fn([_ps(s_near), _ps(s_far)], [150.0, 600.0], 600.0)
    get = _getter({"n20": SyntheticDem(fn, 20.0, "n20"), "f60": SyntheticDem(fn, 60.0, "f60"),
                   "all20": SyntheticDem(fn, 20.0, "all20")})
    site = Site(id="syn", name="s", lat_deg=SITE.lat_deg, lon_deg=SITE.lon_deg, height_m=0.0)
    banded = banded_mask(site, (TerrainBand("n20", 5000.0), TerrainBand("f60", 14000.0)), "raymarch",
                         2.0, get_dem=get)
    single = banded_mask(site, (TerrainBand("all20", 14000.0),), "raymarch", 2.0, get_dem=get)
    assert np.max(np.abs(banded.el_deg - single.el_deg)) < 0.02
    i_near = int(np.argmin(np.abs(banded.az_deg - 90.0)))
    i_far = int(np.argmin(np.abs(banded.az_deg - 200.0)))
    assert banded.meta["band_of_max"][i_near] == 0 and banded.meta["band_of_max"][i_far] == 1
    # exact elevation of the far crest (600 m at 9 km, observer 2 m, curvature drop d^2/2R = 23 m)
    d = 9000.0
    exp = math.degrees(math.atan2((R + 600) * math.cos(d / R) - (R + 2), (R + 600) * math.sin(d / R)))
    assert banded.el_deg[i_far] == pytest.approx(exp, abs=0.02)
    assert abs(banded.meta["horizon_distance_km"][i_far] - 9.0) < 0.1


def test_banded_raymarch_vs_bruteforce_synthetic_rough_terrain():
    """60 random hills (sigma 600 m, 50-400 m high), bands 20 m (2-6 km) + 40 m (6-14 km).

    The two algorithms model the DEM differently: raymarch interpolates bilinearly between pixel
    centres, bruteforce gives each cell its centre height over its whole footprint (flat-topped
    blocks).  Their difference in a bin is therefore bounded by (max slope) * (pixel size) /
    (horizon distance): asserted per bin (+ 0.005 deg for the 3-rays-per-bin sampling).  Bruteforce
    must not be systematically LOWER (block model >= bilinear surface): mean difference > -0.01."""
    rng = np.random.default_rng(3)
    x0, y0 = _ps(SITE)
    cen = [(x0 + rng.uniform(-15e3, 15e3), y0 + rng.uniform(-15e3, 15e3)) for _ in range(60)]
    fn = _hill_fn(cen, rng.uniform(50, 400, 60), 600.0)
    get = _getter({"n": SyntheticDem(fn, 20.0, "n"), "f": SyntheticDem(fn, 40.0, "f")})
    bands = (TerrainBand("n", 6000.0), TerrainBand("f", 14000.0))
    site = Site(id="syn", name="s", lat_deg=SITE.lat_deg, lon_deg=SITE.lon_deg)
    ray = banded_mask(site, bands, "raymarch", 2.0, near_exclusion_m=2000.0, get_dem=get)
    bf = banded_mask(site, bands, "bruteforce", 2.0, near_exclusion_m=2000.0, get_dem=get)
    d = bf.el_deg - ray.el_deg
    g = np.arange(-16e3, 16e3, 10.0)
    X, Y = np.meshgrid(x0 + g, y0 + g)
    zy, zx = np.gradient(fn(X, Y), 10.0)
    smax = float(np.max(np.hypot(zx, zy)))
    res = np.where(ray.meta["band_of_max"] == 0, 20.0, 40.0)
    bound = np.degrees(smax * res / (1000.0 * ray.meta["horizon_distance_km"])) + 0.005
    assert np.all(np.abs(d) <= bound)
    assert np.percentile(np.abs(d), 95) < 0.1  # measured 0.07
    assert np.mean(d) > -0.01


def test_combine_masks_rejects_inconsistent_observers():
    dem = SyntheticDem(lambda x, y: np.zeros(np.broadcast(x, y).shape), 50.0)
    get = _getter({"a": dem})
    s0 = Site(id="s", name="s", lat_deg=-89.5, lon_deg=0.0, height_m=0.0)
    s1 = Site(id="s", name="s", lat_deg=-89.5, lon_deg=0.0, height_m=5.0)
    m0 = banded_mask(s0, (TerrainBand("a", 3000.0),), get_dem=get)
    m1 = banded_mask(s1, (TerrainBand("a", 3000.0),), get_dem=get)
    with pytest.raises(ValueError):
        combine_masks([m0, m1], "raymarch", "x")
    with pytest.raises(ValueError):
        banded_mask(s0, (TerrainBand("a", 3000.0), TerrainBand("a", 2000.0)), get_dem=get)


def test_offset_site_distance_and_bearing_against_pyproj_geod():
    """offset_site must move the site by the requested arc length along the requested LOCAL bearing
    (clockwise from north); checked with pyproj.Geod on the 1737.4 km sphere to 1e-6 m / 1e-6 deg."""
    import pyproj

    g = pyproj.Geod(a=R, b=R)
    for base in (Site("a", "a", -89.45, 222.84), Site("b", "b", -88.2, 296.6), Site("c", "c", 10.0, 20.0)):
        for brg in (0.0, 45.0, 90.0, 225.0, 315.0):
            for dist in (100.0, 500.0):
                s = offset_site(base, dist, brg)
                az, _baz, d = g.inv(base.lon_deg, base.lat_deg, s.lon_deg, s.lat_deg)
                assert d == pytest.approx(dist, abs=1e-6)
                assert ((az - brg + 180) % 360 - 180) == pytest.approx(0.0, abs=1e-6)


# ---------------------------------------------------------------------------------------------
# DEM source comparison (Colab function) on synthetic data
# ---------------------------------------------------------------------------------------------
def test_compare_dem_sources_synthetic_offset_and_extra_hill():
    """dem_a = dem_b + 3 m everywhere + a 200 m hill 5 km due EAST of the site.
    Heights: the hill contributes > 1 m only within ~2.4 sigma, so the median difference is 3.000 m.
    Mask: largest difference at az 90 +- 1 deg (east, Horizons convention), equal to the exact
    elevation of the extra hill crest minus the base-terrain horizon there (computed analytically)."""
    x0, y0 = _ps(SITE)
    base = _hill_fn([(x0 - 4000.0, y0 + 1000.0)], [300.0], 800.0)
    hill = offset_site(SITE, 5000.0, 90.0)
    extra = _hill_fn([_ps(hill)], [200.0], 300.0)
    dem_b = SyntheticDem(base, 20.0, "b")
    dem_a = SyntheticDem(lambda x, y: base(x, y) + 3.0 + extra(x, y), 20.0, "a")
    # terrain closer than 1 km ignored: with the observer point fixed from dem_b, +3 m of terrain a
    # few metres from the mast would otherwise dominate (3 m at 1 km = 0.17 deg << 2.3 deg hill)
    r = compare_dem_sources(dem_a, dem_b, SITE, 8000.0, observer_height_m=2.0, near_exclusion_m=1000.0)
    assert r["height_diff_m"]["median"] == pytest.approx(3.0, abs=1e-6)
    md = r["mask_diff_deg"]
    assert abs(((md["az_of_max_deg"] - 90.0 + 180) % 360) - 180) <= 1.0
    h0 = float(base(np.array(x0), np.array(y0)))
    hc = float(base(*map(np.array, _ps(hill)))) + 203.0
    d = 5000.0
    el = math.degrees(math.atan2((R + hc) * math.cos(d / R) - (R + h0 + 2), (R + hc) * math.sin(d / R)))
    i90 = int(np.argmin(np.abs(r["_masks"][0].az_deg - 90.0)))
    assert r["_masks"][0].el_deg[i90] == pytest.approx(el, abs=0.03)
    # away from the hill the only change is +3 m of terrain: the horizon rises by ~3 m / distance
    far = np.abs(((r["_masks"][0].az_deg - 90.0 + 180) % 360) - 180) > 30
    dd = r["_masks"][0].el_deg[far] - r["_masks"][1].el_deg[far]
    assert np.all(dd > -1e-6)


# ---------------------------------------------------------------------------------------------
# pixel selection
# ---------------------------------------------------------------------------------------------
def _synthetic_rasters():
    n = 201
    res = 60.0
    x = (np.arange(n) - n // 2) * res
    y = -x  # north-up rows
    X, Y = np.meshgrid(x, y)
    r = np.hypot(X - 1500, Y + 900)
    avg = np.where(r < 1500, 0.0, np.clip((r - 1500) / 3000, 0, 0.85)).astype(np.float32)
    psr = (r < 1500).astype(np.float32)
    avg[50, 50] = 0.0  # an isolated artefact pixel inside the lit area
    return (ValidationRaster("AVG", avg, x, y, res), ValidationRaster("PSR", psr, x, y, res))


def test_pixel_selection_respects_interior_smoothness_and_separation():
    avg, psr = _synthetic_rasters()
    p = select_psr_pixels(avg, psr, n=10, min_sep_m=300.0)
    assert len(p) == 10
    for (i, j) in p:
        assert np.all(psr.values[i - 2:i + 3, j - 2:j + 3] == 1.0)
        assert np.all(avg.values[i - 2:i + 3, j - 2:j + 3] == 0.0)
    lit = select_lit_pixels(avg, n=15, min_sep_m=500.0)
    assert len(lit) == 15
    pts = np.array([(avg.x_m[j], avg.y_m[i]) for i, j in lit])
    dmin = min(np.hypot(*(pts[a] - pts[b])) for a in range(len(pts)) for b in range(a))
    assert dmin >= 500.0
    for (i, j) in lit:
        w = avg.values[i - 1:i + 2, j - 1:j + 2]
        assert avg.values[i, j] >= 0.6 and w.min() >= 0.5 and w.max() - w.min() <= 0.15
        assert not (i == 50 and j == 50)
    # deterministic
    assert select_lit_pixels(avg, n=15, min_sep_m=500.0) == lit


def test_longest_run_and_metrics_on_flat_horizon():
    assert longest_run(np.array([0, 1, 1, 0, 1, 1, 1, 0], bool)) == 3
    assert longest_run(np.zeros(5, bool)) == 0


# ---------------------------------------------------------------------------------------------
# ephemeris (local SPICE kernels)
# ---------------------------------------------------------------------------------------------
@needs_kernels
def test_moon_centre_vector_ephemeris_matches_spice_provider():
    """Topocentric from Moon-centre vectors vs SpiceProvider (observer-based spkcpo).

    Neglected term: the light time from the surface differs from the light time from the centre by
    up to 1737.4 km / c = 5.8 ms, during which the target moves ~30 km/s in the barycentric frame
    (SPICE light time is solved there) -> up to 0.17 km shift of the apparent target position:
    0.17 km in range and 0.17 km / 384 400 km = 2.6e-5 deg in direction for the Earth (measured
    2.7e-5 deg, 0.176 km).  Bounds 1e-4 deg (0.36 arcsec) and 0.5 km, far below any horizon effect."""
    t = make_times("2026-03-01T00:00:00", 15.0, 6.0)
    for s in (Site("c1", "c1", -89.4505, 222.84), Site("a11", "a11", 0.674, 23.473)):
        d = check_vector_ephemeris(s, t, 1200.0)
        for k in ("sun_el_deg", "sun_az_on_sky_deg", "earth_el_deg", "earth_az_on_sky_deg"):
            assert d[k] < 1e-4, (s.id, k, d[k])
        assert d["sun_dist_km"] < 0.5 and d["earth_dist_km"] < 0.5


@needs_kernels
def test_flat_horizon_polar_illumination_physics():
    """Flat sphere (no terrain) at 89.5S over 5 years: the Sun's elevation stays within
    +-(1.543 + 0.5) deg, so the average illumination is ~50 % (the Sun centre is above the flat
    horizon half the time, by symmetry of the declination cycle; observer 0 m => dip 0).
    Tolerance 3 pp: 5 years is not an integer number of draconic years (346.6 d) - residual
    asymmetry of the cycle sampling.  Earth: near the pole Earth is above a flat horizon about half
    the time too (libration in latitude +-6.7 deg); tolerance 8 pp."""
    t = make_times("2026-01-01T00:00:00", 5 * 365.25, 6.0)
    eph = MoonCentreEphemeris.compute(t)
    flat = SyntheticDem(lambda x, y: np.zeros(np.broadcast(x, y).shape), 50.0)
    get = _getter({"f": flat})
    m = site_illumination(Site("p", "p", -89.5, 0.0), eph, (TerrainBand("f", 5000.0),), 0.0, get_dem=get)
    assert m["avg_illum_pct"] == pytest.approx(50.0, abs=3.0)
    assert 50.0 < m["sun_any_pct"] < 60.0  # upper limb criterion: a bit more than the centre
    assert m["earth_any_pct"] == pytest.approx(50.0, abs=8.0)
    # a mast of 10 m adds 0.19 deg of dip -> more sunlight, never less
    m10 = site_illumination(Site("p", "p", -89.5, 0.0), eph, (TerrainBand("f", 8000.0),), 10.0, get_dem=get)
    assert m10["avg_illum_pct"] > m["avg_illum_pct"]


# ---------------------------------------------------------------------------------------------
# real NASA data (network, cached)
# ---------------------------------------------------------------------------------------------
@pytest.mark.network
def test_trek_header_assumptions_vs_pgda():
    """Moon Trek full-file headers (first 4-12 MB only): geographic CRS on the 1737.4 km sphere,
    no scale/offset tags, and raw values vs PGDA heights give the scale: 0.5 (Int16 half-metres) and
    1.0 (Float32 metres) within 1 % (300 points; inter-DEM noise ~3-6 m on heights of ~1-3 km)."""
    from lunarnav.validate_terrain import trek_header_check

    r = trek_header_check()
    a = r["LRO_LOLA_DEM_SPole875_5mp_v04_EQ"]
    b = r["LRO_LOLA_DEM_SPole75_30mp_v04_EQ"]
    assert a["pass"] and b["pass"]
    assert a["ratio_pgda_over_raw_lsq"] == pytest.approx(0.5, rel=0.01)
    assert b["ratio_pgda_over_raw_lsq"] == pytest.approx(1.0, rel=0.01)
    assert a["is_geographic"] and a["semi_major_m"] == pytest.approx(R, abs=1e-3)
    assert a["scales"] == [1.0] and a["offsets"] == [0.0]


@pytest.mark.network
@pytest.mark.slow
def test_real_terrain_raymarch_vs_bruteforce_ridge():
    """Ridge C1 on PGDA 20/120/240 m bands, 2 m mast.

    Beyond 2 km the two independent algorithms agree to p95 < 0.08 deg, max < 0.3 deg (bound
    slope * res / d = 0.2 * 20 m / 2 km = 0.11 deg for the typical 10 deg slopes; measured p95 0.040,
    max 0.063).  Including the near field p95 < 0.5 deg (measured 0.154: DEM-model difference at
    0.2 km, documented).  Physics: C1 is a crest that is lit ~85 % of the time, so its horizon must
    lie below the Sun's maximum elevation (~2.1 deg) everywhere and below 0 deg on average."""
    from lunarnav.sites import get_site
    from lunarnav.validate_terrain import mask_method_comparison

    r = mask_method_comparison([get_site("ref_connecting_ridge_c1")])[0]
    assert r["beyond_near_exclusion"]["p95_abs_deg"] < 0.08
    assert r["beyond_near_exclusion"]["max_abs_deg"] < 0.3
    assert r["full"]["p95_abs_deg"] < 0.5
    el = r["_masks"]["raymarch"].el_deg
    assert el.max() < 2.1 and el.mean() < 0.0
    # both bands beyond the near field matter: the far terrain sets part of the horizon
    assert r["frac_bins_set_by_band"][1] + r["frac_bins_set_by_band"][2] > 0.2


@pytest.mark.network
@pytest.mark.slow
def test_real_psr_and_lit_pixels_vs_pgda_illumination_maps():
    """PGDA product 69 (Mazarico et al. 2011, 2016 update) at 6 interior PSR pixels and 6 well-lit
    pixels (2 per AVGVISIB range 0.5-0.6 / 0.6-0.7 / >= 0.7), 2026-2030 (18.6 yr in the doc).

    * PSR: < 1 % average illumination for every observer definition (ILLUM_CRITERIA);
    * lit, 2 m mast: median |ours - PGDA| < 2x the 30-pixel criterion (6 pixels only), all within
      15 pp (doc, 30 px / 18.6 yr: median 3.9 pp, max 11.8 pp);
    * lit, primary 0 m / 60 m definition: ours is LOWER on average (doc: -7.6 pp, documented
      near-field finding) but never by more than 25 pp;
    * physics (exact): removing near terrain or raising the observer can only ADD sunlight, so
      per pixel surface0 <= pixel60 <= excl120 and surface0 <= mast2 (the ray samples of a larger
      exclusion are a subset of those of a smaller one: 20 m steps from 20 m; 1e-6 pp tolerance)."""
    from lunarnav.validate_terrain import illumination_validation

    t = make_times("2026-01-01T00:00:00", 5 * 365.25, 6.0)
    eph = MoonCentreEphemeris.compute(t)
    r = illumination_validation(eph, n_psr=6, n_lit=6, catalog_points=False)
    assert r["n_psr"] == 6 and r["n_lit"] == 6
    for v in ("pixel60", "surface0", "mast2", "excl120"):
        assert r["stats"][v]["psr"]["max_avg_illum_pct"] < ILLUM_CRITERIA["psr_max_pct"]
    lit = [p for p in r["pixels"] if p["kind"] == "lit"]
    d2 = np.array([p["variants"]["mast2"]["avg_illum_pct"] - p["pgda_avg_illum_pct"] for p in lit])
    assert np.median(np.abs(d2)) < 2 * ILLUM_CRITERIA["lit_median_abs_pp"]
    assert np.max(np.abs(d2)) < 15.0
    d0 = np.array([p["variants"]["pixel60"]["avg_illum_pct"] - p["pgda_avg_illum_pct"] for p in lit])
    assert np.mean(d0) < 0.0 and np.max(np.abs(d0)) < 25.0
    for p in r["pixels"]:
        v = {k: x["avg_illum_pct"] for k, x in p["variants"].items()}
        assert v["surface0"] <= v["pixel60"] + 1e-6 <= v["excl120"] + 2e-6
        assert v["surface0"] <= v["mast2"] + 1e-6


@pytest.mark.network
@pytest.mark.slow
def test_real_mast_height_and_small_moves_matter_at_the_ridge_not_on_the_plain():
    """Key 'small changes matter' check on real PGDA 20 m terrain, 2026-2030 at 6 h:

    * 10 m mast vs 2 m: horizon lower or equal in every bin, more sunlight (physics, exact);
    * moving the ridge point C1 by only 100 m changes its average illumination by > 10 pp in at
      least one direction (measured 64.9 pp, 18.6 yr), while moving the de Gerlache Rim 2 region
      centre (a smooth plain) by 100 m changes it by < 3 pp (measured 0.7 pp)."""
    from lunarnav.sites import get_site
    from lunarnav.validate_terrain import sensitivity_offsets

    t = make_times("2026-01-01T00:00:00", 5 * 365.25, 6.0)
    eph = MoonCentreEphemeris.compute(t)
    c1 = get_site("ref_connecting_ridge_c1")
    m = sensitivity_mast(c1, eph, (2.0, 10.0))
    assert m["monotone"] and m["illum_monotone"] and m["min_drop_deg"] >= 0.0
    assert m["per_height"][1]["avg_illum_pct"] > m["per_height"][0]["avg_illum_pct"]
    ridge = sensitivity_offsets(c1, eph, distances_m=(100.0,), n_dirs=8)
    plain = sensitivity_offsets(get_site("a3_de_gerlache_rim_2"), eph, distances_m=(100.0,), n_dirs=8)
    assert ridge["rings"][0]["illum_max_abs_change_pp"] > 10.0
    assert plain["rings"][0]["illum_max_abs_change_pp"] < 3.0


@pytest.mark.network
def test_real_trek_imageserver_vs_pgda_30m_around_ridge():
    """Moon Trek 30 m (ImageServer, native polar grid) vs PGDA 30 m (same grid) around C1, 10 km:
    height differences are the expected inter-version spread (std < 5 m, |median| < 2 m; measured
    std 2.1 m, median 0.14 m) and the horizon beyond 1 km agrees to p95 < 0.3 deg (measured 0.15)."""
    from lunarnav.sites import get_site
    from lunarnav.terrain.pgda import PgdaDem
    from lunarnav.terrain.trek import TrekImageServerDem

    r = compare_dem_sources(TrekImageServerDem("LRO_LOLA_DEM_SPole75_30mp_v04"),
                            PgdaDem("LDEM_75S_30MPP_ADJ"), get_site("ref_connecting_ridge_c1"), 10_000.0)
    assert r["height_diff_m"]["std"] < 5.0 and abs(r["height_diff_m"]["median"]) < 2.0
    assert r["height_diff_m"]["n_valid_fraction"] == 1.0
    assert r["mask_diff_beyond_deg"]["p95_abs_deg"] < 0.3
