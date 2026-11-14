# Architecture - Lunar Landing Site Navigator backend

Goal: for any lunar site and period, precompute where the Sun and the Earth are relative to the
**terrain** horizon, and turn that into solar-power potential, direct-to-Earth (DTE) communication
windows, site rankings and alternative landing dates. The UI (later) only reads the precompute
directory described in [OUTPUT_SPEC.md](OUTPUT_SPEC.md).

## 1. Module map

| Module | Responsibility | Inputs → outputs |
|---|---|---|
| `types.py` | shared contract (dataclasses / protocols) and conventions | – |
| `config.py` | constants, data / cache / output directories (`LUNARNAV_DATA`, `LUNARNAV_OUTPUT`) | – |
| `sites.py`, `catalog/*.json` | site catalog (south pole candidates, Apollo...), custom sites | → `Site` |
| `ephem/horizons.py` | **Method A** ephemeris: JPL Horizons API (challenge Resources tab) | `Site`, times → `EphemerisSeries` |
| `ephem/spice.py`, `ephem/kernels.py` | **Method B**: NAIF SPICE generic kernels (DE440 + lunar PA/ME frames) | same |
| `ephem/analytic.py` | **Method C**: independent low-precision model (ERFA + IAU rotation), offline | same |
| `terrain/trek.py` | LOLA DEM from NASA Moon Trek (Resources tab), full-file download (Colab) | → `DemSource` |
| `terrain/pgda.py` | LOLA DEM from NASA GSFC PGDA (COG range reads, cached blocks) | → `DemSource` |
| `terrain/common.py` | polar stereographic projection, DEM blocks, `NestedDem` (fine near, coarse far) | |
| `horizon.py` | terrain horizon masks: `raymarch`, `bruteforce` (independent), `flat` | `DemSource`/`DemPatch`, `Site` → `HorizonMask` |
| `visibility.py` | the visibility rules (Sun disc fraction, upper-limb rule, power proxies, Earth clearance, flat dip) | `EphemerisSeries` + `HorizonMask` → `VisibilitySeries` |
| `windows.py` | boolean series → windows (tiling, truncation flags), metrics, "time until sunset / earthset / next sunrise" | `VisibilitySeries` → `Window`s, metrics |
| `analysis.py` | scenario analysis of several sites, ranking, **alternative landing dates** | sites, period, provider, horizons → `AnalysisResult`, `AltDateResult` |
| `precompute.py` | batch pipeline, deterministic writers, `check_output` (invariants of OUTPUT_SPEC), `SyntheticProvider` (tests), name → provider/DEM/horizon resolvers | → output directory |
| `validate.py` | cross-method validation report (A vs B vs C, raymarch vs bruteforce) | |
| `cli.py` | `lunarnav precompute | analyse | alt-dates | check | validate` | |

Rule: modules code only against `types.py`; heavy / networked modules are imported lazily inside the
pipeline (`precompute.get_provider`, `get_dem`, `make_horizon_fn`) so that `visibility`, `windows`,
`analysis` and `precompute` are testable with synthetic inputs and fakes.

## 2. Data flow

```
 Site (lat, lon E, height?)                         DEM source (Moon Trek | PGDA | none)
        |                                                    |
        |                     horizon.py (raymarch | bruteforce | flat)
        |                                                    v
        |                                 HorizonMask: el_deg(az), surface_height_m, mast
        |                                                    |
        +---- observer height above sphere = surface + mast -+
        v                                                    |
 EphemerisProvider (A Horizons | B SPICE | C analytic)       |
        v                                                    |
 EphemerisSeries: Sun/Earth az, el, dist (UTC grid)          |
        +------------------------+---------------------------+
                                 v
                 visibility.compute_visibility  (rules, one place)
                                 v
       VisibilitySeries: sun_fraction, sun_visible, power, earth_clearance, earth_visible, both
                                 v
         windows.find_windows / compute_metrics / hours_until_*      analysis.rank_sites
                                 v                                   analysis.find_alternative_dates
         precompute.run_precompute -> OUT/ (manifest, sites, summary, per-site CSV/JSON)
                                 v
         precompute.check_output(OUT) == []   <- every invariant of OUTPUT_SPEC.md
```

