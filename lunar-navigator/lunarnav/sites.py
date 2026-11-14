"""Landing-site catalog: verified coordinates with citations, plus user-defined (custom) sites.

Conventions (identical to :mod:`lunarnav.types`):
  * planetocentric latitude in degrees, [-90, 90];
  * EAST longitude in degrees, normalised to [0, 360);
  * frame MOON_ME (mean-Earth / polar-axis, as realised by the JPL DE421 ephemeris), which is the
    frame used by LOLA products, LROC NAC/WAC map products and the IAU/USGS Gazetteer;
  * heights in metres above the 1737.4 km reference sphere. Catalog sites carry ``height_m=None``
    so that the terrain module reads the surface height from the DEM; where a mission/LROC page
    published an elevation it is kept in ``extra['published_elevation_m']`` for cross-checks.

The catalog lives in ``lunarnav/catalog/sites.json``. Everything that does not fit
:class:`lunarnav.types.Site` (source URL, frame statement, accuracy description, region outline,
reference illumination values, landing times, ...) is stored per site under ``"extra"`` and is
available through :func:`get_site_extra`. Catalog-level validation facts (e.g. the Sun elevation at
the Apollo 11 landing) are available through :func:`get_validation_facts`.

Custom sites get a canonical id ``custom:<lat>:<lon>`` with exactly :data:`CUSTOM_ID_DECIMALS`
decimals (e.g. ``custom:-89.4500:222.6900``); their coordinates are rounded to that precision
(1e-4 deg = 3 m on the surface, far below any DEM resolution used here) so that id and coordinates
always agree and identical requests map to identical cache keys.
"""
from __future__ import annotations

import copy
import json
import math
import numbers
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from .types import Site

__all__ = [
    "ALLOWED_GROUPS",
    "ACCURACY_KINDS",
    "CUSTOM_ID_DECIMALS",
    "CatalogError",
    "catalog_path",
    "load_catalog",
    "load_catalog_document",
    "validate_catalog_document",
    "get_site",
    "get_site_extra",
    "custom_site",
    "custom_site_id",
    "parse_custom_id",
    "normalize_lon",
    "sites_in_group",
    "south_pole_sites",
    "apollo_sites",
    "far_side_sites",
    "reference_sites",
    "reference_illumination_pct",
    "get_validation_facts",
    "get_validation_fact",
]

#: Allowed values of :attr:`lunarnav.types.Site.group` for catalog sites.
ALLOWED_GROUPS: tuple[str, ...] = ("south_pole", "apollo", "far_side", "reference")

#: Allowed values of ``extra["accuracy"]["kind"]``.
#:  * ``landed_point``   - position of a lander measured on orbital images after landing;
#:  * ``target_point``   - pre-landing target / intended point (not where a vehicle came to rest);
#:  * ``region_centre``  - representative centre of an extended candidate region (tens of km);
#:  * ``feature_centre`` - IAU/USGS Gazetteer centre of a named feature (e.g. a crater floor);
#:  * ``reference_point``- a point published in the literature together with an illumination value.
ACCURACY_KINDS: tuple[str, ...] = ("landed_point", "target_point", "region_centre", "feature_centre", "reference_point")

#: Number of decimals of latitude/longitude used in canonical custom-site ids.
CUSTOM_ID_DECIMALS = 4

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_]*$")
_CUSTOM_ID_RE = re.compile(r"^custom:(-?\d{1,2}\.\d{%d}):(\d{1,3}\.\d{%d})$" % (CUSTOM_ID_DECIMALS, CUSTOM_ID_DECIMALS))
_SUPPORTED_SCHEMA_VERSIONS = (1,)

# Longitudes accepted as input to custom_site(): either convention (-180..180 or 0..360) plus a
# full turn of slack. Anything outside is almost certainly a unit/sign mistake and is rejected.
_LON_INPUT_MIN = -360.0
_LON_INPUT_MAX = 360.0


