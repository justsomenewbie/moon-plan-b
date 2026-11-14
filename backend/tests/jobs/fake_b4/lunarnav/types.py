"""FAKE lunarnav.types: the Site dataclass only."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Site:
    id: str
    name: str
    lat_deg: float
    lon_deg: float
    origin: str = "custom"
    group: str = ""
    height_m: float | None = None
    source: str = ""
    note: str = ""
