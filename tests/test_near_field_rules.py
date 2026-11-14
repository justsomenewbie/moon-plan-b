"""Near-field rules of the horizon (docs/VALIDATION_TERRAIN.md §7).

* O2  - raymarch ``near_exclusion_m="auto"``: terrain closer than 250 m is ignored on DEMs of <= 5 m
  (Moon Trek 5 m knobs 12-60 m from the mast became false horizons), nothing on coarser DEMs.
* O4b - Moon Trek geographic ``*_EQ`` near-field file: the first ray sample is one pixel of the file
  at the site's latitude (86.7 m for the 30 m product), else 0.5 * resolution.
* O4a - brute force spreads a near cell's centre elevation over the azimuth footprint of the cell's
  central half instead of the whole cell: no conservative near-field bias against the converged
  (15 rays / bin) raymarch, and no overshoot.
* the rules are in the manifest parameters and therefore in the resume fingerprint.
"""
from __future__ import annotations

import json
import math

import numpy as np
import pytest

from lunarnav import config
from lunarnav import horizon as hz
from lunarnav import precompute as pc
from lunarnav.types import DemPatch, Site

R = config.MOON_RADIUS_M


def _offset_xy(lat: float, lon: float, dist_m: float, az_deg: float) -> tuple[float, float]:
    """Projected (south polar) point at arc distance ``dist_m``, azimuth ``az_deg`` from the site."""
    E, N, U = hz.enu_basis(lat, lon)
    th = dist_m / R
    a = math.radians(az_deg)
    u = math.cos(th) * U + math.sin(th) * (math.cos(a) * N + math.sin(a) * E)
    x, y = hz.SOUTH_POLAR.forward_unit(u)
    return float(x), float(y)


def _gauss_fn(features):
    """h(x, y) = sum of Gaussians [(x0, y0, height, sigma), ...] on a 0 m plane (projected metres)."""
    def h(x, y):
        x = np.asarray(x, float)
        y = np.asarray(y, float)
        out = np.zeros(np.broadcast(x, y).shape)
        for x0, y0, hh, sg in features:
            out = out + hh * np.exp(-((x - x0) ** 2 + (y - y0) ** 2) / (2 * sg * sg))
        return out
    return h


class _FnDem:
    """DemSource over an analytic height function of projected coordinates (no files)."""

    def __init__(self, fn, resolution_m: float, name: str = "fn"):
        self.fn, self.resolution_m, self.name = fn, float(resolution_m), name

    def height_at(self, lat_deg, lon_deg):
        x, y = hz.SOUTH_POLAR.latlon_to_xy(np.asarray(lat_deg, float), np.asarray(lon_deg, float))
        return self.fn(x, y)

    def patch(self, lat_deg, lon_deg, half_size_m):
        xs, ys = hz.SOUTH_POLAR.latlon_to_xy(lat_deg, lon_deg)
        g = np.arange(-half_size_m, half_size_m + 1, self.resolution_m)
        x, y = float(xs) + g, float(ys) + g
        X, Y = np.meshgrid(x, y)
        return DemPatch(x, y, self.fn(X, Y), hz.moon_polar_stereo_wkt(-1), self.name, self.resolution_m)


SITE = Site("nf", "nf", -89.5, 0.0, height_m=0.0)


def _knob_and_hill():
    knob = _offset_xy(SITE.lat_deg, SITE.lon_deg, 15.0, 90.0)
    hill = _offset_xy(SITE.lat_deg, SITE.lon_deg, 1000.0, 200.0)
    return _gauss_fn([(*knob, 6.0, 3.0), (*hill, 200.0, 150.0)])


def _bin(m, az):
    return float(m.el_deg[int(round(az / (m.az_deg[1] - m.az_deg[0]))) % m.az_deg.size])