class CatalogError(ValueError):
    """The site catalog JSON does not satisfy the schema. ``problems`` lists every violation."""

    def __init__(self, problems: list[str], path: str | Path | None = None):
        self.problems = list(problems)
        self.path = str(path) if path is not None else None
        where = f" ({self.path})" if self.path else ""
        super().__init__(f"invalid site catalog{where}: " + "; ".join(self.problems))


# --------------------------------------------------------------------------------------------
# Coordinates
# --------------------------------------------------------------------------------------------

def _is_real_number(x: Any) -> bool:
    return isinstance(x, numbers.Real) and not isinstance(x, bool)


def normalize_lon(lon_deg: float) -> float:
    """Normalise a longitude in degrees (east-positive, any finite value) to [0, 360).

    West-negative inputs are converted: ``normalize_lon(-153.98) == 206.02`` (up to float rounding).
    ``-0.0`` and values that round to 360.0 map to ``0.0``.

    Raises:
        TypeError: if ``lon_deg`` is not a real number (bools are rejected).
        ValueError: if ``lon_deg`` is NaN or infinite.
    """
    if not _is_real_number(lon_deg):
        raise TypeError(f"longitude must be a real number in degrees, got {lon_deg!r}")
    lon = float(lon_deg)
    if not math.isfinite(lon):
        raise ValueError(f"longitude must be finite, got {lon_deg!r}")
    out = math.fmod(lon, 360.0)
    if out < 0.0:
        out += 360.0
    if out >= 360.0:  # e.g. -1e-17 + 360.0 == 360.0 in floating point
        out = 0.0
    return out + 0.0  # turns -0.0 into 0.0


def _check_lat(lat_deg: Any) -> float:
    if not _is_real_number(lat_deg):
        raise TypeError(f"latitude must be a real number in degrees, got {lat_deg!r}")
    lat = float(lat_deg)
    if not math.isfinite(lat) or not (-90.0 <= lat <= 90.0):
        raise ValueError(f"latitude must be planetocentric degrees in [-90, 90], got {lat_deg!r}")
    return lat + 0.0


def _check_lon_input(lon_deg: Any) -> float:
    if not _is_real_number(lon_deg):
        raise TypeError(f"longitude must be a real number in degrees, got {lon_deg!r}")
    lon = float(lon_deg)
    if not math.isfinite(lon) or not (_LON_INPUT_MIN <= lon <= _LON_INPUT_MAX):
        raise ValueError(
            f"longitude must be degrees in [{_LON_INPUT_MIN:g}, {_LON_INPUT_MAX:g}] "
            f"(east-positive; west-negative values are converted), got {lon_deg!r}"
        )
    return lon


def _round_custom(lat: float, lon: float) -> tuple[float, float]:
    """Round to the canonical-id precision, then re-normalise (359.99996 -> 0.0, -0.0 -> 0.0)."""
    lat_r = round(lat, CUSTOM_ID_DECIMALS) + 0.0
    lon_r = normalize_lon(round(normalize_lon(lon), CUSTOM_ID_DECIMALS))
    lon_r = round(lon_r, CUSTOM_ID_DECIMALS) + 0.0
    return lat_r, lon_r


def custom_site_id(lat_deg: float, lon_deg: float) -> str:
    """Canonical id ``custom:<lat>:<lon>`` (lat in [-90, 90], east lon in [0, 360), fixed decimals)."""
    lat, lon = _round_custom(_check_lat(lat_deg), _check_lon_input(lon_deg))
    return f"custom:{lat:.{CUSTOM_ID_DECIMALS}f}:{lon:.{CUSTOM_ID_DECIMALS}f}"


