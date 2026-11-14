# Precompute output specification (format `lunarnav-precompute`, version 1)

This is the contract between the computation backend and any future UI. A directory is **correct**
when `lunarnav check DIR` (= `lunarnav.precompute.check_output(DIR)`) reports **0 violations**;
every invariant below that is marked **[checked]** is implemented there and covered by
`tests/test_precompute.py` (which also corrupts outputs on purpose and asserts that each corruption
is caught).

## 1. Conventions (apply to every file)

| Quantity | Convention |
|---|---|
| Time | UTC, ISO 8601 `YYYY-MM-DDTHH:MM:SSZ`, 1 s resolution. Samples `t_k = start + k*step`, `k = 0..n-1`; sample `k` represents the interval `[t_k, t_k + step)`; the covered range is `[start, end)` with `end = start + n*step`. |
| Site coordinates | planetocentric latitude (deg, -90..90) and **EAST** longitude (deg, [0, 360)), Moon Mean-Earth/Polar-Axis frame (MOON_ME, the LOLA frame). |
| Heights | metres above the 1737.4 km reference sphere. Observer = surface + mast (`observer_height_m`, default 2 m). |
| Azimuth | deg in [0, 360), clockwise from local north (towards the lunar north pole): N=0, E=90, S=180, W=270 (as JPL Horizons). |
| Elevation | deg above the plane perpendicular to the local sphere radial; airless (no refraction); apparent (light time + stellar aberration, as Horizons `a-app`). |
| Bodies | Sun and Earth positions are for the body **center**. |
| Booleans | `1` / `0` in CSV, `true` / `false` in JSON. |
| Missing value | empty CSV field / JSON `null`. Never `nan`, `inf`. |