# ------------------------------------------------------------------------------------------------
# O2: 250 m near exclusion on <= 5 m DEMs only
# ------------------------------------------------------------------------------------------------
def test_resolve_near_exclusion():
    r = hz.resolve_near_exclusion_m
    assert r("auto", 5.0) == 250.0 and r("auto", 2.0) == 250.0
    assert r("auto", 5.01) == 0.0 and r("auto", 20.0) == 0.0 and r("auto", 30.0) == 0.0
    assert r(None, 5.0) == 0.0 and r(0, 5.0) == 0.0 and r(120.0, 30.0) == 120.0 and r("80", 5.0) == 80.0
    for bad in (-1.0, float("nan"), "far"):
        with pytest.raises(ValueError):
            r(bad, 5.0)


def test_5m_knob_ignored_hill_seen_with_auto_exclusion():
    """5 m DEM: +6 m knob 15 m east of a 2 m mast (el = atan(4/15) = 14.9 deg) and a +200 m hill 1 km
    away at az 200.  'auto' ignores the knob (< 250 m) and keeps the hill; 0 keeps both."""
    fn = _knob_and_hill()
    kw = dict(observer_height_m=2.0, az_step_deg=0.5, max_radius_km=3.0, resolution_m=5.0)
    auto = hz.compute_horizon(fn, SITE, "raymarch", near_exclusion_m="auto", **kw)
    off = hz.compute_horizon(fn, SITE, "raymarch", near_exclusion_m=0, **kw)
    hill_el = math.degrees(math.atan2((R + 200.0) * math.cos(1000 / R) - (R + 2.0), (R + 200.0) * math.sin(1000 / R)))
    assert _bin(off, 90.0) > 10.0                       # the knob is a false 15 deg horizon ...
    assert _bin(auto, 90.0) < 0.1                       # ... ignored with 'auto' on a 5 m DEM
    assert _bin(auto, 200.0) == pytest.approx(hill_el, abs=0.3)
    assert _bin(off, 200.0) == pytest.approx(_bin(auto, 200.0), abs=0.01)  # other sample grid only
    assert auto.meta["near_exclusion_m"] == 250.0 and auto.meta["first_sample_m"] == pytest.approx(250.0)
    assert auto.meta["near_exclusion_request"] == "auto"
    assert off.meta["near_exclusion_m"] == 0.0 and off.meta["first_sample_m"] == pytest.approx(2.5)


def test_auto_exclusion_not_applied_on_20m_and_30m():
    fn = _knob_and_hill()
    for res in (20.0, 30.0):
        m = hz.horizon_raymarch(fn, SITE, 2.0, 0.5, 3.0, resolution_m=res, near_exclusion_m="auto")
        assert m.meta["near_exclusion_m"] == 0.0
        assert m.meta["first_sample_m"] == pytest.approx(0.5 * res)


def test_make_horizon_fn_5m_nested_trek_like(monkeypatch):
    """make_horizon_fn: NestedDem with a 5 m fine level (default Trek layout) -> 250 m exclusion,
    knob ignored, hill seen; --near-exclusion-m 0 keeps the knob."""
    from lunarnav.terrain.common import NestedDem

    fn = _knob_and_hill()
    nested = NestedDem([(_FnDem(fn, 5.0, "fine5"), 60_000.0), (_FnDem(fn, 30.0, "coarse30"), 1.0e7)])
    monkeypatch.setattr(pc, "get_dem", lambda name, s, label=None, path=None: nested)
    m = pc.make_horizon_fn("trek", "raymarch", radius_km=3.0, observer_height_m=2.0)(SITE)
    assert m.meta["near_exclusion_m"] == 250.0 and m.meta["first_sample_m"] == pytest.approx(250.0)
    assert m.meta["eq_row_min_distance_m"] is None  # not a geographic Trek file
    assert _bin(m, 90.0) < 0.1 and _bin(m, 200.0) > 10.0
    m0 = pc.make_horizon_fn("trek", "raymarch", radius_km=3.0, near_exclusion_m=0)(SITE)
    assert m0.meta["first_sample_m"] == pytest.approx(2.5) and _bin(m0, 90.0) > 10.0
    # 20 m PGDA-like DEM: 'auto' excludes nothing
    monkeypatch.setattr(pc, "get_dem", lambda name, s, label=None, path=None: _FnDem(fn, 20.0, "p20"))
    m20 = pc.make_horizon_fn("trek", "raymarch", radius_km=3.0)(SITE)
    assert m20.meta["near_exclusion_m"] == 0.0 and m20.meta["first_sample_m"] == pytest.approx(10.0)


