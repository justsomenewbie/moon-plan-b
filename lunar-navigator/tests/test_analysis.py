"""Tests of scenario analysis, ranking and the alternative landing-date search (lunarnav/analysis.py)."""
from __future__ import annotations

import numpy as np
import pytest

from lunarnav.analysis import (
    AnalysisOptions,
    DateConstraints,
    analyse,
    find_alternative_dates,
    find_alternative_dates_for_site,
    make_times,
    resolve_mask,
)
from lunarnav.precompute import SyntheticProvider
from lunarnav.types import EphemerisSeries, HorizonMask, Site
from lunarnav.visibility import AU_KM, compute_visibility, flat_horizon_mask

T0 = np.datetime64("2026-01-01T00:00:00", "s")


def series_from_flags(sun: np.ndarray, earth: np.ndarray, sun_el_lit: np.ndarray | float = 5.0):
    """VisibilitySeries whose sun/earth flags equal the given booleans exactly.

    Sun/Earth elevations are +-5 deg against a flat horizon (dip 0.087 deg), far from any
    threshold, so the visibility rules reproduce the flags without ambiguity.
    """
    n = sun.size
    t = T0 + np.arange(n) * np.timedelta64(3600, "s")
    sel = np.where(sun, sun_el_lit, -5.0) * np.ones(n)
    eph = EphemerisSeries(
        "syn", "fake", t,
        np.full(n, 90.0), sel, np.full(n, AU_KM),
        np.zeros(n), np.where(earth, 5.0, -5.0), np.full(n, 384_400.0), 2.0,
    )
    v = compute_visibility(eph, flat_horizon_mask("syn", 2.0))
    assert np.array_equal(v.sun_visible, sun) and np.array_equal(v.earth_visible, earth)
    return v


def runs(n: int, true_ranges) -> np.ndarray:
    f = np.zeros(n, bool)
    for a, b in true_ranges:
        f[a:b] = True
    return f


