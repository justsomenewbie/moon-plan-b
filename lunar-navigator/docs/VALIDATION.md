# Validation - ephemeris section

Owner of this section: `lunarnav/validate.py` (ephemeris cross-check) and `tests/test_crosscheck_ephem.py`.
The terrain/horizon section lives in [VALIDATION_TERRAIN.md](VALIDATION_TERRAIN.md) and runs through the hook
`lunarnav.validate.validate_terrain_hook()`, which calls `lunarnav.validate_terrain.run()`.

The question this section answers: **are the Sun and Earth positions in the sky correct?** We compute the same
quantities three independent ways and require them to agree within justified limits:

| | Method | Source | Lunar frame | Notes |
|---|---|---|---|---|
| A | `HorizonsProvider` | JPL Horizons API (challenge Resources tab), DE441 | "MEAN_ME (high precision)", the DE421 mean-Earth frame realised from DE440 PA | airless apparent az/el, coord@301 on the 1737.4 km sphere |
| B | `SpiceProvider` | NAIF SPICE generic kernels, DE440 (`de440s.bsp`), `moon_pa_de440_200625.bpc` + `moon_de440_250416.tf` | `MOON_ME` = `MOON_ME_DE440_ME421` | local CSPICE, `CN+S` |
| C | `AnalyticProvider` | ERFA `epv00` + `moon98` (truncated ELP2000-82), IAU WGCCRE rotation | `IAU_MOON` | uses no JPL data at all |

A and B use the same JPL modelling, so they should agree to milli-arcseconds. C is independent: it catches
errors that A and B could share (convention, sign or time-scale mistakes), with a looser, budgeted tolerance.

## 1. How to reproduce

```bash
cd /d/UAV/lunar-navigator
# full report: 6 sites x 3 time sets x 3 methods + negative controls + Apollo 11 + lunar day
./.venv/Scripts/python -m lunarnav.validate --no-terrain     # or: lunarnav validate -- --no-terrain
#   options: --offline (Horizons from disk cache only), --no-horizons (B vs C only), --quick, --out DIR
#   writes <output>/validation/validation_report.{json,md}; exit code 0 = all PASS
# tests
./.venv/Scripts/python -m pytest -q tests/test_crosscheck_ephem.py              # all (19 tests)
./.venv/Scripts/python -m pytest -q tests/test_crosscheck_ephem.py -m "not network"   # offline (14 tests)
```

On Google Colab, run the same command after `pip install -e .`, with `LUNARNAV_DATA` on Drive so the Horizons
cache and the SPICE kernels are kept. A whole-project report including terrain is `lunarnav validate`
(without `--no-terrain`, slower: the terrain section reads DEMs). From Python, `lunarnav.validate.run_all()`
returns the same report as a dict.

Runtime on the development machine: about 12 s for the full ephemeris report with a cold Horizons cache
(about 40 small requests), 5 s warm. The test file takes about 11 s.

## 2. What is compared

**Sites.** One or more from every catalog group, with observer height = published surface height (if the
catalog has one) + 2 m mast. The height only has to be the same for all methods:

| site | group | lat | E-lon | height above sphere |
|---|---|---|---|---|
| ref_shackleton_rim | reference (pole) | -89.7849 | 203.970 | 2 m |
| a3_de_gerlache_rim_2 | south_pole (Artemis III region) | -88.2226 | 296.565 | 2 m |
| chandrayaan3_vikram | south_pole (landed, not polar) | -69.3734 | 32.320 | 534 m |
| apollo11 | apollo (equatorial; Sun reaches 88.7 deg) | 0.6742 | 23.473 | 2 m |
| apollo15 | apollo (northern) | 26.1324 | 3.633 | 2 m |
| change6 | far_side | -41.6385 | 206.015 | -5254 m |

**Epochs.** `2026-03` (from 2026-03-01, 709 hourly samples = one synodic month), `2030-09` (same, from
2030-09-01), and `random` (24 random whole-second epochs over 2026-2030, seed 20261113). The random set is
irregular, so it goes through the Horizons TLIST path. Total: 8652 samples per method pair and body.

**Metrics** (per pair, body, site and time set; reported as max / p95 / rms):

* `sep`: the great-circle angle between the two apparent directions, computed from az/el with the chord
  formula `2 asin(|u1-u2|/2)` (stable at milli-arcseconds). This is the main metric because it is
  well-conditioned everywhere.