@pytest.mark.filterwarnings("ignore::RuntimeWarning")
def test_near_exclusion_is_raymarch_only():
    patch = _FnDem(_knob_and_hill(), 50.0).patch(SITE.lat_deg, SITE.lon_deg, 2000.0)
    hz.compute_horizon(patch, SITE, "bruteforce", max_radius_km=1.5, near_exclusion_m="auto")
    with pytest.raises(ValueError, match="raymarch"):
        hz.compute_horizon(patch, SITE, "bruteforce", max_radius_km=1.5, near_exclusion_m=250.0)
    with pytest.raises(ValueError, match="raymarch"):
        pc.make_horizon_fn("trek", "bruteforce", near_exclusion_m=250.0)
    with pytest.raises(ValueError):
        pc.make_horizon_fn("trek", "raymarch", near_exclusion_m=-5.0)


# ------------------------------------------------------------------------------------------------
# O4b: one EQ row as minimum distance for a Trek geographic near-field file
# ------------------------------------------------------------------------------------------------
EQ30_PX = 0.00285740904194023  # deg, LRO_LOLA_DEM_SPole75_30mp_v04_EQ


@pytest.fixture(scope="module")
def eq30_tif(tmp_path_factory):
    """Small geographic GeoTIFF with the pixel size of the Trek 30 m _EQ product around 85.4S 37.4E."""
    import rasterio
    from rasterio.transform import from_origin

    from lunarnav.terrain.trek import TrekProduct

    top, left = -85.10, 36.0
    H, W = 240, 1100
    lat_c = top - (np.arange(H) + 0.5) * EQ30_PX
    lon_c = left + (np.arange(W) + 0.5) * EQ30_PX
    LON, LAT = np.meshgrid(lon_c, lat_c)
    x, y = hz.SOUTH_POLAR.latlon_to_xy(LAT, LON)
    z = (1000.0 + 0.01 * x).astype(np.float32)
    path = tmp_path_factory.mktemp("eq30") / "SYNTH_EQ30.tif"
    wkt = ('GEOGCS["Moon 2000",DATUM["D_Moon_2000",SPHEROID["Moon_2000_IAU_IAG",1737400.0,0.0]],'
           'PRIMEM["Greenwich",0],UNIT["Decimal_Degree",0.0174532925199433]]')
    with rasterio.open(path, "w", driver="GTiff", width=W, height=H, count=1, dtype="float32", crs=wkt,
                       transform=from_origin(left, top, EQ30_PX, EQ30_PX)) as ds:
        ds.write(z, 1)
    prod = TrekProduct("SYNTH_EQ30", "00000000-0000-0000-0000-000000000000", path.stat().st_size,
                       "float32", 1.0, 1.1754939304327482e-38, W, H, EQ30_PX, left, top, 30.0, "none")
    return path, prod


def test_eq_row_spacing_from_file_geometry(eq30_tif):
    from lunarnav.terrain.trek import TrekDem

    path, prod = eq30_tif
    dem = TrekDem(path=path, product=prod)
    row, col = dem.pixel_ground_size_m(-85.43775)
    assert row == pytest.approx(math.radians(EQ30_PX) * R) and row == pytest.approx(86.65, abs=0.05)
    assert col == pytest.approx(row * math.cos(math.radians(85.43775)))
    assert pc.eq_row_min_distance_m(dem, -85.43775) == pytest.approx(row)
    assert pc.eq_row_min_distance_m(_FnDem(lambda x, y: x * 0, 30.0), -85.4) is None