### Visibility rules (lunarnav/visibility.py)
* `sun_semidiam_deg = asin(695700 km / sun_dist_km)` (0.2620..0.2711 deg).
* `sun_fraction` = fraction of the solar disc area above the terrain horizon, the horizon being a
  straight line at `horizon_el_sun_deg` (horizon elevation at the Sun's azimuth). With
  `x = clip((sun_el - horizon_el_sun) / semidiam, -1, 1)`:
  `sun_fraction = 1/2 + (x*sqrt(1-x^2) + asin(x)) / pi` (circular-segment area). Limb darkening ignored.
* `sun_visible = sun_fraction > 0` ⇔ **upper limb above the terrain horizon** ⇔
  `sun_el + semidiam > horizon_el_sun`. Same style as the Horizons "daylight" solar-presence flag
  (upper limb on/above the horizon) but against the *terrain* horizon and without refraction.
* `power_horizontal = sun_fraction * max(0, sin(sun_el))` (flat-lying panel), `power_tracking =
  sun_fraction` (panel normal follows the Sun; for an azimuth-only tracking *vertical* panel the factor
  is `cos(sun_el)` ≥ 0.9996 at the poles, i.e. identical within 0.04 %). Both relative to a fully
  exposed panel facing the Sun; `irradiance_tracking_wm2 = 1361 * (AU / sun_dist_km)^2 * sun_fraction`.
* `earth_clearance_deg = earth_el - horizon_el_earth`; `earth_visible = earth_clearance_deg >
  min_earth_clearance_deg` (manifest parameter, 0..10 deg, default 0). `earth_fraction` (informative):
  disc fraction of the Earth (semi-diameter `asin(6378.137 / earth_dist_km)`, ~0.95 deg).
* `both_visible = sun_visible AND earth_visible` (power + direct-to-Earth link).
* Flat horizon (no DEM): `horizon_el = -acos((R+H)/(R+H+h))` at every azimuth (R = 1737.4 km,
  H = surface height, h = mast); 2 m mast → -0.0869 deg.

### Windows (lunarnav/windows.py)
A window is a maximal run of samples with the same state. `start = t_i` (first sample), `end = t_j`
(first sample of the next window, or range end): exclusive. The real transition lies in
`(t_{j-1}, t_j]`, so **boundaries are accurate to ± one step**. `truncated_start` = the window starts
at the range start (its true start is earlier or unknown), `truncated_end` = it runs to the range end.

## 2. Directory layout

```
OUT/
  manifest.json
  sites.json
  summary.csv
  sites/<site_dir>/horizon_<method>.csv          method = raymarch | bruteforce | flat | ...
  sites/<site_dir>/ephemeris_<provider>.csv.gz   provider = horizons | spice | analytic | synthetic
  sites/<site_dir>/visibility.csv.gz
  sites/<site_dir>/windows.json
```
`site_id` matches `[A-Za-z0-9_.:-]{1,64}` (':' for the canonical custom ids of
`lunarnav.sites.custom_site`, e.g. `custom:-89.4500:222.6900`); `site_dir` = `site_id` with ':'
replaced by '_' (`custom_-89.4500_222.6900`). Directory names are unique **ignoring case** (ids `X`
and `x` are rejected: they would share one directory on Windows / macOS). Readers take file paths
from the `files` of each `sites.json` record rather than building them from the id. Files are written deterministically: identical inputs and
`run_timestamp_utc` give byte-identical files (fixed float formats, gzip mtime 0, sorted JSON keys).

## 3. Files

### 3.1 `manifest.json`
| Key | Type | Meaning |
|---|---|---|
| `format`, `format_version` | str, int | `"lunarnav-precompute"`, `1` **[checked]** |
| `code_version` | str | `lunarnav.__version__` |
| `git_commit` | str/null | 40-hex commit of the code checkout, null if not a git checkout with commits |
| `run_timestamp_utc` | str | run time, **passed in** by the caller (CLI: now, or `--run-timestamp`) |
| `parameters` | object | `start_utc`, `end_utc` (exclusive), `step_minutes`, `step_s`, `n_samples`, `provider`, `dem`, `horizon_method`, `observer_height_m`, `min_earth_clearance_deg`, `rank_weights`, `site_ids`, `provider_config` (plain-valued provider attributes, e.g. SPICE `lunar_set`, `frame`, `abcorr`), plus CLI extras (`horizon_radius_km`, `az_step_deg`, `dem_res_m`, `dem_label`, `dem_path`, `dem_fallback`), plus the horizon rules of `make_horizon_fn` (present whenever the horizon spec is a `make_horizon_fn` callable, so they are in the fingerprint and a rule change makes `--resume` recompute): `near_exclusion_m` (`"auto"` = raymarch ignores terrain < 250 m when the finest DEM is ≤ 5 m, nothing on coarser DEMs; or metres; CLI `--near-exclusion-m`), `eq_row_min_distance` (bool: first raymarch sample ≥ one pixel of the Moon Trek 30 m `*_EQ` near-field file at the site latitude, 86.7 m; the 5 m and 100 m `_EQ` products are not affected), `bruteforce_footprint` (brute-force footprint model, `"central-half-cap6-floor-40px-v3"`; former `"whole-cell-v1"`; see `docs/VALIDATION_TERRAIN.md` §7) |
| `params_fingerprint` | str | 16-hex hash of the parameters except `site_ids`, plus `code_version` and `git_commit` (used by `--resume`, which also requires identical site inputs: id, name, lat/lon, origin, group, input height) |
| `data_sources` | list | `{name, url, sha256, ...}` for the ephemeris service / kernels and DEM products used (deduplicated, sorted) |
| `conventions` | object | human-readable statement of §1 |
| `files` | object | `relative path -> sha256` of every other file **[checked: present, checksum matches]** |

### 3.2 `sites.json`
`{"format_version": 1, "sites": [record, ...]}` in input order (= `parameters.site_ids` **[checked]**).
Record: `id, name, lat_deg, lon_deg, origin, group, source, note, height_m_input` (null = read from
DEM), `surface_height_m` (used), `observer_height_m` (mast), `observer_height_above_sphere_m`,
`horizon_method`, `dem_source` (`none:outside-<dem>-coverage` = smooth-sphere horizon given by
`--dem-fallback flat` to a site the DEM does not cover), `horizon_radius_km` (null = unbounded), `horizon_min_el_deg`,
`horizon_max_el_deg`, `files: {horizon, ephemeris, visibility, windows}` (relative paths).

### 3.3 `sites/<id>/horizon_<method>.csv`
| Column | Unit | Range / meaning |
|---|---|---|
| `az_deg` | deg | uniform grid `i * step`, strictly increasing in [0, 360) **[checked]** |
| `el_deg` | deg | terrain horizon elevation (max terrain elevation in the azimuth bin); may be < 0 (dip) **[checked: within ±90]** |
| `covered_radius_km` | km | radius up to which terrain was actually searched in that direction (DEM edge / nodata shorten it); flat mask: distance to the geometric horizon **[checked: ≥ 0]** |

Horizon elevation at an arbitrary azimuth = periodic linear interpolation (`HorizonMask.at`).

The per-site near-field rule actually applied is not written to the files; it is in the in-memory
`HorizonMask.meta` returned by `make_horizon_fn` (raymarch: `near_exclusion_request` (as given),
`near_exclusion_m` (applied, m), `min_distance_m`, `first_sample_m` (first ray sample, m),
`eq_row_min_distance_m` (one pixel of the Trek 30 m `_EQ` file, m, or null); brute force:
`near_exclusion_m` = 0, `footprint_fraction`, `footprint_extent`, `footprint_near_px`,
`footprint_floor`, `footprint_max_deg`, `footprint_model`, `n_footprint_cells_central`,
`n_footprint_cells_floor`; PGDA bands: `near_exclusion_m` and, for raymarch, `first_sample_m`).
`"auto"` is decided from the DEM's own finest data resolution (finest NestedDem level, first PGDA
band), never from `--dem-res-m`; an unknown resolution never gets the 250 m exclusion.