def parse_custom_id(site_id: str) -> tuple[float, float]:
    """Inverse of :func:`custom_site_id`. Returns (lat_deg, east_lon_deg).

    Only canonical ids are accepted (exact decimals, lon already in [0, 360)), so that one location
    has exactly one id.
    """
    m = _CUSTOM_ID_RE.match(site_id)
    if not m:
        raise ValueError(
            f"not a canonical custom site id: {site_id!r}; expected 'custom:<lat>:<lon>' with "
            f"{CUSTOM_ID_DECIMALS} decimals and east longitude in [0, 360), e.g. custom:-89.4500:222.6900"
        )
    lat = _check_lat(float(m.group(1)))
    lon = float(m.group(2))
    if not (0.0 <= lon < 360.0):
        raise ValueError(f"custom site id longitude must be in [0, 360): {site_id!r}")
    if custom_site_id(lat, lon) != site_id:
        raise ValueError(f"non-canonical custom site id {site_id!r}; canonical form is {custom_site_id(lat, lon)!r}")
    return lat, lon


def custom_site(lat_deg: float, lon_deg: float, name: str | None = None, height_m: float | None = None) -> Site:
    """Create a user-defined site.

    Args:
        lat_deg: planetocentric latitude, degrees in [-90, 90].
        lon_deg: longitude in degrees, east-positive; any value in [-360, 360] is accepted and
            normalised to [0, 360) (e.g. -153.98 -> 206.02).
        name: display name; defaults to a formatted coordinate string.
        height_m: optional surface height above the 1737.4 km sphere (m). ``None`` -> read from DEM.

    Returns:
        A :class:`Site` with ``origin='custom'``, ``group=''`` and canonical id
        ``custom:<lat>:<lon>``. Coordinates are rounded to :data:`CUSTOM_ID_DECIMALS` decimals.

    Raises:
        TypeError / ValueError on non-numeric, non-finite or out-of-range inputs.
    """
    lat, lon = _round_custom(_check_lat(lat_deg), _check_lon_input(lon_deg))
    if height_m is not None:
        if not _is_real_number(height_m) or not math.isfinite(float(height_m)):
            raise ValueError(f"height_m must be a finite number of metres or None, got {height_m!r}")
        height_m = float(height_m)
        if not (-20_000.0 <= height_m <= 20_000.0):  # lunar relief is about -9.1 km .. +10.8 km
            raise ValueError(f"height_m={height_m} m is outside the plausible lunar range [-20000, 20000] m")
    if name is not None and not isinstance(name, str):
        raise TypeError(f"name must be a string or None, got {name!r}")
    if name is None or not name.strip():
        ns = "S" if lat < 0 else "N"
        name = f"Custom site {abs(lat):.{CUSTOM_ID_DECIMALS}f}{ns} {lon:.{CUSTOM_ID_DECIMALS}f}E"
    site_id = f"custom:{lat:.{CUSTOM_ID_DECIMALS}f}:{lon:.{CUSTOM_ID_DECIMALS}f}"
    return Site(
        id=site_id,
        name=name.strip(),
        lat_deg=lat,
        lon_deg=lon,
        origin="custom",
        group="",
        height_m=height_m,
        source="user-defined",
        note="custom site; coordinates as entered (planetocentric, MOON_ME), rounded to 1e-4 deg",
    )


# --------------------------------------------------------------------------------------------
# Catalog file and schema validation
# --------------------------------------------------------------------------------------------

def catalog_path() -> Path:
    """Path of the packaged catalog JSON (``lunarnav/catalog/sites.json``)."""
    return Path(__file__).resolve().parent / "catalog" / "sites.json"


def _num_ok(v: Any) -> bool:
    return _is_real_number(v) and math.isfinite(float(v))


