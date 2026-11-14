# Validation: terrain -> horizon -> visibility

Owner: `lunarnav/validate_terrain.py` (function `run()` returns the report as a dict and writes
`data/cache/validate_terrain/report.json`), tests in `tests/test_crosscheck_terrain.py`.
All numbers below come from the full run on 2026-11-13 (dev machine, light data only: PGDA windowed
reads, the first 4-12 MB of two Moon Trek files and a few Trek ImageServer blocks; no Moon Trek full
file was downloaded).

## Reproduce

```bash
cd /d/UAV/lunar-navigator
./.venv/Scripts/python -m lunarnav.validate_terrain            # full report, ~6 min warm cache (~25 min cold)
./.venv/Scripts/python -m lunarnav.validate_terrain --quick    # 8+8 pixels, 5-yr period, 4 directions
./.venv/Scripts/python -m pytest -q tests/test_crosscheck_terrain.py               # all 15 tests (5 need network, 3 of them slow)
./.venv/Scripts/python -m pytest -q tests/test_crosscheck_terrain.py -m "not network"   # offline, 10 tests
```

On Colab, set `LUNARNAV_DATA` to a Drive folder first (see `docs/ARCHITECTURE.md`) so the caches
are kept between runs.

## Summary of verdicts

| # | Check | Result | Verdict |
|---|---|---|---|
| 0 | Vectorised SPICE ephemeris (vectors from the Moon centre) vs `SpiceProvider` | max 2.7e-5 deg (Earth elevation), 1.1e-8 deg (Sun) | PASS (bound 1e-4 deg) |
| 1 | Raymarch vs brute force on real terrain, terrain beyond 2 km | p95 0.015 / 0.040 / 0.070 deg (crater / ridge / Artemis region) | PASS |
| 1 | Raymarch vs brute force, near field included | p95 up to 0.92 deg (Artemis region, terrain at 80 m) | expected: the two methods model the DEM differently near the mast (see 1.3) |
| 2 | 30 interior PSR pixels, 18.6 yr | 0.000 % sunlight at all 30, for every observer definition | PASS |
| 2 | 30 well-lit pixels, primary definition (0 m, ignore < 60 m), fixed in advance | bias -7.6 pp, median abs 6.3 pp, p90 15.6 pp | **FAIL** (criteria: 5 / 5 / 12 pp) |
| 2 | 30 well-lit pixels, 2 m mast (challenge default) | bias +1.6 pp, median abs 3.9 pp, p90 6.3 pp, r = 0.90 | PASS |
| 2 | 30 well-lit pixels, 0 m, ignore < 120 m (chosen after seeing the results) | bias -1.7 pp, median abs 2.6 pp, p90 6.9 pp, r = 0.91 | PASS (chosen after the fact) |
| 2 | Earth visibility at all 60 pixels | mean abs 0.7 pp (primary), 1.1 pp (2 m mast) | PASS (criterion 10 pp) |
| 2 | Literature points (catalog) | within the published spread at 2 m (table 2.4) | consistent |
| 3 | Moon Trek header assumptions vs PGDA heights | scale 0.50009 (Int16, half-metres), 0.99912 (Float32, metres); CRS geographic, 1737.4 km sphere | PASS |
| 3 | Moon Trek 30 m (ImageServer) vs PGDA 30 m DEMs, 10 km around 2 sites | height std 2.1 / 9.2 m; masks beyond 1 km p95 0.15 / 0.30 deg; sunlight differs by 0.8 / 0.1 pp | consistent |
| 4 | Mast 2 m to 10 m | horizon lower or equal in every bin at all 3 sites; sunlight up or equal | PASS |
| 4 | Moving the site 100-500 m | ridge C1: down to **20 %** (from 85 %) after 100 m; Artemis plain: change at most 1.5 pp | key finding |

**Bugs found:** none in `horizon.py`, `terrain/*` or `visibility.py`; no fixes were needed. The
large differences seen were all traced to modelling choices (sections 1.3 and 2.3), not code errors.
One modelling caveat has consequences for the precompute, see 2.3: **do not use a 0 m observer
without excluding the near field**.

---

## Method

