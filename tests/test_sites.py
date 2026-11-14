"""Tests for lunarnav.sites and the packaged site catalog (lunarnav/catalog/sites.json).

Offline tests check the schema, conventions and internal/independent consistency of the catalog.
Tests marked ``network`` re-fetch the cited sources (cached on disk under data/cache/sites_sources)
and check that the catalog numbers are literally what the sources publish, and that JPL Horizons
reproduces the Apollo 11 Sun-elevation validation fact.
"""
from __future__ import annotations

import json
import math
import re
import time

import numpy as np
import pytest

from lunarnav import sites as S
from lunarnav.config import MOON_RADIUS_KM, cache_dir
from lunarnav.types import Site

R_KM = MOON_RADIUS_KM


def gc_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance on the 1737.4 km sphere (km)."""
    p1, p2, dl = map(math.radians, (lat1, lat2, lon2 - lon1))
    c = math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(dl)
    return R_KM * math.acos(max(-1.0, min(1.0, c)))


def south_ps(lat: float, lon: float) -> tuple[float, float]:
    """South polar stereographic (km), lon 0 towards +y, as used by LOLA polar products."""
    rho = 2 * R_KM * math.tan(math.radians(90.0 + lat) / 2)
    return rho * math.sin(math.radians(lon)), rho * math.cos(math.radians(lon))


def point_in_polygon(x: float, y: float, poly: list[tuple[float, float]]) -> bool:
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


# ----------------------------------------------------------------------------------- catalog basics

def test_catalog_loads_with_expected_content():
    cat = S.load_catalog()
    assert all(isinstance(s, Site) for s in cat)
    ids = [s.id for s in cat]
    # the 9 NASA Artemis III regions (Oct 2024 list), real landings, references, validation sites
    expected = {
        "a3_peak_near_cabeus_b", "a3_haworth", "a3_malapert_massif", "a3_mons_mouton_plateau", "a3_mons_mouton",
        "a3_nobile_rim_1", "a3_nobile_rim_2", "a3_de_gerlache_rim_2", "a3_slater_plain",
        "im2_athena", "im1_odysseus", "chandrayaan3_vikram",
        "ref_connecting_ridge_c1", "ref_connecting_ridge_c2", "ref_shackleton_rim", "ref_de_gerlache_rim",
        "psr_shackleton_floor", "psr_haworth_floor",
        "apollo11", "apollo15", "apollo17", "change4", "change6",
    }
    assert expected <= set(ids)
    assert len([i for i in ids if i.startswith("a3_")]) == 9


def test_ids_unique_and_wellformed():
    ids = [s.id for s in S.load_catalog()]
    assert len(ids) == len(set(ids))
    assert all(re.fullmatch(r"[a-z0-9][a-z0-9_]*", i) for i in ids)


def test_ranges_frame_and_metadata_valid():
    for s in S.load_catalog():
        assert -90.0 <= s.lat_deg <= 90.0, s.id
        assert 0.0 <= s.lon_deg < 360.0, s.id
        assert s.origin == "catalog" and s.group in S.ALLOWED_GROUPS, s.id
        assert s.height_m is None, s.id  # heights come from the DEM; published ones are in extra
        assert s.source.strip(), s.id
        ex = S.get_site_extra(s.id)
        assert ex["source_url"].startswith(("https://", "http://")), s.id
        assert "MOON_ME" in ex["frame"], s.id
        assert ex["accuracy"]["kind"] in S.ACCURACY_KINDS, s.id
        assert ex["accuracy"]["description"], s.id


def test_groups_are_consistent_with_geography():
    for s in S.south_pole_sites():
        assert s.lat_deg < -69.0, s.id  # Chandrayaan-3 (69.37 S) is the northernmost "south-polar" landing
    for s in S.apollo_sites():
        assert 0.0 < s.lat_deg < 30.0 and s.lon_deg < 40.0, s.id  # all three are near-side, low latitude
    assert {s.id for s in S.far_side_sites()} == {"change4", "change6"}
    for s in S.reference_sites():
        assert s.lat_deg < -87.0, s.id  # polar reference points
    # region entries really are flagged as region centres, landings as landed points
    for s in S.load_catalog():
        kind = S.get_site_extra(s.id)["accuracy"]["kind"]
        if s.id.startswith("a3_"):
            assert kind == "region_centre"
        if s.group in ("apollo", "far_side") or s.id in ("im2_athena", "im1_odysseus", "chandrayaan3_vikram"):
            assert kind == "landed_point"


def test_load_catalog_group_filter_and_errors():
    assert all(s.group == "apollo" for s in S.load_catalog(group="apollo"))
    with pytest.raises(ValueError):
        S.load_catalog(group="mars")
    with pytest.raises(KeyError, match="unknown site id"):
        S.get_site("apollo_99")
    with pytest.raises(KeyError):
        S.get_site_extra("nope")


def test_returned_objects_are_copies():
    ex = S.get_site_extra("apollo11")
    ex["source_url"] = "changed"
    assert S.get_site_extra("apollo11")["source_url"] != "changed"


# ----------------------------------------------------------------------------------- verified values

# Values copied from the cited sources; tolerance 0 (exact transcription), compared at 1e-9 deg.
@pytest.mark.parametrize("sid,lat,lon", [
    ("apollo11", 0.67416, 23.47314),     # NSSDCA 1969-059C
    ("apollo15", 26.13239, 3.63330),     # NSSDCA 1971-063C
    ("apollo17", 20.1911, 30.7723),      # NSSDCA 1972-096C
    ("im2_athena", -84.7906, 29.1957),   # LROC images/1408
    ("im1_odysseus", -80.13, 1.44),      # LROC images/1360
    ("chandrayaan3_vikram", -69.3734, 32.3198),  # IAU Statio Shiv Shakti
    ("change6", -41.6385, 206.0148),     # LROC images/1374
    ("change4", -45.457, 177.589),       # LROC images/1087
    ("psr_shackleton_floor", -89.67, 129.78),  # IAU Shackleton
    ("psr_haworth_floor", -87.45, 354.83),     # IAU Haworth
    ("ref_connecting_ridge_c1", -89.4505, 222.84),  # Glaser et al. 2018 Table 1
    ("ref_shackleton_rim", -89.7849, 203.97),       # Glaser et al. 2018 Table 1
])
def test_transcribed_coordinates(sid, lat, lon):
    s = S.get_site(sid)
    assert s.lat_deg == pytest.approx(lat, abs=1e-9)
    assert s.lon_deg == pytest.approx(lon, abs=1e-9)


@pytest.mark.parametrize("sid,ref,tol_km", [
    # Independent second source for the same landed point. Tolerances: the IAU stations are rounded to
    # 0.0001 deg (Apollo 11, ~3 m) or 0.01 deg (Chang'e, ~300 m) -> 0.05 km / 0.5 km.
    ("apollo11", "iau_statio_latlon", 0.05),
    ("change6", "iau_statio_latlon", 0.5),
    ("change4", "iau_statio_latlon", 0.5),
    # LROC vs IAU for Chandrayaan-3: two measurements of the same lander, LROC lon given to 0.01 deg
    ("chandrayaan3_vikram", "lroc_latlon", 0.1),
    # IM-2 came to rest a few hundred metres from its intended site (LROC)
    ("im2_athena", "intended_site_latlon", 0.6),
])
def test_landed_points_agree_with_independent_source(sid, ref, tol_km):
    s = S.get_site(sid)
    lat2, lon2 = S.get_site_extra(sid)[ref]
    assert gc_km(s.lat_deg, s.lon_deg, lat2, S.normalize_lon(lon2)) < tol_km


def test_mons_mouton_region_identified_with_2022_leibnitz_beta_plateau():
    # The 2024 map box centre (measured independently by georeferencing) and the 2022 published centre
    # must coincide within the georeferencing error (<= 2 km, residuals of the fit were <= 1.3 km).
    s = S.get_site("a3_mons_mouton")
    assert gc_km(s.lat_deg, s.lon_deg, -85.4290, 31.7286) < 2.0


def test_im2_landed_inside_mons_mouton_plateau_region():
    # Independent check of the map georeferencing: IM-2 Athena (LROC) must fall inside the region box.
    im2 = S.get_site("im2_athena")
    poly = [south_ps(la, lo) for la, lo in S.get_site_extra("a3_mons_mouton_plateau")["region_corners_latlon"]]
    assert point_in_polygon(*south_ps(im2.lat_deg, im2.lon_deg), poly)
    # ...but not inside the small "Mons Mouton" box further south
    poly2 = [south_ps(la, lo) for la, lo in S.get_site_extra("a3_mons_mouton")["region_corners_latlon"]]
    assert not point_in_polygon(*south_ps(im2.lat_deg, im2.lon_deg), poly2)


def test_region_centres_inside_their_outlines():
    for s in S.south_pole_sites():
        ex = S.get_site_extra(s.id)
        if "region_corners_latlon" not in ex:
            continue
        poly = [south_ps(la, lo) for la, lo in ex["region_corners_latlon"]]
        assert point_in_polygon(*south_ps(s.lat_deg, s.lon_deg), poly), s.id


@pytest.mark.parametrize("sid,feat_lat,feat_lon,max_km", [
    # Named-feature plausibility (IAU Gazetteer centres). Limits = feature radius + region half-size + margin.
    ("a3_haworth", -87.45, 354.83, 60.0),         # Haworth D=51 km; region on its rim/outer flank
    ("a3_slater_plain", -88.0792, 111.2881, 45.0),  # Slater D=25 km; plain next to it
    ("a3_peak_near_cabeus_b", -82.2587, 305.4154, 90.0),  # Cabeus B D=60 km; "peak near" it
    ("a3_mons_mouton", -84.6, 31.0, 65.0),        # Mons Mouton, ~130 km massif
    ("a3_mons_mouton_plateau", -84.6, 31.0, 65.0),
    ("a3_malapert_massif", -86.0, 0.0, 15.0),     # LROC: "flat area (86 S, 0 E) ... heart of" the region
])
def test_region_centres_near_named_features(sid, feat_lat, feat_lon, max_km):
    s = S.get_site(sid)
    assert gc_km(s.lat_deg, s.lon_deg, feat_lat, feat_lon) < max_km


def test_far_side_sites_are_geometrically_hidden_from_earth():
    # Earth visible only if the angular distance from the mean sub-Earth point (0N, 0E) is below
    # 90 deg + max optical libration (~8.2 deg combined) + parallax (~1 deg) + Earth radius (~1 deg) < 101 deg.
    for s in S.far_side_sites():
        d = math.degrees(gc_km(s.lat_deg, s.lon_deg, 0.0, 0.0) / R_KM)
        assert d > 101.0, (s.id, d)
        assert S.get_site_extra(s.id)["earth_never_visible"] is True
    # and the near-side Apollo sites are far inside the always-visible zone (< 90 - 11 deg)
    for s in S.apollo_sites():
        assert math.degrees(gc_km(s.lat_deg, s.lon_deg, 0.0, 0.0) / R_KM) < 79.0


def test_reference_illumination_values():
    # PSR points: 0 %; ridge/rim points: published values between 70 and 90 %.
    assert S.reference_illumination_pct("psr_shackleton_floor") == 0.0
    assert S.reference_illumination_pct("psr_haworth_floor") == 0.0
    for sid, pct in [("ref_connecting_ridge_c1", 76.0), ("ref_connecting_ridge_c2", 75.6),
                     ("ref_shackleton_rim", 81.0), ("ref_de_gerlache_rim", 82.7)]:
        assert S.reference_illumination_pct(sid) == pytest.approx(pct, abs=1e-9)
        refs = S.get_site_extra(sid)["reference_illumination"]
        assert refs and all(0.0 <= r["pct"] <= 100.0 for r in refs)
        # every alternative value refers to a point on the same rim/ridge segment: within 4 km of the catalog
        # point (the farthest is Glaser's 2 m-height maximum on the Shackleton rim, 3.1 km along the rim)
        for r in refs:
            if "lat" in r:
                assert gc_km(S.get_site(sid).lat_deg, S.get_site(sid).lon_deg, r["lat"], r["lon"]) < 4.0
    assert S.reference_illumination_pct("apollo11") is None


def test_pgda_second_source_consistent_with_literature():
    # The PGDA 60 m map (independent product) must agree with the literature value at each reference point to
    # within 12 percentage points: published values for the same point differ by up to 13 points between
    # 20 m and 240 m DEMs (76.0 vs 89.0 at C1), and the PGDA product is in between (60 m).
    for sid in ("ref_connecting_ridge_c1", "ref_connecting_ridge_c2", "ref_shackleton_rim", "ref_de_gerlache_rim"):
        pg = S.get_site_extra(sid)["pgda_avg_illumination_at_point"]["pgda:AVGVISIB_85S_060M_201608"]
        assert abs(pg["max3x3_pct"] - S.reference_illumination_pct(sid)) <= 12.0, sid
    for sid in ("psr_shackleton_floor", "psr_haworth_floor"):
        pg = S.get_site_extra(sid)["pgda_avg_illumination_at_point"]["pgda:AVGVISIB_85S_060M_201608"]
        assert pg["max3x3_pct"] == 0.0


def test_apollo11_validation_fact():
    f = S.get_validation_fact("apollo11_sun_elevation_at_landing")
    assert f["site_id"] == "apollo11"
    assert np.datetime64(f["time_utc"], "s") == np.datetime64("1969-07-20T20:17:40", "s")
    assert f["sun_elevation_deg"] == pytest.approx(10.8)
    assert 0 < f["tolerance_deg"] <= 1.0
    assert S.get_site_extra("apollo11")["landing_time_utc"] == f["time_utc"]
    with pytest.raises(KeyError):
        S.get_validation_fact("nope")


# ----------------------------------------------------------------------------------- longitudes / custom sites

@pytest.mark.parametrize("lon,expected", [
    (-153.98, 206.02), (206.02, 206.02), (0.0, 0.0), (-0.0, 0.0), (360.0, 0.0), (-360.0, 0.0),
    (720.5, 0.5), (-180.0, 180.0), (180.0, 180.0), (359.999999, 359.999999), (-1e-17, 0.0),
])
def test_normalize_lon(lon, expected):
    out = S.normalize_lon(lon)
    assert 0.0 <= out < 360.0
    assert out == pytest.approx(expected, abs=1e-9)
    assert math.copysign(1.0, out) == 1.0  # never -0.0


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), "10", None, True])
def test_normalize_lon_rejects_bad_input(bad):
    with pytest.raises((TypeError, ValueError)):
        S.normalize_lon(bad)


def test_custom_site_basic():
    s = S.custom_site(-41.6385, -153.9852, name="CE-6 by hand")
    assert s.id == "custom:-41.6385:206.0148"
    assert (s.lat_deg, s.lon_deg) == (-41.6385, 206.0148)
    assert s.origin == "custom" and s.group == "" and s.name == "CE-6 by hand"
    # same place as the catalog entry, within rounding (1e-4 deg ~ 3 m)
    ce6 = S.get_site("change6")
    assert gc_km(s.lat_deg, s.lon_deg, ce6.lat_deg, ce6.lon_deg) < 0.005


def test_custom_site_example_from_brief():
    s = S.custom_site(-10.0, -153.98)
    assert s.lon_deg == pytest.approx(206.02, abs=1e-9)
    assert s.id == "custom:-10.0000:206.0200"
    assert s.name == "Custom site 10.0000S 206.0200E"


def test_custom_site_canonical_ids():
    assert S.custom_site(0, 0).id == "custom:0.0000:0.0000"
    assert S.custom_site(-0.0, -0.0).id == "custom:0.0000:0.0000"
    assert S.custom_site(-89.45, -137.31).id == "custom:-89.4500:222.6900"
    assert S.custom_site(-89.45, 222.69).id == S.custom_site(-89.45, -137.31).id
    assert S.custom_site(10, 359.99996).id == "custom:10.0000:0.0000"  # rounds up to 360 -> 0
    assert S.custom_site(90, 10).id == "custom:90.0000:10.0000"
    assert S.custom_site_id(-89.45, 222.69) == "custom:-89.4500:222.6900"


def test_custom_site_roundtrip_via_get_site():
    s = S.custom_site(-85.42, 31.83, name="x")
    t = S.get_site(s.id)
    assert (t.id, t.lat_deg, t.lon_deg, t.origin) == (s.id, s.lat_deg, s.lon_deg, "custom")
    assert S.get_site_extra(s.id)["accuracy"]["kind"] == "target_point"
    assert S.parse_custom_id(s.id) == (-85.42, 31.83)


@pytest.mark.parametrize("bad_id", [
    "custom:-89.45:222.69",        # wrong number of decimals
    "custom:-89.4500:-137.3100",   # west longitude is not canonical
    "custom:-89.4500:360.0000",    # lon must be < 360
    "custom:-95.0000:10.0000",     # lat out of range
    "custom:abc:def",
    "custom:-0.0000:10.0000",      # -0 is not canonical
])
def test_parse_custom_id_rejects_noncanonical(bad_id):
    with pytest.raises(ValueError):
        S.parse_custom_id(bad_id)
    with pytest.raises(ValueError):
        S.get_site(bad_id)


@pytest.mark.parametrize("lat,lon,exc", [
    (91.0, 0.0, ValueError), (-90.0001, 0.0, ValueError), (float("nan"), 0.0, ValueError),
    (0.0, float("inf"), ValueError), (0.0, 360.5, ValueError), (0.0, -360.5, ValueError),
    ("10", 0.0, TypeError), (0.0, None, TypeError), (True, 0.0, TypeError),
])
def test_custom_site_validation(lat, lon, exc):
    with pytest.raises(exc):
        S.custom_site(lat, lon)


def test_custom_site_height_validation():
    assert S.custom_site(-89.0, 0.0, height_m=1500).height_m == 1500.0
    with pytest.raises(ValueError):
        S.custom_site(-89.0, 0.0, height_m=float("nan"))
    with pytest.raises(ValueError):
        S.custom_site(-89.0, 0.0, height_m=50_000)


def test_custom_site_accepts_numpy_scalars():
    s = S.custom_site(np.float64(-89.45), np.float32(-137.31))
    assert s.id == "custom:-89.4500:222.6900"


# ----------------------------------------------------------------------------------- schema validation

def _write(tmp_path, doc) -> str:
    p = tmp_path / "cat.json"
    p.write_text(json.dumps(doc), encoding="utf-8")
    return str(p)


def _good_doc() -> dict:
    return S.load_catalog_document()


def test_schema_accepts_packaged_catalog():
    assert S.validate_catalog_document(_good_doc()) == []


@pytest.mark.parametrize("mutate,needle", [
    (lambda d: d["sites"].append(dict(d["sites"][0])), "duplicate id"),
    (lambda d: d["sites"][0].update(lon_deg=-153.98), "lon_deg"),
    (lambda d: d["sites"][0].update(lon_deg=360.0), "lon_deg"),
    (lambda d: d["sites"][0].update(lat_deg=-91), "lat_deg"),
    (lambda d: d["sites"][0].update(source=""), "source"),
    (lambda d: d["sites"][0].update(group="mars"), "group"),
    (lambda d: d["sites"][0].update(id="Bad Id"), "id must match"),
    (lambda d: d["sites"][0].update(foo=1), "unknown keys"),
    (lambda d: d["sites"][0]["extra"].pop("source_url"), "source_url"),
    (lambda d: d["sites"][0]["extra"]["accuracy"].update(kind="guess"), "accuracy.kind"),
    (lambda d: d["sites"][0]["extra"].update(reference_illumination_pct=120), "reference_illumination_pct"),
    (lambda d: d.update(schema_version=99), "schema_version"),
    (lambda d: d["validation_facts"][0].update(site_id="ghost"), "not a catalog site"),
])
def test_schema_rejects_bad_catalogs(tmp_path, mutate, needle):
    doc = _good_doc()
    mutate(doc)
    path = _write(tmp_path, doc)
    with pytest.raises(S.CatalogError) as ei:
        S.load_catalog(path)
    assert any(needle in p for p in ei.value.problems), ei.value.problems


def test_schema_rejects_invalid_json_and_missing_file(tmp_path):
    p = tmp_path / "broken.json"
    p.write_text("{not json", encoding="utf-8")
    with pytest.raises(S.CatalogError):
        S.load_catalog(p)
    with pytest.raises(FileNotFoundError):
        S.load_catalog(tmp_path / "missing.json")


# ----------------------------------------------------------------------------------- network: re-verify sources

def _fetch_cached(url: str) -> str:
    """GET with on-disk cache and polite retry/backoff (sequential, no parallel requests)."""
    import hashlib

    import requests

    path = cache_dir("sites_sources") / (hashlib.sha256(url.encode()).hexdigest()[:24] + ".txt")
    if path.exists():
        return path.read_text(encoding="utf-8")
    last: Exception | None = None
    for attempt in range(4):
        try:
            r = requests.get(url, timeout=60, headers={"User-Agent": "lunarnav-tests/0.1"})
            r.raise_for_status()
            path.write_text(r.text, encoding="utf-8")
            return r.text
        except Exception as exc:  # noqa: BLE001 - retried, then re-raised below
            last = exc
            time.sleep(2 ** attempt)
    raise RuntimeError(f"could not fetch {url}: {last}")


@pytest.mark.network
@pytest.mark.parametrize("sid,needles", [
    ("apollo11", ["0.67416 degrees N latitude, 23.47314 degrees E longitude", "20:17:40 UT"]),
    ("apollo15", ["26.13239 N latitude, 3.63330 E longitude"]),
    ("apollo17", ["20.1911 N latitude, 30.7723 E longitude"]),
    ("im2_athena", ["84.7906° S, 29.1957° E"]),
    ("change6", ["41.6385°S, 206.0148°E"]),
    ("change4", ["45.457°S, 177.589°E"]),
])
def test_sources_publish_catalog_numbers(sid, needles):
    text = _fetch_cached(S.get_site_extra(sid)["source_url"])
    flat = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text)).replace("&deg;", "°")
    for n in needles:
        assert n in flat, (sid, n)


@pytest.mark.network
def test_horizons_reproduces_apollo11_sun_elevation():
    """Independent check of the validation fact with JPL Horizons (topocentric, airless apparent)."""
    s = S.get_site("apollo11")
    f = S.get_validation_fact("apollo11_sun_elevation_at_landing")
    t = f["time_utc"].replace("T", " ")
    params = {
        "format": "text", "COMMAND": "'10'", "MAKE_EPHEM": "YES", "EPHEM_TYPE": "OBSERVER",
        "CENTER": "'coord@301'", "COORD_TYPE": "GEODETIC", "SITE_COORD": f"'{s.lon_deg},{s.lat_deg},0'",
        "START_TIME": f"'{t}'", "STOP_TIME": "'1969-07-20 20:18:40'", "STEP_SIZE": "'1 m'",
        "QUANTITIES": "'4'", "ANG_FORMAT": "DEG", "APPARENT": "AIRLESS", "TIME_TYPE": "UT",
    }
    from urllib.parse import urlencode

    text = _fetch_cached("https://ssd.jpl.nasa.gov/api/horizons.api?" + urlencode(params))
    block = text[text.index("$$SOE") + 5: text.index("$$EOE")].strip().splitlines()[0]
    el = float(block.split()[-1])
    assert el == pytest.approx(f["horizons_crosscheck_deg"], abs=0.02)  # value recorded in the catalog
    assert abs(el - f["sun_elevation_deg"]) <= f["tolerance_deg"]