def validate_catalog_document(doc: Any) -> list[str]:
    """Check a parsed catalog document against the schema. Returns the list of problems (empty = valid).

    Schema (version 1)::

        {
          "schema_version": 1,
          "frame": str, "conventions": str,
          "sites": [ {
              "id": str  (^[a-z0-9][a-z0-9_]*$, unique),
              "name": str (non-empty),
              "group": one of ALLOWED_GROUPS,
              "lat_deg": number in [-90, 90],
              "lon_deg": number in [0, 360)   (EAST longitude, already normalised),
              "height_m": null | number,
              "source": str (non-empty citation),
              "note": str,
              "extra": {
                  "source_url": "http(s)://..." (non-empty),
                  "frame": str (non-empty),
                  "accuracy": {"kind": one of ACCURACY_KINDS, "description": str, "horizontal_m": null | number > 0},
                  "reference_illumination_pct": optional number in [0, 100],
                  ... any other keys ...
              }
          } ... ],
          "validation_facts": [ {"id": str (unique), "description": str, "source": str, "source_url": str, ...} ]
        }
    """
    problems: list[str] = []
    if not isinstance(doc, dict):
        return ["top level must be a JSON object"]
    if doc.get("schema_version") not in _SUPPORTED_SCHEMA_VERSIONS:
        problems.append(f"schema_version must be one of {_SUPPORTED_SCHEMA_VERSIONS}, got {doc.get('schema_version')!r}")
    for key in ("frame", "conventions"):
        if not isinstance(doc.get(key), str) or not doc.get(key):
            problems.append(f"top-level '{key}' must be a non-empty string")
    sites = doc.get("sites")
    if not isinstance(sites, list) or not sites:
        problems.append("'sites' must be a non-empty list")
        sites = []
    seen: set[str] = set()
    for i, s in enumerate(sites):
        where = f"sites[{i}]"
        if not isinstance(s, dict):
            problems.append(f"{where} must be an object")
            continue
        sid = s.get("id")
        if isinstance(sid, str):
            where = f"site {sid!r}"
        if not isinstance(sid, str) or not _ID_RE.match(sid):
            problems.append(f"{where}: id must match {_ID_RE.pattern}, got {sid!r}")
        elif sid in seen:
            problems.append(f"{where}: duplicate id")
        else:
            seen.add(sid)
        allowed_keys = {"id", "name", "group", "lat_deg", "lon_deg", "height_m", "source", "note", "extra"}
        unknown = set(s) - allowed_keys
        if unknown:
            problems.append(f"{where}: unknown keys {sorted(unknown)} (put extra fields under 'extra')")
        if not isinstance(s.get("name"), str) or not s.get("name", "").strip():
            problems.append(f"{where}: name must be a non-empty string")
        if s.get("group") not in ALLOWED_GROUPS:
            problems.append(f"{where}: group must be one of {ALLOWED_GROUPS}, got {s.get('group')!r}")
        lat = s.get("lat_deg")
        if not _num_ok(lat) or not (-90.0 <= float(lat) <= 90.0):
            problems.append(f"{where}: lat_deg must be a number in [-90, 90], got {lat!r}")
        lon = s.get("lon_deg")
        if not _num_ok(lon) or not (0.0 <= float(lon) < 360.0):
            problems.append(f"{where}: lon_deg must be an EAST longitude in [0, 360), got {lon!r}")
        h = s.get("height_m", None)
        if h is not None and not _num_ok(h):
            problems.append(f"{where}: height_m must be null or a finite number, got {h!r}")
        if not isinstance(s.get("source"), str) or not s.get("source", "").strip():
            problems.append(f"{where}: source (citation) must be a non-empty string")
        if not isinstance(s.get("note", ""), str):
            problems.append(f"{where}: note must be a string")
        extra = s.get("extra")
        if not isinstance(extra, dict):
            problems.append(f"{where}: extra must be an object")
            continue
        url = extra.get("source_url")
        if not isinstance(url, str) or not re.match(r"^https?://\S+$", url):
            problems.append(f"{where}: extra.source_url must be an http(s) URL, got {url!r}")
        if not isinstance(extra.get("frame"), str) or not extra.get("frame"):
            problems.append(f"{where}: extra.frame must be a non-empty string")
        acc = extra.get("accuracy")
        if not isinstance(acc, dict):
            problems.append(f"{where}: extra.accuracy must be an object")
        else:
            if acc.get("kind") not in ACCURACY_KINDS:
                problems.append(f"{where}: extra.accuracy.kind must be one of {ACCURACY_KINDS}, got {acc.get('kind')!r}")
            if not isinstance(acc.get("description"), str) or not acc.get("description"):
                problems.append(f"{where}: extra.accuracy.description must be a non-empty string")
            hm = acc.get("horizontal_m", None)
            if hm is not None and (not _num_ok(hm) or float(hm) <= 0):
                problems.append(f"{where}: extra.accuracy.horizontal_m must be null or a positive number, got {hm!r}")
        if "reference_illumination_pct" in extra:
            ri = extra["reference_illumination_pct"]
            if not _num_ok(ri) or not (0.0 <= float(ri) <= 100.0):
                problems.append(f"{where}: extra.reference_illumination_pct must be a number in [0, 100], got {ri!r}")
    facts = doc.get("validation_facts", [])
    if not isinstance(facts, list):
        problems.append("'validation_facts' must be a list")
        facts = []
    fact_ids: set[str] = set()
    for i, f in enumerate(facts):
        if not isinstance(f, dict):
            problems.append(f"validation_facts[{i}] must be an object")
            continue
        fid = f.get("id")
        if not isinstance(fid, str) or not fid:
            problems.append(f"validation_facts[{i}]: id must be a non-empty string")
        elif fid in fact_ids:
            problems.append(f"validation_facts[{i}]: duplicate id {fid!r}")
        else:
            fact_ids.add(fid)
        for key in ("description", "source"):
            if not isinstance(f.get(key), str) or not f.get(key):
                problems.append(f"validation_facts[{i}]: {key} must be a non-empty string")
        url = f.get("source_url")
        if not isinstance(url, str) or not re.match(r"^https?://\S+$", url):
            problems.append(f"validation_facts[{i}]: source_url must be an http(s) URL")
        if "site_id" in f and f["site_id"] not in seen:
            problems.append(f"validation_facts[{i}]: site_id {f['site_id']!r} is not a catalog site")
    return problems