* **Terrain ("banded" DEM):** the horizon is the maximum terrain elevation over all distances, so it
  is the bin-by-bin maximum of the masks of disjoint distance bands, each computed on its own NASA
  GSFC PGDA product 90 DEM (Barker et al. 2023), passing `min_distance_m` = inner radius.
  * Task 1 and 4 (`BANDS_20M`): LDEM_80S_20MPP_ADJ (20 m) up to 15 km, LDEM_60S_120MPP_ADJ from 15 to
    60 km, LDEM_60S_240MPP_ADJ from 60 to 150 km.
  * Task 2 (`BANDS_40M`): the same, but 40 m (LDEM_80S_40MPP_ADJ) up to 20 km, because 60 sites are
    spread over ±45 km.
  * The site surface height always comes from the finest band and is passed explicitly, so every band
    uses the same observer point (`combine_masks` refuses mixed observers).
  * Why coarse DEMs far away are acceptable: an error dz in a crest height at distance d moves the
    horizon by dz/d. For example, 30 m at 30 km is 0.06 deg, about a ninth of the solar disc.
* **Ephemeris (`MoonCentreEphemeris`):** apparent (LT+S) Sun and Earth vectors from the Moon centre in
  MOON_ME, from SPICE `spkpos` with DE440 and moon_pa_de440 + the moon_de440_250416 frame kernel. They
  are made topocentric per site by subtracting the site vector, with the same east/north/up basis as
  `horizon.enu_basis`.
  * Checked against `SpiceProvider.compute` (per-observer `spkcpo`), 2026, 6 h steps: Sun elevation
    2.6e-9 deg, Sun on-sky azimuth 1.1e-8 deg; Earth elevation 2.7e-5 deg, Earth range 0.18 km.
  * The Earth difference is explained: the light-time difference between the surface and the centre
    is at most 5.8 ms, and the target moves at about 30 km/s in the barycentric frame where light time
    is solved. That gives 0.17 km, which is 2.6e-5 deg at the Earth's distance.
  * Cost: 18.6 yr at 6 h (27,174 epochs) takes 0.6 s once, for all sites.
* **Visibility:** `lunarnav.visibility.compute_visibility`.
  * `avg_illum_pct` is the mean visible fraction of the solar disc, the same quantity as PGDA
    AVGVISIB ("fraction of the solar disc").
  * `sun_any_pct` is the time with the upper limb visible.
  * `earth_any_pct` is the time with any part of the Earth disc visible, the PGDA Earth definition.
* **Period:** 2026-01-01 + 18.6 Julian years (to 2044-08-07), 6 h step. The 2026-2030 sub-period is
  also reported.
* **Azimuth bins:** 0.5 deg, 3 rays per bin, constant along-ray step of half a pixel of each band.

## 1. Raymarch vs brute force on real terrain (2 m mast)

The sites come from the catalog: ridge `ref_connecting_ridge_c1` (89.4505S 222.84E, surface 1957.3 m),
crater floor `psr_shackleton_floor` (89.67S 129.78E, -2788.9 m) and Artemis III region
`a3_de_gerlache_rim_2` (88.2226S 296.5651E, -159.6 m). Differences are brute force minus raymarch.

| site | p95 full | max full | p95 beyond 2 km | max beyond 2 km | mean beyond 2 km | horizon min / max |
|---|---|---|---|---|---|---|
| ridge C1 | 0.154 | 0.314 | **0.040** | 0.063 | +0.014 | -2.83 / -0.00 deg |
| Shackleton floor | 0.015 | 0.036 | **0.015** | 0.036 | +0.006 | 19.79 / 23.59 deg |
| de Gerlache Rim 2 | 0.920 | 2.432 | **0.070** | 0.133 | +0.024 | -2.78 / 13.87 deg |

Each azimuth bin's horizon is set by one band. The share of bins set by each band (20 m / 120 m /
240 m) is:
* C1: 46 / 32 / 22 %. All three bands matter: a ridge sees the distant massifs.
* Shackleton floor: 100 / 0 / 0 %. The crater wall about 10 km away decides everything.
* de Gerlache Rim 2: 58 / 15 / 26 %.

Runtime per site with a warm cache: raymarch 1.6-4.2 s, brute force 5.7-6.5 s.

Per band (brute force minus raymarch, p95 / mean, deg):

