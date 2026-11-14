"""Cross-method ephemeris validation: A (Horizons) vs B (SPICE) vs C (analytic).

Offline tests need the SPICE kernels in data/kernels (downloaded once by lunarnav.ephem.kernels; they
are skipped, not failed, when absent).  Network tests query JPL Horizons (responses cached under
data/cache/horizons, so re-runs are offline-fast).  Thresholds are those of lunarnav.validate and are
justified there and in docs/VALIDATION.md.
"""
from __future__ import annotations

import json
import sys
import types

import numpy as np
import pytest

from lunarnav import config
from lunarnav import validate as V
from lunarnav.ephem import kernels

AS = V.ARCSEC


def _kernels_present(lunar_sets=("de440",)) -> bool:
    keys = ["lsk", "pck", "spk"] + [k for ls in lunar_sets for k in kernels.LUNAR_SETS[ls]]
    return all((config.kernels_dir() / kernels.KERNELS[k].filename).is_file() for k in keys)


needs_kernels = pytest.mark.skipif(not _kernels_present(), reason="SPICE kernels not downloaded")
needs_de421 = pytest.mark.skipif(not _kernels_present(("de440", "de421")), reason="DE421 lunar kernels absent")


# ----------------------------------------------------------------------------------------------
# Comparison maths (pure, offline)
# ----------------------------------------------------------------------------------------------
def test_wrap180_handles_wraparound():
    assert V.wrap180(359.9 - 0.1) == pytest.approx(-0.2, abs=1e-12)
    assert V.wrap180(0.1 - 359.9) == pytest.approx(0.2, abs=1e-12)
    assert V.wrap180(180.0) == pytest.approx(-180.0)  # half-open interval [-180, 180)
    assert np.all(np.abs(V.wrap180(np.linspace(-1000, 1000, 101))) <= 180.0)


def test_separation_and_az_weighting_near_zenith():
    # Near the zenith a 90 deg azimuth difference is a tiny angle: at el = 89.99 deg the two points are
    # 0.01 deg from the zenith, 90 deg apart around it -> chord 0.01*sqrt(2) deg (flat to 1e-8).
    sep = V.angular_separation_deg(np.array([0.0]), np.array([89.99]), np.array([90.0]), np.array([89.99]))
    assert sep[0] == pytest.approx(0.01 * np.sqrt(2), rel=1e-6)
    st = V.compare_body([0.0], [89.99], [1e8], [90.0], [89.99], [1e8])
    assert st["az_raw"]["max"] == pytest.approx(90.0)
    assert st["az_sky"]["max"] == pytest.approx(90.0 * np.cos(np.radians(89.99)), rel=1e-9)  # 0.0157 deg
    assert st["az_raw_lowel"]["n"] == 0  # excluded from the low-elevation raw azimuth statistic
    # milli-arcsecond separations survive (chord formula, not acos)
    sep = V.angular_separation_deg(np.array([123.0]), np.array([1.0]), np.array([123.0]), np.array([1.0 + 1e-3 * AS]))
    assert sep[0] == pytest.approx(1e-3 * AS, rel=1e-4)


def test_compare_body_known_offsets_and_threshold():
    n = 50
    az = np.linspace(0, 359, n)
    el = np.linspace(-5, 5, n)
    d = np.full(n, 384_400.0)
    st = V.compare_body(az, el + 0.01 * AS, d + 0.001, az, el, d)
    assert st["el"]["max"] == pytest.approx(0.01 * AS, rel=1e-6)
    assert st["sep"]["max"] == pytest.approx(0.01 * AS, rel=1e-3)
    assert st["dist_km"]["max"] == pytest.approx(0.001, rel=1e-6)
    assert V.check_threshold(st, V.THRESH_AB, 384_400.0)["passed"]  # 0.01" < 0.02", 1 m < 2.04 m
    st2 = V.compare_body(az, el + 0.03 * AS, d, az, el, d)
    assert not V.check_threshold(st2, V.THRESH_AB, 384_400.0)["passed"]
    st3 = V.compare_body(az, el, d + 0.003, az, el, d)  # 3 m range error
    assert not V.check_threshold(st3, V.THRESH_AB, 384_400.0)["passed"]
    st4 = V.compare_body(az, el * np.nan, d, az, el, d)  # NaN never passes
    assert not V.check_threshold(st4, V.THRESH_C, 384_400.0)["passed"]


