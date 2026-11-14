# Terrain data sources (LOLA DEMs) - what we use, what we verified

Owner: `lunarnav/terrain/` (`common.py`, `trek.py`, `pgda.py`). Facts below were checked on
2026-11-13 with Python `requests` / GDAL 3.12 against the live NASA servers; every number marked
"measured" is reproduced by a test in `tests/test_terrain.py` (`-m network`).

Conventions used by all readers (see `lunarnav/types.py`): planetocentric latitude, EAST
longitude, MOON_ME frame (LOLA products use the DE421 mean-Earth/polar-axis frame), heights in
metres above the 1737.4 km sphere, NaN = nodata. Patches (`DemPatch`) are in polar stereographic
metres, `y_m` increasing (row 0 = south edge of the patch grid), pixel centres.

## 1. Summary: which reader for what

| Reader (DemSource) | Source (challenge role) | Grid | Access | Use |
|---|---|---|---|---|
| `TrekImageServerDem("LRO_LOLA_DEM_SPole875_5mp_v04")` | Moon Trek (Resources tab) | native south polar stereographic, 5 m, +-75.84 km (~87.5S) | partial reads, `exportImage`, cached blocks | **primary fine DEM** near south-pole sites (dev machine and Colab) |
| `TrekImageServerDem("..._SPole75_30mp_v04")`, `("..._SPole45_100mp_v04")` | Moon Trek | native PS 30 m (+-457.44 km, ~75S), 100 m (+-1440 km, ~45S) | same | mid/far field |
| `TrekDem(label)` + `download_product(label)` | Moon Trek full files | **geographic** lat/lon grid (see 2.2) | full download (1-1.9 GB, no Range) | Colab only; reproducible full-file method |
| `PgdaDem("LDEM_80S_20MPP_ADJ")` etc. | NASA GSFC PGDA product 90 (Barker et al. 2023) | native PS 20 m to 80S, 30 m to 75S, 60/120/240 m to 60S | COG range reads, cached blocks | **independent second method** (different LOLA processing) |
| `NestedDem([(fine, r1), (mid, r2), (coarse, r3)])` | any of the above | per distance band | - | horizon masks out to 150+ km without a 5 m grid over 300 km |

Recommended south-pole nesting (horizon radius 150 km):
`NestedDem([(TrekImageServerDem 5 m, 20 km), (PgdaDem LDEM_80S_20MPP_ADJ, 60 km), (TrekImageServerDem 30 m or PgdaDem LDEM_75S_30MPP_ADJ, 150 km)])`
and the same with PGDA/Trek swapped for the cross-check run. `NestedDem.rings()` gives one
`DemPatch` per distance band (see contract note at the end).

## 2. NASA Moon Trek (https://trek.nasa.gov/moon) - challenge resource

### 2.1 Catalogue / metadata / download endpoints

* Search: `https://trek.nasa.gov/moon/TrekServices/ws/index/eq/searchItems?start=0&rows=50&key=<text>`
  (JSON `{"response": {"docs": [...]}}`; `/index/sp/` and `/index/np/` return 404). Fields used:
  `productLabel`, `item_UUID`, `fileSize` (list with one int, bytes), `PIXEL_DEPTH`, `bbox`,
  `resolution` (deg/px), `projection` (geographic WKT!), `trekProjection` (`EPSG::104903`, Moon 2000 geographic).
* FGDC metadata: `https://trek.nasa.gov/moon/TrekWS/rest/cat/metadata/stream?label=<productLabel>`
  - only title, abstract ("shape map (radius) ... Map values are referred to a radius of 1737400 m")
  and bounding box. **No units, no scale factor, no projection info.**
* Full file: `https://trek.nasa.gov/moon/TrekWS/rest/cat/data/stream?uuid=<item_UUID>`
  (`Content-Disposition: attachment; filename=<label>.tif`, `Content-Type: tiff/jpeg2000`,
  `Transfer-Encoding: chunked`, **no Content-Length, no Accept-Ranges; a `Range` header is ignored
  (HTTP 200 + whole body)**). `download_product()` therefore restarts interrupted downloads from
  zero (it still sends `Range` and appends if a server ever answers 206), checks the byte count
  against `fileSize`, computes SHA-256 (Trek publishes no checksum) into `<file>.tif.json`, and
  refuses files > 100 MB unless `allow_large=True`, `LUNARNAV_ALLOW_LARGE_DOWNLOADS=1` or running
  on Google Colab.

