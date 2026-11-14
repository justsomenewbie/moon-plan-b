"""Method C: independent, lower-precision analytic ephemeris (ERFA series + IAU WGCCRE lunar rotation).

Purpose
-------
Catch GROSS errors (sign, frame, azimuth convention, time scale, light-time handling) that the two
JPL-based methods (A: Horizons API, B: NAIF SPICE + DE440) could share because they rely on the same
JPL ephemeris and the same conventions.  Nothing in this module touches NAIF kernels, Horizons, or a
JPL DE file:

* Earth and Sun barycentric state: ERFA ``epv00`` (Bretagnon VSOP2000-fit series, SOFA/ERFA),
  BCRS axes (= ICRS).
* Moon geocentric state: ERFA ``moon98`` (Meeus' truncated ELP-2000/82 theory), GCRS axes.
* Lunar body-fixed frame: IAU_MOON from the IAU/IAG WGCCRE report (Archinal et al. 2011,
  "Report of the IAU Working Group on Cartographic Coordinates and Rotational Elements: 2009",
  Celest. Mech. Dyn. Astr. 109:101-135; unchanged in the 2015 report, Archinal et al. 2018).
  Pole right ascension/declination (alpha0, delta0) and prime meridian W including the 13 periodic
  terms E1..E13, implemented here in numpy.
* UTC -> TDB: astropy ``Time`` (ERFA leap-second table + ERFA ``dtdb``), geocentric TDB-TT (the
  difference to TDB at the Moon is a few microseconds, irrelevant).

Conventions (identical to :mod:`lunarnav.types`)
------------------------------------------------
* Input times UTC, ``datetime64[s]``.
* Site latitude planetocentric, longitude EAST in [0, 360) deg; height in metres above the
  1737.4 km sphere.  The site is placed in IAU_MOON with those numbers (IAU_MOON is the IAU's
  realisation of the Mean-Earth frame, see accuracy below).
* Azimuth clockwise from local north (towards the lunar north pole along the meridian), N=0, E=90,
  S=180, W=270, in [0, 360).  Elevation above the plane perpendicular to the radial (sphere) zenith.
  At an exact pole (|lat| = 90) "north" is taken along the meridian ``lon`` (the limit of the
  formula), i.e. azimuth then depends on the longitude you pass - as in SPICE/Horizons.
* Default aberration correction ``"LT+S"``: converged light time (target state at t - lt, from the
  observer position at t) plus first-order stellar aberration from the observer's barycentric
  velocity (Moon velocity; the 4.6 m/s rotation velocity of the surface is neglected, < 0.01 arcsec).
  This reproduces Horizons' airless "apparent" az/el.  ``"NONE"`` gives geometric directions.
* Distances: light-time corrected observer->target distance (km), like Horizons' ``delta``.

Expected accuracy (vs. Method A/B, which use DE440 + MOON_ME)
-------------------------------------------------------------
1. Frame: IAU_MOON vs MOON_ME (DE421 ME) differ by a time-dependent rotation of amplitude
   ~0.0051 deg (~155 m on the surface) because the IAU formula truncates the libration series
   (NAIF FK ``moon_080317.tf`` comments).  A rigid rotation of the site + its local ENU axes changes
   the az/el of a distant body by at most that angle -> <= ~0.005 deg in elevation and in azimuth
   (azimuth error grows as 1/cos(el); irrelevant at the low elevations of interest).
2. Moon position (moon98 vs ELP/MPP02, 1950-2100): RMS 2.9 arcsec / 6.1 km, worst 18.3 arcsec /
   31.7 km.  Seen from the Moon this shifts the Earth direction by <= 31.7 km / 356 000 km
   = 0.0051 deg (typically ~0.001 deg); the Sun direction by < 0.00002 deg.
3. epv00 (Earth/Sun): a few km -> negligible for directions; < 1e-7 relative in distance.
4. Light-time/aberration modelling: < 0.0001 deg.

Worst-case sum ~0.011 deg for the Earth and ~0.006 deg for the Sun.  Recommended cross-check
tolerance against Horizons/SPICE: :data:`CROSSCHECK_TOL_DEG` = 0.02 deg in elevation and in
azimuth * cos(el) (factor ~2 safety margin), and distance relative tolerance
:data:`CROSSCHECK_DIST_REL` = 2e-4 (Earth distance worst ~32 km / 356 000 km = 9e-5).
Anything larger than ~0.05 deg is a real bug (a sign/frame/time-scale error produces errors of
degrees: e.g. a 69 s UTC/TT mix-up moves the Sun by 0.009 deg but the Earth by ~0.01 deg only via
libration, while an azimuth convention flip or east/west longitude error produces tens of degrees).
"""
from __future__ import annotations

