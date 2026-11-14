"""Visibility windows and metrics from boolean time series.

Sampling convention (documented in docs/OUTPUT_SPEC.md):
  * A series is sampled at UTC instants t_0 < t_1 < ... < t_{n-1} (datetime64[s]) with step dt.
  * Sample i represents the interval [t_i, t_{i+1}) (the last one [t_{n-1}, t_{n-1} + dt)).
    The covered time range is therefore [t_0, t_{n-1} + dt) == [start, end) of the request.
  * A window is a maximal run of equal state. start = t_i of its first sample, end = t_j of the
    first sample of the next window (or range end). Windows of one series TILE the covered range:
    no gaps, no overlaps, states alternate.
  * A real transition happened somewhere in (t_{j-1}, t_j]; window boundaries are therefore
    accurate to +- one step.
  * truncated_start: the window starts at the range start (its true start is unknown, earlier or
    equal); truncated_end: the window runs to the range end (its true end is unknown).
  * Percentages are time-weighted (each sample weighs its interval length).
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import numpy as np

_S_PER_H = 3600.0


@dataclass(frozen=True)
class Window:
    """A maximal run of constant state. Times are UTC datetime64[s]; end is exclusive."""

    start: np.datetime64
    end: np.datetime64
    duration_h: float
    state: bool
    truncated_start: bool
    truncated_end: bool
    start_index: int  # index of first sample
    end_index: int  # index one past the last sample

    def to_dict(self) -> dict:
        """JSON-friendly dict (times as ISO strings with trailing 'Z')."""
        d = asdict(self)
        d["start"] = iso_utc(self.start)
        d["end"] = iso_utc(self.end)
        d["duration_h"] = round(float(self.duration_h), 6)
        d["state"] = bool(self.state)
        return d


def iso_utc(t: np.datetime64) -> str:
    """ISO 8601 string 'YYYY-MM-DDTHH:MM:SSZ' of a datetime64 (seconds precision)."""
    return str(np.datetime64(t, "s")) + "Z"


def parse_utc(s: str | np.datetime64) -> np.datetime64:
    """Parse an ISO UTC string (optional trailing 'Z') into datetime64[s]."""
    if isinstance(s, np.datetime64):
        return s.astype("datetime64[s]")
    s = str(s).strip()
    if s.endswith("Z"):
        s = s[:-1]
    return np.datetime64(s, "s")


def _as_times(times_utc: np.ndarray) -> np.ndarray:
    t = np.asarray(times_utc)
    if t.dtype.kind != "M":
        raise TypeError("times_utc must be numpy datetime64")
    t = t.astype("datetime64[s]")
    if t.ndim != 1 or t.size == 0:
        raise ValueError("times_utc must be a non-empty 1-D array")
    if t.size > 1 and np.any(np.diff(t.astype(np.int64)) <= 0):
        raise ValueError("times_utc must be strictly increasing")
    return t


def infer_step_s(times_utc: np.ndarray, step_s: float | None = None) -> int:
    """Sampling step in seconds: ``step_s`` if given, else the median spacing of the times."""
    t = _as_times(times_utc)
    if step_s is not None:
        if step_s <= 0:
            raise ValueError("step_s must be > 0")
        return int(round(step_s))
    if t.size < 2:
        raise ValueError("cannot infer step from a single sample: pass step_s")
    return int(np.median(np.diff(t.astype(np.int64))))


def sample_weights_s(times_utc: np.ndarray, step_s: float | None = None) -> np.ndarray:
    """Interval length (s) represented by each sample: t_{i+1}-t_i, and step for the last one."""
    t = _as_times(times_utc).astype(np.int64)
    st = infer_step_s(times_utc, step_s)
    return np.append(np.diff(t), st).astype(float)


def range_end(times_utc: np.ndarray, step_s: float | None = None) -> np.datetime64:
    """Exclusive end of the covered range: t_{n-1} + step."""
    t = _as_times(times_utc)
    return t[-1] + np.timedelta64(infer_step_s(times_utc, step_s), "s")


def find_windows(times_utc: np.ndarray, flags: np.ndarray, step_s: float | None = None) -> list[Window]:
    """Split a boolean series into windows that tile [t_0, t_{n-1} + step) (see module docstring)."""
    t = _as_times(times_utc)
    f = np.asarray(flags)
    if f.dtype != bool:
        if f.dtype.kind in "iu" and np.all((f == 0) | (f == 1)):
            f = f.astype(bool)
        else:
            raise TypeError("flags must be boolean")
    if f.shape != t.shape:
        raise ValueError(f"flags shape {f.shape} != times shape {t.shape}")
    n = t.size
    end_t = range_end(t, step_s)
    change = np.flatnonzero(f[1:] != f[:-1]) + 1
    starts = np.concatenate([[0], change])
    ends = np.concatenate([change, [n]])
    out: list[Window] = []
    for i, j in zip(starts.tolist(), ends.tolist()):
        ws = t[i]
        we = t[j] if j < n else end_t
        out.append(
            Window(
                start=ws,
                end=we,
                duration_h=float((we - ws).astype(np.int64)) / _S_PER_H,
                state=bool(f[i]),
                truncated_start=(i == 0),
                truncated_end=(j == n),
                start_index=int(i),
                end_index=int(j),
            )
        )
    return out


def longest_run_h(windows: list[Window], state: bool) -> tuple[float, bool]:
    """Longest window duration (h) with the given state, and whether that window is truncated.

    Returns (0.0, False) if no window has that state. Truncated -> the value is a lower bound.
    """
    best, trunc = 0.0, False
    for w in windows:
        if w.state == state and w.duration_h > best:
            best, trunc = w.duration_h, (w.truncated_start or w.truncated_end)
    return best, trunc


def pct_true(times_utc: np.ndarray, flags: np.ndarray, step_s: float | None = None) -> float:
    """Time-weighted percentage (0..100) of the covered range where flags is True."""
    w = sample_weights_s(times_utc, step_s)
    f = np.asarray(flags, dtype=bool)
    if f.shape != w.shape:
        raise ValueError("flags/times shape mismatch")
    return float(100.0 * np.sum(w[f]) / np.sum(w))


def compute_metrics(
    times_utc: np.ndarray,
    sun_visible: np.ndarray,
    earth_visible: np.ndarray,
    sun_el_deg: np.ndarray | None = None,
    power_horizontal: np.ndarray | None = None,
    power_tracking: np.ndarray | None = None,
    step_s: float | None = None,
) -> dict[str, float | int | bool | None]:
    """Summary metrics of one site over the covered range.

    Keys (units): pct_sun, pct_earth, pct_both, pct_sun_no_earth (percent, 0..100);
    longest_dark_h, longest_comms_gap_h, longest_sun_h, longest_earth_h (hours) and their
    *_truncated flags (True -> the run touches the range boundary, value is a lower bound);
    n_sun_windows, n_dark_windows, n_earth_windows, n_comms_gaps (counts of windows of that
    state, truncated ones included); mean_sun_el_lit_deg (time-weighted mean Sun elevation over
    samples with sun_visible, None if never lit); mean_power_horizontal, mean_power_tracking
    (time-weighted mean over the whole range, 0..1); duration_h (length of the range).
    """
    t = _as_times(times_utc)
    sv = np.asarray(sun_visible, dtype=bool)
    ev = np.asarray(earth_visible, dtype=bool)
    w = sample_weights_s(t, step_s)
    total = float(np.sum(w))
    sun_w = find_windows(t, sv, step_s)
    earth_w = find_windows(t, ev, step_s)
    ld, ld_t = longest_run_h(sun_w, False)
    lg, lg_t = longest_run_h(earth_w, False)
    ls, ls_t = longest_run_h(sun_w, True)
    le, le_t = longest_run_h(earth_w, True)
    m: dict[str, float | int | bool | None] = {
        "duration_h": total / _S_PER_H,
        "pct_sun": 100.0 * float(np.sum(w[sv])) / total,
        "pct_earth": 100.0 * float(np.sum(w[ev])) / total,
        "pct_both": 100.0 * float(np.sum(w[sv & ev])) / total,
        "pct_sun_no_earth": 100.0 * float(np.sum(w[sv & ~ev])) / total,
        "longest_dark_h": ld,
        "longest_dark_truncated": ld_t,
        "longest_comms_gap_h": lg,
        "longest_comms_gap_truncated": lg_t,
        "longest_sun_h": ls,
        "longest_sun_truncated": ls_t,
        "longest_earth_h": le,
        "longest_earth_truncated": le_t,
        "n_sun_windows": sum(1 for x in sun_w if x.state),
        "n_dark_windows": sum(1 for x in sun_w if not x.state),
        "n_earth_windows": sum(1 for x in earth_w if x.state),
        "n_comms_gaps": sum(1 for x in earth_w if not x.state),
        "mean_sun_el_lit_deg": None,
        "mean_power_horizontal": None,
        "mean_power_tracking": None,
    }
    if sun_el_deg is not None and np.any(sv):
        el = np.asarray(sun_el_deg, float)
        m["mean_sun_el_lit_deg"] = float(np.sum(w[sv] * el[sv]) / np.sum(w[sv]))
    if power_horizontal is not None:
        m["mean_power_horizontal"] = float(np.sum(w * np.asarray(power_horizontal, float)) / total)
    if power_tracking is not None:
        m["mean_power_tracking"] = float(np.sum(w * np.asarray(power_tracking, float)) / total)
    return m


# --------------------------------------------------------------------------------------------
# "Time until" queries
# --------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class NextEvent:
    """Answer of a 'time until' query from an instant.

    hours: hours from the query instant until the event (0 if the condition already holds,
        e.g. next_sunrise while lit); if ``lower_bound`` is True the event does not occur before
        the end of the series and ``hours`` is the time to the range end (a lower bound) and
        ``at`` is None.
    state_now: the flag value at the query instant.
    """

    hours: float
    at: np.datetime64 | None
    state_now: bool
    lower_bound: bool

    def to_dict(self) -> dict:
        return {
            "hours": round(float(self.hours), 6),
            "at": iso_utc(self.at) if self.at is not None else None,
            "state_now": bool(self.state_now),
            "lower_bound": bool(self.lower_bound),
        }


def _index_at(t: np.ndarray, when: np.datetime64, end_t: np.datetime64) -> int:
    if when < t[0] or when >= end_t:
        raise ValueError(f"instant {when} outside the covered range [{t[0]}, {end_t})")
    return int(np.searchsorted(t, when, side="right") - 1)


def _time_until_state(times_utc, flags, when, target: bool, step_s) -> NextEvent:
    t = _as_times(times_utc)
    f = np.asarray(flags, dtype=bool)
    end_t = range_end(t, step_s)
    w = parse_utc(when)
    k = _index_at(t, w, end_t)
    now = bool(f[k])
    if now == target:
        return NextEvent(0.0, w, now, False)
    nxt = np.flatnonzero(f[k + 1 :] == target)
    if nxt.size == 0:
        return NextEvent(float((end_t - w).astype(np.int64)) / _S_PER_H, None, now, True)
    at = t[k + 1 + int(nxt[0])]
    return NextEvent(float((at - w).astype(np.int64)) / _S_PER_H, at, now, False)


def time_until_sunset(times_utc, sun_visible, when, step_s: float | None = None) -> NextEvent:
    """Hours from ``when`` until the Sun is no longer visible (0 if already dark)."""
    return _time_until_state(times_utc, sun_visible, when, False, step_s)


def next_sunrise(times_utc, sun_visible, when, step_s: float | None = None) -> NextEvent:
    """Hours from ``when`` until the Sun is next visible (0 if already lit)."""
    return _time_until_state(times_utc, sun_visible, when, True, step_s)


def time_until_earthset(times_utc, earth_visible, when, step_s: float | None = None) -> NextEvent:
    """Hours from ``when`` until Earth is no longer visible (0 if already below the horizon)."""
    return _time_until_state(times_utc, earth_visible, when, False, step_s)


def next_earthrise(times_utc, earth_visible, when, step_s: float | None = None) -> NextEvent:
    """Hours from ``when`` until Earth is next visible (0 if already visible)."""
    return _time_until_state(times_utc, earth_visible, when, True, step_s)


def hours_until_change(times_utc: np.ndarray, flags: np.ndarray, step_s: float | None = None) -> np.ndarray:
    """For every sample: hours from t_i until the state changes (start of the next window).

    NaN where the current window is truncated at the range end (no change inside the series).
    Vectorised: one value per sample, float64.
    """
    t = _as_times(times_utc)
    wins = find_windows(t, flags, step_s)
    ti = t.astype(np.int64)
    out = np.full(t.size, np.nan)
    for w in wins:
        if w.truncated_end:
            continue
        sl = slice(w.start_index, w.end_index)
        out[sl] = (int(np.datetime64(w.end, "s").astype(np.int64)) - ti[sl]) / _S_PER_H
    return out


def hours_until_state(times_utc: np.ndarray, flags: np.ndarray, target: bool, step_s: float | None = None) -> np.ndarray:
    """Per sample: 0 where flags == target, else hours until the next sample with flags == target.

    NaN where no such sample exists before the range end. E.g. ``hours_until_state(t, sun, False)``
    is "hours until sunset" and ``hours_until_state(t, sun, True)`` is "hours until sunrise".
    """
    f = np.asarray(flags, dtype=bool)
    h = hours_until_change(times_utc, f, step_s)
    return np.where(f == target, 0.0, h)


def clean_float(x: float | None, nd: int = 6) -> float | None:
    """Round a float for JSON output; None / NaN -> None; inf raises."""
    if x is None:
        return None
    x = float(x)
    if math.isnan(x):
        return None
    if math.isinf(x):
        raise ValueError("infinite value in output")
    return round(x, nd)