def test_solar_day_theory():
    # Kepler: Sun's ecliptic rate 1.0194 deg/d at perihelion (early Jan), 0.9532 at aphelion (early
    # July) -> 360/(13.17636 - rate) = 710.7 h / 706.8 h; the yearly mean is the synodic month 708.73 h.
    assert V.solar_day_length_h("2026-01-03T00:00:00") == pytest.approx(710.7, abs=0.15)
    assert V.solar_day_length_h("2026-07-04T00:00:00") == pytest.approx(706.85, abs=0.15)
    days = np.datetime64("2026-01-01", "s") + np.arange(0, 365 * 86400, 86400 // 4).astype("timedelta64[s]")
    # mean of the instantaneous period is not exactly the harmonic mean; 0.05 h covers the difference
    mean_rate = np.mean([1.0 / V.solar_day_length_h(t) for t in days])
    assert 1.0 / mean_rate == pytest.approx(V.SYNODIC_MONTH_D * 24.0, abs=0.05)


def test_terrain_hook_absent_and_present(monkeypatch):
    monkeypatch.setitem(sys.modules, "lunarnav.validate_terrain", None)  # import -> ModuleNotFoundError
    r = V.validate_terrain_hook(quick=True)
    assert r["status"] in ("absent", "error") and r["passed"] in (None, False)
    calls = {}

    def run(quick: bool = False):
        calls["quick"] = quick
        return {"passed": True, "n": 3}

    fake = types.ModuleType("lunarnav.validate_terrain")
    fake.run = run
    monkeypatch.setitem(sys.modules, "lunarnav.validate_terrain", fake)
    r = V.validate_terrain_hook(quick=True, unknown_kw=1)  # unknown kwargs are not passed on
    assert r == {"passed": True, "n": 3, "status": "ran"} and calls["quick"] is True

    def boom(**kw):
        raise RuntimeError("bad DEM")

    fake2 = types.ModuleType("lunarnav.validate_terrain")
    fake2.run_all = boom
    monkeypatch.setitem(sys.modules, "lunarnav.validate_terrain", fake2)
    r = V.validate_terrain_hook()
    assert r["status"] == "error" and r["passed"] is False and "bad DEM" in r["error"]


def test_validation_sites_cover_every_catalog_group():
    from lunarnav import sites

    groups = {s.group for s in sites.load_catalog()}
    chosen = {sites.get_site(s).group for s in V.VALIDATION_SITE_IDS}
    assert chosen == groups  # south_pole, reference, apollo, far_side
    lats = [sites.get_site(s).lat_deg for s in V.VALIDATION_SITE_IDS]
    assert min(lats) < -89.5 and max(lats) > 20  # a pole site and a northern site


# ----------------------------------------------------------------------------------------------
# Fixes in other modules found by this validation
# ----------------------------------------------------------------------------------------------
@needs_kernels
def test_spice_pre1972_utc_matches_erfa():
    """FIX: naif0012 has no 1960-1971 UTC model (deltet used TAI-UTC = 9 s); the official table gives
    7.5746 s at the Apollo 11 landing.  After the fix SPICE ET equals astropy/ERFA TDB to < 1 ms
    (TDB-TT periodic model differences ~20 us), and post-1972 epochs are unchanged."""
    import spiceypy as sp

    from lunarnav.ephem.analytic import utc_to_tdb_jd
    from lunarnav.ephem.spice import utc_to_et

    kernels.load_kernels()
    t = np.array(["1965-06-01T00:00:00", "1969-07-20T20:17:40", "1971-12-31T23:59:59",
                  "1972-01-01T00:00:00", "2026-03-01T00:00:00"], dtype="datetime64[s]")
    et = utc_to_et(t)
    jd1, jd2 = utc_to_tdb_jd(t)
    et_erfa = ((jd1 - 2451545.0) + jd2) * 86400.0
    assert np.max(np.abs(et - et_erfa)) < 1e-3
    u = (t - np.datetime64("2000-01-01T12:00:00", "s")).astype(np.int64).astype(float)
    assert et[1] - u[1] == pytest.approx(7.5746 + 32.184, abs=2e-3)  # TAI-UTC + TT-TAI (+ <2 ms TDB-TT)
    for k in (3, 4):  # post-1972: identical to plain deltet
        assert et[k] == pytest.approx(u[k] + sp.deltet(u[k], "UTC"), abs=1e-9)


@needs_kernels
def test_spice_default_is_converged_light_time():
    """FIX: SPICE default abcorr CN+S. LT+S (one light-time iteration) differs in Earth range by
    rho (v_r/c)^2 <= 406 700 km x (30.3 km/s / c)^2 = 4.15 m (semi-monthly cos^2 signal).  Directions:
    Sun identical (< 1e-5"), Earth moves by ~0.001" (towards Horizons: 0.0019" -> 0.0018")."""
    from lunarnav import sites
    from lunarnav.ephem.spice import SpiceProvider

    p = SpiceProvider()
    assert p.abcorr == "CN+S"
    s = sites.get_site("apollo11")
    t = V.default_time_sets()[0].times
    a, b = p.compute(s, t, 2.0), SpiceProvider(abcorr="LT+S").compute(s, t, 2.0)
    c = V.compare_series(a, b)
    assert 3.0 < c["earth"]["dist_km"]["max"] * 1000 < 4.2
    assert c["earth"]["sep"]["max"] < 0.002 * AS and c["sun"]["sep"]["max"] < 1e-5 * AS


# ----------------------------------------------------------------------------------------------
# B vs C (offline)
# ----------------------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def offline_matrix():
    if not _kernels_present():
        pytest.skip("SPICE kernels not downloaded")
    from lunarnav import sites

    provs = V.make_providers(include_horizons=False)
    ss = [sites.get_site(s) for s in V.VALIDATION_SITE_IDS]
    return ss, V.crosscheck_matrix(ss, V.default_time_sets(), provs)


def test_spice_vs_analytic_all_sites(offline_matrix):
    _sites, mat = offline_matrix
    summ = {s["body"]: s for s in mat["summary"] if s["pair"] == "spice-analytic"}
    assert set(summ) == {"sun", "earth"}
    for body, s in summ.items():
        assert s["passed"], s["failures"]
        assert s["n_samples"] == 6 * (2 * V.LUNAR_MONTH_HOURS + V.N_RANDOM)
        # within the analytic budget (0.0051 deg frame + 0.0051 deg moon98) ...
        assert s["sep"]["max"] < 0.011
        # ... and genuinely independent: nonzero, at least the IAU_MOON-vs-ME frame difference (> 2")
        assert s["sep"]["rms"] > 2 * AS
        # Presence flags (Sun upper limb / Earth centre above the sphere horizon) may differ only for
        # samples closer to the horizon than the 0.02 deg tolerance (enforced by check_threshold);
        # at the poles both bodies hug the horizon, still < 0.5 % of samples.
        rows = [r for r in mat["rows"] if r["pair"] == "spice-analytic" and r["body"] == body]
        assert all(r["flag_mismatch_max_margin_deg"] <= V.THRESH_C.el_deg for r in rows)
        assert s["flag_mismatches"] < 0.005 * s["n_samples"]
    # distances: moon98 error dominates, worst 31.7 km -> relative <= 9e-5 (Earth), Sun < 1e-4
    assert summ["earth"]["dist_rel"]["max"] < 9e-5
    assert summ["sun"]["dist_rel"]["max"] < 1e-4


def test_far_side_and_pole_geometry_consistent(offline_matrix):
    """Physics sanity of the series used in the cross-check (both methods agree on it)."""
    _sites, mat = offline_matrix
    for (sid, tsn, m), s in mat["series"].items():
        if sid == "change6":  # far side: Earth always far below the horizon
            assert s.earth_el_deg.max() < -30.0
        if sid == "ref_shackleton_rim":  # 89.78 S: Sun within 0.22 + 1.54 + 0.27 deg, Earth within ~7
            assert np.abs(s.sun_el_deg).max() < 2.1
            assert np.abs(s.earth_el_deg).max() < 7.5


def test_analytic_error_is_explained_by_moon98(offline_matrix):
    ex = V.analytic_moon_theory_error(V.default_time_sets()[:2])
    for x in ex:
        assert x["total_km_max"] < 31.7  # published worst case of the truncated ELP2000-82 series
        assert x["lateral_arcsec_max"] < 0.0051 * 3600
    # The Earth-direction "theory" error seen from the Moon equals the moon98 lateral error.
    from lunarnav import sites

    s = sites.get_site("ref_shackleton_rim")
    _ss, mat = offline_matrix
    an = mat["series"][(s.id, "2026-03", "analytic")]
    d = V.discrepancy_diagnostics({(s.id, "2026-03"): mat["series"][(s.id, "2026-03", "spice")]}, [s],
                                  analytic={(s.id, "2026-03"): an})
    theory = next(v for v in d if v["key"] == "analytic_vs_spice_iau")
    assert theory["earth_sep_max_arcsec"] == pytest.approx(ex[0]["lateral_arcsec_max"], abs=0.5)
    assert theory["sun_sep_max_arcsec"] < 0.1  # Sun direction is insensitive to the Moon's position


# ----------------------------------------------------------------------------------------------
# Negative controls, offline (SPICE MOON_ME as reference)
# ----------------------------------------------------------------------------------------------
@needs_de421
def test_negative_controls_detected_offline(offline_matrix):
    from lunarnav import sites

    s = sites.get_site("ref_shackleton_rim")
    _ss, mat = offline_matrix
    ref = {(s.id, "2026-03"): mat["series"][(s.id, "2026-03", "spice")]}
    d = {v["key"]: v for v in V.discrepancy_diagnostics(ref, [s])}
    for v in d.values():
        if v["must_detect"]:
            assert v["detected_everywhere"], v
    # Expected magnitudes (physics, see lunarnav.validate.VARIANTS):
    assert 95 < d["frame_moon_pa"]["sun_sep_max_arcsec"] < 115          # 0.0289 deg ME->PA rotation
    assert 2 < d["frame_iau_moon"]["sun_sep_max_arcsec"] < 18.4         # <= 0.0051 deg
    assert 30 < d["time_utc_as_tdb"]["sun_sep_max_arcsec"] < 40         # 69 s x 0.508 deg/h = 35"
    assert 19.5 < d["abcorr_none"]["sun_sep_max_arcsec"] < 22.5         # annual aberration 20.5" (+Moon)
    assert d["abcorr_none"]["earth_sep_max_arcsec"] < 1.5               # Earth/Moon share the velocity
    assert 0.2 < d["radius_1738"]["earth_sep_max_arcsec"] < 0.4         # 0.6 km / 384 400 km = 0.32"
    assert d["radius_1738"]["sun_sep_max_arcsec"] < 0.01
    assert 3.0 < d["abcorr_lt_s_1iter"]["earth_dist_max_m"] < 4.2       # rho (v_r/c)^2 <= 4.15 m
    assert d["lon_west_positive"]["sun_sep_max_arcsec"] > 3600          # degrees
    assert d["lunar_set_de421"]["earth_sep_max_arcsec"] < 1.0           # alternative valid libration
    from lunarnav.ephem import kernels as K

    K.load_kernels("de440")


# ----------------------------------------------------------------------------------------------
# Apollo 11 and lunar day (offline with B + C)
# ----------------------------------------------------------------------------------------------
@needs_de421
def test_apollo11_landing_sun_elevation_offline():
    provs = V.make_providers(include_horizons=False)
    r = V.apollo11_fact_check(provs)
    assert r["passed"], r
    # Documented 10.8 +- 0.5 deg; Horizons (DE441) gives 10.70331 deg -> SPICE must reproduce it to
    # 1" (0.0003 deg) now that pre-1972 UTC is handled; C within its 0.02 deg budget.
    assert r["sun_el_deg"]["spice"] == pytest.approx(10.70331, abs=0.0003)
    assert r["sun_el_deg"]["spice_de421"] == pytest.approx(r["sun_el_deg"]["spice"], abs=1.0 * AS)
    assert r["sun_el_deg"]["analytic"] == pytest.approx(r["sun_el_deg"]["spice"], abs=0.02)
    assert abs(r["sun_el_deg"]["spice"] - 10.8) <= 0.5
    # Sun rises ~0.5 deg/h at Tranquility Base (equatorial, synodic rate 0.508 deg/h x cos(lat)).
    assert r["sun_el_rate_deg_per_s"] * 3600 == pytest.approx(0.508, abs=0.01)


@needs_kernels
def test_lunar_day_and_time_until_sunset_offline():
    r = V.lunar_day_check(V.make_providers(include_horizons=False))
    assert r["passed"], r["checks"]
    assert len(r["days"]) == 2 and len(r["nights"]) == 3
    for d in r["days"]:
        # 14.77 d half synodic month + 1.39 h (upper limb + 2 m mast dip) + January eccentricity
        assert 356.0 < d["daylight_true_h"] < 357.5
        assert d["daylight_true_h"] / 24 == pytest.approx(14.77, abs=0.12)
        assert d["hours_until_sunset_at_first_lit"] == d["daylight_window_h"]
        assert 0.0 <= d["hus_minus_truth_h_min"] and d["hus_minus_truth_h_max"] < 1.0
    assert r["event_time_differences"]["spice-analytic"]["max_abs_s"] < 30  # measured 7 s; budget 142 s


# ----------------------------------------------------------------------------------------------
# Network: Method A (JPL Horizons)
# ----------------------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def full_matrix():
    if not _kernels_present():
        pytest.skip("SPICE kernels not downloaded")
    from lunarnav import sites

    ss = [sites.get_site(s) for s in V.VALIDATION_SITE_IDS]
    return ss, V.crosscheck_matrix(ss, V.default_time_sets(), V.make_providers(include_horizons=True))


@pytest.mark.network
def test_horizons_vs_spice_arcsec_level(full_matrix):
    _ss, mat = full_matrix
    summ = {(s["pair"], s["body"]): s for s in mat["summary"]}
    for body in ("sun", "earth"):
        s = summ[("horizons-spice", body)]
        assert s["passed"], s["failures"]
        assert s["sep"]["max"] < 0.02 * AS and s["el"]["max"] < 0.02 * AS and s["az_sky"]["max"] < 0.02 * AS
        assert s["flag_mismatches"] == 0
    # Earth range: CN+S vs Horizons = DE440 vs DE441 radial (0.14 m); Sun: 10 m print quantisation.
    assert summ[("horizons-spice", "earth")]["dist_km"]["max"] < 0.001
    assert summ[("horizons-spice", "sun")]["dist_km"]["max"] < 0.012
    for pair in ("horizons-analytic", "spice-analytic"):
        for body in ("sun", "earth"):
            assert summ[(pair, body)]["passed"], summ[(pair, body)]["failures"]
            assert summ[(pair, body)]["sep"]["max"] < 0.011  # analytic budget, 2x below the limit


@pytest.mark.network
def test_negative_controls_against_horizons(full_matrix):
    ss, mat = full_matrix
    k = ("apollo11", "2026-03")
    d = V.discrepancy_diagnostics({k: mat["series"][(*k, "horizons")]}, ss)
    for v in d:
        if v["must_detect"]:
            assert v["detected_everywhere"], v
    kernels.load_kernels("de440")


@pytest.mark.network
def test_de441_vs_de440_explains_residual():
    x = V.de441_vs_de440_moon()
    assert x["radial_m_max"] < 1.0       # explains the 0.15 m Earth-range residual
    assert x["lateral_arcsec_max"] < 0.005  # explains the ~0.002" Earth-direction residual


@pytest.mark.network
def test_apollo11_all_methods_including_horizons():
    r = V.apollo11_fact_check(V.make_providers(include_horizons=True))
    kernels.load_kernels("de440")
    assert r["passed"], r
    assert abs(r["horizons_minus_spice_arcsec"]) < 0.05  # was 0.72" before the pre-1972 UTC fix
    assert abs(r["sun_el_deg"]["horizons"] - 10.8) <= 0.5
    lo, hi = r["eva"]["sun_el_range_deg"]["horizons"]
    assert 13.5 <= lo and hi <= 17.0  # documented 14.5-16 deg +- 1 deg


@pytest.mark.network
def test_run_all_quick_report_is_json():
    rep = V.run_all(include_horizons=True, terrain=False, quick=True)
    kernels.load_kernels("de440")
    assert rep["passed"] is True
    s = json.dumps(rep)  # serialisable, no NaN/inf objects
    assert "horizons-spice" in s
    md = V.render_markdown(rep)
    assert "PASS" in md and "FAIL" not in md.split("Negative controls")[0]
