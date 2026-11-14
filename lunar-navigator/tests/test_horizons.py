"""Tests for Method A ephemeris (JPL Horizons API).

Offline tests use two real Horizons responses saved under tests/data/ (fetched 2026-11-13):
  * horizons_sun_apollo11_sunset_20260109.txt  - Sun from (0.674N, 23.473E, 0 km), 20-min steps
    across the upper-limb sunset; contains blank solar markers and an 's' (set) event code.
  * horizons_earth_southpole_earthrise_20260121.txt - Earth from (89.5S, 0E, -1.5 km), 30-min steps.

Network tests query the live API (cached under data/cache/horizons after the first run).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from lunarnav.config import EARTH_RADIUS_KM, SUN_RADIUS_KM
from lunarnav.ephem.horizons import (
    EARTH_ID,
    SUN_ID,
    HorizonsClient,
    HorizonsError,
    HorizonsProvider,
    RequestChunk,
    _as_utc_seconds,
    parse_horizons_csv,
    plan_chunks,
    site_coord_string,
)
from lunarnav.types import EphemerisProvider, EphemerisSeries, Site

DATA = Path(__file__).parent / "data"
SUN_SAMPLE = DATA / "horizons_sun_apollo11_sunset_20260109.txt"
EARTH_SAMPLE = DATA / "horizons_earth_southpole_earthrise_20260121.txt"

AU_KM = 149_597_870.7
ARCSEC_PER_RAD = 180.0 / np.pi * 3600.0

APOLLO11 = Site("apollo11", "Apollo 11", 0.674, 23.473, group="apollo")
# Chang'e-6 landing site ~41.63 S, 153.98 W  ->  206.02 E (far side, Apollo basin)
CHANGE6 = Site("change6", "Chang'e-6", -41.63, 206.02)
SOUTH_POLE = Site("sp89", "near south pole", -89.5, 0.0, group="south_pole")
EQUATOR0 = Site("eq0", "equator 0E", 0.0, 0.0)


def hourly(start: str, end: str) -> np.ndarray:
    return np.arange(np.datetime64(start, "s"), np.datetime64(end, "s"), np.timedelta64(1, "h"))


# ======================================================================================
# Offline: parser
# ======================================================================================
class TestParser:
    def test_sun_sample_rows_values_and_markers(self) -> None:
        tab = parse_horizons_csv(SUN_SAMPLE.read_text(encoding="utf-8"))
        assert len(tab) == 16
        expected_t = np.arange(np.datetime64("2026-01-09T01:00:00", "ms"),
                               np.datetime64("2026-01-09T06:00:01", "ms"), np.timedelta64(20, "m"))
        assert np.array_equal(tab.times_utc, expected_t)
        # Values copied from the saved file; exact float parse (no tolerance needed beyond repr).
        assert tab.columns["Azimuth_(a-app)"][0] == pytest.approx(268.769258421, abs=1e-12)
        assert tab.columns["Elevation_(a-app)"][0] == pytest.approx(1.490146087, abs=1e-12)
        assert tab.columns["Ang-diam"][0] == pytest.approx(1949.228, abs=1e-9)
        assert tab.columns["delta"][-1] == pytest.approx(1.4722245955e8, rel=1e-12)
        # Solar presence: 11 daylight rows, then 5 blank rows (blank columns must not shift data).
        assert "".join(tab.solar_marker) == "*" * 11 + " " * 5
        # Interfering body (Earth) marker overridden by the 's' set-event code at 04:40.
        assert tab.body_marker is not None
        assert tab.body_marker[11] == "s"
        assert set(np.delete(tab.body_marker, 11)) == {"i"}

    def test_sun_sample_header_facts(self) -> None:
        tab = parse_horizons_csv(SUN_SAMPLE.read_text(encoding="utf-8"))
        h = tab.header
        assert h["Center pole/equ"].startswith("MEAN_ME")
        assert h["Center radii"].startswith("1737.4, 1737.4, 1737.4 km")
        assert h["Vis. interferer"].startswith("EARTH")
        assert h["Atmos refraction"].startswith("NO (AIRLESS)")

    def test_daylight_marker_equals_upper_limb_rule(self) -> None:
        # Horizons '*' = solar upper limb on/above the airless spherical horizon:
        # el + angdiam/2 >= 0. The sample brackets the transition (04:20 -> +0.074 deg,
        # 04:40 -> -0.095 deg), far from the 0.001 deg print resolution.
        tab = parse_horizons_csv(SUN_SAMPLE.read_text(encoding="utf-8"))
        upper = tab.columns["Elevation_(a-app)"] + tab.columns["Ang-diam"] / 7200.0
        assert np.array_equal(tab.solar_marker == "*", upper >= 0)

    def test_angular_diameter_matches_range(self) -> None:
        # Ang-diam = 2 asin(R/delta); printed to 0.001", so tolerance 0.002".
        for path, radius in ((SUN_SAMPLE, SUN_RADIUS_KM), (EARTH_SAMPLE, EARTH_RADIUS_KM)):
            tab = parse_horizons_csv(path.read_text(encoding="utf-8"))
            model = 2 * np.arcsin(radius / tab.columns["delta"]) * ARCSEC_PER_RAD
            assert np.max(np.abs(model - tab.columns["Ang-diam"])) < 2e-3

    def test_earth_sample_negative_altitude(self) -> None:
        tab = parse_horizons_csv(EARTH_SAMPLE.read_text(encoding="utf-8"))
        assert len(tab) == 13
        lon, lat, alt = (float(x) for x in tab.header["Center geodetic"].split("{")[0].split(","))
        assert (lon, lat, alt) == (0.0, -89.5, -1.5)
        # Earth crosses the mathematical horizon between 21:30 and 22:00
        el = tab.columns["Elevation_(a-app)"]
        assert el[7] < 0 < el[8]

    def test_synthetic_blank_markers_and_na(self) -> None:
        text = (
            "header\n****\n Date__(UT)__HR:MN:SC.fff, , ,Azimuth_(a-app), Elevation_(a-app),  Ang-diam,  delta,\n"
            "****\n$$SOE\n"
            " 2026-Jan-01 00:00:00.000, , ,  10.5,  -3.25,  n.a.,  4.0E+05,\n"
            " 2026-Feb-28 23:59:59.999,*, ,  359.999999999,  0.0,  1949.0,  1.5E+08,\n"
            "$$EOE\n"
        )
        tab = parse_horizons_csv(text)
        assert list(tab.solar_marker) == [" ", "*"]
        assert list(tab.body_marker) == [" ", " "]
        assert np.isnan(tab.columns["Ang-diam"][0])
        assert tab.columns["Azimuth_(a-app)"][1] == 359.999999999
        assert tab.times_utc[1] == np.datetime64("2026-02-28T23:59:59.999")

    def test_error_text_raises_with_message(self) -> None:
        with pytest.raises(HorizonsError, match="Geodetic latitude not in the range"):
            parse_horizons_csv("Geodetic latitude not in the range -90 to 90 degrees\n")

    def test_malformed_row_raises(self) -> None:
        text = (" Date__(UT)__HR:MN, , ,Azimuth_(a-app), Elevation_(a-app),\n****\n$$SOE\n"
                " 2026-Jan-01 00:00,*,i,  abc,  1.0,\n$$EOE\n")
        with pytest.raises(HorizonsError, match="non-numeric"):
            parse_horizons_csv(text)


# ======================================================================================
# Offline: request planning, inputs
# ======================================================================================
class TestPlanning:
    def test_site_coord_string(self) -> None:
        assert site_coord_string(-41.63, 206.02, -2500.0) == "'206.020000000,-41.630000000,-2.500000'"
        assert site_coord_string(10.0, -10.0, 0.0).startswith("'350.000000000,")  # east lon normalised
        with pytest.raises(ValueError):
            site_coord_string(91.0, 0.0, 0.0)

    def test_uniform_chunks(self) -> None:
        t = hourly("2026-01-01", "2026-01-02T21:00")  # 45 points
        ch = plan_chunks(t, 20)
        assert [len(c.times) for c in ch] == [20, 20, 5]
        assert all(c.uniform for c in ch)
        span, tl = ch[0].time_params()
        assert tl is None
        assert span == {"START_TIME": "'2026-01-01 00:00:00'", "STOP_TIME": "'2026-01-01 19:00:00'",
                        "STEP_SIZE": "'19'"}  # 19 equal intervals -> 20 output times
        assert np.array_equal(np.concatenate([c.times for c in ch]), t)

    def test_single_point_remainder_uses_tlist(self) -> None:
        ch = plan_chunks(hourly("2026-01-01", "2026-01-02T17:00"), 20)  # 41 points
        assert [len(c.times) for c in ch] == [20, 20, 1]
        assert ch[-1].uniform is False
        assert ch[-1].time_params() == ({"TLIST_TYPE": "CAL"}, ["2026-01-02 16:00:00"])

    def test_irregular_chunks_capped_at_10000(self) -> None:
        rng = np.random.default_rng(0)
        t = np.unique(np.datetime64("2026-01-01", "s") + rng.integers(0, 10**8, 25_000).astype("timedelta64[s]"))
        ch = plan_chunks(t, 20_000)
        assert all(not c.uniform for c in ch)
        assert max(len(c.times) for c in ch) == 10_000
        assert np.array_equal(np.concatenate([c.times for c in ch]), t)

    def test_times_validation(self) -> None:
        with pytest.raises(ValueError, match="sub-second"):
            _as_utc_seconds(np.array(["2026-01-01T00:00:00.5"], dtype="datetime64[ms]"))
        with pytest.raises(ValueError, match="1-D"):
            _as_utc_seconds(np.zeros((2, 2), dtype="datetime64[s]"))
        out = _as_utc_seconds(np.array(["2026-01-01T00:00:00"], dtype="datetime64[ms]"))
        assert out.dtype == np.dtype("datetime64[s]")

    def test_provider_satisfies_protocol(self) -> None:
        assert isinstance(HorizonsProvider(), EphemerisProvider)
        assert HorizonsProvider.name == "horizons"


# ======================================================================================
# Offline: cache + transport with a fake HTTP session
# ======================================================================================
class _FakeResp:
    def __init__(self, payload: dict, status: int = 200) -> None:
        self._p, self.status_code, self.text = payload, status, json.dumps(payload)

    def json(self) -> dict:
        return self._p


class _FakeSession:
    """Serves the saved Sun sample for any request; records calls."""

    def __init__(self, text: str) -> None:
        self.text, self.calls, self.headers = text, [], {}

    def get(self, url, params=None, timeout=None):  # noqa: ANN001
        self.calls.append(("GET", url, params))
        return _FakeResp({"result": self.text})

    def post(self, url, data=None, files=None, timeout=None):  # noqa: ANN001
        self.calls.append(("POST", url, files["input"][1]))
        return _FakeResp({"result": self.text})


SAMPLE_TIMES = np.arange(np.datetime64("2026-01-09T01:00:00", "s"),
                         np.datetime64("2026-01-09T06:00:01", "s"), np.timedelta64(20, "m"))


class TestCacheOffline:
    def test_second_call_served_from_disk(self, tmp_path: Path) -> None:
        sess = _FakeSession(SUN_SAMPLE.read_text(encoding="utf-8"))
        client = HorizonsClient(tmp_path, session=sess, min_interval_s=0.0)
        hp = HorizonsProvider(client=client)
        a = hp.fetch_body(SUN_ID, 0.674, 23.473, 0.0, SAMPLE_TIMES)
        assert client.http_calls == 1 and len(sess.calls) == 1
        assert sess.calls[0][2]["STEP_SIZE"] == "'15'"  # 16 times -> 15 intervals
        b = hp.fetch_body(SUN_ID, 0.674, 23.473, 0.0, SAMPLE_TIMES)
        assert client.http_calls == 1 and client.cache_hits == 1
        assert np.array_equal(a.el_deg, b.el_deg)
        assert len(list(tmp_path.glob("*.txt"))) == 1
        # offline provider reading the same cache needs no network at all
        off = HorizonsProvider(tmp_path, offline=True)
        c = off.fetch_body(SUN_ID, 0.674, 23.473, 0.0, SAMPLE_TIMES)
        assert np.array_equal(a.az_deg, c.az_deg) and off.client.http_calls == 0

    def test_offline_cache_miss_raises(self, tmp_path: Path) -> None:
        with pytest.raises(HorizonsError, match="offline"):
            HorizonsProvider(tmp_path, offline=True).fetch_body(SUN_ID, 0.0, 0.0, 0.0, SAMPLE_TIMES)

    def test_grid_mismatch_detected(self, tmp_path: Path) -> None:
        sess = _FakeSession(SUN_SAMPLE.read_text(encoding="utf-8"))
        hp = HorizonsProvider(client=HorizonsClient(tmp_path, session=sess, min_interval_s=0.0))
        with pytest.raises(HorizonsError, match="do not match requested grid"):
            hp.fetch_body(SUN_ID, 0.674, 23.473, 0.0, SAMPLE_TIMES + np.timedelta64(1, "s"))

    def test_site_echo_mismatch_detected(self, tmp_path: Path) -> None:
        sess = _FakeSession(SUN_SAMPLE.read_text(encoding="utf-8"))  # file echoes 23.473E, 0.674N
        hp = HorizonsProvider(client=HorizonsClient(tmp_path, session=sess, min_interval_s=0.0))
        with pytest.raises(HorizonsError, match="echoed site"):
            hp.fetch_body(SUN_ID, 0.674, 24.0, 0.0, SAMPLE_TIMES)

    def test_long_tlist_switches_to_file_api_post(self, tmp_path: Path) -> None:
        sess = _FakeSession(SUN_SAMPLE.read_text(encoding="utf-8"))
        client = HorizonsClient(tmp_path, session=sess, min_interval_s=0.0, max_url_length=300)
        hp = HorizonsProvider(client=client)
        irregular = SAMPLE_TIMES[[0, 1, 2, 3, 5, 8, 13]]  # non-uniform -> TLIST
        sess.text = _subset_sample(SUN_SAMPLE.read_text(encoding="utf-8"), [0, 1, 2, 3, 5, 8, 13])
        hp.fetch_body(SUN_ID, 0.674, 23.473, 0.0, irregular)
        method, url, body = sess.calls[0]
        assert method == "POST" and url.endswith("horizons_file.api")
        assert "TLIST=\n'2026-01-09 01:00:00'\n'2026-01-09 01:20:00'" in body

    def test_get_transport_batches_to_fit_url(self, tmp_path: Path) -> None:
        full = SUN_SAMPLE.read_text(encoding="utf-8")
        idx = [0, 1, 2, 3, 5, 8, 13]

        class Sess(_FakeSession):
            def get(self, url, params=None, timeout=None):  # noqa: ANN001
                self.calls.append(("GET", url, params))
                want = [s.strip("'") for s in params["TLIST"].split("' '")]
                sel = [i for i in range(16) if str(SAMPLE_TIMES[i]).replace("T", " ") in want]
                return _FakeResp({"result": _subset_sample(full, sel)})

        sess = Sess(full)
        hp = HorizonsProvider(client=HorizonsClient(tmp_path, session=sess, min_interval_s=0.0,
                                                    tlist_transport="get"))
        # URL limit chosen so that 4 TLIST entries fit but 7 do not -> forces batching
        base = {**hp.body_params(SUN_ID, 0.674, 23.473, 0.0), "TLIST_TYPE": "CAL"}
        strs = [str(x).replace("T", " ") for x in SAMPLE_TIMES[idx]]
        limit = hp.client.get_url_length(base, strs[:4])
        assert limit < hp.client.get_url_length(base, strs)
        hp.client.max_url_length = limit
        out = hp.fetch_body(SUN_ID, 0.674, 23.473, 0.0, SAMPLE_TIMES[idx])
        assert len(sess.calls) >= 2 and all(c[0] == "GET" for c in sess.calls)
        assert all(hp.client.get_url_length({k: v for k, v in c[2].items() if k != "TLIST"},
                                            [s.strip("'") for s in c[2]["TLIST"].split("' '")]) <= limit
                   for c in sess.calls)
        full_tab = parse_horizons_csv(full)
        assert np.array_equal(out.el_deg, full_tab.columns["Elevation_(a-app)"][idx])

    def test_error_payload_raises_and_is_not_cached(self, tmp_path: Path) -> None:
        class ErrSess(_FakeSession):
            def get(self, url, params=None, timeout=None):  # noqa: ANN001
                self.calls.append(("GET", url, params))
                return _FakeResp({"error": "Output length exceeded, 95000 times requested, max. is 90000"})

        client = HorizonsClient(tmp_path, session=ErrSess(""), min_interval_s=0.0)
        with pytest.raises(HorizonsError, match="Output length exceeded"):
            HorizonsProvider(client=client).fetch_body(SUN_ID, 0.674, 23.473, 0.0, SAMPLE_TIMES)
        assert list(tmp_path.glob("*.txt")) == []


def _subset_sample(text: str, rows: list[int]) -> str:
    i0, i1 = text.index("$$SOE") + 6, text.index("$$EOE")
    lines = text[i0:i1].splitlines()
    return text[:i0] + "\n".join(lines[r] for r in rows) + "\n" + text[i1:]


# ======================================================================================
# Network: physical checks against the live Horizons API
# ======================================================================================
@pytest.fixture(scope="module")
def hp() -> HorizonsProvider:
    return HorizonsProvider()  # default cache data/cache/horizons -> reruns are offline


JAN = hourly("2026-01-01", "2026-02-01")  # 744 h > one synodic month (708.7 h)


@pytest.mark.network
class TestPhysics:
    def test_alignment_and_metadata(self, hp: HorizonsProvider) -> None:
        e = hp.compute(APOLLO11, JAN, 0.0)
        assert isinstance(e, EphemerisSeries) and e.method == "horizons"
        assert e.times_utc.dtype == np.dtype("datetime64[s]") and np.array_equal(e.times_utc, JAN)
        assert e.meta["frame"].startswith("MEAN_ME")
        for a in (e.sun_az_deg, e.earth_az_deg):
            assert np.all((a >= 0) & (a < 360))

    def test_apollo11_earth_high(self, hp: HorizonsProvider) -> None:
        # Earth zenith distance = arc from site to the sub-Earth point, which librates by
        # |lon| <= 8.2 deg, |lat| <= 6.9 deg around (0, 0): arc in [23.47-8.2, ~32.5] deg,
        # so el in [57.5, 74.8] (topocentric parallax lowers it by <= 0.26 deg).
        e = hp.compute(APOLLO11, JAN, 0.0)
        assert 56.9 < e.earth_el_deg.min() and e.earth_el_deg.max() < 74.8
        assert 63.0 < e.earth_el_deg.mean() < 69.0  # "stays high ~60-70 deg"

    def test_change6_far_side_earth_never_visible(self, hp: HorizonsProvider) -> None:
        # Min arc site <-> sub-Earth point >= ~122 deg (lon diff >= 146 deg, lat libration
        # <= 6.9 deg) -> el <= -32 deg. Also the upper limb is never up.
        e = hp.compute(CHANGE6, JAN, 0.0)
        assert e.earth_el_deg.max() < -32.0
        assert not np.any(e.meta["earth_up_marker"])

    def test_south_pole_sun_and_earth_near_horizon(self, hp: HorizonsProvider) -> None:
        # Sub-solar latitude |b_sun| <= 1.54 deg (lunar equator vs ecliptic), colatitude 0.5 deg
        # -> |sun el| <= 2.04 deg. Sub-Earth latitude |b_e| <= 6.9 deg -> |earth el| <= 7.4 deg
        # (+0.26 parallax). Latitude libration (~6.7 deg amplitude) spans >= 10 deg per month.
        e = hp.compute(SOUTH_POLE, JAN, 0.0)
        assert np.max(np.abs(e.sun_el_deg)) < 2.1
        assert np.max(np.abs(e.earth_el_deg)) < 7.7
        assert np.ptp(e.earth_el_deg) > 10.0
        # Sun circles the horizon once per synodic month: all azimuth octants visited
        assert len(np.unique((e.sun_az_deg // 45).astype(int))) == 8

    def test_equator_local_noon_sun_near_zenith(self, hp: HorizonsProvider) -> None:
        # At local noon el = 90 - |b_sun - lat| >= 88.46; hourly sampling misses the peak by
        # <= 0.254 deg of hour angle -> max el >= 90 - hypot(1.54, 0.254) = 88.44 deg.
        e = hp.compute(EQUATOR0, JAN, 0.0)
        assert e.sun_el_deg.max() > 88.4 and e.sun_el_deg.min() < -88.4
        # Sun near zenith while the Earth (near-side) is also high above (0,0): el >= 80
        assert e.earth_el_deg.min() > 80.0

    def test_distances_and_angular_sizes(self, hp: HorizonsProvider) -> None:
        e = hp.compute(APOLLO11, JAN, 0.0)
        # Earth-Sun 0.9833..1.0167 au, Moon offset <= 0.0027 au
        assert 0.980 < e.sun_dist_km.min() / AU_KM and e.sun_dist_km.max() / AU_KM < 1.020
        # Moon-Earth centre 356 400..406 700 km, observer within 1737 km of the Moon centre
        assert 354_000 < e.earth_dist_km.min() and e.earth_dist_km.max() < 408_500
        # ang-diam printed to 0.001" -> agreement with 2 asin(R/d) to 0.002"
        for d, r, key in ((e.sun_dist_km, SUN_RADIUS_KM, "sun_ang_diam_arcsec"),
                          (e.earth_dist_km, EARTH_RADIUS_KM, "earth_ang_diam_arcsec")):
            assert np.max(np.abs(2 * np.arcsin(r / d) * ARCSEC_PER_RAD - e.meta[key])) < 2e-3

    def test_horizons_markers_match_upper_limb_rule(self, hp: HorizonsProvider) -> None:
        for site in (APOLLO11, SOUTH_POLE):
            e = hp.compute(site, JAN, 0.0)
            m = hp.daylight_markers(site, JAN, 0.0)
            assert m.interferer == "EARTH"
            su = e.sun_el_deg + e.meta["sun_ang_diam_arcsec"] / 7200
            eu = e.earth_el_deg + e.meta["earth_ang_diam_arcsec"] / 7200
            ok_s, ok_e = np.abs(su) > 1e-3, (np.abs(eu) > 1e-3) & m.earth_known  # skip ties at print resolution
            assert np.array_equal(m.sun_daylight[ok_s], su[ok_s] >= 0)
            assert np.array_equal(m.earth_up[ok_e], eu[ok_e] >= 0)

    def test_negative_altitude_and_height_effect(self, hp: HorizonsProvider) -> None:
        # A 4 km lower observer on a sphere changes only the topocentric parallax:
        # Earth el shifts by <= (4/384 400) rad ~ 0.0006 deg; header echo is checked inside.
        t = JAN[:48]
        a = hp.compute(SOUTH_POLE, t, 0.0)
        b = hp.compute(SOUTH_POLE, t, -4000.0)
        assert b.observer_height_m == -4000.0 and b.meta["site_coord"].endswith(",-4.000000'")
        d = np.abs(a.earth_el_deg - b.earth_el_deg)
        assert 0 < d.max() < 1e-3


@pytest.mark.network
class TestRequestPaths:
    def test_cache_second_call_no_http(self, tmp_path: Path) -> None:
        hp = HorizonsProvider(tmp_path)
        t = hourly("2026-03-01", "2026-03-03")
        a = hp.compute(APOLLO11, t, 0.0)
        n = hp.client.http_calls
        assert n == 2  # one Sun + one Earth request
        b = hp.compute(APOLLO11, t, 0.0)
        assert hp.client.http_calls == n and hp.client.cache_hits == 2
        assert np.array_equal(a.sun_el_deg, b.sun_el_deg) and np.array_equal(a.earth_az_deg, b.earth_az_deg)

    def test_chunked_equals_single_request(self, tmp_path: Path) -> None:
        t = hourly("2026-03-01", "2026-03-04")  # 72 points
        one = HorizonsProvider(tmp_path / "a").compute(SOUTH_POLE, t, 0.0)
        hp = HorizonsProvider(tmp_path / "b", max_points_per_request=25)
        many = hp.compute(SOUTH_POLE, t, 0.0)
        assert many.meta["n_requests"] == 2 * 3
        # identical Horizons computation; values printed with 9 decimals
        assert np.max(np.abs(one.sun_el_deg - many.sun_el_deg)) < 1e-9
        assert np.max(np.abs(one.earth_az_deg - many.earth_az_deg)) < 1e-9

    def test_irregular_unsorted_duplicates_all_transports(self, tmp_path: Path) -> None:
        grid = hourly("2026-03-01", "2026-03-04")
        ref = HorizonsProvider(tmp_path / "ref").compute(SOUTH_POLE, grid, 0.0)
        rng = np.random.default_rng(42)
        idx = rng.choice(grid.size, 60, replace=False)
        idx = np.concatenate([idx, idx[:5]])  # duplicates, random order
        extra = np.array(["2026-03-02T07:13:29", "2026-03-01T00:00:01"], dtype="datetime64[s]")
        t = np.concatenate([grid[idx], extra])
        results = {}
        for mode in ("auto", "get", "post"):
            hp = HorizonsProvider(tmp_path / mode, tlist_transport=mode)
            e = hp.compute(SOUTH_POLE, t, 0.0)
            assert np.array_equal(e.times_utc, t)  # exact requested order, duplicates kept
            results[mode] = e
            if mode == "get":
                assert e.meta["n_requests"] > 2  # 63 unique times do not fit one ~1.8 kB URL
        for mode in ("get", "post"):
            assert np.max(np.abs(results[mode].sun_el_deg - results["auto"].sun_el_deg)) < 1e-9
        k = idx.size
        assert np.max(np.abs(results["auto"].earth_el_deg[:k] - ref.earth_el_deg[idx])) < 1e-9
        assert np.max(np.abs(results["auto"].sun_az_deg[:k] - ref.sun_az_deg[idx])) < 1e-9

    def test_single_time(self, tmp_path: Path) -> None:
        t = np.array(["2026-01-09T04:00:00"], dtype="datetime64[s]")
        e = HorizonsProvider(tmp_path).compute(APOLLO11, t, 0.0)
        # equals the saved fixture row (same instant / site / quantities)
        assert e.sun_el_deg[0] == pytest.approx(-0.027729318, abs=1e-9)
        assert e.sun_az_deg[0] == pytest.approx(268.789287162, abs=1e-9)


@pytest.mark.network
@pytest.mark.slow
def test_five_year_hourly_precompute_span(tmp_path: Path) -> None:
    """Default precompute scope 2026-2031 hourly: 43 824 points -> 3 chunks per body."""
    from lunarnav.config import DEFAULT_END_UTC, DEFAULT_START_UTC

    t = hourly(DEFAULT_START_UTC, DEFAULT_END_UTC)
    hp = HorizonsProvider(tmp_path)
    e = hp.compute(APOLLO11, t, 0.0)
    assert np.array_equal(e.times_utc, t) and e.meta["n_requests"] == 6
    # Same libration bound as test_apollo11_earth_high, now over 5 years.
    assert 56.9 < e.earth_el_deg.min() and e.earth_el_deg.max() < 74.8
    assert np.all(np.isfinite(e.sun_el_deg))