### 3.4 `sites/<id>/ephemeris_<provider>.csv.gz`
`time_utc, sun_az_deg, sun_el_deg, sun_dist_km, earth_az_deg, earth_el_deg, earth_dist_km` — raw
provider output for the observer point (angles %.6f deg, distances %.3f km). Same times and az/el as
the visibility file **[checked, ±3e-6 deg]**.

### 3.5 `sites/<id>/visibility.csv.gz` (one row per time step)
| Column | Unit | Range | Notes |
|---|---|---|---|
| `time_utc` | UTC | uniform step, covers `[start, end)` **[checked]** | |
| `sun_az_deg`, `earth_az_deg` | deg | [0, 360) **[checked]** | |
| `sun_el_deg`, `earth_el_deg` | deg | [-90, 90] **[checked]** | |
| `sun_dist_km` | km | 1.46e8..1.53e8 **[checked]** | observer → Sun center |
| `earth_dist_km` | km | 3.50e5..4.10e5 **[checked]** | observer → Earth center |
| `sun_semidiam_deg`, `earth_semidiam_deg` | deg | ~0.262..0.271, ~0.89..1.04 | `asin(R/d)` **[checked for Sun, ±1e-6]** |
| `horizon_el_sun_deg`, `horizon_el_earth_deg` | deg | | horizon file interpolated at the body azimuth **[checked, ±1e-5]** |
| `sun_clearance_deg` | deg | | `sun_el - horizon_el_sun` (Sun *center*) **[checked]** |
| `sun_fraction` | – | [0, 1] | circular-segment formula **[checked, ±2e-5]** |
| `sun_visible` | bool | | `sun_fraction > 0` ⇔ upper limb above horizon **[checked]** |
| `power_horizontal` | – | [0, 1] | `fraction * max(0, sin el)` **[checked]** |
| `power_tracking` | – | [0, 1] | `= sun_fraction` **[checked]** |
| `irradiance_tracking_wm2` | W/m² | 0..~1420 | **[checked, ±0.01]** |
| `earth_clearance_deg` | deg | | `earth_el - horizon_el_earth` **[checked]** |
| `earth_fraction` | – | [0, 1] | informative **[checked range]** |
| `earth_visible` | bool | | `earth_clearance_deg > min_earth_clearance_deg` **[checked]** |
| `both_visible` | bool | | `sun_visible AND earth_visible` **[checked]** |
| `hours_until_sunset` | h | ≥ 0 | 0 if Sun not visible; else time to the start of the next dark window; empty if no sunset before range end **[checked]** |
| `hours_until_sunrise` | h | ≥ 0 | 0 if Sun visible; else time to next sunrise; empty if none in range **[checked]** |
| `hours_until_earthset`, `hours_until_earthrise` | h | ≥ 0 | same for Earth **[checked]** |