| site | 20 m, 0-15 km | 120 m, 15-60 km | 240 m, 60-150 km |
|---|---|---|---|
| C1 | 0.207 / +0.065 | 0.036 / +0.014 | 0.039 / +0.012 |
| Shackleton floor | 0.015 / +0.006 | 0.112 / **-0.044** (100 % of bins have their maximum at the 15 km inner edge) | 0.035 / +0.006 |
| de Gerlache Rim 2 | 1.660 / +0.277 | 0.059 / +0.012 (0.042 for bins not at the edge) | 0.042 / +0.013 |

### 1.1 Expected size of the difference

* Raymarch interpolates the DEM bilinearly between pixel centres.
* Brute force gives each cell its centre height over its whole azimuth footprint (flat-topped
  blocks). It is therefore slightly higher, which is why the mean is positive.
* Their difference in a bin is bounded by slope x pixel / distance:
  * 10-20 deg slopes on 20 m at 2 km give 0.10-0.20 deg;
  * 120 m at 15 km gives 0.08-0.16 deg;
  * 240 m at 60 km gives 0.04-0.08 deg.
* Every measured value lies inside these bounds.
* The synthetic test `test_banded_raymarch_vs_bruteforce_synthetic_rough_terrain` asserts the
  per-bin bound exactly.

### 1.2 Outliers (top 3 per site, from `outliers`)

* **Shackleton floor:** +0.036, +0.030 and +0.028 deg at az 174, 349.5 and 248. The horizon there is
  the crater wall at 9.7-11.1 km, at an elevation of 20-23 deg. The 20 m cells span about 0.11 deg in
  azimuth at that distance, so the block model adds slope x 10 m / 10 km. On a 35 deg wall that is
  about 0.04 deg, matching what was measured.
* **C1:** +0.31 deg at az 298-301. The horizon there is at **0.22 km** and -2 deg: terrain falling
  away from the crest. A 20 m cell at 220 m spans 5 deg of azimuth, and the block model spreads its
  centre height across that width.
* **de Gerlache Rim 2:** +2.4 deg at az 103.5-104.5. The horizon there is at **0.08-0.09 km**, i.e.
  4 pixels from the mast, on a gentle slope rising east. At 80 m one 20 m pixel spans 14 deg of
  azimuth and differences in its height of a few metres change the elevation by degrees.
* **120 m band at Shackleton floor (mean -0.044):** every bin has its band maximum exactly at the
  15 km inner cut, because the terrain beyond the rim falls away. Raymarch samples exactly at 15.000
  km, while brute force only sees cell centres beyond it. This is an artefact of the cut-off, and it
  is irrelevant: that band sets no bin of the final mask.

### 1.3 Interpretation

Beyond about 2 km (100 px) both independent algorithms agree to better than 0.07 deg p95, about an
eighth of the solar disc. Within about 20 px of the mast the horizon is limited by the DEM itself
(1-2 pixels, with metre-level errors), not by the algorithm. Near-field horizons should be treated
as uncertain at the 1-2 deg level.

## 2. Our illumination vs NASA's published LOLA-based maps

### 2.1 Reference products

These are PGDA product 69 (Mazarico et al. 2011, Icarus 211:1066, update 2016-08), 60 m polar
stereographic, 85S-90S (`docs/DATA_SOURCES.md` section 5):
* `AVGVISIB_85S_060M_201608.TIF`: average visible solar-disc fraction over 18.6 yr, hourly.
* `AVGVISIB_85S_060M_201608_EARTH.TIF`: Earth visibility, counting any part of the disc.
* `LPSR_85S_060M_201608.TIF`: permanently shadowed regions. The raw value 20000 is scaled to 1.0 (PSR).

A ±45 km window (1517 x 1517 px) around the pole is read once and cached.

**Pixel selection** uses fixed seeds, keeps pixels within 43 km of the pole and is deterministic:
* **PSR (30 pixels):** LPSR = 1 and AVGVISIB = 0 in the whole 5x5 window (interior of PSRs), at
  least 1 km apart. They lie in Shackleton, de Gerlache, Sverdrup, Faustini-rim and other craters,
  89.8S to 88.6S.
