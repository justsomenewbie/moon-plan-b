"""Tests of windows, metrics and 'time until' queries (lunarnav/windows.py)."""
from __future__ import annotations

import numpy as np
import pytest

from lunarnav.windows import (
    compute_metrics,
    find_windows,
    hours_until_change,
    hours_until_state,
    longest_run_h,
    next_earthrise,
    next_sunrise,
    pct_true,
    time_until_earthset,
    time_until_sunset,
)

T0 = np.datetime64("2026-01-01T00:00:00", "s")


def hourly(n: int) -> np.ndarray:
    return T0 + np.arange(n) * np.timedelta64(3600, "s")


def assert_tiles(wins, t, step_s=3600):
    """Windows cover [t0, t_end + step) contiguously, alternate state, and every sample once."""
    assert wins[0].start == t[0]
    assert wins[-1].end == t[-1] + np.timedelta64(step_s, "s")
    for a, b in zip(wins, wins[1:]):
        assert a.end == b.start
        assert a.state != b.state
    assert sum(w.end_index - w.start_index for w in wins) == t.size
    total_h = sum(w.duration_h for w in wins)
    assert total_h == pytest.approx(t.size * step_s / 3600.0, abs=1e-12)
    assert wins[0].truncated_start and wins[-1].truncated_end
    assert not any(w.truncated_start for w in wins[1:])
    assert not any(w.truncated_end for w in wins[:-1])


class TestFindWindows:
    def test_all_true(self):
        t = hourly(48)
        w = find_windows(t, np.ones(48, bool))
        assert len(w) == 1 and w[0].state and w[0].duration_h == 48.0
        assert w[0].truncated_start and w[0].truncated_end
        assert_tiles(w, t)

    def test_all_false(self):
        t = hourly(10)
        w = find_windows(t, np.zeros(10, bool))
        assert len(w) == 1 and not w[0].state and w[0].duration_h == 10.0
        assert_tiles(w, t)

    def test_alternating(self):
        t = hourly(7)
        f = np.array([1, 0, 1, 0, 1, 0, 1], bool)
        w = find_windows(t, f)
        assert len(w) == 7
        assert [x.state for x in w] == f.tolist()
        assert all(x.duration_h == 1.0 for x in w)
        assert_tiles(w, t)

    def test_truncation_and_boundaries(self):
        t = hourly(10)
        f = np.array([0, 0, 1, 1, 1, 0, 0, 0, 1, 1], bool)
        w = find_windows(t, f)
        assert [(x.state, x.duration_h) for x in w] == [(False, 2), (True, 3), (False, 3), (True, 2)]
        # window boundaries are the first sample of the new state (true transition within +-1 step)
        assert w[1].start == t[2] and w[1].end == t[5]
        assert [x.truncated_start for x in w] == [True, False, False, False]
        assert [x.truncated_end for x in w] == [False, False, False, True]
        assert_tiles(w, t)

    def test_single_sample_needs_step(self):
        t = hourly(1)
        with pytest.raises(ValueError):
            find_windows(t, np.array([True]))
        w = find_windows(t, np.array([True]), step_s=600)
        assert w[0].duration_h == pytest.approx(600 / 3600)

    def test_non_hourly_step(self):
        t = T0 + np.arange(6) * np.timedelta64(600, "s")
        w = find_windows(t, np.array([1, 1, 0, 0, 0, 1], bool))
        assert [x.duration_h for x in w] == pytest.approx([1 / 3, 1 / 2, 1 / 6])
        assert_tiles(w, t, 600)

    def test_random_series_tiles(self):
        rng = np.random.default_rng(0)
        t = hourly(1000)
        f = rng.random(1000) < 0.3
        w = find_windows(t, f)
        assert_tiles(w, t)
        for x in w:
            assert np.all(f[x.start_index : x.end_index] == x.state)

    def test_errors(self):
        t = hourly(3)
        with pytest.raises(ValueError):
            find_windows(t, np.array([True, False]))
        with pytest.raises(ValueError):
            find_windows(t[::-1].copy(), np.array([True, False, True]))
        with pytest.raises(TypeError):
            find_windows(t, np.array([0.5, 1.0, 0.0]))

    def test_to_dict(self):
        d = find_windows(hourly(3), np.array([1, 1, 0], bool))[0].to_dict()
        assert d == {
            "start": "2026-01-01T00:00:00Z",
            "end": "2026-01-01T02:00:00Z",
            "duration_h": 2.0,
            "state": True,
            "truncated_start": True,
            "truncated_end": False,
            "start_index": 0,
            "end_index": 2,
        }


