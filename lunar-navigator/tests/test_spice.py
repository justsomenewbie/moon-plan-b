"""Tests for Method B ephemeris (NAIF SPICE): kernels, internal consistency, physics, Horizons cross-check.

Kernel download (~45 MB from naif.jpl.nasa.gov, once, cached in data/kernels) is needed by every test
here; tests are skipped with a clear reason if the kernels are absent and cannot be downloaded.
"""
from __future__ import annotations

import hashlib
import json
import re

import numpy as np
import pytest
import requests

from lunarnav import config
from lunarnav.types import EphemerisProvider, Site

kernels = pytest.importorskip("lunarnav.ephem.kernels")
spice = pytest.importorskip("lunarnav.ephem.spice")


@pytest.fixture(scope="module")
def provider():
    try:
        return spice.SpiceProvider()
    except kernels.KernelError as e:  # no network and no cache
        pytest.skip(f"SPICE kernels unavailable: {e}")


def _hourly(start: str, days: float, step_h: float = 1.0) -> np.ndarray:
    t0 = np.datetime64(start, "s")
    return t0 + (np.arange(0, days * 24, step_h) * 3600).astype("timedelta64[s]")


# ------------------------------------------------------------------------------------------- kernels
def test_kernels_verified_and_loaded(provider):
    import spiceypy as sp

    names = [p.name for p in provider.kernel_paths]
    assert names == ["naif0012.tls", "pck00011.tpc", "de440s.bsp", "moon_pa_de440_200625.bpc", "moon_de440_250416.tf"]
    for p in provider.kernel_paths:
        spec = next(s for s in kernels.KERNELS.values() if s.filename == p.name)
        assert p.stat().st_size == spec.size  # exact NAIF byte size: no truncated download
    with kernels.SPICE_LOCK:
        assert sp.ktotal("ALL") == 5
        # pck00011 defines the Moon as the 1737.4 km sphere (same as LOLA / Horizons).
        assert np.allclose(sp.bodvrd("MOON", "RADII", 3)[1], config.MOON_RADIUS_KM)
        # de440s coverage includes the whole planning range 2026-2031.
        assert sp.str2et("2026-01-01") > -1.5e9 and sp.str2et("2031-01-01") < 4.7e9


def test_frame_me_vs_pa_offset(provider):
    # NAIF FK comment: MOON_ME and MOON_PA differ by ~0.0289 deg (~875 m at the surface).
    # MOON_ME_DE440_ME421 is a fixed offset frame, so the angle is constant to < 1e-6 deg.
    a = spice.frame_offset_deg(0.0)
    b = spice.frame_offset_deg(8.0e8)
    assert a == pytest.approx(0.02886, abs=2e-4)
    assert abs(a - b) < 1e-6


def test_provider_protocol(provider):
    assert isinstance(provider, EphemerisProvider)
    assert provider.name == "spice"


# ------------------------------------------------------------------------------------------ time
def test_utc_to_et_matches_str2et(provider):
    import spiceypy as sp

    t = np.array(["2026-01-01T00:00:00", "2016-12-31T23:59:59", "2017-01-01T00:00:00", "2030-07-01T12:34:56"],
                 dtype="datetime64[s]")
    et = spice.utc_to_et(t)
    with kernels.SPICE_LOCK:
        ref = np.array([sp.str2et(str(x)) for x in t])
    # Both use the same LSK; double precision ET ~1e9 s -> agreement to ~1 microsecond.
    assert np.max(np.abs(et - ref)) < 1e-5
    # Leap second at end of 2016: one UTC second spans 2 ET seconds.
    assert et[2] - et[1] == pytest.approx(2.0, abs=1e-6)
    # ET-UTC in 2026 = 37 s (TAI-UTC) + 32.184 s (TT-TAI) + |TDB-TT| < 1.7 ms.
    assert et[0] - (np.datetime64("2026-01-01T00:00:00") - np.datetime64("2000-01-01T12:00:00")).astype(float) \
        == pytest.approx(69.184, abs=2e-3)


# ---------------------------------------------------------------- two internal implementations agree
@pytest.mark.parametrize("lat,lon,h", [(-89.9, 0.0, 0.0), (-89.45, 222.69, 1500.0), (0.674, 23.473, -1900.0),
                                        (45.0, 300.0, 0.0), (-45.44, 177.6, 0.0)])