def test_30m_min_distance_default_unless_trek_eq30(monkeypatch, eq30_tif):
    """30 m DEM: first sample 15 m (0.5 * res) for a projected DEM; ~one EQ row (86.7 m) when the
    near-field source is a Trek geographic 30 m file (directly or as a NestedDem fine level)."""
    from lunarnav.terrain.common import NestedDem
    from lunarnav.terrain.trek import TrekDem

    path, prod = eq30_tif
    site = Site("nob", "nob", -85.43775, 37.444641)
    eq = TrekDem(path=path, product=prod)
    flat30 = _FnDem(lambda x, y: 1000.0 + 0.01 * np.asarray(x, float), 30.0, "ps30")
    for src, expect in ((flat30, 15.0), (eq, math.radians(EQ30_PX) * R),
                        (NestedDem([(eq, 60_000.0), (flat30, 1e7)]), math.radians(EQ30_PX) * R)):
        monkeypatch.setattr(pc, "get_dem", lambda name, s, label=None, path=None, _s=src: _s)
        m = pc.make_horizon_fn("trek", "raymarch", radius_km=3.0, az_step_deg=1.0)(site)
        assert m.meta["near_exclusion_m"] == 0.0  # 30 m: no 250 m exclusion
        assert m.meta["first_sample_m"] == pytest.approx(expect, rel=1e-9), src
    m = pc.make_horizon_fn("trek", "raymarch", radius_km=3.0, az_step_deg=1.0, eq_row_min_distance=False)(site)
    assert m.meta["first_sample_m"] == pytest.approx(15.0)


# ------------------------------------------------------------------------------------------------
# O4a: brute force vs converged raymarch on terrain with near peaks
# ------------------------------------------------------------------------------------------------
def _pct_sun(mask, site, days=730.0):
    from lunarnav.analysis import make_times
    from lunarnav.visibility import VisibilityOptions, compute_visibility

    times = make_times("2026-01-01T00:00:00", "2028-01-01T00:00:00", 360.0)
    e = pc.SyntheticProvider().compute(site, times, mask.surface_height_m + mask.observer_height_m)
    v = compute_visibility(e, mask, VisibilityOptions(observer_height_m=mask.observer_height_m))
    return 100.0 * float(np.mean(v.sun_visible))


def _near_peak_case(seed: int):
    """20 m DEM around 86S: fractal terrain (RMS slope 6 deg, like the lunar highlands at the pixel
    baseline, as in test_horizon.fractal_patch) plus 4 knobs 5-20 m high (sigma 40-120 m) 60-600 m
    from the mast.  Returns (patch, site with its DEM height)."""
    from tests.test_horizon import fractal_patch

    lat, lon = -86.0, 120.0
    patch = fractal_patch(lat, lon, seed, res=20.0, half=8000.0, rms_slope_deg=6.0)
    rng = np.random.default_rng(100 + seed)
    feats = []
    for _ in range(4):
        d, a = rng.uniform(60.0, 600.0), rng.uniform(0.0, 360.0)
        feats.append((*_offset_xy(lat, lon, d, a), rng.uniform(5.0, 20.0), rng.uniform(40.0, 120.0)))
    X, Y = np.meshgrid(patch.x_m, patch.y_m)
    patch.z_m = patch.z_m + _gauss_fn(feats)(X, Y)
    xs, ys = hz.SOUTH_POLAR.latlon_to_xy(lat, lon)
    h = float(hz.sample_patch_bilinear(patch, np.atleast_1d(xs), np.atleast_1d(ys))[0])
    return patch, Site(f"np{seed}", "np", lat, lon, height_m=h)