@lru_cache(maxsize=8)
def _load_document_cached(path_str: str, mtime_ns: int) -> dict:
    p = Path(path_str)
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise CatalogError([f"not valid JSON: {exc}"], p) from exc
    problems = validate_catalog_document(doc)
    if problems:
        raise CatalogError(problems, p)
    return doc


def load_catalog_document(path: str | Path | None = None) -> dict:
    """Read and validate the catalog JSON. Returns a deep copy (callers may mutate it freely).

    Raises:
        FileNotFoundError: the file does not exist.
        CatalogError: invalid JSON or schema violations (all problems are listed).
    """
    p = Path(path) if path is not None else catalog_path()
    if not p.is_file():
        raise FileNotFoundError(f"site catalog not found: {p}")
    return copy.deepcopy(_load_document_cached(str(p.resolve()), p.stat().st_mtime_ns))


def _site_from_record(rec: dict) -> Site:
    return Site(
        id=rec["id"],
        name=rec["name"],
        lat_deg=float(rec["lat_deg"]),
        lon_deg=float(rec["lon_deg"]),
        origin="catalog",
        group=rec["group"],
        height_m=None if rec.get("height_m") is None else float(rec["height_m"]),
        source=rec["source"],
        note=rec.get("note", ""),
    )


def load_catalog(path: str | Path | None = None, group: str | None = None) -> list[Site]:
    """Load the validated site catalog as :class:`Site` objects (file order).

    Args:
        path: alternative catalog JSON (default: the packaged ``catalog/sites.json``).
        group: optional filter, one of :data:`ALLOWED_GROUPS`.
    """
    if group is not None and group not in ALLOWED_GROUPS:
        raise ValueError(f"unknown group {group!r}; allowed: {ALLOWED_GROUPS}")
    doc = load_catalog_document(path)
    sites = [_site_from_record(r) for r in doc["sites"]]
    if group is not None:
        sites = [s for s in sites if s.group == group]
    return sites