* `|d el|`.
* `|d az| cos(el)`: the on-sky azimuth error. The raw `|d az|` is wrapped to [-180, 180) and reported, but it is
  never given a limit, because it blows up near the zenith (Apollo 11 Sun at 88.7 deg). The raw azimuth is
  also reported for |el| <= 80 deg only.
* `|d dist|` (km) and the relative distance difference.
* Presence flags against the airless sphere horizon (Sun upper limb `el + asin(R_sun/d) > 0`, the Horizons '*'
  rule; Earth centre `el > 0`). A flag may differ only on a sample closer to the boundary than the elevation
  limit.

## 3. Thresholds and why

| pair | direction limit (sep, \|d el\|, \|d az\|cos el) | distance limit | justification |
|---|---|---|---|
| A-B | **0.02"** (5.6e-6 deg) | **2 m + 1e-10 d** (Earth 2.04 m, Sun 15 m) | Same JPL modelling (DE441 vs DE440, same MOON_ME, same sphere). Expected residuals: DE441-DE440 Moon 0.0014" lateral / 0.14 m radial (measured, section 5); Horizons light bending < 0.003"; print precision 1e-9 deg; Sun `delta` printed to 10 m. Measured max 0.0020" -> 10x margin. The limit is still below every real error class tested (section 4); the smallest real error, the 1738.0 vs 1737.4 km radius, is 0.34". |
| A-C, B-C | **0.02 deg** (72") | **2e-4 d** | Budget of method C: IAU_MOON vs MOON_ME <= 0.0051 deg, moon98 Earth direction <= 0.0051 deg, epv00 negligible, so the worst case is about 0.011 deg. Measured max 0.0040 deg (14.5"), giving 5x margin. Distance: moon98 worst 31.7 km / 356 000 km = 9e-5. Sign, frame, azimuth-convention and east/west errors are degrees. A time-scale slip (69 s gives 0.0098 deg) is caught by the tight A-B limit, not by this one. |

## 4. Results (measured 2026-11-13, DE441 Horizons / DE440 SPICE / ERFA)

### 4.1 Cross-method matrix - **PASS**

| pair | body | samples | sep max | sep p95 | sep rms | \|d el\| max | \|d az\|cos(el) max | \|d az\| max (\|el\|<=80) | \|d dist\| max | limit | flag mismatches | result |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A-B horizons-spice | Sun | 8652 | 0.0017" | 0.0001" | 0.0001" | 0.0014" | 0.0013" | 0.0041" | 7.7 m | 0.02" / 15 m | 0 | **PASS** |
| A-B horizons-spice | Earth | 8652 | 0.0020" | 0.0020" | 0.0014" | 0.0019" | 0.0020" | 0.0050" | 0.20 m | 0.02" / 2.04 m | 0 | **PASS** |
| A-C horizons-analytic | Sun | 8652 | 14.48" (0.0040 deg) | 14.36" | 7.56" | 14.10" | 14.47" | 71.8" | 8.36 km (5.6e-8) | 72" / 2e-4 | 12 | **PASS** |
| A-C horizons-analytic | Earth | 8652 | 12.34" (0.0034 deg) | 12.14" | 7.69" | 11.23" | 10.88" | 25.8" | 8.61 km (2.3e-5) | 72" / 2e-4 | 0 | **PASS** |
| B-C spice-analytic | Sun | 8652 | 14.48" | 14.36" | 7.56" | 14.10" | 14.47" | 71.8" | 8.36 km | 72" / 2e-4 | 12 | **PASS** |
| B-C spice-analytic | Earth | 8652 | 12.34" | 12.14" | 7.69" | 11.23" | 10.88" | 25.7" | 8.61 km | 72" / 2e-4 | 0 | **PASS** |

The worst A-B sample per site is between 0.0008" and 0.0017" for the Sun and 0.0020" for the Earth at every
site. The worst C sample per site is 14.47-14.48" for the Sun and 12.26-12.34" for the Earth, the same at
every site, because it is a frame and theory effect, not a site effect.

All 12 flag mismatches with C are polar Sun samples (de Gerlache rim 9, Shackleton rim 3) whose upper limb was
closer to the horizon than the 0.02 deg limit, so they are explained. The raw azimuth column shows why raw
azimuth is not used: 71.8" raw becomes 14.5" on the sky.

