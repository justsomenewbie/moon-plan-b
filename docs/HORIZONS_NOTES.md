# JPL Horizons as Method A ephemeris - notes and evidence

Module: `lunarnav/ephem/horizons.py` (`HorizonsProvider`, name `"horizons"`).
Tests: `tests/test_horizons.py`. Fixtures (real responses from 2026-11-13): `tests/data/horizons_*.txt`.

## 1. Request we send

```
GET https://ssd.jpl.nasa.gov/api/horizons.api
  format=json  OBJ_DATA=NO  MAKE_EPHEM=YES  EPHEM_TYPE=OBSERVER
  COMMAND='10' (Sun) | '399' (Earth)
  CENTER='coord@301'  COORD_TYPE=GEODETIC  SITE_COORD='<E-lon deg>,<lat deg>,<alt km>'
  QUANTITIES='4,13,20'  CSV_FORMAT=YES  TIME_TYPE=UT  TIME_DIGITS=FRACSEC
  ANG_FORMAT=DEG  APPARENT=AIRLESS  EXTRA_PREC=YES  RANGE_UNITS=KM  SUPPRESS_RANGE_RATE=YES
  + either START_TIME/STOP_TIME/STEP_SIZE='<N>'   (uniform grid, N equal intervals)
  + or     TLIST_TYPE=CAL TLIST='YYYY-MM-DD HH:MM:SS' ...   (irregular set)
```

* `SITE_COORD` order is **east longitude, latitude, altitude (km)**. Our height convention
  (m above the 1737.4 km sphere) is sent as km. Negative altitudes are accepted (south-pole
  craters are 2-5 km below the sphere); Horizons echoes them, e.g.
  `Center geodetic : 0.0, -89.5, -1.5 {E-lon(deg),Lat(deg),Alt(km)}`.
* A unitless `STEP_SIZE='N'` splits [START, STOP] into N equal intervals, so any whole-second
  step (not only whole minutes) is reproduced exactly; `TIME_DIGITS=FRACSEC` prints the
  time tags to 1 ms and the code asserts every returned tag equals the requested one
  (|dt| <= 1 ms), raising `HorizonsError` otherwise.

## 2. Which Moon model does `coord@301` use?  (answer: 1737.4 km sphere, MEAN_ME frame)

Evidence, verbatim header lines of every response (see `tests/data/horizons_sun_apollo11_sunset_20260109.txt`):

```
Center body name: Moon (301)                      {source: DE441}
Center geodetic : 23.473, .674, -2.15679E-13      {E-lon(deg),Lat(deg),Alt(km)}
Center cylindric: 23.473, 1737.27979, 20.43747    {E-lon(deg),Dxy(km),Dz(km)}
Center pole/equ : MEAN_ME (high precision)        {East-longitude positive}
Center radii    : 1737.4, 1737.4, 1737.4 km       {Equator_a, b, pole_c}
Vis. interferer : EARTH (R_eq= 6378.137) km       {source: DE441}
Atmos refraction: NO (AIRLESS)
```

* **Sphere 1737.4 km**: all three radii are 1737.4 km. Check: cylindrical
  Dxy = 1737.4 cos(0.674 deg) = 1737.2798 km, Dz = 1737.4 sin(0.674 deg) = 20.4375 km,
  matching the echo. Hence Horizons "geodetic" latitude == planetocentric latitude and the
  altitude is height above the LOLA reference sphere - exactly the `types.py` contract.
* **Frame MEAN_ME**: the Horizons manual (section "Lunar Mean-Earth Frame of DE421") says the
  lunar body-fixed system is the mean-Earth/polar-axis frame of DE421, realised as a fixed
  rotation from the DE440 principal-axis (PA) frame; "The lunar PA frame is not currently
  available in Horizons". It is used only for A.D. 1550-2650; outside, Horizons falls back
  to IAU_MOON and the header shows it. The provider checks the `Center pole/equ` line of
  every chunk and raises if it is not MEAN_ME. This is the same frame as LOLA products
  (MOON_ME, DE421 mean Earth). For SPICE cross-checks the matching NAIF frame is
  `MOON_ME_DE440_ME421` (moon_de440_*.tf) / `MOON_ME` defined from DE421.
* Planetary/lunar ephemeris: DE441 (`{source: DE441}`).
* Longitude is east-positive for the Moon (manual: "Exceptions are the Earth, Moon and Sun").

## 3. Quantities and their meaning (from the response "Column meaning" footer)

