# Site catalog (`lunarnav/catalog/sites.json`)

The catalog is loaded with `lunarnav.sites.load_catalog()`. It has 23 sites, and every one is checked against the
schema when it loads. All coordinates follow the project contract (`lunarnav/types.py`):

* planetocentric latitude, EAST longitude normalised to [0, 360), in degrees;
* frame **MOON_ME** (mean Earth / polar axis, DE421 realisation). LOLA, LROC, the IAU/USGS Gazetteer and NSSDCA
  all use this frame. Each site states its frame in `extra.frame`;
* `height_m` is `null` for every catalog site, so the terrain module reads the height from the DEM. Elevations
  published by the mission or LROC are kept in `extra.published_elevation_m` so they can be checked against the
  DEM: IM-1 2579 m, Chandrayaan-3 532 m, Chang'e-6 -5256 m.

`extra.accuracy.kind` tells you what a point is:
`landed_point` (a lander found on LROC images), `region_centre` (a representative point of an Artemis III
candidate region, which spans 20 to 80 km and is NOT a landing site), `reference_point` (a literature point that
has a published illumination value), and `feature_centre` (an IAU crater centre).

## Table

`ref %` is the primary literature value of average solar illumination (`extra.reference_illumination_pct`). The
period, DEM resolution and observer height that each value applies to are listed in
`extra.reference_illumination`. `PGDA %` is the NASA GSFC PGDA / LOLA PDS average-illumination map sampled at the
catalog point, given as pixel value (3x3 maximum). It comes from an independent second source: an 18.6-year
hourly average for an observer at the surface, using the 60 m/px map where it covers the point and the
120 m/px map elsewhere.