def test_bruteforce_matches_converged_raymarch_near_peaks():
    """Brute force (every cell, central-half footprint) vs raymarch with 15 rays / bin, near field
    INCLUDED, on 8 synthetic sites where the near field sets the horizon: % sun (SyntheticProvider,
    2 yr, 6 h) agrees to < 0.5 pp at every site (measured max 0.38).  The former whole-cell footprint
    (``footprint_extent=1.0``) is biased conservative (measured -0.07..-1.99 pp, mean -1.4) and
    no spreading within 40 px (``footprint_extent=0.0``) overshoots: the fix sits between the two."""
    d_new, d_old, d_none = [], [], []
    for seed in range(8):
        patch, site = _near_peak_case(seed)
        ray = hz.horizon_raymarch(patch, site, 2.0, 0.5, 7.5, oversample=15, step_growth_km=1e6)
        p_ray = _pct_sun(ray, site)
        bf = hz.horizon_bruteforce(patch, site, 2.0, 0.5, 7.5)
        assert bf.meta["footprint_extent"] == 0.5 and bf.meta["footprint_model"] == hz.BRUTEFORCE_FOOTPRINT_MODEL
        d_new.append(_pct_sun(bf, site) - p_ray)
        d_old.append(_pct_sun(hz.horizon_bruteforce(patch, site, 2.0, 0.5, 7.5, footprint_extent=1.0), site) - p_ray)
        d_none.append(_pct_sun(hz.horizon_bruteforce(patch, site, 2.0, 0.5, 7.5, footprint_extent=0.0,
                                                       footprint_floor=False, footprint_max_deg=None),
                                site) - p_ray)
        print(seed, round(d_new[-1], 3), round(d_old[-1], 3), round(d_none[-1], 3))
    d_new, d_old, d_none = map(np.array, (d_new, d_old, d_none))
    assert np.all(np.abs(d_new) < 0.5), d_new
    assert np.mean(d_old) < -1.0 and np.all(d_old < 0.05), d_old      # old: conservative bias
    assert np.mean(d_none) > 3.0, d_none                                # no spreading: overshoot
    assert np.mean(np.abs(d_new)) < 0.3 * np.mean(np.abs(d_old))


# ------------------------------------------------------------------------------------------------
# manifest parameters / resume fingerprint
# ------------------------------------------------------------------------------------------------
def test_rules_in_manifest_and_fingerprint(tmp_path):
    from lunarnav.analysis import AnalysisOptions

    site = Site("fp", "fp", -89.5, 0.0, height_m=0.0)
    prov = pc.SyntheticProvider()
    fps, mans = [], []
    for k, ne in enumerate(("auto", 0.0, 250.0)):
        fn = pc.make_horizon_fn("none", near_exclusion_m=ne)
        out = pc.run_precompute([site], "2026-01-01", "2026-01-03", 360.0, prov, fn, tmp_path / f"r{k}",
                                "2026-01-01T00:00:00Z", AnalysisOptions())
        man = json.loads((out / "manifest.json").read_text())
        mans.append(man["parameters"])
        fps.append(man["params_fingerprint"])
    assert mans[0]["near_exclusion_m"] == "auto" and mans[1]["near_exclusion_m"] == 0.0
    assert mans[2]["near_exclusion_m"] == 250.0
    for p in mans:
        assert p["eq_row_min_distance"] is True and p["bruteforce_footprint"] == hz.BRUTEFORCE_FOOTPRINT_MODEL
    assert len(set(fps)) == 3  # a rule change changes the fingerprint -> --resume recomputes
    assert pc.check_output(tmp_path / "r0") == []


def test_cli_near_exclusion_flag():
    import argparse

    from lunarnav import cli

    assert cli._near_exclusion("auto") == "auto" and cli._near_exclusion("AUTO") == "auto"
    assert cli._near_exclusion("150") == 150.0 and cli._near_exclusion("0") == 0.0
    for bad in ("-1", "x", "inf"):
        with pytest.raises(argparse.ArgumentTypeError):
            cli._near_exclusion(bad)


