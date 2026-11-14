"""Method B ephemeris: NAIF SPICE (spiceypy) topocentric apparent Sun/Earth positions on the Moon.

Independent of JPL Horizons (same underlying DE440 ephemeris, but computed locally with CSPICE, so
it cross-checks the Horizons request/parsing pipeline, the site-coordinate convention, the time
scales and the topocentric frame definition).

Conventions (see :mod:`lunarnav.types`):
  * input times: UTC ``datetime64[s]``; converted to ET (= TDB seconds past J2000) with
    ``ET = UTC_s + deltet(UTC_s, "UTC")`` using the naif0012 leap-second kernel;
  * observer: planetocentric lat / EAST lon on the sphere ``R = 1737.4 km + height`` expressed in the
    lunar body-fixed ``frame`` (default ``MOON_ME``, the LOLA frame);
  * aberration correction ``CN+S`` (converged Newtonian light time + stellar aberration, observer
    velocity including the lunar rotation of the surface point) - the "apparent" airless position,
    like Horizons "a-app".  FIX (validation, docs/VALIDATION.md): the default was ``LT+S``, whose
    single light-time iteration leaves a range error rho (v_r / c)^2 (Earth: up to 4.1 m with a
    half-month period vs Horizons); ``CN+S`` agrees with Horizons to 0.15 m (= DE440 vs DE441);
    directions differ by < 1e-4 arcsec between the two;
  * azimuth clockwise from local north (towards the body-fixed +Z pole along the meridian),
    elevation from the plane perpendicular to the radial (spherical) zenith;
  * distances: apparent (light-time corrected) observer-to-body-center range in km.

Two independent internal implementations are provided and must agree to < 1e-6 deg:
  * ``method="manual"``: ``spkcpo`` apparent position vector in the body-fixed frame, rotated into a
    local East-North-Up basis built here from the observer position vector;
  * ``method="azlcpo"``: CSPICE's own ``azlcpo`` (``azccw=False``, ``elplsz=True``), which builds the
    topocentric frame from the outward normal of the PCK reference ellipsoid (the Moon is the
    1737.4 km sphere in pck00011, so normal == radial).
"""
from __future__ import annotations

import time as _time

import numpy as np
import spiceypy as sp

from lunarnav import config
from lunarnav.ephem import kernels
from lunarnav.ephem.kernels import SPICE_LOCK
from lunarnav.types import EphemerisSeries, Site

_J2000_UTC = np.datetime64("2000-01-01T12:00:00", "s")
TARGETS = {"sun": "SUN", "earth": "EARTH"}


def site_position_km(lat_deg: float, lon_deg: float, height_above_sphere_m: float) -> np.ndarray:
    """Body-fixed Cartesian position (km) of a point at planetocentric lat / east lon and
    ``height_above_sphere_m`` metres above the 1737.4 km reference sphere."""
    if not -90.0 <= lat_deg <= 90.0:
        raise ValueError(f"latitude {lat_deg} out of [-90, 90]")
    r = config.MOON_RADIUS_KM + height_above_sphere_m / 1000.0
    la, lo = np.radians(lat_deg), np.radians(lon_deg)
    return r * np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])


def enu_basis(pos_km: np.ndarray, lon_deg: float | None = None) -> np.ndarray:
    """Rows = unit East, North, Up vectors (body-fixed) at ``pos_km`` for a spherical body.

    Up is the radial direction; East = Z x Up normalised (= (-sin lon, cos lon, 0)); North =
    Up x East (points to the +Z pole along the meridian).

    ``lon_deg`` (east longitude of the site, degrees) is needed only at the exact pole
    (lat = +-90), where Z x Up vanishes: there East = (-sin lon, cos lon, 0) and North = Up x East,
    i.e. the azimuth origin is the meridian ``lon_deg`` - the convention of ``horizon.enu_basis``
    (terrain masks), the analytic provider and JPL Horizons.  FIX (integration review): this used
    to raise at the pole, so method B could not be cross-checked there.  Without ``lon_deg`` the
    pole still raises ValueError (the azimuth origin would be undefined).
    """
    up = np.asarray(pos_km, dtype=float) / np.linalg.norm(pos_km)
    east = np.cross([0.0, 0.0, 1.0], up)
    n = np.linalg.norm(east)
    if n < 1e-12:
        if lon_deg is None:
            raise ValueError("azimuth undefined at the exact pole (lat = +-90) without the site "
                             "longitude: pass lon_deg (azimuth origin = meridian lon_deg)")
        lo = np.radians(lon_deg)
        east = np.array([-np.sin(lo), np.cos(lo), 0.0])
    else:
        east /= n
    north = np.cross(up, east)
    return np.vstack([east, north, up])