## 3. Independent methods (A / B / C) and how they are cross-checked

| Quantity | A | B | C | Check |
|---|---|---|---|---|
| Sun / Earth topocentric az, el, distance | JPL Horizons API (`coord@301`, airless apparent) | SPICE `azlcpo`/vector math on DE440 + MOON_ME | ERFA epv00/moon98 + IAU rotation | angular separation of directions per time step; A–B expected ≲ 0.001°, A–C ≲ 0.01° (measured A–C ≤ 0.003°, March 2026) |
| Terrain horizon | `raymarch` (great-circle rays, bilinear) | `bruteforce` (every DEM cell, exact 3-D az/el) | `flat` (smooth sphere, analytic dip) as a lower bound | per-azimuth max / RMS difference (`horizon.compare_masks`); bruteforce ≥ raymarch − DEM interpolation error |
| DEM | Moon Trek LOLA (Resources tab) | PGDA LOLA 5/20 m (Barker et al. 2023) | – | height differences at sample points; mask differences from the same algorithm on both DEMs |
| Visibility, windows | rules implemented once (`visibility.py`, `windows.py`) | independent re-implementation inside `check_output` from the written columns | brute-force reference implementations in the tests | tests: closed-form disc fraction vs 1-D integration and pixel counting; windows vs hand-built series; alt-dates vs pure-Python brute force (6 random scenarios) |
| Visibility end-to-end | precompute with A | precompute with C | – | same flags except ≤ 2 samples per rise/set (`test_horizons_vs_analytic_visibility_agree`) |

`lunarnav validate` (module `validate.py`) runs the method comparisons on real data and writes a
report; `lunarnav check` validates the *format and physics* of any precompute directory.

What "correct" means is defined in [OUTPUT_SPEC.md §4](OUTPUT_SPEC.md): structural invariants
(tiling windows, checksums, ranges), rule consistency (every derived column recomputed from the
written columns) and physics sanity (polar Sun within ~1.6° of the horizon, Earth azimuth at the pole
≈ 360° − lon, far side never sees Earth, distance ranges).

## 4. Key algorithms

* **Sun visible fraction**: horizon treated as a straight line at the Sun's azimuth; circular
  segment area `f = 1/2 + (x√(1−x²) + asin x)/π`, `x = (el − horizon)/semidiameter`. `sun_visible`
  = upper limb above horizon (Horizons "daylight" style).
* **Windows**: maximal runs; `[start, end)` with end = first sample of the next state; windows tile the
  range; accuracy ± one step; truncation flags at the range boundaries.
* **Alternative landing dates** (`analysis.find_alternative_dates`): every sample in
  `[earliest, latest]` is a candidate landing L with mission `[L, L+D)`. Rolling sums (cumsum) give
  % Sun / Earth / both; forward run lengths give continuous Sun/Earth after landing; a vectorised
  row-wise longest-run on a sliding window view gives the longest dark period / comms gap inside the
  mission (computed only for candidates passing the cheap constraints). Feasible candidates are
  ranked by an explicit objective (`balanced`, `sun`, `earth`, `both`, `energy`, `earliest`; ties →
  earlier), then thinned to one per opportunity (`min_separation_h`). `rejected_by` tells the user
  which constraint eliminated how many landing times ("schedule slipped: what now?").

## 5. Where things run

* **This Windows machine**: development and tests with light data only (synthetic provider, analytic
  provider, short Horizons queries, PGDA block reads). Never download a full Moon Trek DEM (> 100 MB).
  `pytest -m "not network and not slow"` runs offline.
* **Google Colab**: the heavy run (Moon Trek DEM files of 1-2 GB, multi-year hourly precompute for
  all catalog sites). Recipe:

```python
# Colab cell 1 - code + persistent storage on Google Drive
from google.colab import drive; drive.mount('/content/drive')
!git clone <repo-url> /content/lunar-navigator      # or upload the project folder
%pip install -q -e /content/lunar-navigator
import os
os.environ["LUNARNAV_DATA"] = "/content/drive/MyDrive/lunarnav/data"     # DEMs, kernels, HTTP cache
os.environ["LUNARNAV_OUTPUT"] = "/content/drive/MyDrive/lunarnav/output"

# Colab cell 1b - Moon Trek LOLA DEMs (1-2 GB each, ONLY on Colab), stored in $LUNARNAV_DATA/dem
from lunarnav.terrain.trek import download_product
for label in ["LRO_LOLA_DEM_SPole875_5mp_v04_EQ", "LRO_LOLA_DEM_SPole75_30mp_v04_EQ",
              "LRO_LOLA_DEM_SPole45_100mp_v04_EQ"]:   # 100 m: sites north of 75S (chandrayaan3_vikram)
    download_product(label, allow_large=True)
# get_dem('trek', site) then picks by latitude: <= 87.5S NestedDem(5 m to 60 km, 30 m beyond),
# <= 75S 30 m, <= 45S 100 m; override with --dem-label / --dem-path.
# Every run first checks that the DEM serves ALL selected sites (file present, product covers the
# site, finite height) and stops with the full list otherwise; sites outside every polar DEM
# (Apollo, far side) need --dem-fallback flat (smooth-sphere horizon, recorded as
# dem_source "none:outside-<dem>-coverage" in sites.json).

# Colab cell 2 - precompute (resumable: re-run the same cell after a disconnect)
!lunarnav precompute --sites group:south_pole,apollo11 --start 2026-01-01 --end 2031-01-01 --step-min 60 \
    --provider horizons --dem trek --horizon-method raymarch --dem-fallback flat \
    --out /content/drive/MyDrive/lunarnav/output/sp_2026_2030 --resume

# Colab cell 3 - second method + checks. --dem pgda (default product choice) = the banded PGDA
# model of validate_terrain: the finest product covering the site to 15 km (20 m inside 80S, 30 m
# inside 75S, 60 m inside 60S), 120 m to 60 km, 240 m to the radius - so bruteforce at 150 km needs
# three small patches (a single 20 m patch would be 15002 x 15002 px > max_pixels).
!lunarnav precompute --sites group:south_pole,apollo11 --start 2026-01-01 --end 2031-01-01 --step-min 60 \
    --provider spice --dem pgda --horizon-method bruteforce --dem-fallback flat \
    --out /content/drive/MyDrive/lunarnav/output/sp_2026_2030_B --resume
!lunarnav check /content/drive/MyDrive/lunarnav/output/sp_2026_2030
!lunarnav check /content/drive/MyDrive/lunarnav/output/sp_2026_2030_B
!lunarnav validate --no-terrain        # every option after 'validate' is passed through unchanged
```

  Because `LUNARNAV_DATA` points to Drive, the Horizons HTTP cache, SPICE kernels and DEM files
  survive Colab disconnects; `--resume` skips sites whose files already exist with the same
  parameter fingerprint (all run parameters, provider configuration, `lunarnav.__version__` and the
  git commit) **and** the same site inputs (id, name, lat/lon, group, origin, input height), so a
  corrected coordinate or a code update is recomputed, never silently reused; `run_precompute`
  writes every file atomically (temp file + rename).
  Then download the output directory (or zip it) for the UI.

## 6. Output size (hourly, 5 years = 43 824 samples per site)

Measured (synthetic provider, flat horizon, 1 site, 5 years hourly): `visibility.csv.gz` 2.8 MB,
ephemeris 1.4 MB, windows.json 57 kB (more windows with terrain), horizon csv 20 kB; a 20-site run
is ≈ 90 MB. Precompute time is dominated by the ephemeris provider (Horizons requests are cached)
and the horizon masks; visibility + windows + writing take ≈ 0.5 s per site-year.