South-pole LOLA v04 products (catalogue values):

| productLabel | item_UUID | fileSize (bytes) | PIXEL_DEPTH |
|---|---|---|---|
| LRO_LOLA_DEM_SPole875_5mp_v04_EQ | 52bac771-64e8-4db8-8614-b28c40cd1366 | 1 882 525 028 | Int16 |
| LRO_LOLA_DEM_SPole75_30mp_v04_EQ | df2e71f5-2c33-4e9d-80fc-d82d41ede253 | 1 026 486 758 | Float32 |
| LRO_LOLA_DEM_SPole45_100mp_v04_EQ | 80402dbf-a89e-4188-ad99-559106cb948b | 1 671 213 380 | Int16 |

(North-pole twins `LRO_LOLA_DEM_NPole*` exist too; global `LRO_LOLA_DEM_Global_128ppd_v04`
(Float32, 2.2 GB) and `..._256ppd_v06`.)

### 2.2 What is inside the files (verified from the first 4-12 MB only)

The header's first-IFD pointer points to an IFD at the **end** of the file (offset 1 882 065 114 of
1 882 525 028 for the 5 m file; GDAL rewrote the IFD after creation), but the original IFD with all
GeoTIFF tags is still right after the 8/16-byte header. `trek.probe_remote_header()` streams the
first N bytes, re-points the header to that IFD and parses it with rasterio.

| | SPole875_5mp | SPole75_30mp | SPole45_100mp |
|---|---|---|---|
| TIFF | classic | BigTIFF | classic |
| size (px) | 306 098 x 3 006 | 125 988 x 7 382 | 70 111 x 11 830 |
| dtype / compression | Int16 / none | Float32 / LZW | Int16 / none |
| tiles | 128 x 128 | 128 x 128 | 128 x 128 |
| CRS | `GEOGCS["GCS_Moon", SPHEROID 1737400,0]` | `GCS_Moon_2000` (ESRI 104903), sphere 1737400 | `GCS_Moon` sphere |
| pixel (deg) | 0.0011760941003603 | 0.00285740904194023 | 0.00513474545017597 |
| origin (lon, lat) | (-180, -86.46411384641813) | (-180, -68.90749860552876) | (-180, -29.253632629011033) |
| latitude spacing | **35.66 m** | **86.65 m** | **155.70 m** |
| nodata | 32767 | 1.1754939e-38 (FLT_MIN) | 32767 |
| scale/offset tags | none (1, 0) | none | none |
| height unit | **half-metres** | metres | **half-metres** |

* **Projection: the `_EQ` files are geographic (equirectangular) grids, not polar stereographic.**
  The latitude spacing means the radial resolution of the "5 m" file is ~36 m (longitude spacing near
  the pole is sub-metre). `TrekDem.patch()` resamples bilinearly onto a polar stereographic grid;
  within the last half pixel around the pole it interpolates radially to the mean of the edge row.