All "hours until" values are accurate to ± one step. For an instant between samples use
`lunarnav.windows.time_until_sunset / next_sunrise / time_until_earthset / next_earthrise`.

### 3.6 `sites/<id>/windows.json`
```
{ "site_id", "step_s", "n_samples", "range_start_utc", "range_end_utc", "min_earth_clearance_deg",
  "sun":   [window, ...],   // state true = Sun visible, false = dark
  "earth": [window, ...],   // state true = Earth visible (DTE possible), false = comms gap
  "both":  [window, ...],
  "metrics": {...}, "params_fingerprint", "site_record" (= sites.json record), "data_sources" }
window = { "start", "end" (exclusive), "duration_h", "state", "truncated_start", "truncated_end",
           "start_index", "end_index" (sample indices, end exclusive) }
```
Metrics (time-weighted over the range): `duration_h`; `pct_sun`, `pct_earth`, `pct_both`,
`pct_sun_no_earth` (percent 0..100); `longest_dark_h`, `longest_comms_gap_h`, `longest_sun_h`,
`longest_earth_h` (hours) with `*_truncated` (true → touches the range boundary, value is a lower bound);
`n_sun_windows`, `n_dark_windows`, `n_earth_windows`, `n_comms_gaps` (counts, truncated included);
`mean_sun_el_lit_deg` (mean Sun elevation over lit samples, null if never lit);
`mean_power_horizontal`, `mean_power_tracking` (0..1, mean over the whole range).

### 3.7 `summary.csv` (one row per site, sorted by rank)
`rank, site_id, name, group, lat_deg, lon_deg, surface_height_m, score, pct_sun, pct_earth, pct_both,
pct_sun_no_earth, longest_dark_h, longest_dark_truncated, longest_comms_gap_h,
longest_comms_gap_truncated, longest_sun_h, longest_earth_h, n_sun_windows, n_dark_windows,
n_earth_windows, n_comms_gaps, mean_sun_el_lit_deg, mean_power_horizontal, mean_power_tracking,
horizon_min_el_deg, horizon_max_el_deg`.
`score = Σ rank_weights[k] * metric[k]` (default `0.4 pct_sun + 0.3 pct_earth + 0.3 pct_both`, 0..100);
ties → shorter `longest_dark_h`, then `site_id`.

## 4. Invariants of a correct output (all **[checked]** by `check_output`)

`check_output` recomputes every derived quantity from the written columns with its own code: the
`hours_until_*` columns (next-index search) and all window metrics (run-length encoding) are NOT
computed with the writer's `windows.py` functions, so a bug there cannot pass the check.

Structural
1. Manifest has all keys, known format; every listed file exists and its sha256 matches.
2. `sites.json` ids = `parameters.site_ids`; `summary.csv` has the same ids, ranks are exactly 1..N
   and scores are non-increasing with rank.
3. Each visibility file: `n_samples` rows, strictly uniform `step_s`, first time = `start_utc`,
   last time + step = `end_utc`; identical time axis and az/el in the ephemeris file.