* **Well-lit (30 pixels):** 10 per AVGVISIB range [0.5, 0.6), [0.6, 0.7) and [0.7, 1.0], at least
  300 m apart.
  * The two lower ranges also need a 3x3 minimum of at least 0.40 / 0.45 and a 3x3 range of at most
    0.25 / 0.30.
  * The top range needs only a 3x3 minimum of at least 0.40, which guards against the isolated
    zero-valued artefact pixels. Pixels at or above 0.7 always sit on narrow crests: only 2 of 134
    candidates have a 3x3 minimum within 0.15.
  * The selected values run from 50.1 to 76.8 %.
* **Catalog literature points:** the reference group with `reference_illumination_pct`.

### 2.2 Period and sampling mismatch (measured)

* **18.6 yr vs 2026-2030:** the 5-yr result differs from the 18.6-yr result by +0.5 pp on average,
  at most 1.2 pp (lit pixels). Earth: at most 1.2 pp. The solar inclination cycle (draconic year) is
  the dominant one, so the start of the 18.6-yr window matters very little.
* **6 h vs 1 h step** (C1, 2026-2027, primary definition): 79.806 % vs 79.803 % (0.003 pp). Earth:
  55.34 % vs 55.27 %.
* Our window starts in 2026, while Mazarico's 18.6-yr window started earlier. Given the two points
  above, this contributes at most about 1 pp.

### 2.3 Observer definition: the key modelling choice

A point exactly on the DEM surface (0 m) sits on a tilted bilinear facet. Its own slope then blocks
the Sun in roughly the uphill half of the azimuths.
* At C1, 20 m DEM: 44 % at 0 m, 77 % with terrain below 60 m ignored, 85 % with a 2 m mast.
* At the Shackleton rim: 50 / 73 / 82 %.

The comparison was therefore made for four definitions:
* `pixel60`: **primary, fixed before the comparison.** 0 m observer as stated for the references;
  terrain inside the reference's own 60 m pixel ignored.
* `surface0`: 0 m observer, nothing ignored.
* `mast2`: 2 m mast, the challenge default.
* `excl120`: 0 m observer, terrain below 120 m (two reference pixels) ignored. **Added after seeing
  the results**, as a sensitivity check.

Statistics are ours minus PGDA in percentage points (pp), over the 30 lit pixels and 18.6 yr:

| definition | bias | median abs | p90 abs | max abs | r | bias 50-60 / 60-70 / 70-100 % | verdict |
|---|---|---|---|---|---|---|---|
| pixel60 (primary) | -7.58 | 6.32 | 15.59 | 20.8 | 0.85 | -3.1 / -7.1 / -12.5 | **FAIL** |
| surface0 | -14.99 | 15.89 | 28.63 | 30.2 | 0.30 | -4.8 / -14.7 / -25.5 | FAIL |
| mast2 | +1.64 | 3.86 | 6.30 | 11.8 | 0.90 | +2.2 / +1.2 / +1.5 | PASS |
| excl120 (chosen after the fact) | -1.69 | 2.64 | 6.86 | 13.5 | 0.91 | +0.5 / -2.6 / -2.9 | PASS |

The criteria (`ILLUM_CRITERIA`) were set before the comparison: |bias| ≤ 5 pp, median |d| ≤ 5 pp,
p90 |d| ≤ 12 pp. Their reasons:
* the DEM versions differ (2016 LOLA vs Barker 2023: a few metres rms, 16 m p99);
* the reference is a 60 m pixel average, while ours is a point value from a 40 m DEM;
* the periods differ (about 1 pp, see 2.2);
* the literature itself spreads by more than 10 pp at the same point (C1: Gläser 76.0, Mazarico 89.0,
  Speyerer 64.2 %).

**Findings:**
* The PGDA map agrees with our pipeline within a few pp when the observer is not glued to its own DEM
  facet: a 2 m mast, or the nearest ~2 reference pixels ignored. Correlation is 0.90-0.91 over a range
  of 50-77 %.
* With the a-priori 0 m / 60 m definition our values are lower, and the gap grows with illumination
  (-3, -7, -12.5 pp). The best-lit pixels sit on crests where terrain 60-120 m away, 1-2 m higher
  than the observer, hides the low Sun.
* A quick check on the 60 m PGDA DEM (LDEM_60S_60MPP_ADJ, the same grid as the reference) gave the
  same pattern, 2026-2030: 0 m / 60 m bias -4.6 pp, 0 m / 120 m -0.1 pp, 2 m mast +3.6 pp. So the
  reference appears not to include self-shadowing by the first one to two neighbouring pixels.
