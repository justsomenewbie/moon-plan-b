"""Constants and data directories. Override the data root with env LUNARNAV_DATA."""
from __future__ import annotations

import os
from pathlib import Path

# Mean lunar radius used by LOLA products and by JPL Horizons for the Moon reference sphere.
MOON_RADIUS_KM = 1737.4
MOON_RADIUS_M = MOON_RADIUS_KM * 1000.0

# Default observer height above local terrain (e.g. solar panel / antenna height), metres.
DEFAULT_OBSERVER_HEIGHT_M = 2.0

# Physical radii used for apparent angular sizes.
SUN_RADIUS_KM = 695_700.0
EARTH_RADIUS_KM = 6_378.137

# Default precompute scope (user chose defaults: south pole + a few Apollo sites, 2026-2030, hourly).
DEFAULT_START_UTC = "2026-01-01T00:00:00"
DEFAULT_END_UTC = "2031-01-01T00:00:00"
DEFAULT_STEP_MINUTES = 60

# Horizon mask defaults
DEFAULT_AZ_STEP_DEG = 0.5
DEFAULT_HORIZON_RADIUS_KM = 150.0

# Raymarch near-field exclusion ``near_exclusion_m="auto"`` (docs/VALIDATION_TERRAIN.md §7): on DEMs
# of <= 5 m (Moon Trek LOLA v04 5 m) terrain closer than 250 m is ignored, because their 4-7 m knobs
# 12-60 m from the mast become false horizons of up to 19 deg; on coarser DEMs nothing is excluded
# (the 250 m cut would remove real horizon terrain: Cabeus B 61.0 -> 71.4 % sun on Trek 30 m).
NEAR_EXCLUSION_AUTO_M = 250.0
NEAR_EXCLUSION_AUTO_MAX_RES_M = 5.0

# Raymarch minimum distance of one file row for a Moon Trek geographic ``*_EQ`` near-field file
# (docs/VALIDATION_TERRAIN.md §7): only for the products of these nominal resolutions (m).  The
# 30 m product's rows are 86.7 m apart near the pole and one row becomes a false peak next to the
# mast (a3_nobile_rim_1).  Not the 100 m product (155.7 m rows, measured effect <= 0.03 pp) nor the
# 5 m one (35.7 m rows, below the 250 m auto exclusion).
EQ_ROW_MIN_DISTANCE_NOMINAL_MPP = (30.0,)


def data_root() -> Path:
    root = Path(os.environ.get("LUNARNAV_DATA", Path(__file__).resolve().parent.parent / "data"))
    root.mkdir(parents=True, exist_ok=True)
    return root


def cache_dir(name: str) -> Path:
    """data/cache/<name>/ - HTTP responses (Horizons), intermediate results."""
    p = data_root() / "cache" / name
    p.mkdir(parents=True, exist_ok=True)
    return p


def kernels_dir() -> Path:
    p = data_root() / "kernels"
    p.mkdir(parents=True, exist_ok=True)
    return p


def dem_dir() -> Path:
    p = data_root() / "dem"
    p.mkdir(parents=True, exist_ok=True)
    return p


def output_dir() -> Path:
    p = Path(os.environ.get("LUNARNAV_OUTPUT", Path(__file__).resolve().parent.parent / "output"))
    p.mkdir(parents=True, exist_ok=True)
    return p