Windows
4. For sun / earth / both: windows **tile the full range without gaps or overlaps** — first start =
   range start, last end = range end, `end_k = start_{k+1}`, consecutive states differ (maximal runs),
   `duration_h = end - start`, sample counts add up to `n_samples`.
5. Only the first window has `truncated_start`, only the last has `truncated_end`.
6. Every window's state equals the corresponding visibility column on all of its samples.
7. Metrics recomputed from the visibility file match `windows.json` (percentages ±1e-6, hours ±1e-5,
   counts exactly; `mean_sun_el_lit_deg`, `mean_power_*` ±1e-5) and `summary.csv` (±1e-5);
   `0 ≤ pct ≤ 100`; `pct_both ≤ min(pct_sun, pct_earth)`; longest runs ≤ range duration.

Visibility rules (tolerances come from the %.6f rounding of each written angle)
8. `sun_visible` ⇒ `sun_el + semidiam > horizon_el_sun` and not visible ⇒ `≤` (±3e-6 deg);
   `sun_fraction` = circular-segment formula of the written angles (±2e-5: df/dh ≤ 2/(π r) ≈ 2.4 per
   degree times 2 roundings, ×2 margin); `sun_fraction = 0` when not visible.
9. `earth_visible` ⇔ `earth_clearance_deg > min_earth_clearance_deg` (±3e-6 deg band ignored);
   clearances = elevation − horizon; `both = sun AND earth`; power and irradiance formulas.
10. Horizon columns = horizon file interpolated at the body azimuth (±1e-5 deg).
11. `hours_until_*` columns consistent with the visibility flags (±1e-3 h; empty ⇔ no event in range).

Physics sanity (catch frame / sign / longitude-convention errors)
12. Polar sites (|lat| ≥ 80°): `|sun_el| ≤ (90 − |lat|) + 1.65°` — the Sun's declination in the
    lunar frame never exceeds 1.543° (lunar equator vs ecliptic) — **at the south pole the Sun stays
    within ~1.6° of the horizon**; `|earth_el| ≤ (90 − |lat|) + 7.3°` (optical libration in
    latitude ≤ 6.85° plus Earth parallax ≤ 0.29°).
13. Near-polar sites (85° ≤ |lat| < 89.99°): `earth_az` within 15° of the great-circle bearing from
    the site to the sub-Earth mean point (0°N, 0°E). At the south pole this bearing is
    `(360 − lon) mod 360`: **Earth is due north (az ≈ 0°) for lon ≈ 0°**, e.g. az ≈ 137° at the
    Shackleton rim (lon 222.7°E). The 15° bound covers the ±8° libration in longitude.
14. Far side: if the site is more than 105° from (0°N, 0°E), `earth_el < 0` always; beyond 110°,
    `earth_visible` is never true (Earth ≤ −9° below the geometric horizon; no lunar terrain dip is that
    large) → **far-side sites have 0 % Earth**.
15. Distances in the physical ranges of §3.5; `sun_semidiam = asin(R_sun/d)`.
16. Site latitude in [-90, 90], longitude in [0, 360).

## 5. How to check

```
lunarnav check OUT_DIR             # prints each violation, exit code 1 if any
python -c "from lunarnav.precompute import check_output; print(check_output('OUT_DIR'))"
```
`lunarnav precompute` runs the check automatically at the end (disable with `--no-check`).
Cross-method validation (Horizons vs SPICE vs analytic; raymarch vs bruteforce) is a separate step:
`lunarnav validate ...` (see docs/ARCHITECTURE.md).

Reference numbers that a correct run reproduces (from the tests):
* Equatorial lunar day: 354.37 h (half synodic month) + 1.39 h (upper limb + 2 m mast dip) = 355.8 h ±1 h.
* Solar semi-diameter at 1 AU 0.26645°, flat-horizon dip for a 2 m mast 0.08694°.
* Horizons vs analytic directions (Shackleton rim, Apollo 11, March 2026): ≤ 0.003°; visibility flags
  differ at ≤ 1 sample per rise/set.