### 4.2 Negative controls - the limits catch every error class - **PASS**

Each variant is computed with SPICE, deliberately wrong, and compared with Horizons (pole site and Apollo 11,
March 2026). "Flagged" means the A-B pass criteria fail at every site.

| variant | expected (physics) | Sun sep max | Earth sep max | Earth range max | flagged | result |
|---|---|---|---|---|---|---|
| MOON_PA instead of MOON_ME | constant ME-PA rotation 0.0289 deg | 103.9" | 104.4" | 660 m | yes | PASS |
| IAU_MOON instead of MOON_ME | truncated IAU libration, <= 0.0051 deg | 8.11" | 10.38" | 85 m | yes | PASS |
| DE421 lunar libration (`lunar_set="de421"`) | alternative valid model, < 1 m | 0.049" | 0.046" | 0.44 m | yes | info |
| UTC used as TDB (69 s) | 69 s x 0.508 deg/h = 35" | 35.1" | 5.05" | 4.1 km | yes | PASS |
| UTC used as TAI (37 s) | 19" | 18.8" | 2.71" | 2.2 km | yes | PASS |
| single-iteration light time (`LT+S`, the former SPICE default) | Earth range rho (v_r/c)^2 <= 4.15 m | 0.0014" | 0.0019" | 3.98 m | yes (range) | PASS |
| no stellar aberration (`LT`) | v/c = 30 km/s / c = 20.6" | 21.4" | 21.4" | 3.98 m | yes | PASS |
| geometric (`NONE`) | Sun 20.6"; Earth ~ relative velocity 1 km/s / c = 0.7" | 21.4" | 0.74" | 40 km | yes | PASS |
| 1738.0 km sphere instead of 1737.4 km | Earth parallax 0.6 km / 384 400 km <= 0.32" | 0.002" | 0.336" | 569 m | yes | PASS |
| longitude read as WEST-positive | degrees | 47.9 deg | 47.9 deg | 141 km | yes | PASS |
| azimuth counter-clockwise | 2 \|az-180\| | 179 deg | 59.5 deg | 0.15 m | yes | PASS |
| C vs SPICE-in-IAU_MOON (C's frame error removed) | theory error only | 0.023" | 6.98" | 8.57 km | - | info |

### 4.3 Explaining every residual

* **A-B Earth, 0.002" and 0.15-0.20 m.** This is DE441 (Horizons) against DE440 (SPICE), not our code.
  A Horizons `VECTORS` query of the geometric geocentric Moon (`de441_vs_de440_moon()`, March 2026) minus SPICE
  DE440 gives 2.42 m total, 0.14 m radial and 0.0014" lateral as seen from the Moon. That matches the topocentric
  residual in size and in where it falls (along or across the line of sight).
* **A-B Sun, about 0.0001" typical and 0.0017" max; range up to 7.7 m.** Horizons prints `delta` with 11
  significant digits, which is 10 m resolution for 1.47e8 km. The 0.0017" maximum occurs at Apollo 11/15 with
  the Sun near the zenith, where printing az/el to 1e-9 deg is still ample. Horizons also applies gravitational
  light deflection and SPICE does not; that is below 0.003".
* **A-B Earth range, 4 m before the fix.** The residual had a half-month period (peaks at the quarter Moons,
  about 0 at new and full Moon) with a peak of 3.98 m. That is the `rho (v_r/c)^2` error of SPICE's *single*
  light-time iteration (`LT`), with v_r = the Earth's 30 km/s orbital velocity along the line of sight. Using
  converged light time (`CN+S`) brings it down to 0.15 m, the DE441-DE440 floor. **Fixed** (section 6).
* **A/B-C Sun, 14.5" (0.0040 deg), the same at every site.** This is the frame: C places the site in IAU_MOON,
  whose truncated libration series differs from MOON_ME by up to 0.0051 deg. Proof: comparing C with SPICE
  evaluated in IAU_MOON leaves only 0.023" on the Sun.
* **A/B-C Earth, 12.3" (0.0034 deg).** Frame (as above) plus the moon98 lunar theory. With the frame removed,
  6.98" remains, equal to the moon98-minus-DE440 lateral Moon error seen from the Moon (6.96" in 2026-03,
  4.47" in 2030-09; `analytic_moon_theory_error()`).
* **A/B-C distances, 8.4-8.6 km.** These are moon98 position errors: 14.3 km total, 8.55 km along the Earth
  direction and 8.36 km along the Sun direction in March 2026. They match the 8.61 km and 8.36 km range
  differences. The relative error is 2.3e-5 for Earth and 5.6e-8 for Sun, far below 2e-4.
* **Time scale, light time, aberration, radius, east/west, azimuth convention.** All are measured explicitly
  in 4.2 and none is present in A, B or C.
* **Frame ME vs PA.** B in MOON_PA misses Horizons by 104", so Horizons is shown to be MOON_ME. The DE421-libration
  variant differs by 0.05", so even the libration model choice can be resolved, and DE440 is the one that
  matches Horizons.
* **Lunar radius.** Horizons echoes "Center radii: 1737.4, 1737.4, 1737.4 km". A 1738.0 km sphere would be
  0.34" off and would be flagged.

### 4.4 Apollo 11 landing Sun elevation - **PASS**

Catalog fact `apollo11_sun_elevation_at_landing`: 1969-07-20T20:17:40 UTC at Tranquility Base, documented
10.8 deg with a tolerance of ±0.5 deg. Kernel coverage for 1969: `de440s.bsp` 1849-2150, `moon_pa_de440` 1550-2650,
DE421 PCK 1900-2050; the Horizons MEAN_ME frame is valid 1550-2650. All of them cover the date.

| method | Sun elevation at landing | EVA 02:39-05:11 UTC range (documented 14.5-16 ±1 deg) |
|---|---|---|
| A Horizons | 10.703313 deg | 13.941 - 15.231 deg |
| B SPICE (DE440 libration) | 10.703313 deg (A-B 0.00001") | 13.941 - 15.231 deg |
| B SPICE (DE421 libration) | 10.703309 deg | 13.941 - 15.231 deg |
| C analytic | 10.702091 deg (A-C 4.4") | 13.940 - 15.230 deg |
| documented | 10.8 ± 0.5 deg | 14.5 - 16 deg |

* Every method is 0.097 deg below the quoted 10.8 deg. The Sun was rising 0.509 deg/h, so 0.097 deg is 11 min
  of time, or the rounding of a quoted planning value. The catalog notes that the NASA documents only say
  "about 10 degrees", and the methods agree to 0.0012 deg, so the quoted value is the imprecise one.
  The ±0.5 deg tolerance holds.
* Our EVA range is about 0.5 deg lower than the Mission Report's "14.5 to 16 deg". This is consistent with
  approximate EVA times (±several minutes, about 0.1 deg) and with a "sun angle" measured against local
  terrain rather than the sphere. It is within the ±1 deg tolerance.
* **Pre-1972 UTC bug found here:** before the fix, SPICE gave 10.703512 deg, 0.72" above Horizons, which is
  an A-B failure. Converted to time at the Sun's rate of 0.000142 deg/s, that is 1.43 s, exactly
  9 s - 7.5746 s. naif0012 has no model of 1960-1971 UTC (the "rubber second" era, when
  TAI-UTC = 4.21317 s + 0.002592 s/day x (MJD - 39126)); `deltet` silently used 9 s. Horizons and ERFA use the
  official table. **Fixed** (section 6). Dates after 1972, including all 2026-2031 work, were never affected.

### 4.5 Lunar day and time-until-sunset at an equatorial site - **PASS**

Apollo 11 site (0.674 N), flat horizon with a 2 m mast (dip 0.0870 deg), upper-limb rule, hourly SPICE samples
2026-01-01 + 90 days. Windows and "time until" values come from `lunarnav.windows`. The true event times come
from a 1-s bisection on the continuous ephemeris.

Theory: the local solar day is `P = 360 / (13.17636 - lambda_dot_sun)` deg/day. That is 29.61 d in January
and 29.45 d in July; the mean is the synodic month 29.53 d, so half a day is **14.77 d (354.4 h)** on average.
Daylight = P/2 + 2 (semidiameter + dip) / (360/P), where the upper limb and mast add about 1.4 h.

| quantity | measured | theory | limit | result |
|---|---|---|---|---|
| daylight 2026-01-23 22:02:33 -> 02-07 19:10:33 | 357.13 h (14.88 d) | 356.65 h | ±0.75 h | PASS |
| daylight 2026-02-22 12:18:26 -> 03-09 09:06:47 | 356.81 h (14.87 d) | 356.32 h | ±0.75 h | PASS |
| hourly window durations (day / nights) | 357, 357 / 354, 353, 352 h | 356.6, 356.3 / 353.9, 353.7, 353.3 h | ±1.75 h | PASS |
| sunset to sunset | 709.94 h | 710.02 h | ±0.75 h | PASS |
| `hours_until_sunset` minus true time-to-sunset (every lit sample) | in [0, 1) h | first dark sample, so 0 to 1 step late | [0, 1) h | PASS |
| `hours_until_sunset` slope | -1 h per hourly step | -1 | exact | PASS |
| `hours_until_sunset` at local noon | 179 h, 179 h | daylight/2 = 178.3, 178.2 h | ±2 h | PASS |
| sunrise/sunset instants, A-B / A-C / B-C | 0.00007 s / 6.97 s / 6.97 s | - | 1 s / 142 s / 142 s | PASS |

Limits: the Sun's parallax from the Moon's orbit (direction offset up to 0.147 deg) shifts each event by up to
0.29 h, and the effect is systematic for a fixed longitude. That is why both measured days are about +0.48 h.
The declination effect at 0.67 deg latitude is below 0.1 h; hourly sampling adds 1 h. For C the event limit is
0.02 deg divided by 0.508 deg/h, which is 142 s.

## 5. What correct ephemeris output looks like (acceptance criteria)

1. A-B: direction (sep, |d el|, |d az|cos el) <= 0.02" and Earth range <= 2 m at every sample. Sun/Earth
   presence flags identical.
2. C against A/B: <= 0.02 deg and <= 2e-4 relative distance. Presence flags differ only within 0.02 deg of the
   horizon.
3. Each negative control in 4.2 is flagged. This proves the limits are sensitive to the frame, time scale,
   light time, aberration, radius, longitude sign and azimuth convention.
4. Apollo 11: 10.8 ± 0.5 deg for all methods, and A-B < 0.05".
5. Equatorial lunar day: 14.77 d mean half day (theory per date ±0.75 h); `hours_until_sunset` is exact to
   one sampling step.

## 6. Bugs found and fixed in other modules

| file | bug | effect | fix |
|---|---|---|---|
| `lunarnav/ephem/spice.py` `utc_to_et` | naif0012 has no 1960-1971 UTC model; `deltet` used TAI-UTC = 9 s before 1972 | 1.43 s time error for 1969 (Apollo 11 Sun 0.72" off Horizons); historical validation only | For 1960-01-01 <= t < 1972-01-01, ET = TDB(UTC + ERFA `dat` + 32.184 s), with TT->TDB from SPICE `unitim`. Agrees with astropy/ERFA TDB to < 1 ms; post-1972 epochs unchanged (bit-identical code path). |
| `lunarnav/ephem/spice.py` `SpiceProvider` | default `abcorr="LT+S"` uses a single light-time iteration | Earth range error up to 4 m (half-month signal) vs Horizons; Earth direction 0.0011" | Default changed to `"CN+S"` (converged Newtonian light time); range now agrees with Horizons to 0.15-0.20 m, direction to 0.0018". Same speed (about 0.04 s per 709 samples). |

No change was needed in `horizons.py` or `analytic.py`. Teammates' tests (`test_spice.py`, `test_horizons.py`,
`test_analytic.py`, ...) still pass after both fixes.

## 7. Limitations

* Validation covers 2026 and 2030 lunar months plus random 2026-2030 epochs, and 1969 for Apollo 11. DE440
  (SPICE) and DE441 (Horizons) would slowly diverge outside 1550-2650, which is outside the project's range.
* Leap seconds: all methods assume none after 2017 (Horizons, naif0012 and ERFA agree). A new leap second
  would need new kernels or tables in all three.
* The Horizons light-deflection term is not modelled in B or C; its effect was not isolated separately and
  is bounded below 0.003" by the A-B agreement itself.
* `lunarnav/validate_terrain.py` (terrain section, not part of this section) computes its own Moon-centre vectors
  with SPICE `LT+S`. That is fine for directions (the single-iteration error only affects range by 4 m).
