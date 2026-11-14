"""Shared contract between modules. Change only with care: every module depends on it.

Conventions (apply EVERYWHERE, tests must check them):
  * Time: UTC, numpy datetime64[s] arrays. Conversions to TDB/ET happen inside ephemeris providers.
  * Site coordinates: planetocentric latitude (deg, -90..90) and EAST longitude (deg, normalised
    to [0, 360)), in the Moon Mean-Earth/Polar-Axis frame (MOON_ME), which is the frame LOLA uses.
  * Heights: metres above the 1737.4 km reference sphere (LOLA convention).
  * Observer: site surface point (DEM height, or site.height_m if given) + observer_height_m.
  * Azimuth: degrees in [0, 360), measured CLOCKWISE from local north (towards the lunar north
    pole along the meridian): N=0, E=90, S=180, W=270  (same as JPL Horizons).
  * Elevation: degrees above the plane perpendicular to the local radial (sphere) zenith, airless
    (no refraction), apparent (light-time + stellar aberration) - same as Horizons "a-app".
  * Body positions are for the CENTER of the Sun / Earth.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

import numpy as np


@dataclass(frozen=True)
class Site:
    id: str
    name: str
    lat_deg: float
    lon_deg: float  # east longitude, [0, 360)
    origin: str = "custom"  # "catalog" | "custom"
    group: str = ""  # e.g. "south_pole", "apollo"
    height_m: float | None = None  # surface height above 1737.4 km sphere; None -> read from DEM
    source: str = ""  # citation for the coordinates
    note: str = ""


@dataclass
class EphemerisSeries:
    """Topocentric apparent positions of the Sun and Earth seen from one observer."""

    site_id: str
    method: str  # "horizons" | "spice" | "analytic"
    times_utc: np.ndarray  # datetime64[s], shape (n,)
    sun_az_deg: np.ndarray
    sun_el_deg: np.ndarray
    sun_dist_km: np.ndarray
    earth_az_deg: np.ndarray
    earth_el_deg: np.ndarray
    earth_dist_km: np.ndarray
    observer_height_m: float = 0.0  # height above the reference sphere actually used (surface + mast)
    meta: dict = field(default_factory=dict)

    def __len__(self) -> int:
        return int(self.times_utc.shape[0])


@runtime_checkable
class EphemerisProvider(Protocol):
    name: str

    def compute(self, site: Site, times_utc: np.ndarray, height_above_sphere_m: float) -> EphemerisSeries:
        """Return Sun/Earth az/el/dist for the observer at (site.lat, site.lon, R + height_above_sphere_m)."""
        ...


@dataclass
class HorizonMask:
    """Terrain horizon: highest elevation angle of terrain as a function of azimuth."""

    site_id: str
    az_deg: np.ndarray  # strictly increasing, covers [0, 360) uniformly
    el_deg: np.ndarray  # same shape; elevation angle of the terrain horizon (can be < 0)
    method: str  # e.g. "raymarch", "bruteforce", "flat"
    dem_source: str  # e.g. "trek:LRO_LOLA_DEM_SPole75_30mp_v04_EQ", "pgda:LDEM_80S_20MPP_ADJ", "none"
    radius_km: float
    observer_height_m: float  # mast height above local surface
    surface_height_m: float  # DEM surface height at the site above the 1737.4 km sphere
    meta: dict = field(default_factory=dict)

    def at(self, az_deg: np.ndarray | float) -> np.ndarray:
        """Horizon elevation at arbitrary azimuth(s), periodic linear interpolation."""
        az = np.mod(np.asarray(az_deg, dtype=float), 360.0)
        xp = np.concatenate([self.az_deg, [self.az_deg[0] + 360.0]])
        fp = np.concatenate([self.el_deg, [self.el_deg[0]]])
        return np.interp(az, xp, fp)


@dataclass
class DemPatch:
    """A square DEM window in the lunar south (or north) polar stereographic projection."""

    x_m: np.ndarray  # 1-D, easting of pixel centers, increasing
    y_m: np.ndarray  # 1-D, northing of pixel centers, increasing
    z_m: np.ndarray  # 2-D (len(y), len(x)), height above 1737.4 km sphere, NaN = nodata
    crs_wkt: str
    source: str
    resolution_m: float


@runtime_checkable
class DemSource(Protocol):
    name: str

    def height_at(self, lat_deg: np.ndarray | float, lon_deg: np.ndarray | float) -> np.ndarray:
        """Bilinear terrain height (m above 1737.4 km sphere)."""
        ...

    def patch(self, lat_deg: float, lon_deg: float, half_size_m: float) -> DemPatch:
        """Square window centered on the site (polar stereographic grid)."""
        ...
