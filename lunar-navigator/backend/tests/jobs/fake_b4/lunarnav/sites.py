"""FAKE lunarnav.sites: two catalog sites + canonical custom ids."""
from __future__ import annotations

from .types import Site

CATALOG = {
    "fake_polar": Site(id="fake_polar", name="Fake polar site", lat_deg=-85.0, lon_deg=10.0, origin="catalog"),
    "fake_tall": Site(id="fake_tall", name="Fake site with a catalog height", lat_deg=-70.0, lon_deg=20.0, origin="catalog", height_m=100.0),
}


def custom_site_id(lat_deg: float, lon_deg: float) -> str:
    return f"custom:{round(float(lat_deg), 4):.4f}:{round(float(lon_deg) % 360.0, 4):.4f}"


def parse_custom_id(site_id: str) -> tuple[float, float]:
    _, lat, lon = site_id.split(":")
    return float(lat), float(lon)


def get_site(site_id: str) -> Site:
    if site_id.startswith("custom:"):
        lat, lon = parse_custom_id(site_id)
        return Site(id=site_id, name=site_id, lat_deg=lat, lon_deg=lon)
    if site_id not in CATALOG:
        raise KeyError(site_id)
    return CATALOG[site_id]