def test_manual_vs_azlcpo(provider, lat, lon, h):
    site = Site("x", "x", lat, lon)
    t = _hourly("2026-03-01T00:00:00", 60, step_h=7.0)
    a = spice.SpiceProvider(method="manual").compute(site, t, h)
    b = spice.SpiceProvider(method="azlcpo").compute(site, t, h)
    for body in ("sun", "earth"):
        daz = (getattr(a, f"{body}_az_deg") - getattr(b, f"{body}_az_deg") + 180.0) % 360.0 - 180.0
        dl = getattr(a, f"{body}_el_deg") - getattr(b, f"{body}_el_deg")
        # Same SPICE vectors, different topocentric-frame construction: only rounding differs
        # (~1e-12 deg). Contract: < 1e-6 deg. Azimuth scaled by cos(el) is the true angular error;
        # here |el| < 90 - 1 deg for the Sun/Earth so the raw azimuth bound is applied directly.
        assert np.max(np.abs(daz)) < 1e-6
        assert np.max(np.abs(dl)) < 1e-6
        assert np.max(np.abs(getattr(a, f"{body}_dist_km") - getattr(b, f"{body}_dist_km"))) < 1e-6


def test_output_contract(provider):
    site = Site("sp", "south pole", -89.9, 0.0)
    t = _hourly("2026-01-01T00:00:00", 3)
    s = provider.compute(site, t, 2.0)
    assert s.method == "spice" and s.site_id == "sp" and len(s) == 72
    assert s.times_utc.dtype == np.dtype("datetime64[s]")
    for a in (s.sun_az_deg, s.earth_az_deg):
        assert a.shape == (72,) and np.all((a >= 0) & (a < 360))
    # Sun ~1 AU (0.983-1.017 AU), Earth 356 000-407 000 km centre-to-centre +- lunar radius.
    assert np.all((s.sun_dist_km > 1.46e8) & (s.sun_dist_km < 1.53e8))
    assert np.all((s.earth_dist_km > 3.5e5) & (s.earth_dist_km < 4.1e5))
    assert s.observer_height_m == 2.0


def test_height_changes_distance_by_radial_projection(provider):
    # Raising the observer by 10 km at the Apollo 11 site shortens the Earth range by
    # ~10 km * sin(el_earth) (Earth near zenith there): check to 5 m (light-time/aberration second order).
    site = Site("a11", "Apollo 11", 0.674, 23.473)
    t = _hourly("2026-05-01T00:00:00", 2, 6)
    lo = provider.compute(site, t, 0.0)
    hi = provider.compute(site, t, 10_000.0)
    expect = 10.0 * np.sin(np.radians(lo.earth_el_deg))
    assert np.max(np.abs((lo.earth_dist_km - hi.earth_dist_km) - expect)) < 5e-3


def test_azimuth_convention_north_east(provider):
    # At the Apollo 11 site (nearside, ~23.5 E) the Earth sits high in the WEST-ish sky
    # (sub-Earth point ~0 lon is west of the site): azimuth in (180, 360), elevation ~ 90 - 23.5 +- 8 deg.
    site = Site("a11", "Apollo 11", 0.674, 23.473)
    s = provider.compute(site, _hourly("2026-01-01T00:00:00", 60, 5), 0.0)
    assert np.all((s.earth_el_deg > 90 - 23.5 - 9) & (s.earth_el_deg < 90 - 23.5 + 9))
    assert np.all((s.earth_az_deg > 180) & (s.earth_az_deg < 360))
    # Sun rises in the EAST (az ~ 90) and sets in the WEST (az ~ 270) on the Moon.
    up = s.sun_el_deg > 0
    rising = np.where(~up[:-1] & up[1:])[0]
    setting = np.where(up[:-1] & ~up[1:])[0]
    assert len(rising) >= 1 and len(setting) >= 1
    assert np.all(np.abs(s.sun_az_deg[rising] - 90) < 3)  # within ~1.5 deg of the ecliptic + equator tilt
    assert np.all(np.abs(s.sun_az_deg[setting] - 270) < 3)


# -------------------------------------------------------------------------- physical invariants
def test_south_pole_sun_earth_ranges(provider):
    site = Site("sp", "near south pole", -89.9, 0.0)
    t = _hourly("2026-01-01T00:00:00", 366, 2)
    s = provider.compute(site, t, 0.0)
    # Sun declination w.r.t. lunar equator <= 1.543 deg (inclination to ecliptic) + physical libration
    # (~0.04 deg) + ME/PA offset 0.03 deg; observer is 0.1 deg off the pole -> |el| <= ~1.72.
    # Over a year the extremes must reach > 1.4 deg (the tilt is always explored within a draconic year).
    assert np.max(np.abs(s.sun_el_deg)) < 1.75
    assert s.sun_el_deg.max() > 1.4 and s.sun_el_deg.min() < -1.4
    # Earth: optical libration in latitude <= 6.85 deg + 0.1 colatitude + topocentric parallax
    # (<= asin(1737/356000) = 0.28 deg) -> |el| < 7.5 deg.
    assert np.max(np.abs(s.earth_el_deg)) < 7.5
    assert s.earth_el_deg.max() > 6.0 and s.earth_el_deg.min() < -6.0
    # Sun azimuth makes one full turn per synodic month (29.53 d): ~12.4 turns per year.
    turns = np.sum(np.abs(np.diff(np.unwrap(np.radians(s.sun_az_deg))))) / (2 * np.pi)
    assert turns == pytest.approx(365.0 / 29.5306, abs=0.3)


