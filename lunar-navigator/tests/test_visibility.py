"""Tests of the Sun/Earth visibility rules (lunarnav/visibility.py)."""
from __future__ import annotations

import numpy as np
import pytest

from lunarnav.config import MOON_RADIUS_M, SUN_RADIUS_KM
from lunarnav.types import EphemerisSeries, HorizonMask
from lunarnav.visibility import (
    AU_KM,
    SOLAR_CONSTANT_WM2,
    VisibilityOptions,
    compute_visibility,
    disc_visible_fraction,
    earth_semidiameter_deg,
    flat_horizon_dip_deg,
    flat_horizon_mask,
    sun_semidiameter_deg,
)


def _numeric_fraction(h: float, r: float, n: int = 4001) -> float:
    """Area fraction of a disc (radius r) above the line y = -h (disc center at y = 0), by
    midpoint integration of the chord length over y: A_above = int_{-h}^{r} 2 sqrt(r^2 - y^2) dy."""
    lo = max(-h, -r)
    if lo >= r:
        return 0.0
    edges = np.linspace(lo, r, n + 1)
    y = 0.5 * (edges[1:] + edges[:-1])
    dy = edges[1] - edges[0]
    return float(np.sum(2.0 * np.sqrt(np.maximum(r * r - y * y, 0.0))) * dy / (np.pi * r * r))


def _grid_fraction(h: float, r: float, n: int = 1500) -> float:
    """Independent 2-D pixel count of the disc above the line (Monte-Carlo-free brute force)."""
    g = (np.arange(n) + 0.5) / n * 2 * r - r
    x, y = np.meshgrid(g, g)
    inside = x * x + y * y <= r * r
    return float(np.sum(inside & (y > -h)) / np.sum(inside))


class TestSemidiameter:
    def test_sun_at_1au(self):
        # asin(695700 / 149597870.7) = 0.266453 deg (959.23 arcsec; IAU nominal 959.63" uses R=696000)
        assert sun_semidiameter_deg(AU_KM) == pytest.approx(np.degrees(np.arcsin(SUN_RADIUS_KM / AU_KM)), abs=1e-12)
        assert float(sun_semidiameter_deg(AU_KM)) == pytest.approx(0.266453, abs=2e-6)

    def test_earth_from_moon(self):
        # Earth seen from 384400 km: asin(6378.137/384400) = 0.950721 deg (the Earth disc is ~1.9 deg wide)
        assert float(earth_semidiameter_deg(384_400.0)) == pytest.approx(0.950721, abs=2e-6)

    def test_rejects_nonphysical_distance(self):
        with pytest.raises(ValueError):
            sun_semidiameter_deg(1000.0)


class TestDiscFraction:
    @pytest.mark.parametrize("x", np.linspace(-1.2, 1.2, 25))
    def test_formula_vs_numeric_integration(self, x):
        r = 0.2665
        h = x * r
        f = float(disc_visible_fraction(h, 0.0, r))
        # 1-D midpoint rule with 4001 cells: error O(dy^1.5) near the tangent point < 1e-5
        assert f == pytest.approx(_numeric_fraction(h, r), abs=1e-5)

    @pytest.mark.parametrize("x", [-0.9, -0.5, -0.1, 0.0, 0.3, 0.7, 0.95])
    def test_formula_vs_pixel_count(self, x):
        r = 0.27
        f = float(disc_visible_fraction(x * r, 0.0, r))
        # 1500x1500 pixel grid: boundary pixels ~ pi*n/... -> counting error ~ 1/n ~ 7e-4
        assert f == pytest.approx(_grid_fraction(x * r, r), abs=1.5e-3)

    def test_limits_and_symmetry(self):
        r = 0.27
        assert disc_visible_fraction(0.0, 0.0, r) == pytest.approx(0.5, abs=1e-15)
        assert disc_visible_fraction(r, 0.0, r) == 1.0
        assert disc_visible_fraction(-r, 0.0, r) == 0.0
        assert disc_visible_fraction(5.0, 1.0, r) == 1.0
        assert disc_visible_fraction(-5.0, 1.0, r) == 0.0
        h = np.linspace(-r, r, 101)
        f = disc_visible_fraction(h, 0.0, r)
        # f(h) + f(-h) = 1 (complementary segments), exactly up to rounding
        np.testing.assert_allclose(f + f[::-1], 1.0, atol=1e-12)
        assert np.all(np.diff(f) > 0)

    def test_horizon_shift_invariance(self):
        # only el - horizon matters
        assert disc_visible_fraction(1.3, 1.2, 0.27) == pytest.approx(disc_visible_fraction(0.1, 0.0, 0.27), abs=1e-12)

    def test_upper_limb_threshold(self):
        r = 0.2665
        assert disc_visible_fraction(-r + 1e-6, 0.0, r) > 0
        assert disc_visible_fraction(-r - 1e-6, 0.0, r) == 0

    def test_rejects_bad_radius(self):
        with pytest.raises(ValueError):
            disc_visible_fraction(0.0, 0.0, 0.0)


