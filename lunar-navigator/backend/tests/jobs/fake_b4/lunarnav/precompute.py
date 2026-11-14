"""FAKE lunarnav.precompute for the /tools/* tests: get_provider, get_dem, make_horizon_fn, covered_radius_km,
provider_config, DemCoverageError (no _fmt_column: the bridges then use their own rounding).

Behaviour is chosen by the site latitude:
  -11  provider / horizon raises RuntimeError mentioning a server path   -> provider_error (502)
  -12  sleeps 60 s                                                      -> timeout (504)
  -13  prints garbage on the REAL stdout and exits 0                    -> PYTHON_FAILED (502)
  -14  ZeroDivisionError (traceback, exit 1)                            -> PYTHON_FAILED (502)
  -15  ValueError                                                       -> value_error (422)
  -16  RuntimeError 'cannot open PGDA product' (PGDA offline)            -> capability (422)
  lat >= -60: outside the fake PGDA coverage (get_dem raises DemCoverageError)
Values: sun_az = (hours since 2026-01-01 * 15 + lon) mod 360 + 1/3, sun_el = lat / 100 + height / 1e6 + 1/7,
sun_dist = 1.5e8 + height / 3, earth_* = sun_* + 1 (dist + 2e5); horizon el = 0.1 * sin(az) + 1/7.
"""
from __future__ import annotations

import math
import os
import sys
import time

import numpy as np


class DemCoverageError(ValueError):
    pass


def _behave(lat: float) -> None:
    if lat == -11.0:
        raise RuntimeError(f"network down while reading {os.path.join(os.getcwd(), 'data', 'cache', 'x.bin')}")
    if lat == -12.0:
        time.sleep(60)
    if lat == -13.0:
        sys.__stdout__.write("this is not json\n")
        sys.__stdout__.flush()
        os._exit(0)
    if lat == -14.0:
        _ = 1 / 0
    if lat == -15.0:
        raise ValueError("fake: time outside the ephemeris")
    if lat == -16.0:  # lunarnav.terrain.pgda.PgdaDem without network (even with cached blocks)
        raise RuntimeError("cannot open PGDA product LDEM_FAKE at /vsicurl/https://pgda.gsfc.nasa.gov/fake.tif: Could not resolve host")


class _Eph:
    pass


class FakeProvider:
    def __init__(self, name: str) -> None:
        self.name = name
        self.flavour = "fake"

    def compute(self, site, times_utc, height_above_sphere_m):
        _behave(float(site.lat_deg))
        t = np.asarray(times_utc).astype("datetime64[s]")
        h = (t - np.datetime64("2026-01-01T00:00:00", "s")).astype(np.int64) / 3600.0
        e = _Eph()
        e.times_utc = t
        e.sun_az_deg = np.mod(h * 15.0 + site.lon_deg, 360.0) + 1.0 / 3.0
        e.sun_el_deg = np.full(t.shape, site.lat_deg / 100.0 + height_above_sphere_m / 1e6 + 1.0 / 7.0)
        e.sun_dist_km = np.full(t.shape, 1.5e8 + height_above_sphere_m / 3.0)
        e.earth_az_deg = np.mod(e.sun_az_deg + 1.0, 360.0)
        e.earth_el_deg = e.sun_el_deg + 1.0
        e.earth_dist_km = e.sun_dist_km + 2e5
        return _Series(e)


class _Series:
    def __init__(self, e):
        self.__dict__.update(e.__dict__)

    def __len__(self):
        return int(self.times_utc.shape[0])


def get_provider(name: str, **kwargs):
    return FakeProvider(name)


def provider_config(provider) -> dict:
    return {"name": provider.name, "flavour": provider.flavour}


class _Dem:
    name = "fake_bands"

    def height_at(self, lat, lon):
        return np.asarray([1000.0 + float(lat)])


def get_dem(name: str, site, label=None, path=None):
    _behave(float(site.lat_deg))
    if site.lat_deg >= -60.0:
        raise DemCoverageError(f"fake PGDA covers the south polar region only (site lat {site.lat_deg})")
    return _Dem()


class _Mask:
    pass


def make_horizon_fn(dem="none", method="raymarch", radius_km=150.0, az_step_deg=0.5, observer_height_m=2.0,
                    resolution_m=None, dem_label=None, dem_path=None, dem_fallback="error", near_exclusion_m="auto",
                    eq_row_min_distance=True):
    def fn(site):
        _behave(float(site.lat_deg))
        n = int(round(360.0 / az_step_deg))
        m = _Mask()
        m.az_deg = np.arange(n) * az_step_deg
        m.observer_height_m = float(observer_height_m)
        m.meta = {}
        flat = dem == "none" or method == "flat"
        if not flat and site.lat_deg >= -60.0:
            if dem_fallback == "error":
                raise DemCoverageError(f"site {site.id}: outside the fake PGDA coverage")
            flat = True
            m.meta["dem_fallback"] = "outside the fake PGDA coverage"
        if flat:
            m.method = "flat"
            m.el_deg = np.full(n, -0.05)
            m.dem_source = "none" if "dem_fallback" not in m.meta else f"none:outside-{dem}-coverage"
            m.radius_km = 2.5
            m.surface_height_m = site.height_m or 0.0
        else:
            m.method = method
            m.el_deg = 0.1 * np.sin(np.radians(m.az_deg)) + 1.0 / 7.0
            m.dem_source = f"fake:{dem}:{method}:r{radius_km:g}:ne{near_exclusion_m}:obs{observer_height_m:g}"
            m.radius_km = float(radius_km)
            m.surface_height_m = 1000.0 + site.lat_deg
            m.meta["near_exclusion_m"] = 0.0 if near_exclusion_m == "auto" else float(near_exclusion_m)
            m.meta["horizon_distance_km"] = np.where(np.arange(n) == 0, np.nan, np.full(n, radius_km / 3.0))
        return m

    return fn


def covered_radius_km(mask):
    return np.full(mask.az_deg.shape, float(mask.radius_km))