* This is a modelling definition, not a code bug.

**Consequence for the precompute:**
* Use a mast of at least 1-2 m, which the default `config.DEFAULT_OBSERVER_HEIGHT_M = 2` already does.
* Never present 0 m surface values without an explicit near-field rule: they depend on metre-level
  DEM noise within about 100 m.

**PSR (30 pixels):** average illumination is **0.000 %** and the upper limb is never visible
(`sun_any` = 0) at all 30 pixels, for all four definitions, over the full 18.6 yr. PASS: criterion
< 1 % at every pixel, at least 80 % exactly 0.

**Earth visibility (all 60 pixels, any part of the disc):**
* Mean abs difference: 0.71 pp (pixel60), 1.05 pp (mast2), 0.75 pp (excl120), 1.56 pp (surface0).
* Max: 7.8 / 6.3 / 7.0 / 11.0 pp. PASS (criterion 10 pp).
* Examples: PSR pixel 88.589S 46.31E, PGDA 39.9 %, ours 39.8 %; PSR pixel 89.375S 121.8E, PGDA 32.7 %,
  ours 32.5 %. The Earth can be visible from inside a PSR.

### 2.4 Literature points (catalog, 40 m bands, 18.6 yr)

Each cell gives average illumination % / upper-limb-visible %.

| point | published values (%) | ours pixel60 | ours excl120 | ours mast2 | longest dark (mast2) |
|---|---|---|---|---|---|
| Ridge C1 89.4505S 222.84E | Gläser 2018 76.0 (0 m), 88.0 (2 m); Mazarico 2011 89.0; Speyerer 2013 64.2; PGDA pixel 86.4 | 78.6 / 83.8 | 82.2 / 87.1 | **85.7** / 90.5 | 126 h |
| Ridge C2 89.3157S 245.94E | Gläser 75.6 (0 m), 78.1 (2 m); PGDA 74.9 (3x3 max 79.4) | 75.9 / 81.1 | 77.8 | **78.0** / 81.8 | 168 h |
| Shackleton rim 89.7849S 203.97E | Gläser 81.0 (0 m), 85.5 (2 m); Mazarico 86.7; Speyerer 71.6; PGDA 85.5 | 73.0 / 78.1 | 77.9 | **81.8** / 86.2 | 174 h |
| de Gerlache rim 88.6646S 291.60E | PGDA 82.7 | 77.1 / 80.5 | 77.3 | **80.4** / 83.3 | 258 h |
| Shackleton floor (PSR) | 0 | 0.0 | 0.0 | 0.0 | whole period |
| Haworth floor (PSR) | 0 | 0.0 | 0.0 | 0.0 (Earth 4.8 %) | whole period |

At 2 m our values agree with Gläser 2018 (20 m DEM, 2017-2037, 2 m) to within -2.3 / -0.1 / -3.7 pp
at C1, C2 and the Shackleton rim. At the literature points the Earth is visible 56-61 % of the time.

**DEM resolution effect** at the task-1 sites (20 m vs 40 m near band):
* C1: pixel60 77.2 vs 78.6 %; mast2 85.2 vs 85.7 %; surface0 44.1 vs 71.6 %. The 0 m case is again
  ill-posed.
* de Gerlache Rim 2: mast2 37.4 vs 37.6 %.

## 3. Moon Trek vs PGDA (DEM source cross-check)

### 3.1 Header assumptions (`trek_header_check`, first 4-12 MB of each file only, cached)

| Trek file | dtype | CRS | scale/offset tags | PGDA reference | least-squares PGDA/raw | residual median / std |
|---|---|---|---|---|---|---|
| LRO_LOLA_DEM_SPole875_5mp_v04_EQ | int16 (registry agrees) | geographic, sphere 1 737 400 m | 1 / 0 (absent) | LDEM_75S_30MPP_ADJ, 300 pts at about 86.5S | **0.50009** (assumed 0.5) | -0.10 / 3.19 m |
| LRO_LOLA_DEM_SPole75_30mp_v04_EQ | float32 (agrees) | geographic, sphere 1 737 400 m | 1 / 0 | LDEM_60S_120MPP_ADJ, 300 pts at about 68.9S | **0.99912** (assumed 1.0) | +1.19 / 22.8 m (120 m vs 30 m grid) |

