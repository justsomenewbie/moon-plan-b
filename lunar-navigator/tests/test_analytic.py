"""Tests for Method C (lunarnav.ephem.analytic): independent ERFA + IAU_MOON ephemeris.

Offline tests check physical invariants that do not depend on any JPL product.  Network tests compare
against JPL Horizons (Method A's data source) and the NAIF PCK (IAU coefficients); an optional test
compares against SPICE/DE440/MOON_ME when the kernels are already present in data/kernels.
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import numpy as np
import pytest

from lunarnav import config
from lunarnav.ephem.analytic import (
    CROSSCHECK_DIST_REL,
    CROSSCHECK_TOL_DEG,
    AnalyticProvider,
    apparent_vectors_bf,
    azel_from_bf,
    iau_moon_angles,
    iau_moon_matrix,
    site_vector_bf,
    sub_point_lonlat,
    utc_to_tdb_jd,
)
from lunarnav.types import EphemerisProvider, Site

AU_KM = 149_597_870.7
MOON_OBLIQUITY_DEG = 1.543  # inclination of the lunar equator to the ecliptic (Cassini law)


def _hours(start: str, end: str, step_h: int = 1) -> np.ndarray:
    return np.arange(np.datetime64(start, "s"), np.datetime64(end, "s"), np.timedelta64(3600 * step_h, "s"))


def _wrap180(x: np.ndarray) -> np.ndarray:
    return (np.asarray(x) + 180.0) % 360.0 - 180.0


def _sep_deg(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    c = np.sum(a * b, axis=-1) / (np.linalg.norm(a, axis=-1) * np.linalg.norm(b, axis=-1))
    return np.rad2deg(np.arccos(np.clip(c, -1.0, 1.0)))


@pytest.fixture(scope="module")
def year_2027() -> np.ndarray:
    return _hours("2027-01-01T00:00:00", "2028-01-01T00:00:00")


@pytest.fixture(scope="module")
def provider() -> AnalyticProvider:
    return AnalyticProvider()


# ----------------------------------------------------------------------------------- contract
def test_protocol_and_output_contract(provider: AnalyticProvider) -> None:
    assert isinstance(provider, EphemerisProvider)
    assert provider.name == "analytic"
    t = _hours("2027-05-01T00:00:00", "2027-05-03T00:00:00")
    s = provider.compute(Site("x", "x", -85.0, 30.0), t, 1234.0)
    assert s.method == "analytic" and s.site_id == "x" and len(s) == t.size
    assert s.times_utc.dtype == np.dtype("datetime64[s]")
    assert s.observer_height_m == 1234.0
    for arr in (s.sun_az_deg, s.sun_el_deg, s.earth_az_deg, s.earth_el_deg, s.sun_dist_km, s.earth_dist_km):
        assert arr.shape == t.shape and np.isfinite(arr).all()
    assert ((s.sun_az_deg >= 0) & (s.sun_az_deg < 360)).all()
    assert ((s.earth_az_deg >= 0) & (s.earth_az_deg < 360)).all()


def test_bad_inputs_raise(provider: AnalyticProvider) -> None:
    t = np.array(["2027-01-01T00:00:00", "NaT"], dtype="datetime64[s]")
    with pytest.raises(ValueError, match="NaT"):
        provider.compute(Site("x", "x", 0, 0), t, 0.0)
    with pytest.raises(ValueError, match="latitude"):
        provider.compute(Site("x", "x", 91.0, 0), t[:1], 0.0)
    with pytest.raises(ValueError, match="abcorr"):
        AnalyticProvider(abcorr="CN+S")


def test_utc_to_tdb_offset() -> None:
    # TDB - UTC = 37 s (TAI-UTC since 2017) + 32.184 s (TT-TAI) + |TDB-TT| < 1.7 ms.
    t = np.array(["2027-06-01T00:00:00", "2030-12-31T00:00:00"], dtype="datetime64[s]")
    jd1, jd2 = utc_to_tdb_jd(t)
    utc_jd = (t - np.datetime64("2000-01-01T12:00:00", "s")).astype(float) / 86400.0 + 2451545.0
    dt_s = ((jd1 - utc_jd) + jd2) * 86400.0
    np.testing.assert_allclose(dt_s, 69.184, atol=2e-3)  # 1.7 ms TDB-TT + float rounding of JD


# ----------------------------------------------------------------------------------- frame
def test_rotation_matrix_orthonormal_and_pole() -> None:
    d = np.linspace(-5000.0, 15000.0, 101)
    m = iau_moon_matrix(d)
    eye = np.einsum("nij,nkj->nik", m, m)
    np.testing.assert_allclose(eye, np.broadcast_to(np.eye(3), eye.shape), atol=1e-14)
    np.testing.assert_allclose(np.linalg.det(m), 1.0, atol=1e-14)
    a0, d0, w = iau_moon_angles(d)
    a, dd = np.deg2rad(a0), np.deg2rad(d0)
    pole = np.stack([np.cos(dd) * np.cos(a), np.cos(dd) * np.sin(a), np.sin(dd)], axis=-1)
    np.testing.assert_allclose(m[:, 2, :], pole, atol=1e-14)
    # The lunar pole stays within ~4 deg (E1 term: 3.88 deg RA * cos(66.5) and 1.54 deg Dec) of the
    # mean value (269.99, 66.54); W advances by the sidereal rate 13.176 deg/day.
    assert np.all(_sep_deg(pole, np.array([np.cos(np.deg2rad(66.54)) * np.cos(np.deg2rad(269.99)),
                                           np.cos(np.deg2rad(66.54)) * np.sin(np.deg2rad(269.99)),
                                           np.sin(np.deg2rad(66.54))])) < 2.0)
    rate = np.polyfit(d, w, 1)[0]
    assert abs(rate - 13.17635815) < 1e-4


def test_azel_conventions_on_unit_vectors() -> None:
    # Equator, lon 0: up=+x, east=+y, north=+z.
    az, el = azel_from_bf(np.array([[0, 1, 0], [0, 0, 1], [0, -1, 0], [0, 0, -1], [1, 0, 0]]), 0.0, 0.0)
    np.testing.assert_allclose(az[:4], [90, 0, 270, 180], atol=1e-12)
    np.testing.assert_allclose(el, [0, 0, 0, 0, 90], atol=1e-12)
    # Near the south pole on meridian 0 "north" points away from the pole towards lon 0 (+x) and
    # "east" towards +y (increasing east longitude): az = lon_target - lon_site.
    az, el = azel_from_bf(np.array([[1, 0, 0], [0, 1, 0], [-1, 0, 0]]), -89.999, 0.0)
    np.testing.assert_allclose(az, [0, 90, 180], atol=2e-3)
    # North pole: +x (the lon-0 meridian) is SOUTH of the pole observer looking along meridian 0.
    az, _ = azel_from_bf(np.array([[1, 0, 0], [0, 1, 0]]), 89.999, 0.0)
    np.testing.assert_allclose(az, [180, 90], atol=2e-3)


def test_sub_earth_point_is_libration(year_2027: np.ndarray) -> None:
    # The Moon's prime meridian (W) is defined to face Earth on average: the sub-Earth point is the
    # optical libration, |lon| <= 7.9 deg, |lat| <= 6.9 deg, mean longitude ~0.  A wrong W sign, a
    # west-longitude convention or a wrong pole gives hundreds of degrees or > 10 deg here.
    lon, lat = sub_point_lonlat(year_2027, "earth")
    lon = _wrap180(lon)
    assert np.abs(lon).max() < 8.2 and np.abs(lon).max() > 6.0
    assert np.abs(lat).max() < 7.0 and np.abs(lat).max() > 6.0
    assert abs(lon.mean()) < 1.0 and abs(lat.mean()) < 1.0


def test_sub_solar_latitude_bound(year_2027: np.ndarray) -> None:
    # Sub-solar latitude = Sun's declination in the lunar frame: |lat| <= 1.543 deg (lunar equator vs
    # ecliptic) + 0.0 (Sun is on the ecliptic) ; seen from the Moon centre the Moon's orbital motion
    # adds < 0.003 deg.  Over a year it must reach within 0.2 deg of the bound (draconic precession).
    _, lat = sub_point_lonlat(year_2027, "sun")
    assert np.abs(lat).max() < MOON_OBLIQUITY_DEG + 0.01
    assert lat.max() > 1.2 and lat.min() < -1.2


# ----------------------------------------------------------------------------------- invariants
@pytest.mark.parametrize("lat,lon", [(-90.0, 0.0), (-89.5, 222.0), (89.6, 100.0)])
def test_polar_sun_elevation_bound(provider: AnalyticProvider, year_2027: np.ndarray, lat: float, lon: float) -> None:
    # At a polar site the Sun's elevation = sub-solar latitude (<= 1.543 deg) + the site's offset
    # from the pole (90 - |lat|) projected on the Sun's azimuth, + solar parallax 1737/1.5e8 rad
    # (0.0007 deg).  Bound with 0.01 deg margin.
    s = provider.compute(Site("p", "p", lat, lon), year_2027, 0.0)
    bound = MOON_OBLIQUITY_DEG + (90.0 - abs(lat)) + 0.01
    assert np.abs(s.sun_el_deg).max() < bound
    assert s.sun_el_deg.max() > 1.2 and s.sun_el_deg.min() < -1.2  # it does move, both signs
    np.testing.assert_array_less(np.abs(s.sun_dist_km / AU_KM - 1.0), 0.0194)  # e_earth + a_moon/au


def test_far_side_earth_never_visible(provider: AnalyticProvider, year_2027: np.ndarray) -> None:
    # Anti-Earth point (0, 180): Earth elevation = -(90 - libration), libration <= ~10.5 deg total.
    s = provider.compute(Site("f", "far side", 0.0, 180.0), year_2027, 0.0)
    assert s.earth_el_deg.max() < -78.0
    s2 = provider.compute(Site("f2", "far side", -30.0, 150.0), year_2027, 0.0)
    assert s2.earth_el_deg.max() < -20.0  # >= 50 deg beyond the limb minus libration


def test_near_side_earth_elevation_range(provider: AnalyticProvider, year_2027: np.ndarray) -> None:
    # Sub-Earth point (0, 0): Earth zenith distance = libration (<= ~10.5 deg) -> el in (79, 90].
    s = provider.compute(Site("n", "near side", 0.0, 0.0), year_2027, 0.0)
    assert s.earth_el_deg.min() > 79.0 and s.earth_el_deg.max() > 89.0
    # Earth-Moon distance seen from the surface: perigee/apogee 356-407 thousand km minus ~1737 km.
    assert 352_000 < s.earth_dist_km.min() < 362_000
    assert 402_000 < s.earth_dist_km.max() < 407_000
    # Apollo 11 site (0.674 N, 23.473 E): Earth in the WEST, ~66 deg high (90 - 23.5 +- libration).
    a11 = provider.compute(Site("a11", "Apollo 11", 0.674, 23.473), year_2027, 0.0)
    assert (np.abs(_wrap180(a11.earth_az_deg - 270.0)) < 35.0).all()
    assert 56.0 < a11.earth_el_deg.min() and a11.earth_el_deg.max() < 77.0


def test_sun_azimuth_rotates_once_per_synodic_month(provider: AnalyticProvider, year_2027: np.ndarray) -> None:
    # Near the south pole az(Sun) ~= sub-solar longitude - site longitude, and the sub-solar longitude
    # DECREASES at 360 deg per synodic month (29.5306 d mean, individual lunations 29.27-29.83 d).
    s = provider.compute(Site("sp", "south pole", -89.5, 0.0), year_2027, 0.0)
    unwrapped = np.rad2deg(np.unwrap(np.deg2rad(s.sun_az_deg)))
    days = (year_2027 - year_2027[0]).astype(float) / 86400.0
    assert np.all(np.diff(unwrapped) < 0)  # monotonic westward (decreasing azimuth) motion
    rate = np.polyfit(days, unwrapped, 1)[0]
    assert abs(rate - (-360.0 / 29.530589)) < 0.01  # deg/day; mean over 12.4 lunations
    # Crossing times of each full turn (k * 360 deg) -> individual lunation lengths.
    k = np.floor(unwrapped / 360.0)
    idx = np.nonzero(np.diff(k) != 0)[0]
    tc = days[idx] + (k[idx] * 360.0 - unwrapped[idx]) / (unwrapped[idx + 1] - unwrapped[idx]) * (days[idx + 1] - days[idx])
    periods = np.diff(tc)
    assert periods.size >= 11
    assert np.all((periods > 29.2) & (periods < 29.9))
    assert abs(periods.mean() - 29.5306) < 0.08  # mean of ~12 lunations: +-0.25 d scatter / sqrt(12)
    # North pole: azimuth INCREASES (az = 180 - (lon_sun - lon_site)).
    n = provider.compute(Site("np", "north pole", 89.5, 0.0), year_2027[:72], 0.0)
    assert np.all(np.diff(np.unwrap(np.deg2rad(n.sun_az_deg))) > 0)


@pytest.mark.parametrize("lon,az0", [(0.0, 0.0), (180.0, 180.0), (90.0, 270.0)])
def test_polar_earth_azimuth(provider: AnalyticProvider, year_2027: np.ndarray, lon: float, az0: float) -> None:
    # South polar site on meridian `lon`: Earth (sub-Earth lon ~0 +- 7.9 deg) is at az ~ 0 - lon.
    # Site offset 0.5 deg from the pole perturbs this by < 0.5 deg * tan(6.9 deg) ~ 0.06 deg.
    s = provider.compute(Site("e", "e", -89.5, lon), year_2027, 0.0)
    dev = _wrap180(s.earth_az_deg - az0)
    assert np.abs(dev).max() < 8.5
    assert dev.max() - dev.min() > 12.0  # longitude libration visible (2 x ~7 deg)
    # Earth elevation ~ sub-Earth latitude (|.| <= 6.9) + 0.5 cos(az) + topocentric parallax 0.26 deg.
    assert np.abs(s.earth_el_deg).max() < 7.8


def test_observer_height_raises_horizon_dip(provider: AnalyticProvider) -> None:
    # Raising the observer by h changes only parallax (h / dist): for the Earth at the anti-sub-Earth
    # geometry this is < 1e-5 deg per km. A 10 km mast must change el by < 0.002 deg.
    t = _hours("2027-03-01T00:00:00", "2027-03-02T00:00:00")
    a = provider.compute(Site("h", "h", -89.0, 10.0), t, 0.0)
    b = provider.compute(Site("h", "h", -89.0, 10.0), t, 10_000.0)
    assert np.abs(a.earth_el_deg - b.earth_el_deg).max() < 0.002
    assert np.abs(a.sun_el_deg - b.sun_el_deg).max() < 1e-5
    np.testing.assert_allclose(np.linalg.norm(site_vector_bf(-89.0, 10.0, 10_000.0)), 1747.4, rtol=1e-12)


def test_aberration_magnitude(provider: AnalyticProvider) -> None:
    # Apparent - geometric Sun direction ~ v_moon/c = 30 km/s / c = 20.5 arcsec (0.0057 deg),
    # minus/plus the Moon's ~1 km/s geocentric velocity -> 0.0052..0.0062 deg.  Earth: only the relative
    # Earth-Moon velocity matters (~1 km/s / c -> < 0.0004 deg).
    t = _hours("2027-01-01T00:00:00", "2027-02-01T00:00:00", 6)
    jd1, jd2 = utc_to_tdb_jd(t)
    app = apparent_vectors_bf(jd1, jd2, np.zeros(3), abcorr="LT+S")
    geo = apparent_vectors_bf(jd1, jd2, np.zeros(3), abcorr="NONE")
    ds = _sep_deg(app["sun"][0], geo["sun"][0])
    de = _sep_deg(app["earth"][0], geo["earth"][0])
    assert 0.0050 < ds.min() and ds.max() < 0.0064
    assert de.max() < 0.0004


@pytest.mark.parametrize(
    "t_greatest,gamma,kind",
    [
        # NASA GSFC eclipse catalogue (Espenak): total lunar eclipse 2025-03-14, gamma 0.3485;
        # total solar eclipse 2024-04-08, gamma 0.3431. Times = greatest eclipse (UT).
        ("2025-03-14T06:58:43", 0.3485, "lunar"),
        ("2024-04-08T18:17:16", 0.3431, "solar"),
    ],
)
def test_eclipse_geometry(t_greatest: str, gamma: float, kind: str) -> None:
    # At greatest eclipse the Sun-Earth separation seen from the Moon centre is gamma * R_E / r
    # (lunar: Earth and Sun nearly coincide; solar: nearly opposite). This checks the ephemeris and
    # the time scale independently of any JPL product: the instant must match within 2 min (the
    # Moon's 0.55"/s relative motion vs moon98 worst error 18" -> <= 33 s; a time-scale error of
    # hours/days or a UTC/TDB sign mix-up of 2 x 69 s would show).
    tt = np.datetime64(t_greatest, "s") + np.arange(-7200, 7201, 15).astype("timedelta64[s]")
    jd1, jd2 = utc_to_tdb_jd(tt)
    v = apparent_vectors_bf(jd1, jd2, np.zeros(3), abcorr="NONE")
    sep = _sep_deg(v["sun"][0], v["earth"][0])
    off = sep if kind == "lunar" else 180.0 - sep
    i = int(np.argmin(off))
    assert abs((tt[i] - np.datetime64(t_greatest, "s")).astype(int)) <= 120
    expected = np.rad2deg(gamma * 6378.137 / v["earth"][1][i])
    assert abs(off[i] - expected) < 0.01  # 0.33 deg; gamma given to 1e-4 and moon98 ~0.005 deg


# ----------------------------------------------------------------------------------- network
_HZ_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"


def _horizons_azel(body: str, lon: float, lat: float, start: str, stop: str, step: str) -> dict[str, np.ndarray]:
    """Minimal cached Horizons OBSERVER query (airless apparent az/el, delta) from a lunar site."""
    import requests

    params = {
        "format": "text", "COMMAND": f"'{body}'", "OBJ_DATA": "NO", "MAKE_EPHEM": "YES",
        "EPHEM_TYPE": "OBSERVER", "CENTER": "'coord@301'", "COORD_TYPE": "GEODETIC",
        "SITE_COORD": f"'{lon},{lat},0'", "START_TIME": f"'{start}'", "STOP_TIME": f"'{stop}'",
        "STEP_SIZE": f"'{step}'", "QUANTITIES": "'4,20'", "ANG_FORMAT": "DEG", "APPARENT": "AIRLESS",
        "CSV_FORMAT": "YES", "TIME_TYPE": "UT", "EXTRA_PREC": "YES",
    }
    key = hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest()[:20]
    cache = config.cache_dir("analytic_test") / f"horizons_{key}.txt"
    if cache.is_file():
        text = cache.read_text()
    else:
        text = ""
        for attempt in range(4):
            try:
                r = requests.get(_HZ_URL, params=params, timeout=90)
                r.raise_for_status()
                text = r.text
                break
            except requests.RequestException:
                if attempt == 3:
                    raise
                time.sleep(2 ** attempt)
        if "$$SOE" not in text:
            raise RuntimeError(f"Horizons returned no ephemeris: {text[:500]}")
        cache.write_text(text)
    body_txt = text.split("$$SOE")[1].split("$$EOE")[0]
    times, az, el, delta = [], [], [], []
    for line in body_txt.strip().splitlines():
        f = [x.strip() for x in line.split(",")]
        times.append(np.datetime64(_parse_hz_date(f[0]), "s"))
        az.append(float(f[3]))
        el.append(float(f[4]))
        delta.append(float(f[5]))
    return {"t": np.array(times), "az": np.array(az), "el": np.array(el), "delta_km": np.array(delta) * AU_KM}


def _parse_hz_date(s: str) -> str:
    months = {m: i + 1 for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}
    date, hm = s.split()
    y, mon, d = date.split("-")
    return f"{y}-{months[mon]:02d}-{d}T{hm}:00"


@pytest.mark.network
@pytest.mark.parametrize(
    "lat,lon",
    [(-89.45, 222.69), (0.674, 23.473), (-20.0, 160.0)],  # south pole ridge, Apollo 11, far side
)
def test_against_horizons(provider: AnalyticProvider, lat: float, lon: float) -> None:
    # Budget (module docstring): IAU_MOON vs MOON_ME <= 0.0051 deg, moon98 <= 0.0051 deg (Earth only).
    # Sun uses a TIGHTER 0.008 deg tolerance so that a 69 s UTC/TT slip (Sun moves 0.0085 deg/min in
    # the lunar sky -> 0.0098 deg) is detected; Earth uses the documented CROSSCHECK_TOL_DEG.
    site = Site("hz", "hz", lat, lon)
    for body, tol in (("10", 0.008), ("399", CROSSCHECK_TOL_DEG)):
        hz = _horizons_azel(body, lon, lat, "2027-01-01 00:00", "2027-02-01 00:00", "6 h")
        s = provider.compute(site, hz["t"], 0.0)
        az, el, dist = (s.sun_az_deg, s.sun_el_deg, s.sun_dist_km) if body == "10" else (
            s.earth_az_deg, s.earth_el_deg, s.earth_dist_km)
        assert np.abs(el - hz["el"]).max() < tol
        ok = np.abs(hz["el"]) < 89.0  # azimuth undefined at the zenith
        assert (np.abs(_wrap180(az - hz["az"])) * np.cos(np.deg2rad(hz["el"])))[ok].max() < tol
        assert (np.abs(dist / hz["delta_km"] - 1.0)).max() < CROSSCHECK_DIST_REL


def _find_or_fetch_pck() -> Path:
    for name in ("pck00011.tpc", "pck00010.tpc"):
        p = config.kernels_dir() / name
        if p.is_file():
            return p
    import requests

    p = config.cache_dir("analytic_test") / "pck00011.tpc"
    if not p.is_file():
        r = requests.get("https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc", timeout=120)
        r.raise_for_status()
        if not r.content.startswith(b"KPL/PCK"):
            raise RuntimeError("downloaded pck00011.tpc is not a text PCK")
        p.write_bytes(r.content)
    return p


def _spice_lock():
    try:
        from lunarnav.ephem.kernels import SPICE_LOCK
    except Exception:  # teammate module absent/changed: tests run single-threaded anyway
        import threading

        return threading.RLock()
    return SPICE_LOCK


@pytest.mark.network
def test_iau_matrix_matches_naif_pck() -> None:
    # Same formulas, same coefficients, double precision: NAIF's IAU_MOON (pck00011/00010) must agree
    # with our numpy implementation to < 1e-9 rad (coefficients are printed to 1e-7 deg/day; the
    # residual is float rounding). This proves the hand-typed E1..E13 tables are right.
    sp = pytest.importorskip("spiceypy")
    pck = str(_find_or_fetch_pck())
    d = np.linspace(9000.0, 11500.0, 37)  # 2024-2031
    with _spice_lock():
        sp.furnsh(pck)
        try:
            ref = np.array([sp.pxform("J2000", "IAU_MOON", float(x) * 86400.0) for x in d])
        finally:
            sp.unload(pck)
    np.testing.assert_allclose(iau_moon_matrix(d), ref, atol=1e-9)


def _kernel_set() -> list[Path] | None:
    kd = config.kernels_dir()
    sets = [
        ["naif0012.tls", "pck00011.tpc", "de440s.bsp", "moon_pa_de440_200625.bpc", "moon_de440_250416.tf"],
        ["naif0012.tls", "pck00011.tpc", "de440.bsp", "moon_pa_de440_200625.bpc", "moon_de440_250416.tf"],
        ["naif0012.tls", "pck00010.tpc", "de421.bsp", "moon_pa_de421_1900-2050.bpc", "moon_080317.tf"],
    ]
    for names in sets:
        paths = [kd / n for n in names]
        if all(p.is_file() for p in paths):
            return paths
    return None


def test_against_spice_moon_me_if_kernels_present(provider: AnalyticProvider) -> None:
    # Optional: SPICE azlcpo with DE440 + MOON_ME (Method B's data) vs Method C, CROSSCHECK_TOL_DEG.
    paths = _kernel_set()
    if paths is None:
        pytest.skip("SPICE kernels not present in data/kernels (run the kernels download first)")
    sp = pytest.importorskip("spiceypy")
    lat, lon = -89.45, 222.69
    t = _hours("2027-01-01T00:00:00", "2027-03-01T00:00:00", 6)
    s = provider.compute(Site("sp", "sp", lat, lon), t, 0.0)
    obs = site_vector_bf(lat, lon, 0.0)
    with _spice_lock():
        for p in paths:
            sp.furnsh(str(p))
        try:
            ref = {"SUN": [], "EARTH": []}
            for ti in t:
                et = sp.str2et(str(ti))  # ISO "T" format is UTC in SPICE
                for body in ref:
                    state, _ = sp.azlcpo("ELLIPSOID", body, et, "LT+S", False, True, obs, "MOON", "MOON_ME")
                    ref[body].append([np.rad2deg(state[1]), np.rad2deg(state[2]), state[0]])
        finally:
            for p in paths:
                sp.unload(str(p))
    for body, az, el, dist in (("SUN", s.sun_az_deg, s.sun_el_deg, s.sun_dist_km),
                               ("EARTH", s.earth_az_deg, s.earth_el_deg, s.earth_dist_km)):
        r = np.array(ref[body])
        assert np.abs(el - r[:, 1]).max() < CROSSCHECK_TOL_DEG
        assert (np.abs(_wrap180(az - r[:, 0])) * np.cos(np.deg2rad(r[:, 1]))).max() < CROSSCHECK_TOL_DEG
        assert np.abs(dist / r[:, 2] - 1.0).max() < CROSSCHECK_DIST_REL