# ------------------------------------------------------------------------------------------------
# review regressions: 'auto' from the DEM's own resolution, banded (PGDA) path, CLI wiring, EQ scope
# ------------------------------------------------------------------------------------------------
def test_auto_exclusion_uses_dem_resolution_not_step_override(monkeypatch):
    """A 5 m DEM run with ``resolution_m=10`` (``--dem-res-m 10``) still gets the 250 m exclusion:
    'auto' is decided from the DEM's own finest resolution, not from the step override."""
    fn = _knob_and_hill()
    monkeypatch.setattr(pc, "get_dem", lambda name, s, label=None, path=None: _FnDem(fn, 5.0, "d5"))
    for res in (None, 5.0, 10.0):
        m = pc.make_horizon_fn("trek", "raymarch", radius_km=3.0, observer_height_m=2.0, resolution_m=res)(SITE)
        assert m.meta["near_exclusion_m"] == 250.0, res
        assert m.meta["first_sample_m"] == pytest.approx(250.0)
        assert m.meta["near_exclusion_request"] == "auto"
        assert _bin(m, 90.0) < 0.1  # the 15 m knob stays excluded
    # a 20 m DEM with a 5 m step override: no exclusion either way
    monkeypatch.setattr(pc, "get_dem", lambda name, s, label=None, path=None: _FnDem(fn, 20.0, "d20"))
    m = pc.make_horizon_fn("trek", "raymarch", radius_km=3.0, resolution_m=5.0)(SITE)
    assert m.meta["near_exclusion_m"] == 0.0


def test_auto_exclusion_unknown_resolution_is_not_applied():
    class NoRes:
        pass

    assert pc._auto_exclusion_resolution_m(NoRes()) == math.inf
    assert hz.resolve_near_exclusion_m("auto", pc._auto_exclusion_resolution_m(NoRes())) == 0.0


@pytest.mark.parametrize("near_res, req, expect_excl", [
    (20.0, "auto", 0.0), (5.0, "auto", 250.0), (None, "auto", 0.0), (20.0, 150.0, 150.0), (5.0, 0.0, 0.0)])
def test_banded_pgda_raymarch_auto_rule(monkeypatch, near_res, req, expect_excl):
    """make_horizon_fn('pgda', 'raymarch'): the exclusion handed to banded_mask follows 'auto' on the
    FIRST band's resolution (20 m PGDA -> 0, first sample 10 m; a 5 m band -> 250 m; unknown -> 0)."""
    from lunarnav import validate_terrain as vt

    class Band:
        def __init__(self, product, r):
            self.product, self.outer_radius_m = product, r

    class Dem:  # like PgdaDem / BlockGridDem: pixel size in grid.res
        def __init__(self, res):
            if res is not None:
                self.grid = type("G", (), {"res": res})()

    bands = [Band("NEAR", 15_000.0), Band("FAR", 150_000.0)]
    dems = {"NEAR": Dem(near_res), "FAR": Dem(120.0)}
    seen = {}

    def fake_banded(site, b, method, h, step, near_exclusion_m=0.0, **kw):
        seen["excl"] = near_exclusion_m
        return pc.flat_horizon_mask(site.id, h, site.height_m or 0.0, step)

    monkeypatch.setattr(pc, "_dem_for_site", lambda *a, **k: (object(), bands))
    monkeypatch.setattr(vt, "pgda_dem", lambda prod: dems[prod])
    monkeypatch.setattr(vt, "banded_mask", fake_banded)
    m = pc.make_horizon_fn("pgda", "raymarch", near_exclusion_m=req)(SITE)
    assert seen["excl"] == expect_excl
    assert m.meta["near_exclusion_m"] == expect_excl
    assert m.meta["first_sample_m"] == pytest.approx(max(expect_excl, 0.5 * (near_res or 1.0)))
    mb = pc.make_horizon_fn("pgda", "bruteforce")(SITE)  # bruteforce: never excluded
    assert seen["excl"] == 0.0 and mb.meta["near_exclusion_m"] == 0.0