class TestMetrics:
    def test_known_values(self):
        t = hourly(10)
        sun = np.array([0, 0, 1, 1, 1, 0, 0, 0, 1, 1], bool)
        earth = np.array([1, 1, 1, 0, 0, 0, 0, 1, 1, 1], bool)
        el = np.arange(10, dtype=float)
        m = compute_metrics(t, sun, earth, el, power_horizontal=sun * 0.5, power_tracking=sun * 1.0)
        assert m["pct_sun"] == pytest.approx(50.0)
        assert m["pct_earth"] == pytest.approx(60.0)
        assert m["pct_both"] == pytest.approx(30.0)  # samples 2, 8, 9
        assert m["pct_sun_no_earth"] == pytest.approx(20.0)
        assert m["longest_dark_h"] == 3.0 and not m["longest_dark_truncated"]
        assert m["longest_comms_gap_h"] == 4.0 and not m["longest_comms_gap_truncated"]
        assert m["n_sun_windows"] == 2 and m["n_dark_windows"] == 2
        assert m["n_earth_windows"] == 2 and m["n_comms_gaps"] == 1
        assert m["mean_sun_el_lit_deg"] == pytest.approx((2 + 3 + 4 + 8 + 9) / 5)
        assert m["mean_power_horizontal"] == pytest.approx(0.25)
        assert m["mean_power_tracking"] == pytest.approx(0.5)
        assert m["duration_h"] == 10.0

    def test_never_lit(self):
        t = hourly(5)
        m = compute_metrics(t, np.zeros(5, bool), np.ones(5, bool), np.zeros(5))
        assert m["pct_sun"] == 0.0 and m["mean_sun_el_lit_deg"] is None
        assert m["longest_dark_h"] == 5.0 and m["longest_dark_truncated"]
        assert m["longest_comms_gap_h"] == 0.0

    def test_pct_time_weighted(self):
        # non-uniform sampling: samples weigh their interval length
        t = np.array(["2026-01-01T00:00", "2026-01-01T03:00", "2026-01-01T04:00"], dtype="datetime64[s]")
        # last sample weighs the explicit step (1 h): 3 h lit out of 3 + 1 + 1 h
        assert pct_true(t, np.array([1, 0, 0], bool), step_s=3600) == pytest.approx(100 * 3 / (3 + 1 + 1))
        # without step_s the step is the median spacing (2 h): 3 / (3 + 1 + 2)
        assert pct_true(t, np.array([1, 0, 0], bool)) == pytest.approx(50.0)

    def test_longest_run(self):
        w = find_windows(hourly(6), np.array([1, 0, 0, 1, 0, 1], bool))
        assert longest_run_h(w, False) == (2.0, False)
        assert longest_run_h(w, True) == (1.0, True)  # first True run (truncated) is the first max


class TestTimeUntil:
    t = hourly(10)
    sun = np.array([0, 0, 1, 1, 1, 0, 0, 0, 1, 1], bool)

    def test_sunset(self):
        e = time_until_sunset(self.t, self.sun, "2026-01-01T02:30:00Z")
        assert e.state_now and e.hours == pytest.approx(2.5) and e.at == self.t[5] and not e.lower_bound
        e = time_until_sunset(self.t, self.sun, self.t[0])
        assert not e.state_now and e.hours == 0.0
        e = time_until_sunset(self.t, self.sun, self.t[8])
        assert e.lower_bound and e.at is None and e.hours == pytest.approx(2.0)

    def test_sunrise(self):
        e = next_sunrise(self.t, self.sun, self.t[5])
        assert not e.state_now and e.hours == 3.0 and e.at == self.t[8]
        assert next_sunrise(self.t, self.sun, self.t[3]).hours == 0.0
        e = next_sunrise(self.t, np.zeros(10, bool), self.t[0])
        assert e.lower_bound and e.hours == 10.0

    def test_earth(self):
        earth = ~self.sun
        assert time_until_earthset(self.t, earth, self.t[0]).hours == 2.0
        assert next_earthrise(self.t, earth, self.t[2]).hours == 3.0

    def test_out_of_range(self):
        with pytest.raises(ValueError):
            time_until_sunset(self.t, self.sun, "2026-01-01T10:00:00")  # range end is exclusive
        with pytest.raises(ValueError):
            time_until_sunset(self.t, self.sun, "2025-12-31T23:00:00")

    def test_vectorised(self):
        h = hours_until_change(self.t, self.sun)
        np.testing.assert_array_equal(h[:8], [2, 1, 3, 2, 1, 3, 2, 1])
        assert np.all(np.isnan(h[8:]))
        hs = hours_until_state(self.t, self.sun, False)  # hours until sunset
        np.testing.assert_array_equal(hs[:8], [0, 0, 3, 2, 1, 0, 0, 0])
        assert np.all(np.isnan(hs[8:]))
        hr = hours_until_state(self.t, self.sun, True)  # hours until sunrise
        np.testing.assert_array_equal(hr, [2, 1, 0, 0, 0, 3, 2, 1, 0, 0])
        # agreement with the scalar queries at every sample
        for i in range(8):
            assert time_until_sunset(self.t, self.sun, self.t[i]).hours == hs[i]