PASS: the scale is within 1 %, the median residual is under 5 m, dtype and CRS are as registered,
and the pixel sizes are as registered. The tag block at the end of the 1-2 GB files could not be
inspected here. On Colab, `download_product(verify=True)` re-checks it, and the comparison below can
then be run on the full files.

### 3.2 Height and horizon comparison (`compare_dem_sources`, 10 km radius, 2 m mast, same observer point)

The comparison is Moon Trek `TrekImageServerDem("LRO_LOLA_DEM_SPole75_30mp_v04")`, the native polar
grid, against PGDA `LDEM_75S_30MPP_ADJ` on the same 30 m grid.

| site | height diff median / std / p99 abs / max abs (m) | site height Trek / PGDA (m) | mask diff p95 / max, all terrain | mask diff p95 / max, beyond 1 km | avg illum Trek / PGDA | Earth Trek / PGDA |
|---|---|---|---|---|---|---|
| Shackleton rim | +0.27 / 9.17 / 41.6 / 81.0 | 1736.03 / 1736.71 | 5.17 / 7.72 deg | 0.30 / 0.64 deg | 91.34 / 91.22 % | 70.91 / 71.94 % |
| Ridge C1 | +0.14 / 2.07 / 6.4 / 18.1 | 1957.56 / 1957.34 | 0.53 / 0.58 deg | 0.15 / 0.34 deg | 88.97 / 89.75 % | 65.70 / 65.96 % |

(These illumination values use terrain within 10 km only, so they are not comparable to section 2.)

* **Heights:** the two releases agree in the median to better than 0.3 m. The spread is larger on the
  steep Shackleton inner wall (std 9 m, max 81 m where 30 m pixels straddle the rim), which is
  expected for different LOLA processing (Trek v04 uses data to 2011; Barker 2023 has more tracks
  and is crossover-adjusted).
* **Horizon:** metre-level height differences next to the mast change the near-field horizon by
  several degrees. Beyond 1 km the masks agree to 0.15-0.30 deg p95.
* **Sunlight:** within 0.1-0.8 pp at both sites.

On Colab, the same function runs on the full Trek files:
`compare_dem_sources(TrekDem("LRO_LOLA_DEM_SPole75_30mp_v04_EQ", patch_resolution_m=30), PgdaDem("LDEM_75S_30MPP_ADJ"), site, 20_000, eph=...)`.
It is tested on synthetic data (`test_compare_dem_sources_synthetic_offset_and_extra_hill`): a +3 m
offset is recovered exactly, and an extra 200 m hill 5 km east is found at az 90 ± 1 deg with its
exact elevation within 0.03 deg.

## 4. Sensitivity checks

### 4.1 Mast height 2 m to 10 m (20 m bands, 18.6 yr)

| site | min / mean / max horizon drop (deg) | monotone in every bin | avg illum 2 m to 10 m | upper limb visible | longest dark |
|---|---|---|---|---|---|
| Ridge C1 | 0.003 / 0.403 / 1.742 | yes | 85.24 to **92.39 %** | 90.1 to 95.4 % | 132 to 90 h |
| Shackleton floor | 0.036 / 0.040 / 0.042 | yes | 0 to 0 % | 0 to 0 % | whole period |
| de Gerlache Rim 2 | 0.003 / 0.333 / 2.191 | yes | 37.43 to 38.75 % | 38.7 to 40.1 % | 498 h |

The Earth is visible essentially the same amount at both heights (C1 58.06 to 58.08 %).

* The physics is exact: el = atan2(h_terrain - h_obs - curvature, d) decreases as h_obs increases for
  every terrain sample, so the per-bin maximum cannot rise.
* The largest drops (1.7-2.2 deg) are near-field bins, where 8 m more mast over 200-300 m of terrain
  matters most.
* At the floor of Shackleton the drop is about 8 m / 11 km = 0.04 deg against a 20-23 deg wall:
  still dark.

### 4.2 Moving the site by 100 / 250 / 500 m (8 directions, 2 m mast, 20 m bands, 18.6 yr)

Each moved site gets its own DEM surface height and horizon mask.

