"""FAKE lunarnav.analysis for the alt-dates bridge tests. Behaviour is chosen by max_results:
  41 -> sleeps 60 s (timeout test)     42 -> RuntimeError (traceback, exit 1)
  43 -> ValueError (bridge exit 2)     44 -> prints garbage to stdout
  otherwise -> one fixed candidate (echoes the request); every call appends a line to LUNARNAV_OUTPUT/altdates_calls.txt
"""
import os
import sys
import time


class DateConstraints:
    def __init__(self, **kw):
        self.kw = kw


class _Result:
    def __init__(self, d):
        self._d = d

    def to_dict(self):
        return self._d


def find_alternative_dates(vis, earliest, latest, mission_h, constraints, max_results=10):
    if max_results == 41:
        time.sleep(60)
    if max_results == 42:
        raise RuntimeError("fake crash")
    if max_results == 43:
        raise ValueError("fake: no sample in range")
    if max_results == 44:
        print("this is not json", flush=True)
        sys.exit(0)
    out_dir = os.environ.get("LUNARNAV_OUTPUT")
    if out_dir:
        with open(os.path.join(out_dir, "altdates_calls.txt"), "a", encoding="utf-8") as f:
            f.write(f"{vis.site_id} {earliest} {latest}\n")
    return _Result({
        "site_id": vis.site_id,
        "earliest_utc": earliest + "Z",
        "latest_utc": latest + "Z",
        "mission_duration_h": float(mission_h),
        "constraints": constraints.kw,
        "n_evaluated": 2,
        "n_feasible": 1,
        "rejected_by": {"min_sun_pct": 1},
        "candidates": [{
            "rank": 1, "landing_utc": earliest + "Z", "mission_end_utc": latest + "Z", "slip_h": 0.0, "score": 50.0,
            "sun_pct": 50.0, "earth_pct": 50.0, "both_pct": 25.0, "longest_dark_h": 3.0, "longest_comms_gap_h": 4.0,
            "continuous_sun_h": 5.0, "continuous_sun_lower_bound": False, "continuous_earth_h": 6.0,
            "continuous_earth_lower_bound": True, "sun_at_landing": True, "earth_at_landing": False,
            "sun_el_at_landing_deg": 1.5, "earth_el_at_landing_deg": -0.5, "mean_power_horizontal": 0.01,
            "mean_power_tracking": 0.4,
        }],
    })