def utc_to_et(times_utc: np.ndarray) -> np.ndarray:
    """UTC datetime64 array -> ET (TDB seconds past J2000), via the loaded leap-second kernel.

    ET - UTC = delta_AT + 32.184 s + periodic TDB-TT term (|.| < 1.7 ms), computed by ``deltet``.
    """
    t = np.asarray(times_utc).astype("datetime64[s]")
    if np.isnat(t).any():
        raise ValueError("times_utc contains NaT")
    u = (t - _J2000_UTC).astype(np.int64).astype(float)
    kernels.ensure_any_loaded()  # LSK needed; never switches an already-loaded set
    with SPICE_LOCK:
        # ET - UTC changes only at leap seconds (integer) plus a tiny periodic term: cheap loop.
        d = np.fromiter((sp.deltet(x, "UTC") for x in u), dtype=float, count=u.size)
    et = u + d
    # FIX (validation, see docs/VALIDATION.md): naif0012 has no model of 1960-1971 UTC ("rubber
    # seconds", TAI-UTC = offset + rate * (MJD - MJD0)); deltet silently uses TAI-UTC = 9 s before
    # 1972-01-01.  Use the official table (ERFA dat, same as astropy and JPL Horizons) there.
    # Example: Apollo 11 landing 1969-07-20T20:17:40 UTC has TAI-UTC = 7.5746 s, not 9 s (1.43 s).
    pre = (t >= np.datetime64("1960-01-01", "s")) & (t < np.datetime64("1972-01-01", "s"))
    if pre.any():
        import warnings

        import erfa

        tp = t[pre]
        days = tp.astype("datetime64[D]")
        ymd = [(int(str(x)[0:4]), int(str(x)[5:7]), int(str(x)[8:10])) for x in days]
        fd = (tp - days).astype(np.int64) / 86400.0
        with warnings.catch_warnings():  # ERFA flags pre-1972 dates as "dubious"; values are the
            warnings.simplefilter("ignore")  # official USNO/BIH TAI-UTC table (Explanatory Supplement)
            dat = np.array([erfa.dat(y, m, dd, f) for (y, m, dd), f in zip(ymd, fd)], dtype=float)
        tt = u[pre] + dat + 32.184
        with SPICE_LOCK:
            et[pre] = np.fromiter((sp.unitim(x, "TT", "TDB") for x in tt), dtype=float, count=tt.size)
    return et


