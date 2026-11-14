"""Method A ephemeris: JPL Horizons API (the challenge's named "Resources" ephemeris source).

Topocentric observer tables for an observer standing on the Moon:

    EPHEM_TYPE=OBSERVER, CENTER='coord@301', COORD_TYPE=GEODETIC,
    SITE_COORD='<E-lon deg>,<lat deg>,<alt km>'

Facts verified against live Horizons output (evidence in docs/HORIZONS_NOTES.md):
  * The Moon reference surface for coord@301 is a SPHERE of 1737.4 km
    ("Center radii : 1737.4, 1737.4, 1737.4 km"), so Horizons' "geodetic" latitude
    equals planetocentric latitude and the altitude is height above the 1737.4 km
    sphere, exactly the LOLA / lunarnav convention (types.py).
  * The body-fixed frame is the lunar Mean-Earth/polar-axis frame of DE421
    ("Center pole/equ : MEAN_ME (high precision)"), i.e. MOON_ME, the frame LOLA uses,
    valid A.D. 1550-2650 (outside that span Horizons silently falls back to IAU_MOON,
    which this module reports as an error).
  * Longitude is EAST-positive for the Moon; SITE_COORD order is E-lon, lat, alt(km).
  * Azimuth is clockwise from north (N=0, E=90), elevation is airless apparent
    (light time + gravitational deflection + stellar aberration) relative to the plane
    perpendicular to the local radial of the reference sphere - identical to types.py.
  * QUANTITIES 4 (az/el), 13 (angular diameter, arcsec), 20 (range "delta"; with
    RANGE_UNITS=KM in km, light-time aberrated apparent range).

Request strategy:
  * uniform grids  -> START_TIME/STOP_TIME + unitless STEP_SIZE='N' (N equal intervals),
    which reproduces any whole-second step exactly;
  * irregular sets -> TLIST of calendar strings, via GET when the URL stays below
    ``max_url_length`` (the server answers HTTP 502 above ~2000 characters), otherwise via
    the file-based API (POST to horizons_file.api); at most 10 000 TLIST entries/request;
  * long spans are chunked (Horizons refuses > 90 000 output lines);
  * every successful response is cached on disk under data/cache/horizons/, keyed by the
    SHA-256 of the canonical request (endpoint, parameters, TLIST).

All public times are UTC numpy ``datetime64[s]``; Horizons is queried with TIME_TYPE=UT
(UTC after 1962) and returns times with millisecond print resolution.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

import numpy as np
import requests

from lunarnav import config
from lunarnav.types import EphemerisSeries, Site

API_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
FILE_API_URL = "https://ssd.jpl.nasa.gov/api/horizons_file.api"

SUN_ID = "10"
EARTH_ID = "399"
MOON_CENTER = "coord@301"

#: Horizons refuses a table with more than this many output times.
HORIZONS_MAX_LINES = 90_000
#: Documented maximum number of TLIST entries in one request.
HORIZONS_MAX_TLIST = 10_000
#: Empirical: GET URLs of ~2.2 kB return HTTP 502, 1.3 kB work. Keep a margin.
DEFAULT_MAX_URL_LENGTH = 1800

_MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}
_DATE_RE = re.compile(
    r"^\s*(\d{4})-([A-Z][a-z]{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*$")

# Fixed observer-table settings shared by every request (see module docstring).
_BASE_PARAMS: dict[str, str] = {
    "format": "json",
    "OBJ_DATA": "NO",
    "MAKE_EPHEM": "YES",
    "EPHEM_TYPE": "OBSERVER",
    "CENTER": f"'{MOON_CENTER}'",
    "COORD_TYPE": "GEODETIC",
    "QUANTITIES": "'4,13,20'",
    "CSV_FORMAT": "YES",
    "TIME_TYPE": "UT",
    "TIME_DIGITS": "FRACSEC",
    "ANG_FORMAT": "DEG",
    "APPARENT": "AIRLESS",
    "EXTRA_PREC": "YES",
    "RANGE_UNITS": "KM",
    "SUPPRESS_RANGE_RATE": "YES",
}


class HorizonsError(RuntimeError):
    """Horizons returned an error, an unparsable table, or data violating the contract."""


# --------------------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------------------
@dataclass
class HorizonsTable:
    """One parsed Horizons observer table (the rows between $$SOE and $$EOE).

    Attributes:
        times_utc: datetime64[ms] print times (UT = UTC after 1962).
        columns: header name -> float array (NaN where Horizons printed ``n.a.``),
            e.g. ``"Azimuth_(a-app)"`` [deg], ``"Elevation_(a-app)"`` [deg],
            ``"Ang-diam"`` [arcsec], ``"delta"`` [km with RANGE_UNITS=KM, else au].
        solar_marker: per-row solar-presence character ('*' daylight, ' ' night; on Earth
            also 'C','N','A' twilight), or None if the column is absent.
        body_marker: per-row interfering-body presence character ('i' / 'm' up, ' ' down,
            or an r/e/t/s rise/max/transit/set event code that overrides it), or None.
        header: selected ``key : value`` header lines (e.g. "Center pole/equ").
    """

    times_utc: np.ndarray
    columns: dict[str, np.ndarray]
    solar_marker: np.ndarray | None
    body_marker: np.ndarray | None
    header: dict[str, str] = field(default_factory=dict)

    def __len__(self) -> int:
        return int(self.times_utc.shape[0])

    def column(self, *names: str) -> np.ndarray:
        """Return the first existing column among ``names`` (exact header match)."""
        for n in names:
            if n in self.columns:
                return self.columns[n]
        raise HorizonsError(f"none of the columns {names} in Horizons table; have {list(self.columns)}")


def _parse_time(s: str) -> np.datetime64:
    m = _DATE_RE.match(s)
    if m is None:
        raise HorizonsError(f"cannot parse Horizons time tag {s!r} (B.C. dates / JD tags unsupported)")
    y, mon, d, hh, mm, ss, frac = m.groups()
    if mon not in _MONTHS:
        raise HorizonsError(f"bad month in Horizons time tag {s!r}")
    ms = int(round(float("0." + frac) * 1000)) if frac else 0
    base = np.datetime64(f"{y}-{_MONTHS[mon]:02d}-{d}T{hh}:{mm}:{ss or '00'}", "ms")
    return base + np.timedelta64(ms, "ms")


def _parse_float(s: str) -> float:
    s = s.strip()
    if s in ("n.a.", ""):
        return math.nan
    try:
        return float(s)
    except ValueError as exc:
        raise HorizonsError(f"non-numeric Horizons field {s!r}") from exc


def _header_dict(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text[: text.find("$$SOE")].splitlines():
        m = re.match(r"^([A-Z][A-Za-z0-9 ./\-]+?)\s*:\s(.*)$", line)
        if m and not line.startswith("*"):
            key = m.group(1).strip()
            out.setdefault(key, m.group(2).strip())
    return out


def parse_horizons_csv(text: str) -> HorizonsTable:
    """Parse a Horizons OBSERVER table produced with CSV_FORMAT=YES.

    Robust to: blank solar/body presence columns (they are kept as characters, never
    shifted), r/e/t/s event codes, trailing commas, ``n.a.`` values, any column order
    (columns are located by their header names).

    Raises:
        HorizonsError: if the text holds no $$SOE/$$EOE block (typically a Horizons error
            message, which is included in the exception), or rows are malformed.
    """
    i0, i1 = text.find("$$SOE"), text.find("$$EOE")
    if i0 < 0 or i1 < 0 or i1 < i0:
        snippet = text.strip()[:1500]
        raise HorizonsError(f"Horizons response has no $$SOE..$$EOE ephemeris block:\n{snippet}")

    # Column header: the last non-empty, non-'****' line before $$SOE.
    header_line = None
    for line in reversed(text[:i0].splitlines()):
        st = line.strip()
        if st and not set(st) <= {"*"}:
            header_line = line
            break
    if header_line is None or "," not in header_line:
        raise HorizonsError("Horizons CSV column header line not found (was CSV_FORMAT=YES used?)")
    names = [h.strip() for h in header_line.split(",")]
    if not names[0].startswith("Date"):
        raise HorizonsError(f"unexpected first Horizons column {names[0]!r}; expected calendar date")

    blank_idx = [k for k, n in enumerate(names[1:], start=1) if n == "" and k < len(names) - 1]
    # Marker columns are the blank-named columns right after the date.
    marker_idx = [k for k in blank_idx if k <= 2]
    data_idx = {n: k for k, n in enumerate(names) if n}
    data_idx.pop(names[0])

    rows = [ln for ln in text[i0 + 5: i1].splitlines() if ln.strip()]
    n = len(rows)
    times = np.empty(n, dtype="datetime64[ms]")
    cols = {name: np.empty(n, dtype=float) for name in data_idx}
    solar = np.empty(n, dtype="<U1") if len(marker_idx) >= 1 else None
    body = np.empty(n, dtype="<U1") if len(marker_idx) >= 2 else None
    for r, line in enumerate(rows):
        f = line.split(",")
        if len(f) < len(names) - 1:
            raise HorizonsError(f"Horizons row has {len(f)} fields, header has {len(names)}: {line!r}")
        times[r] = _parse_time(f[0])
        if solar is not None:
            solar[r] = f[marker_idx[0]].strip()[:1] or " "
        if body is not None:
            body[r] = f[marker_idx[1]].strip()[:1] or " "
        for name, k in data_idx.items():
            cols[name][r] = _parse_float(f[k])
    return HorizonsTable(times, cols, solar, body, _header_dict(text))


# --------------------------------------------------------------------------------------
# Request planning
# --------------------------------------------------------------------------------------
def format_utc(t: np.datetime64) -> str:
    """'YYYY-MM-DD HH:MM:SS' calendar string accepted by Horizons (UT)."""
    return str(np.datetime64(t, "s")).replace("T", " ")


def site_coord_string(lat_deg: float, lon_deg: float, height_above_sphere_m: float) -> str:
    """SITE_COORD value for coord@301: 'E-lon(deg),lat(deg),alt(km above 1737.4 km sphere)'."""
    if not (-90.0 <= lat_deg <= 90.0):
        raise ValueError(f"latitude {lat_deg} outside [-90, 90] deg")
    if not math.isfinite(lon_deg) or not math.isfinite(height_above_sphere_m):
        raise ValueError("longitude and height must be finite")
    lon = float(np.mod(lon_deg, 360.0))
    return f"'{lon:.9f},{lat_deg:.9f},{height_above_sphere_m / 1000.0:.6f}'"


@dataclass(frozen=True)
class RequestChunk:
    """One Horizons request worth of times: either a uniform span or an explicit TLIST."""

    times: np.ndarray  # datetime64[s], sorted unique
    uniform: bool

    def time_params(self) -> tuple[dict[str, str], list[str] | None]:
        """(span parameters, TLIST strings or None)."""
        if self.uniform:
            return ({"START_TIME": f"'{format_utc(self.times[0])}'",
                     "STOP_TIME": f"'{format_utc(self.times[-1])}'",
                     "STEP_SIZE": f"'{len(self.times) - 1}'"}, None)
        return ({"TLIST_TYPE": "CAL"}, [format_utc(t) for t in self.times])


def _is_uniform(t: np.ndarray) -> bool:
    if t.size < 3:
        return t.size == 2
    d = np.diff(t.astype("int64"))
    return bool(np.all(d == d[0]) and d[0] > 0)


def plan_chunks(times_sorted_unique: np.ndarray, max_points: int) -> list[RequestChunk]:
    """Split sorted unique datetime64[s] times into Horizons requests.

    Uniform grids become START/STOP/STEP chunks of <= max_points points (a 1-point
    remainder becomes a TLIST). Irregular sets become TLIST chunks of
    <= min(max_points, 10000) points.
    """
    t = times_sorted_unique
    if t.size == 0:
        return []
    if max_points < 2:
        raise ValueError("max_points must be >= 2")
    out: list[RequestChunk] = []
    if _is_uniform(t):
        for i in range(0, t.size, max_points):
            c = t[i: i + max_points]
            out.append(RequestChunk(c, uniform=c.size >= 2))
        return out
    step = min(max_points, HORIZONS_MAX_TLIST)
    for i in range(0, t.size, step):
        out.append(RequestChunk(t[i: i + step], uniform=False))
    return out


def _as_utc_seconds(times_utc: np.ndarray | Sequence) -> np.ndarray:
    t = np.asarray(times_utc)
    if t.ndim != 1:
        raise ValueError(f"times_utc must be 1-D, got shape {t.shape}")
    if not np.issubdtype(t.dtype, np.datetime64):
        t = t.astype("datetime64[s]")
    ts = t.astype("datetime64[s]")
    if np.any(np.isnat(ts)):
        raise ValueError("times_utc contains NaT")
    if not np.array_equal(ts.astype(t.dtype), t):
        raise ValueError("times_utc has sub-second precision; the contract is datetime64[s]")
    return ts


# --------------------------------------------------------------------------------------
# HTTP client with disk cache
# --------------------------------------------------------------------------------------
class HorizonsClient:
    """Polite, caching HTTP client for the Horizons API.

    TLIST transport: "auto" = GET while the URL is <= max_url_length, else POST to the
    file API; "get" = always GET (the provider then batches TLISTs so each URL fits);
    "post" = always the file API.

    Attributes:
        http_calls: number of HTTP requests actually sent (cache hits excluded).
        cache_hits: number of requests answered from the disk cache.
    """

    def __init__(self, cache_dir: str | Path | None = None, *, timeout_s: float = 300.0,
                 max_retries: int = 5, min_interval_s: float = 0.5,
                 max_url_length: int = DEFAULT_MAX_URL_LENGTH, offline: bool = False,
                 tlist_transport: str = "auto", session: requests.Session | None = None) -> None:
        if tlist_transport not in ("auto", "get", "post"):
            raise ValueError("tlist_transport must be 'auto', 'get' or 'post'")
        self.tlist_transport = tlist_transport
        self.cache_dir = Path(cache_dir) if cache_dir is not None else config.cache_dir("horizons")
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.timeout_s = timeout_s
        self.max_retries = max_retries
        self.min_interval_s = min_interval_s
        self.max_url_length = max_url_length
        self.offline = offline
        self.session = session or requests.Session()
        self.session.headers.setdefault("User-Agent", "lunarnav/0.1 (python-requests)")
        self.http_calls = 0
        self.cache_hits = 0
        self._last_request = 0.0

    # -- cache -------------------------------------------------------------------------
    @staticmethod
    def cache_key(params: dict[str, str], tlist: list[str] | None) -> str:
        """SHA-256 of the canonical request (transport-independent: GET and POST share it)."""
        canon = json.dumps({"api": API_URL, "params": sorted(params.items()), "tlist": tlist},
                           separators=(",", ":"), ensure_ascii=True)
        return hashlib.sha256(canon.encode("ascii")).hexdigest()

    def _cache_path(self, key: str) -> Path:
        return self.cache_dir / f"{key}.txt"

    def _write_cache(self, key: str, text: str, params: dict[str, str], n_tlist: int) -> None:
        path = self._cache_path(key)
        tmp = path.with_suffix(f".tmp{os.getpid()}")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
        meta = {"params": params, "n_tlist": n_tlist, "fetched_unix": time.time()}
        path.with_suffix(".json").write_text(json.dumps(meta, indent=1), encoding="utf-8")

    # -- transport ---------------------------------------------------------------------
    def _throttle(self) -> None:
        dt = time.monotonic() - self._last_request
        if dt < self.min_interval_s:
            time.sleep(self.min_interval_s - dt)
        self._last_request = time.monotonic()

    def get_url_length(self, params: dict[str, str], tlist: list[str] | None) -> int:
        """Length of the GET URL this request would need."""
        p = dict(params)
        if tlist is not None:
            p["TLIST"] = " ".join(f"'{s}'" for s in tlist)
        req = requests.Request("GET", API_URL, params=p).prepare()
        return len(req.url or "")

    def _send(self, params: dict[str, str], tlist: list[str] | None) -> str:
        if self.offline:
            raise HorizonsError("HorizonsClient is offline and the request is not cached")
        too_long = tlist is not None and self.get_url_length(params, tlist) > self.max_url_length
        if too_long and self.tlist_transport == "get":
            raise HorizonsError(f"TLIST GET URL longer than {self.max_url_length} chars; batch it")
        use_post = tlist is not None and (self.tlist_transport == "post" or too_long)
        last_exc: Exception | None = None
        for attempt in range(self.max_retries):
            self._throttle()
            try:
                self.http_calls += 1
                if use_post:
                    lines = ["!$$SOF"] + [f"{k}={v}" for k, v in params.items() if k != "format"]
                    lines += ["TLIST="] + [f"'{s}'" for s in (tlist or [])]
                    r = self.session.post(FILE_API_URL, data={"format": "json"},
                                          files={"input": ("input.txt", "\n".join(lines) + "\n")},
                                          timeout=self.timeout_s)
                else:
                    p = dict(params)
                    if tlist is not None:
                        p["TLIST"] = " ".join(f"'{s}'" for s in tlist)
                    r = self.session.get(API_URL, params=p, timeout=self.timeout_s)
                if r.status_code in (429, 500, 502, 503, 504):
                    last_exc = HorizonsError(f"HTTP {r.status_code} from Horizons")
                else:
                    try:
                        payload = r.json()
                    except ValueError as exc:
                        raise HorizonsError(f"HTTP {r.status_code}: non-JSON reply {r.text[:300]!r}") from exc
                    if "error" in payload:
                        raise HorizonsError(f"Horizons error: {payload['error']}")
                    if r.status_code != 200:
                        raise HorizonsError(f"HTTP {r.status_code}: {str(payload)[:500]}")
                    return str(payload.get("result", ""))
            except (requests.ConnectionError, requests.Timeout) as exc:
                last_exc = exc
            time.sleep(min(60.0, 2.0 * 2 ** attempt))
        raise HorizonsError(f"Horizons request failed after {self.max_retries} attempts: {last_exc}")

    def fetch(self, params: dict[str, str], tlist: list[str] | None = None) -> str:
        """Return the Horizons result text for this request, from cache when available.

        Only responses that contain a complete $$SOE..$$EOE block are cached; Horizons
        error texts raise HorizonsError and are never cached.
        """
        key = self.cache_key(params, tlist)
        path = self._cache_path(key)
        if path.exists():
            self.cache_hits += 1
            return path.read_text(encoding="utf-8")
        text = self._send(params, tlist)
        if "$$SOE" not in text or "$$EOE" not in text:
            raise HorizonsError(f"Horizons returned no ephemeris:\n{text.strip()[:1500]}")
        self._write_cache(key, text, params, 0 if tlist is None else len(tlist))
        return text


# --------------------------------------------------------------------------------------
# Provider
# --------------------------------------------------------------------------------------
@dataclass
class PresenceMarkers:
    """Horizons' own visibility flags for one site (from the Sun-target table).

    sun_daylight: True where Horizons prints '*' = solar UPPER LIMB on/above the
        airless horizon of the 1737.4 km SPHERE (no terrain!).
    earth_up: True where the interfering-body marker is 'i' (Earth upper limb above the
        spherical horizon), False for ' '; NaN-like ``earth_known`` False where an
        r/e/t/s event code (printed only for steps <= 30 min) hides the state.
    """

    site_id: str
    times_utc: np.ndarray
    sun_daylight: np.ndarray
    earth_up: np.ndarray
    earth_known: np.ndarray
    interferer: str
    raw_solar: np.ndarray
    raw_body: np.ndarray


@dataclass
class BodySeries:
    """Values for one target body aligned to the requested times (sorted unique order)."""

    times_utc: np.ndarray
    az_deg: np.ndarray
    el_deg: np.ndarray
    dist_km: np.ndarray
    ang_diam_arcsec: np.ndarray
    solar_marker: np.ndarray
    body_marker: np.ndarray
    header: dict[str, str]
    n_requests: int


class HorizonsProvider:
    """EphemerisProvider backed by the JPL Horizons API (method name ``"horizons"``).

    Args:
        cache_dir: response cache directory (default data/cache/horizons).
        max_points_per_request: chunk size; Horizons refuses > 90 000 lines. 20 000 keeps
            responses ~3 MB.
        max_url_length: GET URL limit for TLIST requests before switching to POST.
        offline: if True never touch the network (cache only).
        tlist_transport: "auto" | "get" | "post" policy for irregular time sets (HorizonsClient).
        client: inject a preconfigured HorizonsClient (tests).
    """

    name = "horizons"

    def __init__(self, cache_dir: str | Path | None = None, *, max_points_per_request: int = 20_000,
                 max_url_length: int = DEFAULT_MAX_URL_LENGTH, offline: bool = False,
                 tlist_transport: str = "auto", client: HorizonsClient | None = None) -> None:
        if not (2 <= max_points_per_request <= HORIZONS_MAX_LINES):
            raise ValueError(f"max_points_per_request must be in [2, {HORIZONS_MAX_LINES}]")
        self.max_points_per_request = max_points_per_request
        self.client = client or HorizonsClient(cache_dir, max_url_length=max_url_length, offline=offline,
                                               tlist_transport=tlist_transport)

    # -- low level ---------------------------------------------------------------------
    def body_params(self, target: str, lat_deg: float, lon_deg: float, height_m: float) -> dict[str, str]:
        p = dict(_BASE_PARAMS)
        p["COMMAND"] = f"'{target}'"
        p["SITE_COORD"] = site_coord_string(lat_deg, lon_deg, height_m)
        return p

    def fetch_body(self, target: str, lat_deg: float, lon_deg: float, height_above_sphere_m: float,
                   times_utc: np.ndarray) -> BodySeries:
        """Query one target body; returns rows for ``np.unique(times_utc)`` (sorted)."""
        t = np.unique(_as_utc_seconds(times_utc))
        base = self.body_params(target, lat_deg, lon_deg, height_above_sphere_m)
        parts: list[HorizonsTable] = []
        chunks = self._split_for_url(base, plan_chunks(t, self.max_points_per_request))
        for ch in chunks:
            span, tlist = ch.time_params()
            tab = parse_horizons_csv(self.client.fetch({**base, **span}, tlist))
            got = tab.times_utc
            want = ch.times.astype("datetime64[ms]")
            if got.shape != want.shape or np.any(np.abs((got - want).astype("int64")) > 1):
                raise HorizonsError(
                    f"Horizons times do not match requested grid for target {target}: requested "
                    f"{want.size} [{want[0]} .. {want[-1]}], got {got.size}"
                    + (f" [{got[0]} .. {got[-1]}]" if got.size else ""))
            parts.append(tab)
        if not parts:
            e = np.empty(0)
            return BodySeries(t, e, e, e, e, np.empty(0, "<U1"), np.empty(0, "<U1"), {}, 0)
        hdr = parts[0].header
        for p in parts:  # every chunk: the lunar frame could change inside a long span
            self._check_header(p.header, lat_deg, lon_deg, height_above_sphere_m)

        def cat(*names: str) -> np.ndarray:
            return np.concatenate([p.column(*names) for p in parts])

        def mk(attr: str) -> np.ndarray:
            arrs = [getattr(p, attr) if getattr(p, attr) is not None else np.full(len(p), " ", "<U1")
                    for p in parts]
            return np.concatenate(arrs)

        dist = cat("delta")
        if np.nanmin(dist) < 1000.0:  # Earth >= ~350 000 km, Sun ~1.5e8 km; au values are < 2
            raise HorizonsError("range column looks like au, expected km (RANGE_UNITS=KM)")
        out = BodySeries(t, cat("Azimuth_(a-app)"), cat("Elevation_(a-app)"), dist, cat("Ang-diam"),
                         mk("solar_marker"), mk("body_marker"), hdr, len(chunks))
        for nm, arr in (("az", out.az_deg), ("el", out.el_deg), ("dist", out.dist_km)):
            if np.any(~np.isfinite(arr)):
                raise HorizonsError(f"Horizons returned n.a. in {nm} for target {target}")
        return out

    def _split_for_url(self, base: dict[str, str], chunks: list[RequestChunk]) -> list[RequestChunk]:
        """With tlist_transport='get', halve TLIST chunks until each GET URL fits."""
        if self.client.tlist_transport != "get":
            return chunks
        out: list[RequestChunk] = []
        stack = list(reversed(chunks))
        while stack:
            ch = stack.pop()
            span, tlist = ch.time_params()
            if tlist is None or len(tlist) == 1 or                     self.client.get_url_length({**base, **span}, tlist) <= self.client.max_url_length:
                out.append(ch)
                continue
            h = len(ch.times) // 2
            stack.append(RequestChunk(ch.times[h:], uniform=False))
            stack.append(RequestChunk(ch.times[:h], uniform=False))
        return out

    @staticmethod
    def _check_header(hdr: dict[str, str], lat: float, lon: float, h_m: float) -> None:
        """Assert that Horizons used the sphere / MEAN_ME / site we asked for."""
        radii = hdr.get("Center radii", "")
        nums = [float(x) for x in re.findall(r"[-+]?\d+\.\d+|\d+", radii.split("km")[0])]
        if len(nums) < 3 or any(abs(r - config.MOON_RADIUS_KM) > 1e-6 for r in nums[:3]):
            raise HorizonsError(f"Horizons Moon radii {radii!r} != {config.MOON_RADIUS_KM} km sphere")
        frame = hdr.get("Center pole/equ", "")
        if "IAU_MOON" in frame or "ME" not in frame:
            raise HorizonsError(f"Horizons lunar frame is {frame!r}; expected MEAN_ME (A.D. 1550-2650 only)")
        geo = hdr.get("Center geodetic", "").split("{")[0]
        vals = [float(x) for x in geo.replace(" ", "").split(",") if x]
        if len(vals) == 3:
            dlon = (vals[0] - lon + 180.0) % 360.0 - 180.0
            if abs(dlon) > 1e-6 or abs(vals[1] - lat) > 1e-6 or abs(vals[2] - h_m / 1000.0) > 1e-5:
                raise HorizonsError(f"Horizons echoed site {vals} != requested ({lon}, {lat}, {h_m / 1000} km)")
        else:
            warnings.warn(f"could not verify Horizons site echo {geo!r}", stacklevel=3)

    # -- protocol ----------------------------------------------------------------------
    def compute(self, site: Site, times_utc: np.ndarray, height_above_sphere_m: float) -> EphemerisSeries:
        """Sun and Earth airless apparent az/el (deg) and apparent range (km) for the observer at
        (site.lat_deg, site.lon_deg, 1737.4 km + height_above_sphere_m), at exactly ``times_utc``.

        Times may be uniform, irregular, unsorted or repeated; the returned series has
        ``times_utc`` identical to the input (as datetime64[s]).
        meta keys: sun/earth_ang_diam_arcsec, sun_daylight_marker, earth_up_marker,
        horizons_header_sun / _earth, n_requests, http_calls, frame, site_coord.
        """
        t_req = _as_utc_seconds(times_utc)
        uniq, inv = np.unique(t_req, return_inverse=True)
        lat, lon = float(site.lat_deg), float(site.lon_deg)
        sun = self.fetch_body(SUN_ID, lat, lon, height_above_sphere_m, uniq)
        earth = self.fetch_body(EARTH_ID, lat, lon, height_above_sphere_m, uniq)
        if not (np.array_equal(sun.times_utc, uniq) and np.array_equal(earth.times_utc, uniq)):
            raise HorizonsError("internal time alignment failure")
        series = EphemerisSeries(
            site_id=site.id, method=self.name, times_utc=t_req.copy(),
            sun_az_deg=sun.az_deg[inv], sun_el_deg=sun.el_deg[inv], sun_dist_km=sun.dist_km[inv],
            earth_az_deg=earth.az_deg[inv], earth_el_deg=earth.el_deg[inv], earth_dist_km=earth.dist_km[inv],
            observer_height_m=float(height_above_sphere_m),
            meta={
                "source": "JPL Horizons API " + API_URL,
                "frame": sun.header.get("Center pole/equ", ""),
                "site_coord": site_coord_string(lat, lon, height_above_sphere_m),
                "ephemeris": sun.header.get("Target body name", ""),
                "sun_ang_diam_arcsec": sun.ang_diam_arcsec[inv],
                "earth_ang_diam_arcsec": earth.ang_diam_arcsec[inv],
                "sun_daylight_marker": sun.solar_marker[inv] == "*",
                "earth_up_marker": sun.body_marker[inv] == "i",
                "horizons_header_sun": sun.header,
                "horizons_header_earth": earth.header,
                "n_requests": sun.n_requests + earth.n_requests,
                "http_calls": self.client.http_calls,
            },
        )
        assert np.array_equal(series.times_utc, t_req)
        return series

    def daylight_markers(self, site: Site, times_utc: np.ndarray, height_above_sphere_m: float) -> PresenceMarkers:
        """Horizons' own Sun 'daylight' ('*') and Earth ('i') presence flags.

        They refer to the UPPER LIMB versus the airless horizon of the reference sphere
        (no terrain) and are useful only as a cross-check of the el + semidiameter rule.
        Uses the same (cached) Sun request as compute().
        """
        t_req = _as_utc_seconds(times_utc)
        uniq, inv = np.unique(t_req, return_inverse=True)
        sun = self.fetch_body(SUN_ID, float(site.lat_deg), float(site.lon_deg), height_above_sphere_m, uniq)
        raw_s, raw_b = sun.solar_marker[inv], sun.body_marker[inv]
        interferer = sun.header.get("Vis. interferer", "").split("(")[0].strip()
        return PresenceMarkers(site.id, t_req.copy(), raw_s == "*", raw_b == "i",
                               np.isin(raw_b, ["i", " "]), interferer, raw_s, raw_b)


__all__ = [
    "API_URL", "FILE_API_URL", "HorizonsClient", "HorizonsError", "HorizonsProvider", "HorizonsTable",
    "PresenceMarkers", "BodySeries", "RequestChunk", "parse_horizons_csv", "plan_chunks",
    "site_coord_string", "format_utc",
]