class TestFlatHorizon:
    def test_dip_two_metres(self):
        # exact acos(R/(R+h)); small-angle check sqrt(2h/R) = sqrt(4/1737400) rad = 0.086937 deg
        dip = flat_horizon_dip_deg(2.0)
        assert dip == pytest.approx(np.degrees(np.sqrt(2 * 2.0 / MOON_RADIUS_M)), rel=1e-6)
        assert dip == pytest.approx(0.086937, abs=1e-6)

    def test_dip_zero_height(self):
        assert flat_horizon_dip_deg(0.0) == 0.0

    def test_mask(self):
        m = flat_horizon_mask("s", 10.0, az_step_deg=1.0)
        assert m.az_deg.size == 360 and m.az_deg[0] == 0 and m.az_deg[-1] == 359
        np.testing.assert_allclose(m.el_deg, -flat_horizon_dip_deg(10.0))
        # horizon distance sqrt(2Rh) = sqrt(2*1737400*10) m = 5.894 km
        assert m.radius_km == pytest.approx(5.894, abs=1e-3)
        with pytest.raises(ValueError):
            flat_horizon_mask("s", -1.0)


def _eph(sun_az, sun_el, earth_az, earth_el, sun_d=AU_KM, earth_d=384_400.0) -> EphemerisSeries:
    n = len(sun_az)
    t = np.datetime64("2026-01-01T00:00:00", "s") + np.arange(n) * np.timedelta64(3600, "s")
    f = lambda x: np.broadcast_to(np.asarray(x, float), (n,)).copy()  # noqa: E731
    return EphemerisSeries("s", "fake", t, f(sun_az), f(sun_el), f(sun_d), f(earth_az), f(earth_el), f(earth_d), 2.0)


def _mask(el_fn) -> HorizonMask:
    az = np.arange(0, 360, 1.0)
    return HorizonMask("s", az, el_fn(az), "fake", "none", 10.0, 2.0, 0.0)