class SpiceProvider:
    """EphemerisProvider using NAIF SPICE generic kernels (DE440 + lunar PA/ME orientation).

    Parameters
    ----------
    lunar_set : "de440" (default) or "de421" - which lunar orientation BPC/FK pair to load.
    frame : body-fixed frame of the site coordinates (default "MOON_ME", the LOLA frame;
        "MOON_PA" or "IAU_MOON" for comparisons).
    method : "manual" (spkcpo + own ENU) or "azlcpo" (CSPICE topocentric routine).
    abcorr : SPICE aberration correction, default "CN+S" (apparent, converged light time).
        "LT+S" (one light-time iteration, ~4 m Earth range error), "NONE" gives geometric.
    full_spk : load de440.bsp (1550-2650) instead of de440s.bsp (1849-2150).
    """

    name = "spice"

    def __init__(
        self,
        lunar_set: str = "de440",
        frame: str = "MOON_ME",
        method: str = "manual",
        abcorr: str = "CN+S",
        full_spk: bool = False,
    ) -> None:
        if method not in ("manual", "azlcpo"):
            raise ValueError(f"method must be 'manual' or 'azlcpo', got {method!r}")
        self.lunar_set = lunar_set
        self.frame = frame
        self.method = method
        self.abcorr = abcorr
        self.full_spk = full_spk
        self.kernel_paths = kernels.load_kernels(lunar_set, full_spk)
        with SPICE_LOCK:
            try:
                sp.pxform("J2000", frame, 0.0)
            except sp.utils.exceptions.SpiceyError as e:
                raise ValueError(f"frame {frame!r} not usable with kernel set {lunar_set!r}: {e}") from e

    # ---------------------------------------------------------------- core
    def _azel(self, target: str, et: np.ndarray, pos_km: np.ndarray,
              lon_deg: float | None = None) -> tuple[np.ndarray, ...]:
        """Return (az_deg, el_deg, dist_km) of ``target`` for each ET. Caller holds SPICE_LOCK.

        ``lon_deg`` = site east longitude, used for the azimuth origin at the exact pole.
        """
        n = et.size
        out = np.empty((n, 3))
        if self.method == "manual":
            basis = enu_basis(pos_km, lon_deg)
            vec = np.empty((n, 3))
            for i, e in enumerate(et):
                st, _lt = sp.spkcpo(target, e, self.frame, "OBSERVER", self.abcorr, pos_km, "MOON", self.frame)
                vec[i] = st[:3]
            enu = vec @ basis.T
            dist = np.linalg.norm(vec, axis=1)
            out[:, 0] = np.mod(np.degrees(np.arctan2(enu[:, 0], enu[:, 1])), 360.0)
            out[:, 1] = np.degrees(np.arcsin(np.clip(enu[:, 2] / dist, -1.0, 1.0)))
            out[:, 2] = dist
        else:
            for i, e in enumerate(et):
                azl, _lt = sp.azlcpo("ELLIPSOID", target, e, self.abcorr, False, True, pos_km, "MOON", self.frame)
                out[i] = (np.degrees(azl[1]), np.degrees(azl[2]), azl[0])
            out[:, 0] = np.mod(out[:, 0], 360.0)
        return out[:, 0], out[:, 1], out[:, 2]

    def compute(self, site: Site, times_utc: np.ndarray, height_above_sphere_m: float) -> EphemerisSeries:
        """Sun/Earth apparent az/el/dist for the observer at (site.lat, site.lon, R + height).

        ``height_above_sphere_m`` is the full observer height above the 1737.4 km sphere (surface +
        mast), in metres.
        """
        times = np.asarray(times_utc).astype("datetime64[s]")
        if times.ndim != 1:
            raise ValueError("times_utc must be 1-D")
        pos = site_position_km(site.lat_deg, site.lon_deg, float(height_above_sphere_m))
        if self.method == "azlcpo" and abs(site.lat_deg) >= 90.0:
            # CSPICE azlcpo builds its frame with TWOVEC(normal, +Z): SPICE(DEPENDENTVECTORS) at the pole
            raise ValueError("method='azlcpo' is undefined at the exact pole (CSPICE TWOVEC fails); "
                             "use method='manual' (azimuth origin = meridian Site.lon_deg)")
        t0 = _time.perf_counter()
        with SPICE_LOCK:
            kernels.load_kernels(self.lunar_set, self.full_spk)
            et = utc_to_et(times)
            sun = self._azel(TARGETS["sun"], et, pos, site.lon_deg)
            earth = self._azel(TARGETS["earth"], et, pos, site.lon_deg)
        return EphemerisSeries(
            site_id=site.id,
            method=self.name,
            times_utc=times,
            sun_az_deg=sun[0],
            sun_el_deg=sun[1],
            sun_dist_km=sun[2],
            earth_az_deg=earth[0],
            earth_el_deg=earth[1],
            earth_dist_km=earth[2],
            observer_height_m=float(height_above_sphere_m),
            meta={
                "kernels": [p.name for p in self.kernel_paths],
                "lunar_set": self.lunar_set,
                "frame": self.frame,
                "abcorr": self.abcorr,
                "impl": self.method,
                "observer_pos_km": pos.tolist(),
                "elapsed_s": _time.perf_counter() - t0,
            },
        )


def frame_offset_deg(et: float, frame_a: str = "MOON_ME", frame_b: str = "MOON_PA") -> float:
    """Total rotation angle (deg) between two body-fixed frames at ET (diagnostic)."""
    with SPICE_LOCK:
        m = sp.pxform(frame_a, frame_b, et)
        _axis, ang = sp.raxisa(m)
    return float(np.degrees(ang))