def _records_by_id(path: str | Path | None = None) -> dict[str, dict]:
    return {r["id"]: r for r in load_catalog_document(path)["sites"]}


def get_site(site_id: str, path: str | Path | None = None) -> Site:
    """Return a catalog site by id, or rebuild a custom site from a canonical ``custom:<lat>:<lon>`` id.

    Raises:
        KeyError: unknown catalog id (the message lists the available ids).
        ValueError: malformed custom id.
    """
    if not isinstance(site_id, str):
        raise TypeError(f"site id must be a string, got {site_id!r}")
    if site_id.startswith("custom:"):
        lat, lon = parse_custom_id(site_id)
        return custom_site(lat, lon)
    recs = _records_by_id(path)
    if site_id not in recs:
        raise KeyError(f"unknown site id {site_id!r}; available: {', '.join(sorted(recs))}")
    return _site_from_record(recs[site_id])


def get_site_extra(site_id: str, path: str | Path | None = None) -> dict:
    """Extra per-site metadata (source_url, frame, accuracy, reference values, ...). Returns a copy.

    Custom sites return a minimal dict describing their origin.
    """
    if site_id.startswith("custom:"):
        parse_custom_id(site_id)
        return {
            "source_url": None,
            "frame": "MOON_ME (as entered by the user; assumed planetocentric, east longitude)",
            "accuracy": {"kind": "target_point", "description": "user-entered coordinates", "horizontal_m": None},
        }
    recs = _records_by_id(path)
    if site_id not in recs:
        raise KeyError(f"unknown site id {site_id!r}; available: {', '.join(sorted(recs))}")
    return copy.deepcopy(recs[site_id]["extra"])


def sites_in_group(group: str, path: str | Path | None = None) -> list[Site]:
    """All catalog sites of one group (see :data:`ALLOWED_GROUPS`)."""
    return load_catalog(path, group=group)


def south_pole_sites(path: str | Path | None = None) -> list[Site]:
    """Artemis III candidate regions and actual south-polar landings / targets."""
    return sites_in_group("south_pole", path)


def apollo_sites(path: str | Path | None = None) -> list[Site]:
    """Apollo landing sites used for validation (official LRO-derived LM coordinates)."""
    return sites_in_group("apollo", path)


def far_side_sites(path: str | Path | None = None) -> list[Site]:
    """Far-side landing sites (Earth never above the geometric horizon) used for validation."""
    return sites_in_group("far_side", path)


def reference_sites(path: str | Path | None = None) -> list[Site]:
    """Literature reference points (high-illumination points, permanently shadowed points)."""
    return sites_in_group("reference", path)


def reference_illumination_pct(site_id: str, path: str | Path | None = None) -> float | None:
    """Published average solar illumination (%) for a reference site, or None if not available.

    See ``get_site_extra(site_id)['reference_illumination']`` for the conditions (period, DEM,
    observer height above ground, exact point) the value refers to.
    """
    v = get_site_extra(site_id, path).get("reference_illumination_pct")
    return None if v is None else float(v)


def get_validation_facts(path: str | Path | None = None) -> list[dict]:
    """Catalog-level validation facts (copies), e.g. the Apollo 11 landing time and Sun elevation."""
    return load_catalog_document(path).get("validation_facts", [])


def get_validation_fact(fact_id: str, path: str | Path | None = None) -> dict:
    """One validation fact by id. Raises KeyError if absent."""
    for f in get_validation_facts(path):
        if f["id"] == fact_id:
            return f
    raise KeyError(f"unknown validation fact {fact_id!r}")