def test_far_side_earth_never_visible(provider):
    # Antipode of the mean sub-Earth point: optical libration <= ~8 deg in lon/lat, parallax 0.3 deg
    # -> Earth elevation <= -90 + 8.2 + 6.9 ... far below horizon; bound conservatively at -75.
    site = Site("fs", "far side center", 0.0, 180.0)
    s = provider.compute(site, _hourly("2026-01-01T00:00:00", 400, 6), 0.0)
    assert s.earth_el_deg.max() < -75.0
    # Chang'e 4 (Von Karman crater): Earth never above the horizon either.
    s2 = provider.compute(Site("ce4", "Chang'e 4", -45.44, 177.6), _hourly("2026-01-01T00:00:00", 400, 6), 0.0)
    assert s2.earth_el_deg.max() < -30.0


def test_subearth_point_earth_near_zenith(provider):
    # At lat 0, lon 0 (mean sub-Earth point) the Earth stays within libration (~8 deg) of zenith.
    s = provider.compute(Site("o", "origin", 0.0, 0.0), _hourly("2026-01-01T00:00:00", 60, 6), 0.0)
    assert s.earth_el_deg.min() > 90 - 10.5


def test_de421_set_consistent(provider):
    # The DE421 lunar orientation pair realises the same MOON_ME frame; DE440-vs-DE421 libration
    # differences are a few metres at the surface -> < 1 arcsec of az/el for Sun and Earth.
    site = Site("sp", "south pole", -89.45, 222.69)
    t = _hourly("2026-06-01T00:00:00", 30, 6)
    try:
        b = spice.SpiceProvider(lunar_set="de421").compute(site, t, 0.0)
    except kernels.KernelError as e:
        pytest.skip(f"DE421 kernels unavailable: {e}")
    finally:
        kernels.load_kernels("de440")  # restore default set for other tests
    a = spice.SpiceProvider().compute(site, t, 0.0)
    for body in ("sun", "earth"):
        # azimuth error projected on the sky: near the pole az is a fast-varying coordinate; the
        # site sits ~16.7 km from the pole, so a 3 m frame shift rotates azimuth by < 0.02 deg.
        d_el = np.abs(getattr(a, f"{body}_el_deg") - getattr(b, f"{body}_el_deg")) * 3600
        assert d_el.max() < 1.0
        d_az = np.abs((getattr(a, f"{body}_az_deg") - getattr(b, f"{body}_az_deg") + 180) % 360 - 180)
        assert d_az.max() < 0.02


# ------------------------------------------------------------------------ Horizons (Method A) live
HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
XCHECK_SITES = [
    # id, lat, lon(E), height above 1737.4 km sphere (km)
    ("shackleton_rim", -89.45, 222.69, 1.2),
    ("apollo11", 0.67408, 23.47297, 0.0),
    ("change4", -45.4446, 177.5991, -5.9),
]


