"""Lunar Landing Site Navigator - computation backend.

Module map (each module owns one responsibility; see docs/ARCHITECTURE.md):
  types.py            shared dataclasses / protocols (the contract between modules)
  config.py           constants and data/cache directories
  sites.py            site catalog loading, custom sites
  ephem/horizons.py   Method A: JPL Horizons API (resource tab)
  ephem/spice.py      Method B: NAIF SPICE kernels (spiceypy)
  ephem/analytic.py   Method C: independent low-precision model (astropy + IAU rotation)
  terrain/trek.py     LOLA DEM from NASA Moon Trek (resource tab), full-file download
  terrain/pgda.py     LOLA DEM from NASA GSFC PGDA (cloud-optimized GeoTIFF range reads)
  terrain/common.py   polar stereographic projection, DEM sampling helpers
  horizon.py          terrain horizon masks (two independent algorithms)
  visibility.py       Sun/Earth visibility rules
  windows.py          visibility windows and metrics
  analysis.py         scenario analysis, site ranking, alternative landing dates
  precompute.py       batch precomputation + writers (output format: docs/OUTPUT_SPEC.md)
  validate.py         cross-method validation report
  cli.py              command line entry point
"""

__version__ = "0.1.0"