import warnings

import numpy as np
import erfa
from astropy.time import Time

from lunarnav.config import MOON_RADIUS_KM
from lunarnav.types import EphemerisSeries, Site

__all__ = [
    "AnalyticProvider",
    "CROSSCHECK_TOL_DEG",
    "CROSSCHECK_DIST_REL",
    "utc_to_tdb_jd",
    "iau_moon_angles",
    "iau_moon_matrix",
    "earth_sun_moon_bcrs",
    "site_vector_bf",
    "apparent_vectors_bf",
    "azel_from_bf",
    "sub_point_lonlat",
]

#: Recommended tolerance (deg) when cross-checking this provider against Horizons / SPICE
#: (elevation, and azimuth multiplied by cos(elevation)).  See module docstring for the budget.
CROSSCHECK_TOL_DEG = 0.02
#: Recommended relative tolerance for distances in cross-checks.
CROSSCHECK_DIST_REL = 2e-4

J2000_JD = 2451545.0
AU_KM = erfa.DAU / 1000.0  # astronomical unit, km (IAU 2012 exact)
C_KM_S = erfa.CMPS / 1000.0  # speed of light, km/s
_DAY_S = 86400.0

ABCORRS = ("LT+S", "LT", "NONE")

# --------------------------------------------------------------------------------------------
# IAU WGCCRE 2009 (= 2015) lunar rotation model.  d = TDB days since J2000, T = d / 36525.
# Angles E_i = a_i + b_i * d  (deg).
_E_A = np.array([125.045, 250.089, 260.008, 176.625, 357.529, 311.589, 134.963,
                 276.617, 34.226, 15.134, 119.743, 239.961, 25.053])
_E_B = np.array([-0.0529921, -0.1059842, 13.0120009, 13.3407154, 0.9856003, 26.4057084,
                 13.0649930, 0.3287146, 1.7484877, -0.1589763, 0.0036096, 0.1643573,
                 12.9590088])
# alpha0 = 269.9949 + 0.0031 T + sum(_RA_SIN * sin E)
_RA_SIN = np.array([-3.8787, -0.1204, 0.0700, -0.0172, 0.0, 0.0072, 0.0, 0.0, 0.0,
                    -0.0052, 0.0, 0.0, 0.0043])
# delta0 = 66.5392 + 0.0130 T + sum(_DEC_COS * cos E)
_DEC_COS = np.array([1.5419, 0.0239, -0.0278, 0.0068, 0.0, -0.0029, 0.0009, 0.0, 0.0,
                     0.0008, 0.0, 0.0, -0.0009])
# W = 38.3213 + 13.17635815 d - 1.4e-12 d^2 + sum(_W_SIN * sin E)
_W_SIN = np.array([3.5610, 0.1208, -0.0642, 0.0158, 0.0252, -0.0066, -0.0047, -0.0046,
                   0.0028, 0.0052, 0.0040, 0.0019, -0.0044])
_RA0, _RA1 = 269.9949, 0.0031
_DEC0, _DEC1 = 66.5392, 0.0130
_W0, _W1, _W2 = 38.3213, 13.17635815, -1.4e-12


def _as_utc_seconds(times_utc: np.ndarray) -> np.ndarray:
    """Validate and convert to a 1-D ``datetime64[s]`` array (raises on NaT / bad input)."""
    try:
        t = np.atleast_1d(np.asarray(times_utc, dtype="datetime64[s]"))
    except (TypeError, ValueError) as exc:  # pragma: no cover - message path
        raise TypeError(f"times_utc must be convertible to datetime64[s] (UTC): {exc}") from exc
    if t.ndim != 1:
        raise ValueError(f"times_utc must be 1-D, got shape {t.shape}")
    if t.size == 0:
        raise ValueError("times_utc is empty")
    if np.isnat(t).any():
        raise ValueError("times_utc contains NaT")
    return t