def _horizons_azel(target: str, lat: float, lon: float, alt_km: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Fetch Horizons apparent airless az/el + range for ~50 times in 2026 (cached on disk)."""
    params = dict(
        format="text", COMMAND=f"'{target}'", OBJ_DATA="NO", MAKE_EPHEM="YES", EPHEM_TYPE="OBSERVER",
        CENTER="'coord@301'", COORD_TYPE="GEODETIC", SITE_COORD=f"'{lon},{lat},{alt_km}'",
        START_TIME="'2026-01-01 00:00'", STOP_TIME="'2026-12-20 01:00'", STEP_SIZE="'169 h'",
        QUANTITIES="'4,20'", ANG_FORMAT="DEG", APPARENT="AIRLESS", CSV_FORMAT="YES", EXTRA_PREC="YES",
        TIME_TYPE="UT", TIME_DIGITS="SECONDS",
    )
    key = hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest()[:20]
    cache = config.cache_dir("spice_xcheck_horizons") / f"{key}.txt"
    if cache.is_file():
        text = cache.read_text()
    else:
        text = ""
        for attempt in range(3):
            try:
                r = requests.get(HORIZONS_URL, params=params, timeout=120)
                r.raise_for_status()
                text = r.text
                break
            except requests.RequestException:
                if attempt == 2:
                    raise
        if "$$SOE" not in text:
            raise RuntimeError(f"Horizons error:\n{text[:2000]}")
        cache.write_text(text)
    assert "MEAN_ME" in text, "Horizons no longer reports the MEAN_ME lunar frame - recheck convention"
    body = text.split("$$SOE")[1].split("$$EOE")[0]
    times, az, el, dist = [], [], [], []
    for line in body.strip().splitlines():
        f = [c.strip() for c in line.split(",")]
        times.append(np.datetime64(re.sub(r"(\d{4})-(\w{3})-(\d\d) ", lambda m: f"{m[1]}-{_MON[m[2]]}-{m[3]}T", f[0]), "s"))
        az.append(float(f[3]))
        el.append(float(f[4]))
        dist.append(float(f[5]) * 149_597_870.700)  # au -> km (Horizons' own au)
    return np.array(times), np.array(az), np.array(el), np.array(dist)


_MON = {m: f"{i:02d}" for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], start=1)}


@pytest.mark.network
@pytest.mark.parametrize("sid,lat,lon,alt_km", XCHECK_SITES)
def test_against_horizons(provider, sid, lat, lon, alt_km, capsys):
    site = Site(sid, sid, lat, lon)
    report = []
    for target, body in (("10", "sun"), ("399", "earth")):
        try:
            t, az_h, el_h, d_h = _horizons_azel(target, lat, lon, alt_km)
        except (requests.RequestException, RuntimeError) as e:
            pytest.skip(f"Horizons unavailable: {e}")
        assert len(t) >= 50
        s = provider.compute(site, t, alt_km * 1000.0)
        az_s, el_s, d_s = getattr(s, f"{body}_az_deg"), getattr(s, f"{body}_el_deg"), getattr(s, f"{body}_dist_km")
        daz = (az_s - az_h + 180.0) % 360.0 - 180.0
        # On-sky azimuth error = daz * cos(el); el is within 90-15 deg of horizon for all cases except
        # the Earth at Apollo 11 (el ~ 67 deg), so this is a fair arcsec measure.
        daz_sky = np.abs(daz * np.cos(np.radians(el_h))) * 3600.0
        del_ = np.abs(el_s - el_h) * 3600.0
        dd = np.abs(d_s - d_h)
        report.append(f"{sid:15s} {body:5s} n={len(t)} max|daz|={np.abs(daz).max()*3600:.4f}\" "
                      f"(on-sky {daz_sky.max():.4f}\") max|del|={del_.max():.4f}\" max|ddist|={dd.max():.3f} km")
        # Horizons prints az/el to 1e-9 deg (EXTRA_PREC) so quantisation is negligible.
        # Expected residuals: DE441 (Horizons) vs DE440 (here) < 1 m at Earth/Moon in 2026 -> << 1 mas;
        # Horizons adds relativistic light bending by Sun+Earth (< 4 mas for these geometries);
        # identical MEAN_ME frame and 1737.4 km sphere. Required agreement is 1 arcsec; observed
        # (2026-11) is < 0.003 arcsec, so we assert 0.05 arcsec to catch any regression early.
        assert del_.max() < 0.05
        assert daz_sky.max() < 0.05
        # Range: Horizons 'delta' printed to 1e-14 au = 1.5 m; Earth/Sun distances agree to < 0.01 km.
        assert dd.max() < 0.01
    with capsys.disabled():
        print("\n" + "\n".join(report))


@pytest.mark.network
def test_horizons_frame_is_mean_earth_not_pa(provider):
    """Discriminating power of the cross-check: evaluating the same site in MOON_PA instead of
    MOON_ME (0.029 deg frame rotation, ~875 m surface shift) misses Horizons by > 0.015 deg in
    elevation, i.e. > 1000x the MOON_ME residual. Documents that Horizons uses MEAN_ME (header
    'Center pole/equ : MEAN_ME (high precision)')."""
    sid, lat, lon, alt_km = XCHECK_SITES[0]
    try:
        t, _az, el_h, _d = _horizons_azel("10", lat, lon, alt_km)
    except (requests.RequestException, RuntimeError) as e:
        pytest.skip(f"Horizons unavailable: {e}")
    site = Site(sid, sid, lat, lon)
    me = provider.compute(site, t, alt_km * 1000.0)
    pa = spice.SpiceProvider(frame="MOON_PA").compute(site, t, alt_km * 1000.0)
    assert np.abs(me.sun_el_deg - el_h).max() < 0.05 / 3600
    assert np.abs(pa.sun_el_deg - el_h).max() > 0.015


# ------------------------------------------------------------------------------- exact pole (review fix)
POLE_TIMES = np.datetime64("2026-03-01T00:00:00", "s") + np.arange(0, 49, 6) * np.timedelta64(3600, "s")


@pytest.mark.parametrize("lat", [-90.0, 90.0])
@pytest.mark.parametrize("lon", [0.0, 45.0, 222.69])
def test_exact_pole_azimuth_origin_is_site_meridian(provider, lat, lon):
    """At lat = +-90 the azimuth origin is the meridian Site.lon_deg (types.py / horizon.enu_basis).

    Continuity check: an observer 1e-7 deg (0.3 cm) from the pole along that meridian has the same
    local north, so Sun/Earth az/el must agree to << 1e-4 deg (the 0.3 cm baseline changes the
    Earth direction by 1e-8 rad; the residual is the float rounding of the near-pole basis).
    """
    pole = provider.compute(Site("p", "p", lat, lon), POLE_TIMES, 2.0)
    near = provider.compute(Site("n", "n", lat - np.sign(lat) * 1e-7, lon), POLE_TIMES, 2.0)
    for body in ("sun", "earth"):
        a, b = getattr(pole, f"{body}_az_deg"), getattr(near, f"{body}_az_deg")
        assert np.all((a >= 0) & (a < 360))
        assert np.max(np.abs((a - b + 180.0) % 360.0 - 180.0)) < 1e-4
        assert np.max(np.abs(getattr(pole, f"{body}_el_deg") - getattr(near, f"{body}_el_deg"))) < 1e-4
    # At the south pole north (az 0) points along meridian lon, so the sub-Earth direction (lon ~0)
    # has az ~ -lon; at the north pole the +X direction has az 180 + lon (225 deg for lon 45).
    expected = (-lon) % 360.0 if lat < 0 else (180.0 + lon) % 360.0
    d = np.abs((pole.earth_az_deg - expected + 180.0) % 360.0 - 180.0)
    assert d.max() < 9.0  # libration in longitude <= 7.9 deg + latitude-libration cross term


def test_exact_pole_without_longitude_raises_and_azlcpo_refuses():
    with pytest.raises(ValueError, match="pole"):
        spice.enu_basis(np.array([0.0, 0.0, -1737.4]))
    e, n, u = spice.enu_basis(np.array([0.0, 0.0, -1737.4]), 45.0)
    from lunarnav.horizon import enu_basis as hz_enu

    he, hn, hu = hz_enu(-90.0, 45.0)
    # identical closed-form basis as the terrain code (float rounding only)
    assert np.allclose(e, he, atol=1e-12) and np.allclose(n, hn, atol=1e-12) and np.allclose(u, hu, atol=1e-12)
    with pytest.raises(ValueError, match="azlcpo"):
        spice.SpiceProvider(method="azlcpo").compute(Site("p", "p", -90.0, 0.0), POLE_TIMES, 2.0)


@pytest.mark.network
@pytest.mark.parametrize("lat,lon", [(-90.0, 45.0), (-90.0, 222.69), (90.0, 45.0)])
def test_exact_pole_against_horizons(provider, lat, lon):
    """Method B and method A (JPL Horizons) agree at the exact pole with the same azimuth origin.

    Tolerance 0.05 arcsec: the same DE440/DE441 + MEAN_ME agreement as test_against_horizons
    (observed < 0.003 arcsec away from the pole); azimuth compared on the sky (x cos el).
    """
    from lunarnav.ephem.horizons import HorizonsProvider

    site = Site("pole", "pole", lat, lon)
    try:
        a = HorizonsProvider().compute(site, POLE_TIMES, 2.0)
    except Exception as e:  # pragma: no cover - network
        pytest.skip(f"Horizons unavailable: {e}")
    b = provider.compute(site, POLE_TIMES, 2.0)
    for body in ("sun", "earth"):
        el = getattr(a, f"{body}_el_deg")
        daz = (getattr(b, f"{body}_az_deg") - getattr(a, f"{body}_az_deg") + 180.0) % 360.0 - 180.0
        assert np.max(np.abs(daz * np.cos(np.radians(el)))) * 3600.0 < 0.05
        assert np.max(np.abs(getattr(b, f"{body}_el_deg") - el)) * 3600.0 < 0.05
