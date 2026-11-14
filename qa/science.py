"""Independent QA oracle for piecewise-linear samples, never terrain physics."""
from datetime import datetime, timezone
from math import isfinite
import re


class ContractError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ContractError(message)


def number(value, low, high, label):
    require(type(value) in (int, float) and isfinite(value) and low <= value <= high,
            f"{label}: expected finite number in [{low}, {high}]")
    return value


def utc(value):
    require(isinstance(value, str) and re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z", value),
        "UTC must be ISO 8601 with seconds, optional milliseconds, and Z")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ContractError("UTC is not a real calendar instant") from exc


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def visible(elevation):
    if elevation is None:
        return None
    return number(elevation, -90, 90, "elevation") > 0


def interpolate_azimuth(a, b, fraction):
    number(a, 0, 360, "azimuth"); number(b, 0, 360, "azimuth")
    require(a < 360 and b < 360, "azimuth must be below 360")
    number(fraction, 0, 1, "fraction")
    delta = (b - a + 180) % 360 - 180
    require(abs(delta) != 180, "180-degree interpolation is ambiguous")
    return (a + fraction * delta) % 360


def intervals(samples, body, step_seconds):
    """Duration boundaries using linear crossing estimates. Never bridge unknowns.

    Half-open storage is for accounting: exact crossing point status still uses
    elevation > 0. A zero touch splits intervals, even when durations adjoin.
    """
    require(body in ("sun", "earth"), "unknown body")
    number(step_seconds, 1, 31557600, "sample step")
    result = []
    times = [utc(s["utc"]) for s in samples]
    require(all(b > a for a, b in zip(times, times[1:])), "timestamps must increase")
    for i, (left, right) in enumerate(zip(samples, samples[1:])):
        a, b = times[i:i + 2]
        if (b - a).total_seconds() != step_seconds:
            continue
        if left[body] is None or right[body] is None:
            continue
        x, y = left[body]["elevationDeg"], right[body]["elevationDeg"]
        visible(x); visible(y)
        if x <= 0 and y <= 0:
            continue
        start, end = a, b
        if x <= 0 < y:
            start = a + (b - a) * (-x / (y - x))
        elif x > 0 >= y:
            end = a + (b - a) * (-x / (y - x))
        if start >= end:
            continue
        # Only join through a strictly positive sample, never through zero.
        if result and result[-1][1] == start and x > 0:
            result[-1] = (result[-1][0], end)
        else:
            result.append((start, end))
    return result


def intersection(a, b):
    result = []
    i = j = 0
    while i < len(a) and j < len(b):
        start, end = max(a[i][0], b[j][0]), min(a[i][1], b[j][1])
        if start < end:
            result.append((start, end))
        if a[i][1] <= b[j][1]:
            i += 1
        else:
            j += 1
    return result


def contains(interval, timestamp):
    """Half-open accounting membership; not an instantaneous physics predicate."""
    return interval[0] <= timestamp < interval[1]


def compare_at(scenarios, timestamp):
    instant = utc(timestamp)
    require(len({s["siteId"] for s in scenarios}) == len(scenarios), "duplicate comparison site")
    result = {}
    for scenario in scenarios:
        require(utc(scenario["startUtc"]) <= instant < utc(scenario["endUtc"]),
                "comparison instant outside half-open window")
        matches = [s for s in scenario["samples"] if utc(s["utc"]) == instant]
        require(len(matches) <= 1, "duplicate comparison UTC")
        result[scenario["siteId"]] = matches[0] if matches else None
    return result