| column | quantity | units | meaning |
|---|---|---|---|
| `Azimuth_(a-app)`, `Elevation_(a-app)` | 4 | deg | airless apparent az/el of the target **centre**; light time, gravitational deflection, stellar aberration; az clockwise from north (N 0, E 90); el w.r.t. the plane perpendicular to the reference-surface zenith (sphere -> radial) |
| `Ang-diam` | 13 | arcsec | full-disk equatorial angular width = 2 asin(R/delta), R_sun 695 700 km, R_earth 6 378.137 km (verified to < 0.001", test `test_angular_diameter_matches_range`) |
| `delta` | 20 | km | apparent (light-time aberrated) range to the target centre |

Marker columns after the time tag (CSV fields 2 and 3, often blank - the parser keeps them as
characters so blanks never shift the numeric columns):

* solar presence: `*` = solar **upper limb** on/above the airless horizon of the **sphere**,
  ` ` = night. Verified: `*` <=> el + angdiam/2 >= 0 with zero mismatches over a month at
  Apollo 11 and at 89.5 S (no dip correction, no terrain). Exposed by
  `HorizonsProvider.daylight_markers()` and `meta["sun_daylight_marker"]`.
* interfering body presence (for a Moon observer the interferer is the **Earth**): `i` = Earth
  upper limb above the spherical horizon. For steps <= 30 min it can be overridden by a target
  event code `r`/`e`/`t`/`s` (rise / max elevation / transit / set), e.g. the `s` row in the
  Apollo 11 sunset fixture; `PresenceMarkers.earth_known` is False on such rows.

These markers ignore terrain; they are only a cross-check of our "upper limb" rule, never the
visibility answer at the pole.

## 4. Service limits found (tested 2026-11-13)

| limit | value | handling |
|---|---|---|
| output lines | > 90 000 refused: `Output length exceeded, ... max. is 90000` (JSON `error`) | chunks of `max_points_per_request` (default 20 000 ~ 3 MB) |
| TLIST entries | 10 000 (API doc) | TLIST chunks <= 10 000 |
| GET URL length | 1.3 kB OK, ~2.2 kB -> HTTP 502 from the proxy (~60 calendar TLIST entries) | `tlist_transport="auto"`: GET while URL <= 1800 chars, else POST the same settings to the file API `horizons_file.api` (3 000-entry TLIST verified); `"get"` halves TLIST batches until each URL fits; `"post"` always file API |
| errors | HTTP 200 with JSON `error` (e.g. `Geodetic latitude not in the range -90 to 90 degrees`) | raised as `HorizonsError`, never cached |

Retries: 5 attempts with exponential backoff (2, 4, 8, 16 s) on connection errors and HTTP
429/5xx; >= 0.5 s between requests; requests are strictly sequential.

## 5. Cache

`data/cache/horizons/<sha256>.txt` holds the `result` text of each successful response,
`<sha256>.json` its parameters. The key is the SHA-256 of the canonical request
(API URL, sorted parameters, TLIST list) - independent of GET/POST transport. A second
identical call makes no HTTP request (`client.http_calls` unchanged; tested).
`HorizonsProvider(offline=True)` uses the cache only and raises on a miss. On Colab, mount
or copy `data/cache/horizons` to reuse the responses; set `LUNARNAV_DATA` to relocate it.

## 6. Time scale

`TIME_TYPE=UT`: input and output are UTC (after 1962). Future leap seconds are unknown to
Horizons ("the last known leap-second is used as a constant over future intervals"), the same
assumption every provider has to make. A uniform 4-interval span across the 2016-12-31 leap
second returned whole-hour UTC tags, i.e. the unitless step is uniform in UTC labels.

## 7. Reference numbers (January 2026, hourly, 744 samples, observer on the sphere)

| site | Sun el min..max (deg) | Earth el min..max (deg) |
|---|---|---|
| Apollo 11 (0.674 N, 23.473 E) | -89.50 .. 88.57 | 60.94 .. 73.44 (mean 66.2) |
| Chang'e-6 (41.63 S, 206.02 E) | -47.63 .. 49.49 | -48.94 .. -35.46 (never visible) |
| 89.5 S, 0 E | 0.57 .. 1.81 | -6.45 .. 6.95 |
| 0 N, 0 E | -88.91 .. 88.69 | 82.97 .. 84.62 |

Physical bounds asserted in the tests: sub-solar latitude <= 1.54 deg, optical libration
<= 8.2 deg in longitude and <= 6.9 deg in latitude, Earth parallax <= 0.26 deg,
Sun range 0.980-1.020 au, Earth range 354 000-408 500 km.

## 8. Expected differences vs. other methods

* Horizons includes gravitational light deflection (Sun, Earth); SPICE `LT+S` does not:
  effect on the Sun/Earth directions seen from the Moon is far below 0.001 deg.
* DE441 vs DE440 kernels: designed to agree for the modern era; expect negligible (sub-km at the Sun, metre-level at the Earth) differences for 2026-2031.
* Frame realisation (DE440 PA -> DE421 ME fixed rotation) must match the SPICE frame chosen
  (`MOON_ME_DE440_ME421`); using the low-precision IAU_MOON model instead introduces a site-position / orientation error of order 0.001-0.01 deg, which matters for the 1.5 deg south-pole Sun.
* Recommended cross-method tolerance for az/el of the centres: 0.001-0.005 deg (except
  azimuth near the zenith, where it is ill-conditioned: compare unit vectors instead).