* **Units: Int16 = half-metres.** Evidence (no tag says so):
  5 m file, 300 valid pixels of the first tile row (lat ~86.5-86.6S) vs PGDA LDEM_75S_30MPP_ADJ:
  median ratio PGDA/raw = **0.50003** (5-95 %: 0.4987-0.5016), residual after x0.5: median -0.1 m,
  std 3.2 m (measured, `test_trek_int16_is_half_metres`). 100 m file vs PDS `LDEM_4.IMG`
  (https://imbrium.mit.edu/DATA/LOLA_GDR/CYLINDRICAL/IMG/LDEM_4.IMG, 4 ppd, Int16, SCALING_FACTOR 0.5):
  least-squares slope 0.498. Float32 30 m file vs PGDA: ratio 1.000 (metres).
* Real data coverage of each file is the inscribed circle of the original polar square (corner
  tiles of the top rows hold data, the rest is nodata).

### 2.3 Trek ArcGIS ImageServer (raw elevation, partial reads) - used by `TrekImageServerDem`

Found in the Trek portal configuration `https://trek.nasa.gov/moon/jpl/config/config.json`
(`globalDEMService`). Catalogue: `https://trek.nasa.gov/moon/trekarcgis/rest/services?f=json`
(279 services, ArcGIS 10.61). For each LOLA DEM there is an `_EQ` service (geographic, S16) and a
service WITHOUT `_EQ` which is the **native polar stereographic product**:

| service | pixel | extent (m) | pixelType | min / max (m) |
|---|---|---|---|---|
| LRO_LOLA_DEM_SPole875_5mp_v04 | 5 m | +-75 840 | F32 | -4382.5 / 2372.5 |
| LRO_LOLA_DEM_SPole75_30mp_v04 | 30 m | +-457 440 | F32 | -7762 / 7027 |
| LRO_LOLA_DEM_SPole45_100mp_v04 | 100 m | +-1 440 000 | F32 | -9126.5 / 7026 |

CRS: ESRI `Stereographic_South_Pole`, `standard_parallel_1=-90` (k=1 at the pole), central
meridian 0, sphere 1737400 m - identical to ours (`verify_ps_crs`, < 1 mm). Values in **metres**.

Request (one cached block):
`.../ImageServer/exportImage?bbox=xmin,ymin,xmax,ymax&size=W,H&format=tiff&pixelType=F32&interpolation=RSP_NearestNeighbor&f=image`
with the bbox exactly on pixel edges (multiples of the pixel size from the extent origin).
Limits: `maxImageWidth` 15000, `maxImageHeight` 4100 (we use 1024 x 1024 blocks, ~4 MB, 2-4 s).
Outside the data the server returns -3.4028235e38 (mapped to NaN). Verified: identical values for
different block layouts (no resampling), 5 m averaged 6x6 vs 30 m: mean -0.24 m, std 2.05 m;
30 m vs PGDA 30 m (same grid): mean 0.76 m, std 3.79 m, p99 |d| 16 m (window near Shackleton).

### 2.4 Other Trek services checked (not used)

* WMTS `https://trek.nasa.gov/tiles/Moon/EQ/<label>/1.0.0/WMTSCapabilities.xml`: tiles are
  `image/png`, 2 bands uint8 (gray + alpha, 233 distinct grey levels in a level-0 tile) =
  **rendered images, not elevations**. Useless for computation.
* Subset `https://trek.nasa.gov/moon/TrekWS/rest/transform/latlon/subset/stream/tiff?src=<label>&ulx=&uly=&lrx=&lry=`
  (portal "subset" tool): for `src=LRO_LOLA_DEM_SPole75_30mp_v04` and a lat/lon box it returned a
  2 x 1 px TIFF; parameter semantics undocumented -> not used.
* Elevation profile `https://trek.nasa.gov/moon/TrekServices/ws/elevationProfileSP/calculate?endpoint=<ImageServer>&path=[[x,y],...]&numberOfPoints=100&radiusInMeters=...`
  (portal line tool); `lightingService` `.../TrekWS/rest/light`, `losService` `.../TrekWS/rest/los/`
  (asynchronous jobs that e-mail results) - not suitable for automated precompute.

## 3. LROC QuickMap (https://quickmap.lroc.asu.edu) - challenge resource

The current QuickMap is a single-page app (`/assets/index-*.js`). Map tiles come from
`https://*.actgate.com/tiles` (rendered imagery), and its 3-D globe uses a Cesium height-map terrain
`https://dem-tiles.b-cdn.net/lunar/qts_demstack/` (`lunar-fulleqc`, polar
`lunar-polarshifted-eqc`) - a mixed, undocumented "DEM stack" for visualisation. There is no
documented raw-elevation API (no WCS/point query). **Not used for computation**; useful for visual
sanity checks of horizons/illumination in the frontend phase (it has a Sun/Earth lighting tool).

## 4. NASA GSFC PGDA product 90 - Barker et al. (2023) south-pole LDEMs (second method)

Page: https://pgda.gsfc.nasa.gov/products/90 - Barker, M.K. et al. 2023, PSJ 4:183,
doi:10.3847/PSJ/acf3e1; data doi:10.60903/gsfcpgda-lola-spole. Files:
`https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/<NAME>.TIF` (cloud-optimised GeoTIFF).

| file | pixel | extent | size |
|---|---|---|---|
| LDEM_83S_10MPP_ADJ.TIF | 10 m | to 83S | 4.8 GB |
| LDEM_80S_20MPP_ADJ.TIF | 20 m | 30400 px, +-304 000 m | 2.6 GB |
| LDEM_80S_40MPP_ADJ.TIF / _80MPP_ | 40 / 80 m | +-304 000 m | 685 / 181 MB |
| LDEM_75S_30MPP_ADJ.TIF | 30 m | 30496 px, +-457 440 m (same grid as Trek 30 m) | 2.7 GB |
| LDEM_60S_60MPP_ADJ / _120MPP_ / _240MPP_ | 60/120/240 m | +-931 200 m | 2.9 G / 785 M / 210 M |

Also per product: `_ERR` (height error, m), `_EFFRES` (effective resolution, m), `_HILL`,
`LDEC_*` (LOLA spot counts), `LDSM_*` (slope, deg), `LDRM_*` roughness, point clouds
`LDEM_80S_ADJ.XYZI` (13 GB).

Verified header facts: Float32, DEFLATE, 512 x 512 tiles, overviews x2..x64, nodata NaN, heights in
**metres** (GMT history `... 1000.0 MUL`, `actual_range` -7296.8..7027.2 m for 80S), CRS
`Polar_Stereographic`, sphere 1737400, latitude of origin -90, central meridian 0 (WKT has odd
`AXIS["Easting",NORTH],AXIS["Northing",NORTH]` tags - harmless, verified numerically), MOON_ME/DE421.

Remote reads: `rasterio.open("/vsicurl/<url>")` inside `rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR, CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,.TIF", GDAL_HTTP_MULTIRANGE=YES, GDAL_HTTP_MERGE_CONSECUTIVE_RANGES=YES, GDAL_HTTP_MAX_RETRY=4, GDAL_HTTP_RETRY_DELAY=2)`
(`pgda.GDAL_REMOTE_ENV`). Each 512 x 512 block is cached as `.npz` in `data/cache/pgda/<product>/`.
Server latency ~2-5 s per block.

Measured reference values (PGDA 20 m): south pole (90S) **+1289.3 m** (Trek 5 m: 1289.5, Trek 30 m:
1290.25); 89.9S 45E: 1303.7 m; Shackleton centre 89.66S 129.2E: -2766.1 m; Shackleton floor
(r < 3 km) mean -2718 m / min -2872 m (at x=9970, y=-5490 m); rim annulus 10-11 km mean +1196 m,
max +1738 m -> ~3.9-4.6 km deep.

## 5. Validation products for the illumination / Earth-visibility checks

PGDA product 69, "Lunar Polar Illumination" (Mazarico et al. 2011, Icarus 211:1066, updated
2016-08; averages over 18.6 years, hourly, LOLA topography; Earth "visible" if any part of its disc
is visible): https://pgda.gsfc.nasa.gov/products/69

| quantity | URL (GeoTIFF, remote windowed reads work) |
|---|---|
| avg. solar visibility 85S-90S 60 m | https://pgda.gsfc.nasa.gov/data/MoonIllumination/AVGVISIB_85S_060M_201608.TIF |
| avg. Earth visibility 85S-90S 60 m | https://pgda.gsfc.nasa.gov/data/MoonIllumination/AVGVISIB_85S_060M_201608_EARTH.TIF |
| avg. solar / Earth 75S-90S 120 m | .../AVGVISIB_75S_120M_201608.TIF, .../AVGVISIB_75S_120M_201608_EARTH.TIF |
| avg. solar / Earth 65S-90S 240 m | .../AVGVISIB_65S_240M_201608.TIF, .../AVGVISIB_65S_240M_201608_EARTH.TIF |
| permanent shadow 85S/75S/65S | .../LPSR_85S_060M_201608.TIF, .../LPSR_75S_120M_201608.TIF, .../LPSR_65S_240M_201608.TIF |
| sky visibility 65S | .../SKYV_65S_240M.TIF |
| north-pole equivalents | same names with `N` |
| PDS originals (IMG + LBL) | http://imbrium.mit.edu/EXTRAS/ILLUMINATION/IMG/ (also JP2/), and https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/extras/illumination/ |

Verified tags: Int16, nodata -32768, DEFLATE 256x256 tiles, PS 1737.4 km k=1, 60 m grid
5058 x 5058 (+-151 740 m); AVGVISIB scale **4e-5** (fraction 0..1), LPSR scale 2.5e-5 offset 0.5.
The `*_COG.TIF` links on the page return 404 (2026-11); use the plain `.TIF`. The 60 m maps have
isolated 0-valued pixels (e.g. 89.45S 222.69E is 0 while its 8 neighbours are 0.24-0.86), so
`pgda.read_validation_value(..., neighborhood=1)` (3x3 median) is recommended. Measured: Shackleton
floor 89.66S 129.2E sun 0.0 / Earth 0.0; 89.9S 45E sun 0.41 / Earth 0.56.

Barker 2023 PSR map at 20 m: https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LPSR_80S_20MPP_ADJ.TIF
(Float32, +-304 km, 148 MB) plus shapefile/CSV tables `LPSR_80S_20MPP_ADJ*.{SHP,CSV}` (506 349
PSRs; `_1km2` = 1531 PSRs > 1 km^2).

Possible future high-resolution DEMs: PGDA product 104 (Bertone 2026, 5 m Shape-from-Shading DEMs of
the 13 Artemis III candidate regions, Zenodo) and product 92 (large-scale elevation models for optical
navigation).

## 6. Colab heavy-run recipe

```python
import os; os.environ["LUNARNAV_DATA"] = "/content/drive/MyDrive/lunarnav_data"   # persistent cache
from lunarnav.terrain.trek import download_product, TrekDem, TrekImageServerDem
from lunarnav.terrain.pgda import PgdaDem
from lunarnav.terrain.common import NestedDem
p = download_product("LRO_LOLA_DEM_SPole75_30mp_v04_EQ")   # 1.03 GB, auto-allowed on Colab, ~SHA-256 sidecar
trek30 = TrekDem("LRO_LOLA_DEM_SPole75_30mp_v04_EQ", patch_resolution_m=30.0)
fine = TrekImageServerDem("LRO_LOLA_DEM_SPole875_5mp_v04")
dem_a = NestedDem([(fine, 20e3), (TrekImageServerDem("LRO_LOLA_DEM_SPole75_30mp_v04"), 150e3)])
dem_b = NestedDem([(PgdaDem("LDEM_80S_20MPP_ADJ"), 60e3), (PgdaDem("LDEM_75S_30MPP_ADJ"), 150e3)])
```
Disk: 1-2 GB per Trek file; ImageServer/PGDA caches grow ~1-4 MB per block (a 150 km radius at
30 m is ~100 blocks). Memory: `patch()` refuses > 200 M pixels (`max_pixels`), use `rings()`.

## 7. Known limitations

* Trek `_EQ` full files have degraded radial resolution (35.7 / 86.6 / 155.7 m) - prefer the native
  ImageServer grids for the near field; `TrekDem` remains the "full-file" independent path.
* Trek v04 products (data to 2011) and PGDA Barker 2023 (more tracks, crossover-adjusted) differ by
  a few metres (std ~4 m, p99 ~16 m on 30 m pixels): this is the expected inter-method spread.
* Non-polar sites (Apollo): the polar products do not cover them; `DemPatch` is defined in polar
  stereographic only. A site-centred projection (or the global 128/256 ppd products) would be needed.
* The real Trek full file's final IFD (end of file) could not be inspected without downloading
  1-2 GB; `TrekDem` re-checks dtype/size/CRS/scale on open and `download_product(verify=True)` opens
  the file after download.
