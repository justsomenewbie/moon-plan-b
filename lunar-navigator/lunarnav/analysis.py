"""Scenario analysis: per-site visibility over a period, site ranking, alternative landing dates.

Everything here is pure computation on top of the contract in lunarnav/types.py:
  * an EphemerisProvider (Horizons / SPICE / analytic / a test fake) gives Sun/Earth az/el/dist;
  * a HorizonMask per site (terrain) or 'flat' (smooth sphere + mast dip);
  * lunarnav.visibility applies the rules, lunarnav.windows builds windows and metrics.

Key feature for the challenge ("the schedule slipped"): ``find_alternative_dates`` scans every
candidate landing instant in [earliest, latest] and returns the best ones that satisfy mission
constraints (minimum % of Sun, Earth in view at landing, continuous Sun after landing, maximum
dark / comms gap...), ranked by an explicit objective.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Callable, Iterable, Mapping, Union

import numpy as np

from .config import DEFAULT_OBSERVER_HEIGHT_M
from .types import EphemerisProvider, EphemerisSeries, HorizonMask, Site
from .visibility import VisibilityOptions, VisibilitySeries, compute_visibility, flat_horizon_mask
from .windows import (
    Window,
    clean_float,
    compute_metrics,
    find_windows,
    infer_step_s,
    iso_utc,
    parse_utc,
)

#: A horizon specification: 'flat', a mapping site_id -> HorizonMask, or a callable(site) -> mask.
HorizonSpec = Union[str, Mapping[str, HorizonMask], Callable[[Site], HorizonMask]]

#: Default site-ranking weights (applied to percentages 0..100, so the score is 0..100).
DEFAULT_RANK_WEIGHTS: dict[str, float] = {"pct_sun": 0.4, "pct_earth": 0.3, "pct_both": 0.3}


@dataclass(frozen=True)
class AnalysisOptions:
    """Options of a scenario analysis.

    min_earth_clearance_deg: Earth visibility margin above the terrain horizon (0..10 deg).
    observer_height_m: mast height above the local surface (m). Must match the masks' value.
    rank_weights: metric -> weight for rank_sites (metrics from windows.compute_metrics).
    """

    min_earth_clearance_deg: float = 0.0
    observer_height_m: float = DEFAULT_OBSERVER_HEIGHT_M
    rank_weights: Mapping[str, float] = field(default_factory=lambda: dict(DEFAULT_RANK_WEIGHTS))

    def visibility_options(self) -> VisibilityOptions:
        return VisibilityOptions(
            min_earth_clearance_deg=self.min_earth_clearance_deg,
            observer_height_m=self.observer_height_m,
        )


@dataclass
class SiteAnalysis:
    """Result of one site: inputs used, per-step visibility, windows and metrics."""

    site: Site
    ephemeris: EphemerisSeries
    mask: HorizonMask
    visibility: VisibilitySeries
    sun_windows: list[Window]
    earth_windows: list[Window]
    both_windows: list[Window]
    metrics: dict
    step_s: int

    @property
    def site_id(self) -> str:
        return self.site.id


@dataclass
class AnalysisResult:
    """Scenario analysis over [start, end) with a fixed step for several sites."""

    start: np.datetime64
    end: np.datetime64
    step_s: int
    provider: str
    options: AnalysisOptions
    sites: list[SiteAnalysis]
    ranking: list[dict]

    def site(self, site_id: str) -> SiteAnalysis:
        for s in self.sites:
            if s.site.id == site_id:
                return s
        raise KeyError(site_id)


# --------------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------------
def make_times(start: str | np.datetime64, end: str | np.datetime64, step_minutes: float) -> np.ndarray:
    """UTC sample instants t_k = start + k*step covering [start, end) (datetime64[s]).

    (end - start) must be a positive multiple of the step so that the covered range is exactly
    [start, end) (see windows.py sampling convention).
    """
    t0, t1 = parse_utc(start), parse_utc(end)
    step_s = int(round(step_minutes * 60))
    if step_s <= 0 or abs(step_minutes * 60 - step_s) > 1e-6:
        raise ValueError("step must be a positive whole number of seconds")
    span = int((t1 - t0).astype(np.int64))
    if span <= 0:
        raise ValueError(f"end {t1} must be after start {t0}")
    if span % step_s:
        raise ValueError(f"(end - start) = {span} s is not a multiple of the step {step_s} s")
    return t0 + np.arange(span // step_s, dtype=np.int64) * np.timedelta64(step_s, "s")


def resolve_mask(site: Site, horizons: HorizonSpec, options: AnalysisOptions) -> HorizonMask:
    """Pick/compute the HorizonMask of a site from a HorizonSpec and check its consistency."""
    if isinstance(horizons, str):
        if horizons != "flat":
            raise ValueError(f"unknown horizon spec {horizons!r} (only 'flat' is accepted as a string)")
        mask = flat_horizon_mask(site.id, options.observer_height_m, site.height_m or 0.0)
    elif isinstance(horizons, Mapping):
        if site.id not in horizons:
            raise KeyError(f"no horizon mask for site {site.id!r}")
        mask = horizons[site.id]
    elif callable(horizons):
        mask = horizons(site)
    else:
        raise TypeError("horizons must be 'flat', a mapping site_id -> HorizonMask, or a callable")
    if not isinstance(mask, HorizonMask):
        raise TypeError(f"horizon for {site.id!r} is not a HorizonMask")
    if mask.site_id != site.id:
        raise ValueError(f"horizon mask site_id {mask.site_id!r} != site {site.id!r}")
    if abs(mask.observer_height_m - options.observer_height_m) > 1e-6:
        raise ValueError(
            f"mask for {site.id!r} was computed for a {mask.observer_height_m} m mast but the analysis "
            f"uses {options.observer_height_m} m"
        )
    return mask


def observer_height_above_sphere_m(site: Site, mask: HorizonMask) -> float:
    """Observer height above the 1737.4 km sphere: surface height (mask, else site) + mast."""
    surface = mask.surface_height_m
    if mask.method == "flat" and site.height_m is not None:
        surface = site.height_m
    return float(surface + mask.observer_height_m)


def analyse_site(
    site: Site,
    times_utc: np.ndarray,
    provider: EphemerisProvider,
    mask: HorizonMask,
    options: AnalysisOptions | None = None,
    ephemeris: EphemerisSeries | None = None,
) -> SiteAnalysis:
    """Ephemeris (unless given) + visibility + windows + metrics for one site."""
    opt = options or AnalysisOptions()
    h = observer_height_above_sphere_m(site, mask)
    eph = ephemeris if ephemeris is not None else provider.compute(site, times_utc, h)
    if len(eph) != len(times_utc) or not np.array_equal(eph.times_utc.astype("datetime64[s]"), times_utc):
        raise ValueError(f"provider returned times that differ from the requested ones for {site.id!r}")
    if eph.site_id != site.id:
        raise ValueError(f"ephemeris site_id {eph.site_id!r} != {site.id!r}")
    vis = compute_visibility(eph, mask, opt.visibility_options())
    step_s = infer_step_s(times_utc)
    sw = find_windows(times_utc, vis.sun_visible, step_s)
    ew = find_windows(times_utc, vis.earth_visible, step_s)
    bw = find_windows(times_utc, vis.both_visible, step_s)
    met = compute_metrics(
        times_utc,
        vis.sun_visible,
        vis.earth_visible,
        vis.sun_el_deg,
        vis.power_horizontal,
        vis.power_tracking,
        step_s,
    )
    return SiteAnalysis(site, eph, mask, vis, sw, ew, bw, met, step_s)


def analyse(
    sites: Iterable[Site],
    start: str | np.datetime64,
    end: str | np.datetime64,
    step_minutes: float,
    provider: EphemerisProvider,
    horizons: HorizonSpec = "flat",
    options: AnalysisOptions | None = None,
) -> AnalysisResult:
    """Analyse several sites over [start, end) at a fixed step and rank them."""
    opt = options or AnalysisOptions()
    times = make_times(start, end, step_minutes)
    sites = list(sites)
    if not sites:
        raise ValueError("no sites given")
    ids = [s.id for s in sites]
    if len(set(ids)) != len(ids):
        raise ValueError(f"duplicate site ids: {ids}")
    res = [analyse_site(s, times, provider, resolve_mask(s, horizons, opt), opt) for s in sites]
    step_s = infer_step_s(times)
    return AnalysisResult(
        start=times[0],
        end=times[-1] + np.timedelta64(step_s, "s"),
        step_s=step_s,
        provider=str(getattr(provider, "name", type(provider).__name__)),
        options=opt,
        sites=res,
        ranking=rank_sites(res, opt.rank_weights),
    )


def rank_sites(analyses: Iterable[SiteAnalysis], weights: Mapping[str, float] | None = None) -> list[dict]:
    """Rank sites by score = sum_k weights[k] * metrics[k] (descending).

    Default weights 0.4*pct_sun + 0.3*pct_earth + 0.3*pct_both (0..100). Ties are broken by the
    shorter longest_dark_h, then by site id (deterministic). Returns rows
    {rank (1 = best), site_id, score, pct_sun, pct_earth, pct_both, longest_dark_h, longest_comms_gap_h}.
    """
    w = dict(weights or DEFAULT_RANK_WEIGHTS)
    rows = []
    for a in analyses:
        m = a.metrics
        score = 0.0
        for k, wk in w.items():
            if k not in m or m[k] is None:
                raise KeyError(f"ranking metric {k!r} not available")
            score += float(wk) * float(m[k])
        rows.append(
            {
                "site_id": a.site.id,
                "score": score,
                "pct_sun": m["pct_sun"],
                "pct_earth": m["pct_earth"],
                "pct_both": m["pct_both"],
                "longest_dark_h": m["longest_dark_h"],
                "longest_comms_gap_h": m["longest_comms_gap_h"],
            }
        )
    rows.sort(key=lambda r: (-round(r["score"], 9), r["longest_dark_h"], r["site_id"]))
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    return rows


# --------------------------------------------------------------------------------------------
# Alternative landing dates
# --------------------------------------------------------------------------------------------
OBJECTIVES = ("balanced", "sun", "earth", "both", "energy", "earliest")


@dataclass(frozen=True)
class DateConstraints:
    """Mission constraints for a landing at instant L, mission interval [L, L + D).

    Percentages are of the mission duration D (0..100). Durations in hours.
      min_sun_pct / min_earth_pct / min_both_pct: minimum % of the mission with Sun / Earth / both.
      require_sun_at_landing / require_earth_at_landing: flag must be True at L.
      min_continuous_sun_h / min_continuous_earth_h: uninterrupted Sun / Earth from L (may extend
          beyond the mission end; requires the series to extend that far).
      max_dark_gap_h / max_comms_gap_h: longest Sun-less / Earth-less run inside [L, L+D).
      min_sun_el_at_landing_deg: Sun center elevation at L (e.g. lighting for landing cameras).
      objective: ranking of feasible candidates:
          'balanced' = 0.5*sun_pct + 0.25*earth_pct + 0.25*both_pct, 'sun', 'earth', 'both',
          'energy' = 100 * mean tracking-panel power, 'earliest' = smallest slip.
          Ties -> earlier landing.
      min_separation_h: returned candidates are at least this far apart (one per opportunity).
    """

    min_sun_pct: float = 0.0
    min_earth_pct: float = 0.0
    min_both_pct: float = 0.0
    require_sun_at_landing: bool = True
    require_earth_at_landing: bool = False
    min_continuous_sun_h: float = 0.0
    min_continuous_earth_h: float = 0.0
    max_dark_gap_h: float | None = None
    max_comms_gap_h: float | None = None
    min_sun_el_at_landing_deg: float | None = None
    objective: str = "balanced"
    min_separation_h: float = 12.0

    def __post_init__(self) -> None:
        for k in ("min_sun_pct", "min_earth_pct", "min_both_pct"):
            v = getattr(self, k)
            if not (0.0 <= v <= 100.0):
                raise ValueError(f"{k} must be in [0, 100]")
        for k in ("min_continuous_sun_h", "min_continuous_earth_h", "min_separation_h"):
            if getattr(self, k) < 0:
                raise ValueError(f"{k} must be >= 0")
        if self.objective not in OBJECTIVES:
            raise ValueError(f"objective must be one of {OBJECTIVES}")


@dataclass(frozen=True)
class LandingCandidate:
    """One candidate landing instant and its mission statistics (see DateConstraints)."""

    rank: int
    landing_utc: np.datetime64
    mission_end_utc: np.datetime64
    slip_h: float  # landing - earliest, hours
    score: float
    sun_pct: float
    earth_pct: float
    both_pct: float
    longest_dark_h: float
    longest_comms_gap_h: float
    continuous_sun_h: float  # from landing; lower bound if continuous_sun_lower_bound
    continuous_sun_lower_bound: bool
    continuous_earth_h: float
    continuous_earth_lower_bound: bool
    sun_at_landing: bool
    earth_at_landing: bool
    sun_el_at_landing_deg: float
    earth_el_at_landing_deg: float
    mean_power_horizontal: float
    mean_power_tracking: float

    def to_dict(self) -> dict:
        d = asdict(self)
        d["landing_utc"] = iso_utc(self.landing_utc)
        d["mission_end_utc"] = iso_utc(self.mission_end_utc)
        for k, v in d.items():
            if isinstance(v, float):
                d[k] = clean_float(v)
            elif isinstance(v, (np.bool_,)):
                d[k] = bool(v)
        return d


@dataclass
class AltDateResult:
    """Output of find_alternative_dates: ranked candidates plus diagnostics.

    n_evaluated: landing instants examined; n_feasible: satisfying all constraints;
    rejected_by: constraint name -> number of instants failing it (one instant can fail several).
    """

    site_id: str
    earliest: np.datetime64
    latest: np.datetime64
    mission_duration_h: float
    constraints: DateConstraints
    candidates: list[LandingCandidate]
    n_evaluated: int
    n_feasible: int
    rejected_by: dict[str, int]

    def to_dict(self) -> dict:
        return {
            "site_id": self.site_id,
            "earliest_utc": iso_utc(self.earliest),
            "latest_utc": iso_utc(self.latest),
            "mission_duration_h": self.mission_duration_h,
            "constraints": asdict(self.constraints),
            "n_evaluated": self.n_evaluated,
            "n_feasible": self.n_feasible,
            "rejected_by": dict(self.rejected_by),
            "candidates": [c.to_dict() for c in self.candidates],
        }


def _forward_run_len(f: np.ndarray) -> np.ndarray:
    """r[k] = number of consecutive True samples starting at k (0 if f[k] is False)."""
    n = f.size
    idx = np.arange(n)
    # position of the next False at or after k (n if none)
    nf = np.where(~f, idx, n)
    nf = np.minimum.accumulate(nf[::-1])[::-1]
    return nf - idx


def _longest_false_run_rows(mat: np.ndarray) -> np.ndarray:
    """Row-wise length (samples) of the longest run of False in a 2-D boolean array."""
    x = (~mat).astype(np.int32)
    c = np.cumsum(x, axis=1)
    reset = np.maximum.accumulate(np.where(x == 0, c, 0), axis=1)
    return (c - reset).max(axis=1)


def _windowed_longest_false(f: np.ndarray, starts: np.ndarray, m: int, chunk: int = 4096) -> np.ndarray:
    """Longest False run (samples) inside f[s:s+m] for each s in starts (vectorised, chunked)."""
    out = np.empty(starts.size, dtype=np.int64)
    if starts.size == 0:
        return out
    view = np.lib.stride_tricks.sliding_window_view(f, m)
    for a in range(0, starts.size, chunk):
        sl = starts[a : a + chunk]
        out[a : a + chunk] = _longest_false_run_rows(view[sl])
    return out


def find_alternative_dates(
    vis: VisibilitySeries,
    earliest: str | np.datetime64,
    latest: str | np.datetime64,
    mission_duration_h: float,
    constraints: DateConstraints | None = None,
    max_results: int = 10,
) -> AltDateResult:
    """Rank candidate landing instants in [earliest, latest] for one site.

    ``vis`` must be uniformly sampled and cover [earliest, latest + mission_duration_h) (and
    further if continuous Sun/Earth constraints longer than the mission are used). Each sample
    t_i in [earliest, latest] with a complete mission inside the series is a candidate; mission
    statistics use samples i .. i+m-1 with m = mission_duration_h / step (must be whole).
    Precision of all times: +- one step.
    """
    c = constraints or DateConstraints()
    t = vis.times_utc.astype("datetime64[s]")
    n = t.size
    if n < 2:
        raise ValueError("visibility series too short")
    ti = t.astype(np.int64)
    d = np.diff(ti)
    step_s = int(d[0])
    if np.any(d != step_s):
        raise ValueError("find_alternative_dates needs a uniformly sampled series")
    m_f = mission_duration_h * 3600.0 / step_s
    m = int(round(m_f))
    if m < 1 or abs(m_f - m) > 1e-6:
        raise ValueError(f"mission duration {mission_duration_h} h must be a positive multiple of the step {step_s} s")
    e0, e1 = parse_utc(earliest), parse_utc(latest)
    if e1 < e0:
        raise ValueError("latest must be >= earliest")
    idx = np.flatnonzero((t >= e0) & (t <= e1) & (np.arange(n) + m <= n))
    if idx.size == 0:
        raise ValueError(
            f"series [{t[0]}, {t[-1]}] does not contain any landing time in [{e0}, {e1}] with a full "
            f"{mission_duration_h} h mission"
        )
    sun = np.asarray(vis.sun_visible, bool)
    earth = np.asarray(vis.earth_visible, bool)
    both = sun & earth

    def rolling_pct(f: np.ndarray) -> np.ndarray:
        cs = np.concatenate([[0], np.cumsum(f.astype(np.int64))])
        return 100.0 * (cs[idx + m] - cs[idx]) / m

    def rolling_mean(x: np.ndarray) -> np.ndarray:
        cs = np.concatenate([[0.0], np.cumsum(np.asarray(x, float))])
        return (cs[idx + m] - cs[idx]) / m

    sun_pct, earth_pct, both_pct = rolling_pct(sun), rolling_pct(earth), rolling_pct(both)
    step_h = step_s / 3600.0
    rs, re_ = _forward_run_len(sun), _forward_run_len(earth)
    cont_sun = rs[idx] * step_h
    cont_sun_lb = (idx + rs[idx]) >= n
    cont_earth = re_[idx] * step_h
    cont_earth_lb = (idx + re_[idx]) >= n
    sun_el = np.asarray(vis.sun_el_deg, float)[idx]

    tests: dict[str, np.ndarray] = {
        "min_sun_pct": sun_pct >= c.min_sun_pct - 1e-9,
        "min_earth_pct": earth_pct >= c.min_earth_pct - 1e-9,
        "min_both_pct": both_pct >= c.min_both_pct - 1e-9,
        "require_sun_at_landing": sun[idx] if c.require_sun_at_landing else np.ones(idx.size, bool),
        "require_earth_at_landing": earth[idx] if c.require_earth_at_landing else np.ones(idx.size, bool),
        "min_continuous_sun_h": cont_sun >= c.min_continuous_sun_h - 1e-9,
        "min_continuous_earth_h": cont_earth >= c.min_continuous_earth_h - 1e-9,
    }
    if c.min_sun_el_at_landing_deg is not None:
        tests["min_sun_el_at_landing_deg"] = sun_el >= c.min_sun_el_at_landing_deg
    ok = np.logical_and.reduce(list(tests.values()))
    # Expensive windowed statistics only where the cheap constraints pass.
    dark = np.full(idx.size, np.nan)
    gap = np.full(idx.size, np.nan)
    sel = np.flatnonzero(ok)
    dark[sel] = _windowed_longest_false(sun, idx[sel], m) * step_h
    gap[sel] = _windowed_longest_false(earth, idx[sel], m) * step_h
    if c.max_dark_gap_h is not None:
        tests["max_dark_gap_h"] = ~(dark > c.max_dark_gap_h + 1e-9)
        ok &= tests["max_dark_gap_h"]
    if c.max_comms_gap_h is not None:
        tests["max_comms_gap_h"] = ~(gap > c.max_comms_gap_h + 1e-9)
        ok &= tests["max_comms_gap_h"]
    rejected = {k: int(np.sum(~v)) for k, v in tests.items()}

    p_h = rolling_mean(vis.power_horizontal)
    p_t = rolling_mean(vis.power_tracking)
    slip_h = (ti[idx] - int(e0.astype(np.int64))) / 3600.0
    score = {
        "balanced": 0.5 * sun_pct + 0.25 * earth_pct + 0.25 * both_pct,
        "sun": sun_pct,
        "earth": earth_pct,
        "both": both_pct,
        "energy": 100.0 * p_t,
        "earliest": -slip_h,
    }[c.objective]

    feas = np.flatnonzero(ok)
    order = feas[np.lexsort((slip_h[feas], -np.round(score[feas], 9)))]
    chosen: list[int] = []
    sep_s = c.min_separation_h * 3600.0
    for k in order.tolist():
        if all(abs(ti[idx[k]] - ti[idx[j]]) >= sep_s for j in chosen):
            chosen.append(k)
            if len(chosen) >= max_results:
                break
    cands = []
    earth_el = np.asarray(vis.earth_el_deg, float)
    for r, k in enumerate(chosen, 1):
        i = int(idx[k])
        cands.append(
            LandingCandidate(
                rank=r,
                landing_utc=t[i],
                mission_end_utc=t[i] + np.timedelta64(m * step_s, "s"),
                slip_h=float(slip_h[k]),
                score=float(score[k]),
                sun_pct=float(sun_pct[k]),
                earth_pct=float(earth_pct[k]),
                both_pct=float(both_pct[k]),
                longest_dark_h=float(dark[k]),
                longest_comms_gap_h=float(gap[k]),
                continuous_sun_h=float(cont_sun[k]),
                continuous_sun_lower_bound=bool(cont_sun_lb[k]),
                continuous_earth_h=float(cont_earth[k]),
                continuous_earth_lower_bound=bool(cont_earth_lb[k]),
                sun_at_landing=bool(sun[i]),
                earth_at_landing=bool(earth[i]),
                sun_el_at_landing_deg=float(sun_el[k]),
                earth_el_at_landing_deg=float(earth_el[i]),
                mean_power_horizontal=float(p_h[k]),
                mean_power_tracking=float(p_t[k]),
            )
        )
    return AltDateResult(
        site_id=vis.site_id,
        earliest=e0,
        latest=e1,
        mission_duration_h=float(mission_duration_h),
        constraints=c,
        candidates=cands,
        n_evaluated=int(idx.size),
        n_feasible=int(feas.size),
        rejected_by=rejected,
    )


def find_alternative_dates_for_site(
    site: Site,
    earliest: str | np.datetime64,
    latest: str | np.datetime64,
    mission_duration_h: float,
    provider: EphemerisProvider,
    horizons: HorizonSpec = "flat",
    constraints: DateConstraints | None = None,
    step_minutes: float = 60,
    options: AnalysisOptions | None = None,
    max_results: int = 10,
) -> AltDateResult:
    """Compute ephemeris + visibility for one site and run find_alternative_dates.

    The series spans [earliest, latest + max(mission, continuous constraints) + 1 step), rounded
    up to whole steps.
    """
    c = constraints or DateConstraints()
    opt = options or AnalysisOptions()
    e0, e1 = parse_utc(earliest), parse_utc(latest)
    step_s = int(round(step_minutes * 60))
    extra_h = max(mission_duration_h, c.min_continuous_sun_h, c.min_continuous_earth_h)
    span = int((e1 - e0).astype(np.int64)) + int(np.ceil(extra_h * 3600.0)) + step_s
    span = int(np.ceil(span / step_s)) * step_s
    times = make_times(e0, e0 + np.timedelta64(span, "s"), step_minutes)
    mask = resolve_mask(site, horizons, opt)
    sa = analyse_site(site, times, provider, mask, opt)
    return find_alternative_dates(sa.visibility, e0, e1, mission_duration_h, c, max_results)