def utc_to_tdb_jd(times_utc: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """UTC ``datetime64[s]`` -> two-part TDB Julian date (jd1, jd2), days.

    Uses astropy/ERFA leap seconds (TT = TAI + 32.184 s, TAI - UTC from the ERFA table) and ERFA's
    geocentric TDB - TT series.
    """
    t = _as_utc_seconds(times_utc)
    with warnings.catch_warnings():
        # ERFA flags UTC dates more than ~5 years past its leap-second table release as "dubious
        # year".  The table is still applied (TAI-UTC = 37 s since 2017; no leap second announced),
        # which is exactly what Horizons and naif0012.tls do for future dates.
        warnings.filterwarnings("ignore", message=r".*dubious year.*", category=erfa.ErfaWarning)
        tdb = Time(t, format="datetime64", scale="utc").tdb
    return np.asarray(tdb.jd1, dtype=float), np.asarray(tdb.jd2, dtype=float)


def iau_moon_angles(d_tdb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """IAU 2009/2015 lunar rotational elements.

    Args:
        d_tdb: interval from J2000.0 TDB (JD 2451545.0) in days, any shape.

    Returns:
        (alpha0, delta0, W) in degrees: ICRF right ascension and declination of the lunar north
        pole and the prime-meridian angle (W NOT reduced modulo 360).
    """
    d = np.asarray(d_tdb, dtype=float)
    T = d / 36525.0
    e = np.deg2rad(np.mod(_E_A + _E_B * d[..., None], 360.0))  # (..., 13)
    s, c = np.sin(e), np.cos(e)
    alpha0 = _RA0 + _RA1 * T + s @ _RA_SIN
    delta0 = _DEC0 + _DEC1 * T + c @ _DEC_COS
    w = _W0 + _W1 * d + _W2 * d * d + s @ _W_SIN
    return alpha0, delta0, w


def iau_moon_matrix(d_tdb: np.ndarray) -> np.ndarray:
    """Rotation matrices ICRF -> IAU_MOON, shape (..., 3, 3): ``r_bf = M @ r_icrf``.

    M = R3(W) R1(90 deg - delta0) R3(90 deg + alpha0) with frame (passive) rotations R_i, the
    standard WGCCRE/SPICE construction.  The third row of M is the pole unit vector in ICRF.
    """
    a0, d0, w = iau_moon_angles(d_tdb)
    x = np.deg2rad(90.0 - d0)
    y = np.deg2rad(90.0 + a0)
    z = np.deg2rad(np.mod(w, 360.0))
    cx, sx, cy, sy, cz, sz = np.cos(x), np.sin(x), np.cos(y), np.sin(y), np.cos(z), np.sin(z)
    m = np.empty(np.shape(a0) + (3, 3))
    # Product of R3(z) R1(x) R3(y), expanded.
    m[..., 0, 0] = cz * cy - sz * cx * sy
    m[..., 0, 1] = cz * sy + sz * cx * cy
    m[..., 0, 2] = sz * sx
    m[..., 1, 0] = -sz * cy - cz * cx * sy
    m[..., 1, 1] = -sz * sy + cz * cx * cy
    m[..., 1, 2] = cz * sx
    m[..., 2, 0] = sx * sy
    m[..., 2, 1] = -sx * cy
    m[..., 2, 2] = cx
    return m


def _epv00_km(jd1: np.ndarray, jd2: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Earth (barycentric) and Sun (barycentric) position (km) and velocity (km/s), BCRS axes."""
    pvh, pvb = erfa.epv00(jd1, jd2)
    earth_p = pvb["p"] * AU_KM
    earth_v = pvb["v"] * (AU_KM / _DAY_S)
    sun_p = (pvb["p"] - pvh["p"]) * AU_KM
    sun_v = (pvb["v"] - pvh["v"]) * (AU_KM / _DAY_S)
    return earth_p, earth_v, sun_p, sun_v


def earth_sun_moon_bcrs(jd1: np.ndarray, jd2: np.ndarray) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """Barycentric (ICRS axes) states of Earth, Sun and Moon at TDB (jd1 + jd2).

    Returns:
        {"earth": (p, v), "sun": (p, v), "moon": (p, v)} with p in km and v in km/s, shape (n, 3).
        Moon = Earth (epv00) + geocentric Moon (moon98; GCRS axes are ICRS-aligned to 23 mas,
        relativistic GCRS/BCRS scale differences ~1e-8 are neglected = 4 mm).
    """
    jd1 = np.atleast_1d(np.asarray(jd1, dtype=float))
    jd2 = np.atleast_1d(np.asarray(jd2, dtype=float))
    earth_p, earth_v, sun_p, sun_v = _epv00_km(jd1, jd2)
    pvm = erfa.moon98(jd1, jd2)  # TT argument; TDB is fine (ERFA note 4)
    moon_p = earth_p + pvm["p"] * AU_KM
    moon_v = earth_v + pvm["v"] * (AU_KM / _DAY_S)
    return {"earth": (earth_p, earth_v), "sun": (sun_p, sun_v), "moon": (moon_p, moon_v)}


def site_vector_bf(lat_deg: float, lon_deg: float, height_above_sphere_m: float) -> np.ndarray:
    """Body-fixed (IAU_MOON) site position vector, km, for planetocentric lat / east lon (deg)."""
    if not np.isfinite([lat_deg, lon_deg, height_above_sphere_m]).all():
        raise ValueError("site lat/lon/height must be finite")
    if not -90.0 <= lat_deg <= 90.0:
        raise ValueError(f"latitude {lat_deg} outside [-90, 90] deg")
    r = MOON_RADIUS_KM + height_above_sphere_m / 1000.0
    if r <= 0:
        raise ValueError(f"height {height_above_sphere_m} m puts the observer below the Moon centre")
    la, lo = np.deg2rad(lat_deg), np.deg2rad(lon_deg)
    return r * np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])


def apparent_vectors_bf(
    jd1: np.ndarray,
    jd2: np.ndarray,
    obs_bf_km: np.ndarray,
    abcorr: str = "LT+S",
    bodies: tuple[str, ...] = ("sun", "earth"),
    lt_iterations: int = 3,
) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """Observer -> body vectors in IAU_MOON body-fixed axes.

    Args:
        jd1, jd2: two-part TDB Julian date of observation, shape (n,).
        obs_bf_km: observer position relative to the Moon centre in IAU_MOON, km, shape (3,).
            Use ``np.zeros(3)`` for the Moon centre.
        abcorr: "LT+S" (light time + stellar aberration, Horizons/SPICE apparent), "LT" or "NONE".
        bodies: subset of ("sun", "earth").
        lt_iterations: fixed-point light-time iterations (3 converges to < 1 mm for these bodies).

    The retarded target position is p(t - lt) ~= p(t) - v(t) lt (one ERFA evaluation instead of one
    per iteration).  Error of the linearisation: Earth lt ~1.3 s -> < 1 mm; Sun lt ~500 s and SSB
    acceleration ~2e-7 m/s^2 -> a lt^2 / 2 ~ 3 cm.  Both negligible.

    Returns:
        {body: (vec_bf_km (n, 3), dist_km (n,))}; ``vec_bf_km`` is the apparent direction scaled to
        the light-time corrected distance ``dist_km``.  The body-fixed rotation is evaluated at the
        observation epoch (the observer's frame at reception time), as in SPICE ``azlcpo``.
    """
    if abcorr not in ABCORRS:
        raise ValueError(f"abcorr must be one of {ABCORRS}, got {abcorr!r}")
    jd1 = np.atleast_1d(np.asarray(jd1, dtype=float))
    jd2 = np.atleast_1d(np.asarray(jd2, dtype=float))
    d = (jd1 - J2000_JD) + jd2
    m = iau_moon_matrix(d)  # (n,3,3) ICRF -> bf
    states = earth_sun_moon_bcrs(jd1, jd2)
    moon_p, moon_v = states["moon"]
    obs_icrf = moon_p + np.einsum("nji,j->ni", m, np.asarray(obs_bf_km, dtype=float))  # M^T @ r
    out: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for body in bodies:
        if body not in ("sun", "earth"):
            raise ValueError(f"unknown body {body!r} (expected 'sun' or 'earth')")
        tgt_p, tgt_v = states[body]
        rel = tgt_p - obs_icrf
        if abcorr != "NONE":
            for _ in range(lt_iterations):
                lt_s = np.linalg.norm(rel, axis=1) / C_KM_S
                rel = tgt_p - tgt_v * lt_s[:, None] - obs_icrf
        dist = np.linalg.norm(rel, axis=1)
        if abcorr == "LT+S":
            # First-order stellar aberration (SPICE stelab): p' = p + |p| v_obs / c.
            app = rel + dist[:, None] * (moon_v / C_KM_S)
            rel = app * (dist / np.linalg.norm(app, axis=1))[:, None]
        out[body] = (np.einsum("nij,nj->ni", m, rel), dist)
    return out


def azel_from_bf(vec_bf: np.ndarray, lat_deg: float, lon_deg: float) -> tuple[np.ndarray, np.ndarray]:
    """Topocentric azimuth (clockwise from north, [0, 360)) and elevation (deg) of body-fixed vectors.

    Local axes at planetocentric (lat, east lon): up = radial unit vector, east = d(up)/d(lon)
    normalised, north = up x east (points towards the north pole along the meridian).
    """
    la, lo = np.deg2rad(lat_deg), np.deg2rad(lon_deg)
    sla, cla, slo, clo = np.sin(la), np.cos(la), np.sin(lo), np.cos(lo)
    up = np.array([cla * clo, cla * slo, sla])
    east = np.array([-slo, clo, 0.0])
    north = np.array([-sla * clo, -sla * slo, cla])
    v = np.asarray(vec_bf, dtype=float)
    u, e, n = v @ up, v @ east, v @ north
    el = np.rad2deg(np.arctan2(u, np.hypot(e, n)))
    az = np.mod(np.rad2deg(np.arctan2(e, n)), 360.0)
    az = np.where(az >= 360.0, 0.0, az)  # guard -0.0 -> 360.0 rounding
    return az, el


def sub_point_lonlat(times_utc: np.ndarray, body: str, abcorr: str = "LT+S") -> tuple[np.ndarray, np.ndarray]:
    """Sub-body point (east lon [0, 360), planetocentric lat; deg) of 'sun' or 'earth' on the Moon,
    seen from the Moon centre, in IAU_MOON.  The sub-Earth point is the optical libration."""
    jd1, jd2 = utc_to_tdb_jd(times_utc)
    v, _ = apparent_vectors_bf(jd1, jd2, np.zeros(3), abcorr=abcorr, bodies=(body,))[body]
    lon = np.mod(np.rad2deg(np.arctan2(v[:, 1], v[:, 0])), 360.0)
    lat = np.rad2deg(np.arcsin(v[:, 2] / np.linalg.norm(v, axis=1)))
    return lon, lat


class AnalyticProvider:
    """Method C ephemeris provider (independent of JPL/NAIF): ERFA series + IAU_MOON rotation.

    Implements :class:`lunarnav.types.EphemerisProvider`.  Accuracy vs DE440/MOON_ME: <~0.011 deg
    (Earth) and <~0.006 deg (Sun) worst case; use :data:`CROSSCHECK_TOL_DEG` for cross-checks.

    Args:
        abcorr: "LT+S" (default, apparent as in the contract), "LT" or "NONE" (geometric).
        chunk: number of epochs processed per block (bounds memory for multi-year hourly runs).
    """

    name = "analytic"

    def __init__(self, abcorr: str = "LT+S", chunk: int = 200_000) -> None:
        if abcorr not in ABCORRS:
            raise ValueError(f"abcorr must be one of {ABCORRS}, got {abcorr!r}")
        if chunk < 1:
            raise ValueError("chunk must be >= 1")
        self.abcorr = abcorr
        self.chunk = int(chunk)

    def compute(self, site: Site, times_utc: np.ndarray, height_above_sphere_m: float) -> EphemerisSeries:
        """Sun/Earth topocentric az/el (deg) and distance (km) for the observer at
        (site.lat_deg, site.lon_deg, 1737.4 km + height_above_sphere_m) in IAU_MOON."""
        t = _as_utc_seconds(times_utc)
        obs_bf = site_vector_bf(float(site.lat_deg), float(site.lon_deg), float(height_above_sphere_m))
        jd1, jd2 = utc_to_tdb_jd(t)
        n = t.shape[0]
        res = {k: np.empty(n) for k in ("sun_az", "sun_el", "sun_d", "earth_az", "earth_el", "earth_d")}
        for i0 in range(0, n, self.chunk):
            sl = slice(i0, min(n, i0 + self.chunk))
            vecs = apparent_vectors_bf(jd1[sl], jd2[sl], obs_bf, abcorr=self.abcorr)
            for body in ("sun", "earth"):
                v, dist = vecs[body]
                az, el = azel_from_bf(v, site.lat_deg, site.lon_deg)
                res[f"{body}_az"][sl], res[f"{body}_el"][sl], res[f"{body}_d"][sl] = az, el, dist
        return EphemerisSeries(
            site_id=site.id,
            method=self.name,
            times_utc=t,
            sun_az_deg=res["sun_az"],
            sun_el_deg=res["sun_el"],
            sun_dist_km=res["sun_d"],
            earth_az_deg=res["earth_az"],
            earth_el_deg=res["earth_el"],
            earth_dist_km=res["earth_d"],
            observer_height_m=float(height_above_sphere_m),
            meta={
                "frame": "IAU_MOON (IAU WGCCRE 2009/2015 rotation model, E1..E13)",
                "ephemeris": "ERFA epv00 (Earth/Sun) + ERFA moon98 (Meeus/ELP2000-82 Moon)",
                "time_scale": "UTC -> TDB via astropy/ERFA",
                "abcorr": self.abcorr,
                "expected_accuracy_deg": {"sun": 0.006, "earth": 0.011},
                "crosscheck_tol_deg": CROSSCHECK_TOL_DEG,
                "crosscheck_dist_rel": CROSSCHECK_DIST_REL,
            },
        )