| site (base illum, Earth) | 100 m: illum min-max (max change) | 250 m | 500 m | Earth max change 100 / 250 / 500 m |
|---|---|---|---|---|
| Ridge C1 (85.2 %, 58.1 %) | **20.3-84.7 % (64.9 pp)** | 42.4-77.5 % (42.9 pp) | 40.1-70.2 % (45.1 pp) | 15.4 / 13.1 / 26.2 pp |
| Shackleton rim (83.2 %, 56.5 %) | **44.2-68.5 % (39.0 pp)** | 42.6-58.6 % (40.6 pp) | 38.1-55.0 % (45.1 pp) | 14.6 / 24.1 / 38.2 pp |
| de Gerlache Rim 2, Artemis region (37.4 %, 54.3 %) | 37.4-38.2 % (0.7 pp) | 37.0-38.5 % (1.1 pp) | 36.5-38.9 % (1.5 pp) | 0.1 / 0.3 / 0.6 pp |

* At C1, moving 100 m to the north-east (bearing 45) loses 8 m of height and drops the average
  illumination from 85 % to 20 %. The longest night grows from 120-130 h to **4122 h** (172 days).
* At the Shackleton rim, 100 m to the north (bearing 0) gives a longest night of 2100 h.

**Key insight for the challenge ("small changes matter"):** on south-pole crests a 100 m error in
the landing point can change the solar energy by up to 65 pp. On a smooth plain such as the de
Gerlache Rim 2 region centre the same move changes it by less than 1 pp. Site rankings should
therefore be made on the exact landing ellipse, never on a region centre.

## 5. Test map (tests/test_crosscheck_terrain.py)

| test | what it asserts | net |
|---|---|---|
| test_banded_mask_flat_sphere_matches_geometric_dip_and_mast_monotone | flat sphere: every bin is the exact dip within 1e-3 deg; 2 m to 10 m drop = 0.1075 deg | offline |
| test_banded_mask_equals_single_band_and_bands_pick_the_right_hill | banded = single band within 0.02 deg; band_of_max correct; exact far-crest elevation | offline |
| test_banded_raymarch_vs_bruteforce_synthetic_rough_terrain | per-bin bound slope x res / d; p95 < 0.1 deg | offline |
| test_combine_masks_rejects_inconsistent_observers | errors raised for mixed observers and bad bands | offline |
| test_offset_site_distance_and_bearing_against_pyproj_geod | offset distance and bearing within 1e-6 | offline |
| test_compare_dem_sources_synthetic_offset_and_extra_hill | +3 m offset recovered; hill found east with exact elevation | offline |
| test_pixel_selection_respects_interior_smoothness_and_separation | selection rules hold and are deterministic | offline |
| test_longest_run_and_metrics_on_flat_horizon | run lengths | offline |
| test_moon_centre_vector_ephemeris_matches_spice_provider | within 1e-4 deg / 0.5 km of SpiceProvider | kernels |
| test_flat_horizon_polar_illumination_physics | flat 89.5S: 50 ± 3 % Sun, 50 ± 8 % Earth; 10 m mast gives more | kernels |
| test_trek_header_assumptions_vs_pgda | scale 0.5 / 1.0 within 1 %; CRS sphere | network |
| test_real_terrain_raymarch_vs_bruteforce_ridge | C1 beyond 2 km p95 < 0.08 deg, max < 0.3 deg | network, slow |
| test_real_psr_and_lit_pixels_vs_pgda_illumination_maps | PSR < 1 %; mast2 within criteria; definitions ordered (exact physics) | network, slow |
| test_real_mast_height_and_small_moves_matter_at_the_ridge_not_on_the_plain | mast monotone; C1 changes > 10 pp at 100 m; plain < 3 pp | network, slow |
| test_real_trek_imageserver_vs_pgda_30m_around_ridge | height std < 5 m; mask beyond 1 km p95 < 0.3 deg | network |

## 6. Limitations

* The Trek full-file path (`TrekDem`) was not run on real downloaded files here. That comparison is
  written (`compare_dem_sources`) and tested on synthetic data, ready for Colab.
* The reference near-field rule of Mazarico et al. could not be confirmed from the product
  documentation. The rule we infer (no self-shadowing within about 2 pixels) comes from the variant
  study in 2.3.
* The PSR / lit samples cover ±43 km around the pole only, to keep the windowed reads light. The
  Artemis regions at 84-86S are not part of the pixel sample.
* The illumination uses the disc-fraction rule of `visibility.py`: a straight horizon across the
  disc, no limb darkening.