def test_cli_near_exclusion_reaches_horizon_fn():
    """--near-exclusion-m is wired to make_horizon_fn: default 'auto', explicit value as float."""
    from lunarnav import cli

    base = ["precompute", "--sites", "ref_shackleton_rim", "--provider", "synthetic", "--dem", "none",
            "--out", "unused"]
    args = cli.build_parser().parse_args(base)
    assert args.near_exclusion_m == "auto"
    hfn = cli._setup(args)[2]
    assert hfn.horizon_parameters["near_exclusion_m"] == "auto"
    args = cli.build_parser().parse_args(base + ["--near-exclusion-m", "150"])
    assert cli._setup(args)[2].horizon_parameters["near_exclusion_m"] == 150.0
    args = cli.build_parser().parse_args(base + ["--near-exclusion-m", "0"])
    assert cli._setup(args)[2].horizon_parameters["near_exclusion_m"] == 0.0


def _eq_tif(tmp_path, px_deg, nominal, top, left, H, W, name):
    import rasterio
    from rasterio.transform import from_origin

    from lunarnav.terrain.trek import TrekProduct

    z = np.full((H, W), 1000.0, dtype=np.float32)
    path = tmp_path / f"{name}.tif"
    wkt = ('GEOGCS["Moon 2000",DATUM["D_Moon_2000",SPHEROID["Moon_2000_IAU_IAG",1737400.0,0.0]],'
           'PRIMEM["Greenwich",0],UNIT["Decimal_Degree",0.0174532925199433]]')
    with rasterio.open(path, "w", driver="GTiff", width=W, height=H, count=1, dtype="float32", crs=wkt,
                       transform=from_origin(left, top, px_deg, px_deg)) as ds:
        ds.write(z, 1)
    prod = TrekProduct(name, "00000000-0000-0000-0000-000000000000", path.stat().st_size, "float32", 1.0,
                       1.1754939304327482e-38, W, H, px_deg, left, top, nominal, "none")
    return path, prod


def test_eq_row_rule_only_for_the_30m_eq_product(monkeypatch, tmp_path):
    """The one-row minimum distance is applied to the Trek 30 m _EQ product only: the 100 m _EQ
    product (rows 155.7 m apart) keeps 0.5 * resolution (50 m), as the 5 m one (250 m auto wins)."""
    from lunarnav.terrain.trek import TREK_PRODUCTS, TrekDem

    px100 = TREK_PRODUCTS["LRO_LOLA_DEM_SPole45_100mp_v04_EQ"].pixel_deg
    path, prod = _eq_tif(tmp_path, px100, 100.0, -69.0, 31.9, 160, 160, "SYNTH_EQ100")
    dem100 = TrekDem(path=path, product=prod)
    site = Site("c3", "c3", -69.37, 32.32)
    assert max(dem100.pixel_ground_size_m(site.lat_deg)) == pytest.approx(155.70, abs=0.05)
    assert pc.eq_row_min_distance_m(dem100, site.lat_deg) is None
    monkeypatch.setattr(pc, "get_dem", lambda name, s, label=None, path=None: dem100)
    m = pc.make_horizon_fn("trek", "raymarch", radius_km=3.0, az_step_deg=2.0)(site)
    assert m.meta["eq_row_min_distance_m"] is None and m.meta["first_sample_m"] == pytest.approx(50.0)
    # 5 m _EQ product: no row rule either (the 250 m auto exclusion applies)
    px5 = TREK_PRODUCTS["LRO_LOLA_DEM_SPole875_5mp_v04_EQ"].pixel_deg
    path5, prod5 = _eq_tif(tmp_path, px5, 5.0, -89.0, 0.0, 40, 40, "SYNTH_EQ5")
    assert pc.eq_row_min_distance_m(TrekDem(path=path5, product=prod5), -89.02) is None