class TestComputeVisibility:
    def test_terrain_horizon_and_rules(self):
        # horizon el = 1 + az/360 deg (linear ramp), sampled at the Sun / Earth azimuths
        mask = _mask(lambda az: 1.0 + az / 360.0)
        sd = float(sun_semidiameter_deg(AU_KM))
        sun_az = [90.0, 90.0, 180.0, 180.0, 270.0]
        hz = 1.0 + np.array(sun_az) / 360.0
        sun_el = hz + np.array([0.5, -0.5, 0.0, -sd + 1e-4, sd + 0.1])
        v = compute_visibility(_eph(sun_az, sun_el, [0.0] * 5, [5.0, 1.0, 1.0001, 0.5, 30.0]), mask)
        np.testing.assert_allclose(v.horizon_el_sun_deg, hz, atol=1e-12)
        np.testing.assert_array_equal(v.sun_visible, [True, False, True, True, True])
        assert v.sun_fraction[2] == pytest.approx(0.5, abs=1e-12)
        assert 0 < v.sun_fraction[3] < 1e-5  # only a sliver of the upper limb
        assert v.sun_fraction[4] == 1.0
        # power proxies: horizontal = f*sin(el), tracking = f
        np.testing.assert_allclose(v.power_horizontal, v.sun_fraction * np.sin(np.radians(sun_el)), atol=1e-15)
        np.testing.assert_array_equal(v.power_tracking, v.sun_fraction)
        np.testing.assert_allclose(v.irradiance_tracking_wm2, SOLAR_CONSTANT_WM2 * v.sun_fraction, rtol=1e-12)
        # Earth at az 0 -> horizon 1.0; clearance = el - 1
        np.testing.assert_allclose(v.earth_clearance_deg, [4.0, 0.0, 1e-4, -0.5, 29.0], atol=1e-12)
        np.testing.assert_array_equal(v.earth_visible, [True, False, True, False, True])
        np.testing.assert_array_equal(v.both_visible, v.sun_visible & v.earth_visible)

    def test_negative_elevation_gives_zero_horizontal_power(self):
        # flat horizon at -0.087 deg; Sun center at -0.05 deg: visible (fraction > 0.5) but
        # horizontal panel gets max(0, sin(-0.05)) = 0
        v = compute_visibility(_eph([10.0], [-0.05], [0.0], [2.0]))
        assert v.sun_visible[0] and v.sun_fraction[0] > 0.5
        assert v.power_horizontal[0] == 0.0 and v.power_tracking[0] > 0.5

    def test_min_clearance(self):
        e = _eph([0.0] * 3, [10.0] * 3, [0.0] * 3, [1.0, 3.0, 6.0])
        mask = _mask(lambda az: np.zeros_like(az))
        v0 = compute_visibility(e, mask, VisibilityOptions(min_earth_clearance_deg=0.0))
        v5 = compute_visibility(e, mask, VisibilityOptions(min_earth_clearance_deg=5.0))
        np.testing.assert_array_equal(v0.earth_visible, [True, True, True])
        np.testing.assert_array_equal(v5.earth_visible, [False, False, True])
        with pytest.raises(ValueError):
            VisibilityOptions(min_earth_clearance_deg=12.0)

    def test_flat_default_uses_mast_dip(self):
        # Earth center exactly at -dip/2 is above the flat horizon (-dip) for a 2 m mast
        dip = flat_horizon_dip_deg(2.0)
        v = compute_visibility(_eph([0.0], [10.0], [123.0], [-dip / 2]))
        assert v.earth_visible[0]
        assert v.horizon_el_earth_deg[0] == pytest.approx(-dip, abs=1e-12)

    def test_azimuth_wraparound_interpolation(self):
        # mask: 0 deg at az 0, 1 deg at az 359 (periodic); az 359.5 -> 0.5 deg
        az = np.arange(0, 360, 1.0)
        el = np.where(az == 359.0, 1.0, 0.0)
        v = compute_visibility(_eph([359.5], [5.0], [359.5], [5.0]), HorizonMask("s", az, el, "f", "n", 1, 2.0, 0))
        assert v.horizon_el_sun_deg[0] == pytest.approx(0.5, abs=1e-12)

    def test_input_validation(self):
        e = _eph([0.0, 1.0], [1.0, 1.0], [0.0, 0.0], [1.0, 1.0])
        e.sun_el_deg[1] = np.nan
        with pytest.raises(ValueError):
            compute_visibility(e)
        e = _eph([0.0, 1.0], [1.0, 1.0], [0.0, 0.0], [1.0, 1.0])
        e.times_utc = e.times_utc[::-1].copy()
        with pytest.raises(ValueError):
            compute_visibility(e)