# ------------------------------------------------------------------------------------------
# Alternative dates on synthetic series with a known answer
# ------------------------------------------------------------------------------------------
class TestAltDatesKnownAnswer:
    n = 720
    sun = runs(720, [(100, 300), (400, 700)])
    earth = runs(720, [(150, 450)])

    def vis(self):
        return series_from_flags(self.sun, self.earth)

    def t(self, i):
        return T0 + np.timedelta64(3600 * i, "s")

    def test_best_both_window(self):
        # 'both' = sun & earth = [150, 300): a 100 h mission fully in both needs L in [150, 200];
        # ties -> earliest -> L = t[150]
        r = find_alternative_dates(self.vis(), self.t(0), self.t(500), 100, DateConstraints(objective="both"))
        best = r.candidates[0]
        assert best.landing_utc == self.t(150)
        assert best.both_pct == 100.0 and best.sun_pct == 100.0 and best.earth_pct == 100.0
        assert best.slip_h == 150.0 and best.rank == 1
        assert best.mission_end_utc == self.t(250)
        # continuous Sun from L=150 until the sunset at 300
        assert best.continuous_sun_h == 150.0 and not best.continuous_sun_lower_bound
        # candidates are >= 12 h apart (one per opportunity)
        lt = np.array([c.landing_utc for c in r.candidates]).astype(np.int64)
        assert np.all(np.abs(np.diff(np.sort(lt))) >= 12 * 3600)

    def test_min_continuous_sun_moves_to_second_lunar_day(self):
        # continuous Sun >= 250 h from landing is only possible in the second lit run [400, 700)
        # with L <= 450; the 'both' objective then prefers L = 400 (Earth until 450 -> 50 %)
        c = DateConstraints(objective="both", min_continuous_sun_h=250)
        r = find_alternative_dates(self.vis(), self.t(0), self.t(500), 100, c)
        best = r.candidates[0]
        assert best.landing_utc == self.t(400)
        assert best.both_pct == pytest.approx(50.0) and best.continuous_sun_h == 300.0
        assert not best.continuous_sun_lower_bound  # sunset at 700 h, before the series end (720 h)
        assert r.n_feasible == 51  # L in [400, 450]
        assert all(400 <= (c_.landing_utc - T0).astype(int) / 3600 <= 450 for c_ in r.candidates)

    def test_require_earth_at_landing(self):
        # Sun-only objective: best 100 % Sun for L in [100, 200] u [400, 600]; Earth at landing
        # excludes L < 150 -> earliest feasible optimum is L = 150
        c = DateConstraints(objective="sun", require_earth_at_landing=True)
        r = find_alternative_dates(self.vis(), self.t(0), self.t(500), 100, c)
        assert r.candidates[0].landing_utc == self.t(150)
        c = DateConstraints(objective="sun")
        assert find_alternative_dates(self.vis(), self.t(0), self.t(500), 100, c).candidates[0].landing_utc == self.t(100)

    def test_infeasible_reports_reasons(self):
        c = DateConstraints(min_sun_pct=100, min_earth_pct=100, min_continuous_sun_h=400)
        r = find_alternative_dates(self.vis(), self.t(0), self.t(500), 100, c)
        assert r.candidates == [] and r.n_feasible == 0 and r.n_evaluated == 501
        assert r.rejected_by["min_continuous_sun_h"] == 501
        # Sun not visible at landing for L in [0,100) u [300,400): 200 instants
        assert r.rejected_by["require_sun_at_landing"] == 200

    def test_max_dark_gap(self):
        # 300 h mission, at most 50 h without Sun, landing in sunlight not required.
        # The dark runs are [0,100) and [300,400) (100 h each). Feasible L: [50, 50] (sees 50 h of
        # each) and [350, 420] (sees <= 50 h of the second night; window must fit: L <= 420).
        c = DateConstraints(objective="earliest", max_dark_gap_h=50, require_sun_at_landing=False)
        r = find_alternative_dates(self.vis(), self.t(0), self.t(500), 300, c, max_results=100)
        got = sorted(int((x.landing_utc - T0).astype(int) // 3600) for x in r.candidates)
        assert r.n_feasible == 1 + (420 - 350 + 1)
        assert got[0] == 50 and got[1] == 350
        assert all(x.longest_dark_h <= 50 for x in r.candidates)

    def test_input_errors(self):
        v = self.vis()
        with pytest.raises(ValueError):  # mission not a multiple of the step
            find_alternative_dates(v, self.t(0), self.t(10), 1.5)
        with pytest.raises(ValueError):  # no full mission fits
            find_alternative_dates(v, self.t(700), self.t(710), 100)
        with pytest.raises(ValueError):
            DateConstraints(min_sun_pct=120)


def _brute(sun, earth, lo, hi, m, c: DateConstraints):
    """Independent pure-Python evaluation of the constraints and of the 'balanced' score."""
    n = sun.size
    feas = []
    for i in range(lo, hi + 1):
        if i + m > n:
            break
        s, e = sun[i : i + m], earth[i : i + m]
        sp, ep, bp = 100 * s.mean(), 100 * e.mean(), 100 * (s & e).mean()

        def longest(x):
            best = cur = 0
            for v in x:
                cur = cur + 1 if v else 0
                best = max(best, cur)
            return best

        cont = 0
        while i + cont < n and sun[i + cont]:
            cont += 1
        ok = (
            sp >= c.min_sun_pct and ep >= c.min_earth_pct
            and (sun[i] or not c.require_sun_at_landing)
            and (earth[i] or not c.require_earth_at_landing)
            and cont >= c.min_continuous_sun_h
            and (c.max_dark_gap_h is None or longest(~s) <= c.max_dark_gap_h)
            and (c.max_comms_gap_h is None or longest(~e) <= c.max_comms_gap_h)
        )
        if ok:
            # same 1e-9 rounding of the score as the implementation, so float noise cannot reorder ties
            feas.append((-round(0.5 * sp + 0.25 * ep + 0.25 * bp, 9), i))
    return sorted(feas)


@pytest.mark.parametrize("seed", range(6))
def test_alt_dates_matches_brute_force(seed):
    rng = np.random.default_rng(seed)
    n = 400

    def markov(p_stay):
        x = np.empty(n, bool)
        x[0] = rng.random() < 0.5
        for k in range(1, n):
            x[k] = x[k - 1] if rng.random() < p_stay else not x[k - 1]
        return x

    sun, earth = markov(0.93), markov(0.9)
    c = DateConstraints(
        min_sun_pct=float(rng.choice([0, 30, 50])),
        min_earth_pct=float(rng.choice([0, 20])),
        require_earth_at_landing=bool(rng.random() < 0.5),
        min_continuous_sun_h=float(rng.choice([0, 5, 10])),
        max_dark_gap_h=float(rng.choice([20, 40])),
        max_comms_gap_h=float(rng.choice([15, 60])),
        min_separation_h=0.0,
    )
    v = series_from_flags(sun, earth)
    m = 48
    r = find_alternative_dates(v, T0 + np.timedelta64(3600 * 10, "s"), T0 + np.timedelta64(3600 * 300, "s"), m, c, max_results=1000)
    bf = _brute(sun, earth, 10, 300, m, c)
    assert r.n_feasible == len(bf)
    got = [int((x.landing_utc - T0).astype(int) // 3600) for x in r.candidates]
    assert got == [i for _, i in bf]  # identical ordering (score desc, then earliest)


# ------------------------------------------------------------------------------------------
# analyse() / ranking with the synthetic geometry
# ------------------------------------------------------------------------------------------
SITES = [
    Site("eq0", "Equator near side", 0.0, 0.0),
    Site("far", "Equator far side", 0.0, 180.0),
    Site("sp", "Near south pole", -89.5, 0.0),
]


@pytest.fixture(scope="module")
def result():
    return analyse(SITES, "2026-01-01", "2026-03-02", 60, SyntheticProvider(), "flat")


def test_make_times():
    t = make_times("2026-01-01", "2026-01-02", 60)
    assert t.size == 24 and t[0] == T0 and t.dtype == np.dtype("datetime64[s]")
    with pytest.raises(ValueError):
        make_times("2026-01-01", "2026-01-01T00:30", 60)  # not a whole number of steps
    with pytest.raises(ValueError):
        make_times("2026-01-02", "2026-01-01", 60)


def test_physical_expectations(result):
    eq, far, sp = (result.site(s.id) for s in SITES)
    # near-side equator: Earth within ~10 deg of zenith -> always visible; far side: never
    assert eq.metrics["pct_earth"] == 100.0
    assert far.metrics["pct_earth"] == 0.0 and far.metrics["longest_comms_gap_truncated"]
    # equatorial lunar day: half a synodic month (708.73 h / 2 = 354.37 h) lengthened by the
    # upper-limb rule and the 2 m mast dip: 2*(0.2665+0.087) deg / (360/708.73 deg/h) = 1.39 h
    # -> 355.8 h; hourly windows are accurate to +-1 h
    full_days = [w.duration_h for w in eq.sun_windows if w.state and not (w.truncated_start or w.truncated_end)]
    assert full_days and all(abs(d - 355.76) <= 1.0 for d in full_days)
    # near the pole the Sun stays within colatitude + 1.543 deg of the horizon
    assert np.max(np.abs(sp.visibility.sun_el_deg)) <= 0.5 + 1.543 + 0.01
    # ranking: near side equator (Earth 100 %) beats far side (Earth 0 %)
    order = [r["site_id"] for r in result.ranking]
    assert order.index("eq0") < order.index("far")
    assert [r["rank"] for r in result.ranking] == [1, 2, 3]
    r_eq = next(r for r in result.ranking if r["site_id"] == "eq0")
    m = eq.metrics
    assert r_eq["score"] == pytest.approx(0.4 * m["pct_sun"] + 0.3 * m["pct_earth"] + 0.3 * m["pct_both"])


def test_custom_weights_change_ranking(result):
    from lunarnav.analysis import rank_sites

    sun_only = rank_sites(result.sites, {"pct_sun": 1.0})
    best = max(result.sites, key=lambda a: a.metrics["pct_sun"])
    assert sun_only[0]["site_id"] == best.site.id
    with pytest.raises(KeyError):
        rank_sites(result.sites, {"no_such_metric": 1.0})


def test_resolve_mask_checks():
    s = SITES[0]
    opt = AnalysisOptions(observer_height_m=2.0)
    bad = HorizonMask("eq0", np.arange(0, 360.0), np.zeros(360), "x", "none", 1.0, 5.0, 0.0)
    with pytest.raises(ValueError):  # mast height mismatch
        resolve_mask(s, {"eq0": bad}, opt)
    with pytest.raises(KeyError):
        resolve_mask(s, {}, opt)
    other = HorizonMask("zz", np.arange(0, 360.0), np.zeros(360), "x", "none", 1.0, 2.0, 0.0)
    with pytest.raises(ValueError):
        resolve_mask(s, {"eq0": other}, opt)
    with pytest.raises(ValueError):
        resolve_mask(s, "terrain", opt)


def test_alt_dates_for_site_synthetic():
    # Equatorial site: a 7-day mission fully in sunlight must start within the first
    # 355.8 - 168 = 187.8 h of the lunar day; the best 'sun' candidate is 100 % lit and the
    # mission really is lit at every step.
    s = SITES[0]
    c = DateConstraints(objective="sun", min_sun_pct=100.0)
    r = find_alternative_dates_for_site(s, "2026-01-01", "2026-02-15", 168, SyntheticProvider(), "flat", c)
    assert r.candidates and r.candidates[0].sun_pct == 100.0
    best = r.candidates[0]
    assert best.continuous_sun_h >= 168
    assert best.earth_pct == 100.0  # near side equator
    # feasible landings per lunar day ~ 187.8 h (+-1 h): 45 days span ~1.5 lunations
    assert 150 <= r.n_feasible <= 3 * 190