def _grid_axis_hill_case(frac_px: float):
    """20 m DEM around 86S 120E, 30 m Gaussian hill (sigma 60 m) 200 m from the site along the grid
    +y axis (az ~240 deg, in the SyntheticProvider Earth's azimuth range 232-248 deg), the site
    ``frac_px`` pixel off a cell centre in x.  Returns (patch, site with its DEM height)."""
    res, lat, lon = 20.0, -86.0, 120.0
    xs, ys = (float(v) for v in hz.SOUTH_POLAR.latlon_to_xy(lat, lon))
    x = xs - frac_px * res + np.arange(-200, 201) * res
    y = ys + np.arange(-200, 201) * res
    X, Y = np.meshgrid(x, y)
    z = 30.0 * np.exp(-((X - xs) ** 2 + (Y - (ys + 200.0)) ** 2) / (2 * 60.0 ** 2))
    patch = DemPatch(x, y, z, hz.moon_polar_stereo_wkt(-1), "axis-hill", res)
    h = float(hz.sample_patch_bilinear(patch, np.atleast_1d(xs), np.atleast_1d(ys))[0])
    return patch, Site(f"ax{frac_px}", "ax", lat, lon, height_m=h)


def _pct_sun_earth(mask, site):
    from lunarnav.analysis import make_times
    from lunarnav.visibility import VisibilityOptions, compute_visibility

    times = make_times("2026-01-01T00:00:00", "2027-01-01T00:00:00", 360.0)
    e = pc.SyntheticProvider().compute(site, times, mask.surface_height_m + mask.observer_height_m)
    v = compute_visibility(e, mask, VisibilityOptions(observer_height_m=mask.observer_height_m))
    return 100.0 * float(np.mean(v.sun_visible)), 100.0 * float(np.mean(v.earth_visible))


@pytest.mark.parametrize("frac_px", [0.0, 0.25, 0.4, 0.5])
def test_bruteforce_no_blind_wedge_on_grid_axis(frac_px):
    """Near hill exactly on a grid axis: the central-half footprint alone ("central-half-40px-v2")
    left the hill invisible in a wedge (bf -0.1 deg where raymarch sees 8.2 deg) and so let the
    Earth be seen through it.  With the quadrant floor (default) every azimuth through the hill keeps
    a bilinear lower bound: per-bin max(ray15 - bf) < 1 deg (measured <= 0.43) and the Earth
    visibility (blocked by the hill) equals the converged raymarch's."""
    patch, site = _grid_axis_hill_case(frac_px)
    ray = hz.horizon_raymarch(patch, site, 2.0, 0.5, 3.5, oversample=15, step_growth_km=1e6)
    bf = hz.horizon_bruteforce(patch, site, 2.0, 0.5, 3.5)
    v2 = hz.horizon_bruteforce(patch, site, 2.0, 0.5, 3.5, footprint_floor=False, footprint_max_deg=None)
    assert ray.el_deg.max() > 8.0
    assert np.max(ray.el_deg - bf.el_deg) < 1.0
    _, e_ray = _pct_sun_earth(ray, site)
    _, e_bf = _pct_sun_earth(bf, site)
    assert abs(e_bf - e_ray) < 0.5, (e_bf, e_ray)
    if frac_px >= 0.25:  # the old gap model really had the blind wedge here (regression guard)
        assert np.max(ray.el_deg - v2.el_deg) > 5.0
        assert _pct_sun_earth(v2, site)[1] > e_ray + 1.0


def test_bruteforce_per_bin_floor_near_peaks():
    """Per-bin check on the 8 near-peak sites: brute force never lies more than 1 deg below the
    converged raymarch in any azimuth bin (measured max 0.82 deg; the gap model reached 2.0 deg)."""
    worst, worst_v2 = 0.0, 0.0
    for seed in range(8):
        patch, site = _near_peak_case(seed)
        ray = hz.horizon_raymarch(patch, site, 2.0, 0.5, 7.5, oversample=15, step_growth_km=1e6)
        bf = hz.horizon_bruteforce(patch, site, 2.0, 0.5, 7.5)
        v2 = hz.horizon_bruteforce(patch, site, 2.0, 0.5, 7.5, footprint_floor=False, footprint_max_deg=None)
        worst = max(worst, float(np.max(ray.el_deg - bf.el_deg)))
        worst_v2 = max(worst_v2, float(np.max(ray.el_deg - v2.el_deg)))
    assert worst < 1.0, worst
    assert worst_v2 > 1.5, worst_v2
