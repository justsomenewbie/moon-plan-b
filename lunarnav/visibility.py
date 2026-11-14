"""Sun / Earth visibility rules against a (terrain) horizon.

Conventions (see lunarnav/types.py and docs/OUTPUT_SPEC.md):
  * All angles in degrees. Azimuth clockwise from local north [0, 360), elevation airless/apparent.
  * Ephemeris positions are for the body CENTER.
  * A horizon mask gives the elevation of the terrain horizon as a function of azimuth, as seen
    from the observer point (surface + mast); it can be negative (geometric dip / site on a peak).

Rules implemented here (one place, used by every pipeline):

Sun
  * Apparent semi-diameter  s = asin(R_sun / d)   (d = observer-Sun-center distance, km).
  * Visible fraction of the solar DISC above the terrain horizon, in [0, 1]. The horizon is treated
    as a straight horizontal line at the elevation of the horizon AT THE SUN'S CENTER AZIMUTH
    (the disc is ~0.53 deg wide; terrain slope across it is neglected). With
    h = sun_el - horizon_el (signed height of the disc center above the line) and r = s the
    fraction is the circular-segment area ratio
        f(h, r) = 1/2 + (h * sqrt(r^2 - h^2) + r^2 * asin(h / r)) / (pi * r^2)   for |h| < r,
        f = 1 for h >= r,  f = 0 for h <= -r.
    The small-angle (planar) approximation is used: error ~ (r in rad)^2 ~ 2e-5 relative. Limb
    darkening is neglected (geometric area fraction, not flux fraction).
  * sun_visible = fraction > 0, i.e. the UPPER LIMB is above the local horizon
    (sun_el + s > horizon_el). This is the same style of definition as the JPL Horizons
    solar-presence 'daylight' flag (upper limb on or above the horizon), except that the horizon
    here is the TERRAIN horizon (Horizons uses the reference-body horizon) and there is no refraction.
  * Power proxies (dimensionless, 0..1, relative to a fully exposed panel facing the Sun at the
    same Sun distance):
        power_horizontal = fraction * max(0, sin(sun_el))   - horizontal (flat-lying) panel;
        power_tracking   = fraction                          - Sun-tracking panel (normal follows
                           the Sun). For an azimuth-only tracking VERTICAL panel the exact factor is
                           fraction * cos(sun_el); at the poles |sun_el| < 1.6 deg so cos >= 0.9996
                           and the two are identical to 0.04 %.
    irradiance_tracking_wm2 = SOLAR_CONSTANT_WM2 * (AU / d)^2 * fraction  (W/m^2, tracking panel).

Earth
  * earth_clearance_deg = earth_el - horizon_el(at earth_az)   (Earth CENTER vs terrain horizon).
  * earth_visible = earth_clearance_deg > min_clearance_deg  (configurable 0..10 deg, default 0;
    a margin for antenna beam / multipath / local obstructions).
  * earth_fraction (informative): fraction of the Earth disc above the horizon, same formula with
    the Earth's apparent semi-diameter asin(R_earth / d).

Flat horizon
  * Without a DEM the horizon is the geometric horizon of a smooth sphere seen from a mast of
    height h above the local surface (surface height H above the 1737.4 km sphere):
        dip = acos((R + H) / (R + H + h)),   horizon_el = -dip   (all azimuths).
    For h = 2 m: dip = 0.0870 deg.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .config import (
    DEFAULT_AZ_STEP_DEG,
    DEFAULT_OBSERVER_HEIGHT_M,
    EARTH_RADIUS_KM,
    MOON_RADIUS_M,
    SUN_RADIUS_KM,
)
from .types import EphemerisSeries, HorizonMask

#: Astronomical unit, km (IAU 2012).
AU_KM = 149_597_870.7
#: Total solar irradiance at 1 AU, W/m^2 (Kopp & Lean 2011).
SOLAR_CONSTANT_WM2 = 1361.0
#: Allowed range of the Earth clearance margin, degrees.
MIN_CLEARANCE_RANGE_DEG = (0.0, 10.0)


# --------------------------------------------------------------------------------------------
# Elementary formulas
# --------------------------------------------------------------------------------------------
def semidiameter_deg(radius_km: float, dist_km: np.ndarray | float) -> np.ndarray:
    """Apparent angular semi-diameter (deg) of a sphere of radius ``radius_km`` at ``dist_km``.

    Exact: asin(R / d). Raises ValueError if any distance is not larger than the radius.
    """
    d = np.asarray(dist_km, dtype=float)
    if np.any(~np.isfinite(d)) or np.any(d <= radius_km):
        raise ValueError(f"distance must be finite and > body radius {radius_km} km")
    return np.degrees(np.arcsin(radius_km / d))


def sun_semidiameter_deg(dist_km: np.ndarray | float) -> np.ndarray:
    """Apparent solar semi-diameter (deg), ~0.2665 deg at 1 AU."""
    return semidiameter_deg(SUN_RADIUS_KM, dist_km)


def earth_semidiameter_deg(dist_km: np.ndarray | float) -> np.ndarray:
    """Apparent Earth (equatorial radius) semi-diameter (deg), ~0.95 deg at 384 400 km."""
    return semidiameter_deg(EARTH_RADIUS_KM, dist_km)


def disc_visible_fraction(
    center_el_deg: np.ndarray | float,
    horizon_el_deg: np.ndarray | float,
    semidiameter: np.ndarray | float,
) -> np.ndarray:
    """Fraction (0..1) of a uniform disc lying above a straight horizontal horizon line.

    Parameters are in degrees: disc-center elevation, horizon elevation at the disc azimuth and
    disc semi-diameter (> 0). Uses the circular-segment area formula (planar small-angle geometry):
    ``f = 1/2 + (h*sqrt(r^2-h^2) + r^2*asin(h/r)) / (pi r^2)`` with ``h = el - horizon``, clipped
    to 0 / 1 outside |h| < r. Broadcasts numpy-style.
    """
    el = np.asarray(center_el_deg, dtype=float)
    hz = np.asarray(horizon_el_deg, dtype=float)
    r = np.asarray(semidiameter, dtype=float)
    if np.any(~(r > 0)):
        raise ValueError("semi-diameter must be > 0")
    if np.any(~np.isfinite(el)) or np.any(~np.isfinite(hz)):
        raise ValueError("elevations must be finite")
    x = np.clip((el - hz) / r, -1.0, 1.0)  # normalised height of disc center above the line
    f = 0.5 + (x * np.sqrt(1.0 - x * x) + np.arcsin(x)) / np.pi
    return np.clip(f, 0.0, 1.0)


def flat_horizon_dip_deg(observer_height_m: float, surface_height_m: float = 0.0) -> float:
    """Geometric dip (deg, >= 0) of the horizon of a smooth sphere seen from a mast.

    ``dip = acos((R + H) / (R + H + h))`` with R = 1737.4 km, H = surface height above the sphere,
    h = mast height above the surface (m). The flat horizon elevation is ``-dip``.
    """
    if observer_height_m < 0:
        raise ValueError("observer (mast) height must be >= 0 m")
    rs = MOON_RADIUS_M + float(surface_height_m)
    return float(np.degrees(np.arccos(rs / (rs + float(observer_height_m)))))


def flat_horizon_mask(
    site_id: str,
    observer_height_m: float = DEFAULT_OBSERVER_HEIGHT_M,
    surface_height_m: float = 0.0,
    az_step_deg: float = DEFAULT_AZ_STEP_DEG,
) -> HorizonMask:
    """HorizonMask of a smooth sphere (no terrain): constant elevation ``-dip`` at all azimuths.

    ``radius_km`` is set to the distance to the geometric horizon, sqrt((R+H+h)^2 - (R+H)^2).
    """
    if not (0 < az_step_deg <= 90) or abs(360.0 / az_step_deg - round(360.0 / az_step_deg)) > 1e-9:
        raise ValueError("az_step_deg must divide 360")
    n = int(round(360.0 / az_step_deg))
    az = np.arange(n) * az_step_deg
    dip = flat_horizon_dip_deg(observer_height_m, surface_height_m)
    rs = MOON_RADIUS_M + surface_height_m
    dist_km = float(np.sqrt((rs + observer_height_m) ** 2 - rs**2) / 1000.0)
    return HorizonMask(
        site_id=site_id,
        az_deg=az,
        el_deg=np.full(n, -dip),
        method="flat",
        dem_source="none",
        radius_km=dist_km,
        observer_height_m=float(observer_height_m),
        surface_height_m=float(surface_height_m),
        meta={"dip_deg": dip},
    )


# --------------------------------------------------------------------------------------------
# Time series
# --------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class VisibilityOptions:
    """Options of the visibility rules.

    min_earth_clearance_deg: Earth center must be this many degrees above the terrain horizon to
        count as visible (0..10, default 0).
    observer_height_m: mast height above local surface (used only when building a flat horizon).
    """

    min_earth_clearance_deg: float = 0.0
    observer_height_m: float = DEFAULT_OBSERVER_HEIGHT_M

    def __post_init__(self) -> None:
        lo, hi = MIN_CLEARANCE_RANGE_DEG
        if not (lo <= self.min_earth_clearance_deg <= hi):
            raise ValueError(f"min_earth_clearance_deg must be in [{lo}, {hi}] deg")
        if self.observer_height_m < 0:
            raise ValueError("observer_height_m must be >= 0")


#: Column order of a visibility table (visibility.csv.gz). Units in docs/OUTPUT_SPEC.md.
VISIBILITY_COLUMNS: tuple[str, ...] = (
    "time_utc",
    "sun_az_deg",
    "sun_el_deg",
    "sun_dist_km",
    "sun_semidiam_deg",
    "horizon_el_sun_deg",
    "sun_clearance_deg",
    "sun_fraction",
    "sun_visible",
    "power_horizontal",
    "power_tracking",
    "irradiance_tracking_wm2",
    "earth_az_deg",
    "earth_el_deg",
    "earth_dist_km",
    "earth_semidiam_deg",
    "horizon_el_earth_deg",
    "earth_clearance_deg",
    "earth_fraction",
    "earth_visible",
    "both_visible",
)


@dataclass
class VisibilitySeries:
    """Per-time-step visibility of the Sun and Earth for one site (arrays of shape (n,)).

    Units: degrees, km, W/m^2; fractions/powers dimensionless 0..1; booleans as numpy bool.
    """

    site_id: str
    times_utc: np.ndarray
    sun_az_deg: np.ndarray
    sun_el_deg: np.ndarray
    sun_dist_km: np.ndarray
    sun_semidiam_deg: np.ndarray
    horizon_el_sun_deg: np.ndarray
    sun_clearance_deg: np.ndarray
    sun_fraction: np.ndarray
    sun_visible: np.ndarray
    power_horizontal: np.ndarray
    power_tracking: np.ndarray
    irradiance_tracking_wm2: np.ndarray
    earth_az_deg: np.ndarray
    earth_el_deg: np.ndarray
    earth_dist_km: np.ndarray
    earth_semidiam_deg: np.ndarray
    horizon_el_earth_deg: np.ndarray
    earth_clearance_deg: np.ndarray
    earth_fraction: np.ndarray
    earth_visible: np.ndarray
    both_visible: np.ndarray
    min_earth_clearance_deg: float = 0.0
    meta: dict = field(default_factory=dict)

    def __len__(self) -> int:
        return int(self.times_utc.shape[0])

    def columns(self) -> dict[str, np.ndarray]:
        """All columns in VISIBILITY_COLUMNS order (time_utc first)."""
        out: dict[str, np.ndarray] = {}
        for c in VISIBILITY_COLUMNS:
            out[c] = self.times_utc if c == "time_utc" else getattr(self, c)
        return out

    def slice(self, sl: slice) -> "VisibilitySeries":
        """Sub-series (numpy slice applied to every array)."""
        kw = {c: getattr(self, c)[sl] for c in VISIBILITY_COLUMNS if c != "time_utc"}
        return VisibilitySeries(
            site_id=self.site_id,
            times_utc=self.times_utc[sl],
            min_earth_clearance_deg=self.min_earth_clearance_deg,
            meta=dict(self.meta),
            **kw,
        )


def _check_ephemeris(eph: EphemerisSeries) -> None:
    n = len(eph)
    if eph.times_utc.dtype != np.dtype("datetime64[s]"):
        raise TypeError("EphemerisSeries.times_utc must be datetime64[s] (UTC)")
    for name in ("sun_az_deg", "sun_el_deg", "sun_dist_km", "earth_az_deg", "earth_el_deg", "earth_dist_km"):
        a = np.asarray(getattr(eph, name))
        if a.shape != (n,):
            raise ValueError(f"EphemerisSeries.{name} has shape {a.shape}, expected ({n},)")
        if not np.all(np.isfinite(a)):
            raise ValueError(f"EphemerisSeries.{name} contains non-finite values")
    if n > 1 and np.any(np.diff(eph.times_utc.astype(np.int64)) <= 0):
        raise ValueError("EphemerisSeries.times_utc must be strictly increasing")


def compute_visibility(
    eph: EphemerisSeries,
    mask: HorizonMask | None = None,
    options: VisibilityOptions | None = None,
) -> VisibilitySeries:
    """Apply the visibility rules (module docstring) to an ephemeris series and a horizon mask.

    ``mask=None`` uses a flat-sphere horizon with the geometric dip of ``options.observer_height_m``
    (surface height taken as 0 m above the sphere when unknown; the dip depends on it only at the
    1e-6 level).
    """
    opt = options or VisibilityOptions()
    _check_ephemeris(eph)
    if mask is None:
        mask = flat_horizon_mask(eph.site_id, opt.observer_height_m)
    if mask.az_deg.shape != mask.el_deg.shape or mask.az_deg.ndim != 1 or mask.az_deg.size < 2:
        raise ValueError("HorizonMask az_deg/el_deg must be 1-D arrays of equal length >= 2")
    if not np.all(np.isfinite(mask.el_deg)):
        raise ValueError("HorizonMask.el_deg contains non-finite values")

    sun_az = np.mod(np.asarray(eph.sun_az_deg, float), 360.0)
    sun_el = np.asarray(eph.sun_el_deg, float)
    sun_d = np.asarray(eph.sun_dist_km, float)
    earth_az = np.mod(np.asarray(eph.earth_az_deg, float), 360.0)
    earth_el = np.asarray(eph.earth_el_deg, float)
    earth_d = np.asarray(eph.earth_dist_km, float)

    sun_sd = sun_semidiameter_deg(sun_d)
    hz_sun = mask.at(sun_az)
    sun_frac = disc_visible_fraction(sun_el, hz_sun, sun_sd)
    sun_vis = sun_frac > 0.0
    p_h = sun_frac * np.maximum(0.0, np.sin(np.radians(sun_el)))
    p_t = sun_frac.copy()
    irr = SOLAR_CONSTANT_WM2 * (AU_KM / sun_d) ** 2 * sun_frac

    earth_sd = earth_semidiameter_deg(earth_d)
    hz_earth = mask.at(earth_az)
    clearance = earth_el - hz_earth
    earth_vis = clearance > opt.min_earth_clearance_deg
    earth_frac = disc_visible_fraction(earth_el, hz_earth, earth_sd)

    return VisibilitySeries(
        site_id=eph.site_id,
        times_utc=eph.times_utc,
        sun_az_deg=sun_az,
        sun_el_deg=sun_el,
        sun_dist_km=sun_d,
        sun_semidiam_deg=sun_sd,
        horizon_el_sun_deg=hz_sun,
        sun_clearance_deg=sun_el - hz_sun,
        sun_fraction=sun_frac,
        sun_visible=sun_vis,
        power_horizontal=p_h,
        power_tracking=p_t,
        irradiance_tracking_wm2=irr,
        earth_az_deg=earth_az,
        earth_el_deg=earth_el,
        earth_dist_km=earth_d,
        earth_semidiam_deg=earth_sd,
        horizon_el_earth_deg=hz_earth,
        earth_clearance_deg=clearance,
        earth_fraction=earth_frac,
        earth_visible=earth_vis,
        both_visible=sun_vis & earth_vis,
        min_earth_clearance_deg=opt.min_earth_clearance_deg,
        meta={
            "ephemeris_method": eph.method,
            "horizon_method": mask.method,
            "dem_source": mask.dem_source,
            "observer_height_above_sphere_m": eph.observer_height_m,
        },
    )