| id | name | group | lat | lon E | kind | horiz. accuracy | ref % | PGDA % | source |
|---|---|---|---:|---:|---|---|---:|---|---|
| `a3_peak_near_cabeus_b` | Artemis III region: Peak near Cabeus B | south_pole | -83.6195 | 291.3677 | region_centre | box centre <= 2 km | | 53.6 (68.4) | [NASA map, LPSC 2026](https://ntrs.nasa.gov/citations/20250011660) |
| `a3_haworth` | Artemis III region: Haworth | south_pole | -86.7530 | 336.3282 | region_centre | bbox midpoint | | 32.6 (32.7) | [Bertone+2026 Zenodo](https://zenodo.org/records/17954508) |
| `a3_malapert_massif` | Artemis III region: Malapert Massif | south_pole | -85.9799 | 359.7442 | region_centre | bbox midpoint | | 38.4 (51.7) | [Bertone+2026 Zenodo](https://zenodo.org/records/17954508) |
| `a3_mons_mouton_plateau` | Artemis III region: Mons Mouton Plateau | south_pole | -84.3162 | 30.3933 | region_centre | box centre <= 2 km | | 26.4 (28.9) | [NASA map, LPSC 2026](https://ntrs.nasa.gov/citations/20250011660) |
| `a3_mons_mouton` | Artemis III region: Mons Mouton | south_pole | -85.4258 | 31.8273 | region_centre | bbox midpoint | | 28.5 (37.7) | [Bertone+2026 Zenodo](https://zenodo.org/records/17954508) ("Leibnitz Beta Plateau") |
| `a3_nobile_rim_1` | Artemis III region: Nobile Rim 1 | south_pole | -85.4377 | 37.4446 | region_centre | bbox midpoint | | 28.0 (31.3) | [Bertone+2026 Zenodo](https://zenodo.org/records/17954508) |
| `a3_nobile_rim_2` | Artemis III region: Nobile Rim 2 | south_pole | -83.9531 | 58.7435 | region_centre | bbox midpoint | | 36.3 (40.8) | [Bertone+2026 Zenodo](https://zenodo.org/records/17954508) |
| `a3_de_gerlache_rim_2` | Artemis III region: de Gerlache Rim 2 | south_pole | -88.2226 | 296.5651 | region_centre | bbox midpoint | | 37.9 (39.2) | [Bertone+2026 Zenodo](https://zenodo.org/records/17954508) |
| `a3_slater_plain` | Artemis III region: Slater Plain | south_pole | -87.1777 | 125.5346 | region_centre | box centre <= 2 km | | 6.3 (7.1) | [NASA map, LPSC 2026](https://ntrs.nasa.gov/citations/20250011660) |
| `im2_athena` | IM-2 Athena (landed 2025-03-06) | south_pole | -84.7906 | 29.1957 | landed_point | ~30 m | | 45.1 (46.9) | [LROC 1408](https://www.lroc.asu.edu/images/1408) |
| `im1_odysseus` | IM-1 Odysseus (landed 2024-02-22 23:23:53 UTC) | south_pole | -80.13 | 1.44 | landed_point | ~300 m (2 decimals) | | 35.6 (40.3) | [LROC 1360](https://www.lroc.asu.edu/images/1360) |
| `chandrayaan3_vikram` | Chandrayaan-3 Vikram, Statio Shiv Shakti (2023-08-23) | south_pole | -69.3734 | 32.3198 | landed_point | ~50 m | | | [IAU Gazetteer 16272](https://planetarynames.wr.usgs.gov/Feature/16272), LROC 1314 |
| `ref_connecting_ridge_c1` | Shackleton-de Gerlache connecting ridge, C1 | reference | -89.4505 | 222.8400 | reference_point | 20 m pixel | 76.0 | 86.4 (86.4) | [Gläser+2018](https://ntrs.nasa.gov/citations/20170007365) Table 1 |
| `ref_connecting_ridge_c2` | Connecting ridge, C2 | reference | -89.3157 | 245.9400 | reference_point | 20 m pixel | 75.6 | 74.9 (79.4) | [Gläser+2018](https://ntrs.nasa.gov/citations/20170007365) Table 1 |
| `ref_shackleton_rim` | Shackleton rim, S | reference | -89.7849 | 203.9700 | reference_point | 20 m pixel | 81.0 | 85.5 (85.5) | [Gläser+2018](https://ntrs.nasa.gov/citations/20170007365) Table 1 |
| `ref_de_gerlache_rim` | de Gerlache rim, max-illumination pixel | reference | -88.6646 | 291.6044 | reference_point | 60 m pixel | 82.7 | 82.7 (82.7) | [PGDA product 69](https://pgda.gsfc.nasa.gov/products/69) |
| `psr_shackleton_floor` | Shackleton crater floor (PSR) | reference | -89.67 | 129.78 | feature_centre | ~500 m | 0 | 0 (0) | [IAU Gazetteer 5450](https://planetarynames.wr.usgs.gov/Feature/5450) + PGDA LPSR |
| `psr_haworth_floor` | Haworth crater floor (PSR) | reference | -87.45 | 354.83 | feature_centre | ~500 m | 0 | 0 (0) | [IAU Gazetteer 14502](https://planetarynames.wr.usgs.gov/Feature/14502) + PGDA LPSR |
| `apollo11` | Apollo 11 LM Eagle (1969-07-20 20:17:40 UTC) | apollo | 0.67416 | 23.47314 | landed_point | ~20 m | | | [NSSDCA 1969-059C](https://nssdc.gsfc.nasa.gov/nmc/spacecraft/display.action?id=1969-059C) |
| `apollo15` | Apollo 15 LM Falcon (1971-07-30 22:16:29 UTC) | apollo | 26.13239 | 3.63330 | landed_point | ~20 m | | | [NSSDCA 1971-063C](https://nssdc.gsfc.nasa.gov/nmc/spacecraft/display.action?id=1971-063C) |
| `apollo17` | Apollo 17 LM Challenger (1972-12-11 19:54:57 UTC) | apollo | 20.1911 | 30.7723 | landed_point | ~20 m | | | [NSSDCA 1972-096C](https://nssdc.gsfc.nasa.gov/nmc/spacecraft/display.action?id=1972-096C) |
| `change6` | Chang'e-6, Statio Tianjiang (2024-06-01) | far_side | -41.6385 | 206.0148 | landed_point | +-30 m | | | [LROC 1374](https://www.lroc.asu.edu/images/1374) |
| `change4` | Chang'e-4, Statio Tianhe (2019-01-03) | far_side | -45.457 | 177.589 | landed_point | +-20 m | | | [LROC 1087](https://www.lroc.asu.edu/images/1087) |

### Validation facts (`get_validation_facts()`)

| id | value | tolerance | source |
|---|---|---|---|
| `apollo11_sun_elevation_at_landing` | Sun elevation 10.8 deg at 1969-07-20T20:17:40 UTC (Horizons: 10.70 deg) | +-0.5 deg | Apollo 11 Mission Report MSC-00171 (NTRS 19710015566), ALSJ, NSSDCA |
| `apollo11_eva_sun_elevation_range` | 14.5 to 16 deg, 1969-07-21 02:39 to 05:11 UTC | +-1 deg | Apollo 11 Mission Report MSC-00171 |
| `far_side_earth_never_visible` | Earth centre elevation never > 0 deg at `change4`, `change6` | geometric | geometry (sites are > 130 deg from the sub-Earth point) |
| `psr_zero_illumination` | 0 % illumination at the two PSR points | exact | PGDA LPSR/AVGVISIB maps |

## How each set of coordinates was obtained

* **Artemis III regions.** NASA's current list is the 9 regions announced on 28 Oct 2024 (NASA release 24-136).
  George et al. restated the same list at LPSC 2026 (NTRS 20250011660). NASA publishes this list as a map only,
  with no coordinates.
  * Five of the regions also appear in the 2022 list of 13: Haworth, Malapert Massif, Nobile Rim 1,
    Nobile Rim 2 and de Gerlache Rim 2. NASA GSFC published their lon/lat bounding boxes in the README of
    Bertone et al. 2026 (PSJ, Zenodo 10.5281/zenodo.17954508). We use the midpoint of each box.
  * The 2024 region "Mons Mouton" is the 2022 region "Leibnitz Beta Plateau". The IAU renamed Leibnitz Beta to
    Mons Mouton in 2022, and the 2024 box we measured is 0.6 km from the 2022 centre, so we use the 2022 centre.
  * We measured **Peak near Cabeus B, Mons Mouton Plateau and Slater Plain** on NASA's 9-region map, the image in
    the LPSC 2026 abstract. We fitted a similarity transform to the five regions above. The fit residuals are
    0.2 to 1.3 km, and the map's "South Pole" star lands 0.6 km from the pole. Two checks support the result: the
    LROC IM-2 Athena landing point falls inside the Mons Mouton Plateau box, and Slater Plain and Peak near
    Cabeus B lie next to the IAU craters Slater and Cabeus B.
  * The outline of every region is stored in `extra.region_corners_latlon`.
* **Landings.** LROC NAC measurements are used for IM-2, IM-1, Chang'e-4 and Chang'e-6. The IAU station is used
  for Chandrayaan-3; LROC's independent value is within 21 m. NSSDCA is used for Apollo; it states that its
  values are LRO-derived in the DE421 ME frame. The tests check these against independent second sources: IAU
  stations, LROC, and the IM-2 intended site.
* **Reference illumination points.** These are from Gläser et al. 2018 (PSS 162, 170) Tables 1 and 2, which also
  tabulate Mazarico et al. 2011 and Speyerer & Robinson 2013 for the same points. The ridge points match the
  Barker et al. 2021 "Site 1" region-of-interest centroids in polar-stereographic X/Y.
  * For the de Gerlache rim, the literature coordinates (Barker 2021 "Site 11") were not available to us. We
    took the brightest pixel of the PGDA 60 m average-illumination map on the de Gerlache rim. That pixel lies
    inside NASA's 2022 "de Gerlache Rim" region.
* **PSR points.** These are the IAU crater centres of Shackleton and Haworth. We checked that the PGDA permanent
  shadow map (LPSR_85S_060M) marks the whole 5x5 pixel window (300 m) around each point as permanently shadowed,
  and that the average illumination there is 0.

## Which coordinates are approximate

1. **All nine Artemis III entries are region centres, not landing sites.** Each region is 17 to 80 km across, and
   the actual candidate sites inside them are not public.
   * Five come from published bounding-box midpoints. These are midpoints in lon/lat, not true centroids, so
     near the pole they can sit a few km off the visual centre.
   * Three (Peak near Cabeus B, Mons Mouton Plateau, Slater Plain) were measured on a raster map and have an
     estimated error of 2 km or less. NASA may have refined the 2024 boxes slightly relative to 2022; the
     georeferenced map agrees with the 2022 centres to within 1.3 km.
   * The illumination at a region centre point does not represent the best site in the region. For example,
     Slater Plain's centre is 6 % in the PGDA map.
2. **IM-1 Odysseus** is published to only 0.01 deg, which is about 300 m.
3. **The PSR points** are crater centres given to 0.01 deg, about 300 m. They are safely inside the shadowed
   floors, but they are not specific points from the literature.
4. **Reference illumination values depend on the method.**
   * At the same ridge point, published values range from 64 % (WAC images, 1 year) through 76 % (20 m DEM) to
     89 % (240 m DEM). Values for 2 m above ground are higher (88 % at C1).
   * Validation should compare like with like (DEM resolution, period, observer height) or allow about 10
     percentage points.
   * The de Gerlache rim value comes from a single 60 m map pixel that we selected, not from a published point.
5. **Apollo 11 Sun elevation of 10.8 deg.** This is the value quoted in the project brief. The NASA documents we
   could retrieve give consistent but coarser statements: Armstrong said "about 10 degrees Sun angle" shortly after
   landing, and the Mission Report gives 14.5 to 16 deg during the EVA. JPL Horizons gives 10.70 deg. The
   tolerance is set to 0.5 deg.

Not included, because no verified numeric coordinates were found:

* the VIPER target (now planned for delivery by Blue Origin);
* future CLPS south-pole targets;
* Chang'e-7;
* the Mazarico et al. 2011 Table 3 sites beyond the ridge and the Shackleton rim.

## API summary

```python
from lunarnav import sites
sites.load_catalog()                      # list[Site]; group="south_pole"|"apollo"|"far_side"|"reference"
sites.get_site("im2_athena")              # Site; also accepts canonical "custom:<lat>:<lon>" ids
sites.get_site_extra("ref_shackleton_rim")  # source_url, frame, accuracy, reference_illumination, ...
sites.custom_site(-41.6385, -153.9852)    # -> id "custom:-41.6385:206.0148", lon normalised to [0,360)
sites.normalize_lon(-153.98)              # 206.02
sites.reference_illumination_pct("psr_shackleton_floor")  # 0.0
sites.get_validation_fact("apollo11_sun_elevation_at_landing")
```
