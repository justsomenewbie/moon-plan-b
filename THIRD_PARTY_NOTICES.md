# Third-party notices, data sources and credits

This file covers the `lunar-navigator/` part of the Moon Plan B project for the NASA Space Apps
Challenge 2026, "Lunar Landing Site Navigator". That part is the Python package `lunarnav` and the
Node.js API in `backend/`. The team frontend lives in `frontend/` of the team repository and has its
own credits.

The code in this folder is released under the MIT License (see [`LICENSE`](LICENSE)). The software
and data listed below belong to their own authors and keep their own licenses and terms of use.
They are not covered by our MIT license.

The use of AI tools is described in [`docs/AI_DISCLOSURE.md`](docs/AI_DISCLOSURE.md).

Contents:

1. [Python dependencies](#1-python-dependencies-lunarnav)
2. [Node.js backend dependencies](#2-nodejs-backend-dependencies-backend)
3. [Development-only tooling](#3-development-only-tooling)
4. [External software and services that are not distributed here](#4-external-software-and-services-not-distributed-here)
5. [Copyleft summary](#5-copyleft-summary)
6. [Data sources and credits](#6-data-sources-and-credits)
7. [NASA-derived data files in this repository](#7-nasa-derived-data-files-in-this-repository)
8. [Use of NASA data and names](#8-use-of-nasa-data-and-names)

---

## 1. Python dependencies (`lunarnav`)

Declared in [`pyproject.toml`](pyproject.toml). The versions are the ones installed in the
development virtual environment (Python 3.13.8, Windows) and were read with `importlib.metadata`.
Other environments, such as Google Colab, may resolve newer versions within the same ranges.
This repository does not redistribute any of these packages: `pip` downloads them from PyPI.

### 1.1 Runtime dependencies

| Package | Version | License | Notes |
|---|---|---|---|
| numpy | 2.5.4 | BSD-3-Clause | The wheel's license expression also lists bundled parts under 0BSD, MIT, Zlib and CC0-1.0. |
| scipy | 1.18.1 | BSD-3-Clause | |
| requests | 2.34.2 | Apache-2.0 | |
| spiceypy | 8.4.0 | MIT | Bundles the NAIF CSPICE toolkit (`CSPICE_N0067`, as `spiceypy/utils/cspice.dll`). NAIF distributes CSPICE free of charge under its rules of use: https://naif.jpl.nasa.gov/naif/rules.html |
| rasterio | 1.5.2 | BSD-3-Clause | The binary wheel bundles GDAL 3.12.2 (MIT), PROJ 9.7.1 (MIT) and GDAL's own native dependencies. See section 5. |
| pyproj | 3.8.0 | MIT | The binary wheel bundles PROJ 9.8.1 (MIT). The PROJ license is shipped as `LICENSE_proj` in the wheel. |
| astropy | 8.0.2 | BSD-3-Clause | |
| certifi | 2026.10.23 | MPL-2.0 | Installed through requests and rasterio and used unmodified. Its source code is available from PyPI. |

Transitive runtime packages, all permissive: urllib3 2.8.0 (MIT), idna 3.20 (BSD-3-Clause),
charset-normalizer 3.5.2 (MIT), affine 3.0.1 (BSD-3-Clause), attrs 26.1.0 (MIT), click 8.5.1
(BSD-3-Clause), pyparsing 3.3.3 (MIT), pyerfa 2.0.1.5 (BSD-3-Clause, wraps ERFA), astropy-iers-data
0.2026.11.9.0.35.9 (BSD-3-Clause), PyYAML 6.0.3 (MIT), packaging 26.3 (Apache-2.0 OR BSD-2-Clause)
and colorama 0.4.6 (BSD, on Windows).

### 1.2 Optional extras (`dev`, `notebook`)

| Package | Version | License | Used for |
|---|---|---|---|
| pytest | 9.2.0 | MIT | test suite (`dev` extra) |
| matplotlib | 3.11.2 | Matplotlib License (PSF-based) | sanity plots in the Colab notebook. The bundled DejaVu and STIX fonts have their own licenses inside the package. |
| nbclient | 0.11.0 | BSD-3-Clause | local smoke test of the notebook |
| nbformat | 5.11.1 | BSD-3-Clause | local smoke test of the notebook |
| ipykernel | 7.4.0 | BSD-3-Clause | notebook kernel |

These extras also pull in permissive packages, for example ipython (BSD-3-Clause), pyzmq
(BSD-3-Clause), tornado (Apache-2.0), pillow (MIT-CMU), jsonschema (MIT) and typing_extensions
(PSF-2.0). A scan of every distribution installed in the development environment found no GPL, LGPL
or AGPL package.

---

## 2. Node.js backend dependencies (`backend/`)

Declared in [`backend/package.json`](backend/package.json), with exact versions pinned in
`backend/package-lock.json`. The versions and licenses below were checked against both the lockfile
and `node_modules/*/package.json`. `npm ci` downloads the packages from the npm registry, and
`node_modules/` is not committed. The runtime is Node.js 24 (MIT).

### 2.1 Direct runtime dependencies

| Package | Version | License | Notes |
|---|---|---|---|
| fastify | 5.12.8 | MIT | HTTP framework |
| @fastify/compress | 9.3.0 | MIT | |
| @fastify/cors | 11.4.3 | MIT | |
| @fastify/helmet | 13.2.0 | MIT | |
| @fastify/rate-limit | 11.2.2 | MIT | |
| @fastify/swagger | 9.9.4 | MIT | OpenAPI document generation |
| @fastify/swagger-ui | 6.1.3 | MIT | Serves a pre-built Swagger UI bundle (swagger-ui-dist 5.34.0, Apache-2.0, SmartBear Software) at `/docs`. |
| csv-parse | 7.0.3 | MIT | |
| csv-stringify | 6.9.0 | MIT | |
| execa | 10.2.1 | MIT | runs the Python `lunarnav` CLI for jobs |
| fastify-type-provider-zod | 7.0.0 | MIT | |
| mongodb | 7.9.0 | Apache-2.0 | official MongoDB Node.js driver. Its dependencies bson 7.3.4 and mongodb-connection-string-url 7.0.2 are also Apache-2.0. |
| openapi-types | 12.1.3 | MIT | |
| p-queue | 10.0.0 | MIT | |
| zod | 4.6.7 | MIT | |

### 2.2 All runtime packages in the lockfile

The production install has 120 packages, counting transitive ones. Their licenses are MIT (97),
ISC (7), BSD-3-Clause (5), BlueOak-1.0.0 (6), Apache-2.0 (4) and BSD-2-Clause (1), and all of these
are permissive. The BlueOak-1.0.0 packages are glob, minimatch, lru-cache, minipass, path-scurry and
@isaacs/nonrecursive-glob-match, all pulled in by @fastify/static, a dependency of
@fastify/swagger-ui.

---

## 3. Development-only tooling

These tools are used only to build and test the code. They are not part of the production
dependency tree, and they are not shipped.

| Tool | Version | License | Notes |
|---|---|---|---|
| typescript | 5.9.3 | Apache-2.0 | type checking and build |
| vitest | 5.1.0 | MIT | test runner. It pulls in vite 8.3.8 and rolldown 1.2.19 (MIT), and tslib (0BSD). |
| lightningcss | 1.33.0 | MPL-2.0 | Pulled in through vite. It is a dev-only dependency, used unmodified. |
| mongodb-memory-server | 11.3.0 | MIT | For tests only, it downloads an official MongoDB Community Server binary (version 8.0.23, set in `package.json` `config.mongodbMemoryServer`). That binary is under the Server Side Public License (SSPL-1.0). It runs as a separate, unmodified test process and is never redistributed. |
| @types/node | 24.19.2 | MIT | type definitions |
| @stoplight/prism-cli, @redocly/cli | 5.15.11, 2.78.0 | Apache-2.0, MIT | Optional `npm run mock` / `lint:openapi` helpers, fetched on demand with `npx`. They are not in the lockfile. |

---

## 4. External software and services not distributed here

The deployment scripts in `backend/deploy/` install or use the software below on the API server.
None of it is linked into our code, modified, or included in this repository.

| Software / service | License or terms | Role |
|---|---|---|
| MongoDB Community Server 8.0 | SSPL-1.0 | database for the deployed API, run as an unmodified separate process |
| Caddy | Apache-2.0 | HTTPS reverse proxy (`backend/deploy/Caddyfile`) |
| nginx | BSD-2-Clause | alternative reverse proxy (`backend/deploy/nginx-api.conf`) |
| pm2 7.1.2 | AGPL-3.0 | Process manager installed globally on the server by `provision-ubuntu.sh`. It is an unmodified, separate tool, and our code does not import it. |
| Node.js 24, Python 3 | MIT, PSF-2.0 | runtimes |
| Google Colab | Google terms of service | Hosted notebook service used to run the long precompute (`notebooks/lunar_navigator_colab.ipynb`). It is not an AI tool and does not affect the results. |

---

## 5. Copyleft summary

* None of the code in this repository is under the GPL, LGPL or AGPL. No GPL, LGPL or AGPL package
  is a Python or Node.js dependency of `lunarnav` or `backend/`.
* The MPL-2.0 components are certifi at runtime and lightningcss for development only. Both are
  used unmodified, so we have no file-level obligations beyond keeping their notices.
* Native libraries inside third-party binary wheels: the rasterio wheel for Windows bundles GDAL
  together with GDAL's own dependencies as separate DLLs. One of these is GEOS, which is under
  LGPL-2.1. Our code never calls GEOS directly. The library is loaded dynamically by GDAL, it is
  unmodified, and it comes only from the upstream rasterio wheel on PyPI. We do not redistribute it.
* Other software with copyleft-style terms is used only as separate programs and is never
  distributed by us. These are the MongoDB server (SSPL-1.0), which runs for tests and in
  deployment, and pm2 (AGPL-3.0), which runs on the deployment server.

---

## 6. Data sources and credits

Every number produced by `lunarnav` comes from the data below. Technical details for each source
are in [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md), [`docs/HORIZONS_NOTES.md`](docs/HORIZONS_NOTES.md)
and [`docs/SITES.md`](docs/SITES.md).

The project produces two independent computation runs. Run A uses JPL Horizons with NASA Moon Trek
LOLA terrain. Run B uses SPICE with NASA GSFC PGDA LOLA terrain. Run B is the default dataset of the
API.

### 6.1 Ephemerides (Sun and Earth positions)

* **JPL Horizons System**, from JPL Solar System Dynamics, NASA Jet Propulsion Laboratory /
  California Institute of Technology. API: https://ssd.jpl.nasa.gov/api/horizons.api, web app:
  https://ssd.jpl.nasa.gov/horizons/app.html. It is the run A ephemeris and an independent
  cross-check of run B. Its responses report the DE441 ephemeris and the lunar MEAN_ME frame.
  Citation: Giorgini, J.D., Yeomans, D.K., Chamberlin, A.B., Chodas, P.W., Jacobson, R.A.,
  Keesey, M.S., Lieske, J.H., Ostro, S.J., Standish, E.M., Wimberly, R.N. (1996), "JPL's On-Line
  Solar System Data Service", Bulletin of the American Astronomical Society 28(3), 1158.
* **NAIF SPICE generic kernels**, from the Navigation and Ancillary Information Facility (NAIF),
  NASA JPL: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/. These are the run B ephemeris.
  The kernels are downloaded at run time and are not stored in this repository:
  `lsk/naif0012.tls`, `pck/pck00011.tpc`, `spk/planets/de440s.bsp` (optionally `de440.bsp`),
  `pck/moon_pa_de440_200625.bpc`, `fk/satellites/moon_de440_250416.tf`, and for the DE421
  cross-check `pck/moon_pa_de421_1900-2050.bpc` and `fk/satellites/moon_080317.tf`.
  We acknowledge NAIF / JPL for the SPICE system and kernels. Citations requested by NAIF:
  * Acton, C.H. (1996), "Ancillary data services of NASA's Navigation and Ancillary Information
    Facility", Planetary and Space Science 44(1), 65-70.
  * Acton, C., Bachman, N., Semenov, B., Wright, E. (2018), "A look towards the future in the
    handling of space science mission geometry", Planetary and Space Science 150, 9-12.

  The DE440 planetary and lunar ephemeris: Park, R.S., Folkner, W.M., Williams, J.G., Boggs, D.H.
  (2021), "The JPL Planetary and Lunar Ephemerides DE440 and DE441", The Astronomical Journal
  161:105.

### 6.2 Terrain (LRO LOLA digital elevation models)

All terrain is derived from the Lunar Orbiter Laser Altimeter (LOLA) on NASA's Lunar
Reconnaissance Orbiter (LRO). We credit the LRO mission and the LOLA science team (NASA Goddard
Space Flight Center).

* **NASA Moon Trek LOLA polar DEMs**, from NASA/JPL Solar System Treks: https://trek.nasa.gov/moon/.
  This is the run A terrain and a resource listed for the challenge. The products used are
  `LRO_LOLA_DEM_SPole875_5mp_v04`, `LRO_LOLA_DEM_SPole75_30mp_v04` and
  `LRO_LOLA_DEM_SPole45_100mp_v04`. We read the native ImageServer grids and the `_EQ` full files.
* **NASA GSFC Planetary Geodesy Data Archive (PGDA)**: https://pgda.gsfc.nasa.gov/
  * Product 90, LOLA south-pole DEMs (`LDEM_*_ADJ`): https://pgda.gsfc.nasa.gov/products/90. This
    is the run B terrain. Barker, M.K. et al. (2023), Planetary Science Journal 4:183,
    doi:10.3847/PSJ/acf3e1. Data doi:10.60903/gsfcpgda-lola-spole.
  * Product 69, Lunar Polar Illumination (average Sun and Earth visibility, permanent shadow maps):
    https://pgda.gsfc.nasa.gov/products/69. These maps validate our results and provide the
    "PGDA %" values in the site catalog. Mazarico, E. et al. (2011), Icarus 211, 1066. The PDS
    copies are at http://imbrium.mit.edu/EXTRAS/ILLUMINATION/IMG/ and
    https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/extras/illumination/.
  * Product 104, 5 m Shape-from-Shading DEMs of Artemis III candidate regions:
    https://pgda.gsfc.nasa.gov/products/104. We use its Zenodo README for the region bounding
    boxes, and we do not use the DEMs. Bertone, S. et al. (2026), "Enhanced Topography Models for
    Selected Lunar South Pole Regions with Shape-from-Shading", Planetary Science Journal,
    doi:10.3847/PSJ/ae5b70. Data: Zenodo doi:10.5281/zenodo.17954508
    (https://zenodo.org/records/17954508).
* **LOLA PDS gridded data record**, `LDEM_4.IMG`:
  https://imbrium.mit.edu/DATA/LOLA_GDR/CYLINDRICAL/IMG/LDEM_4.IMG. It was used only to confirm the
  height units of the Moon Trek files.
* **LROC QuickMap**, from Arizona State University / LRO Camera team: https://quickmap.lroc.asu.edu/.
  It is a challenge resource. We used it only for manual visual cross-checks
  (`docs/NASA_TOOLS_CROSSCHECK.md`) and not for any computation.

### 6.3 Site catalog (`lunarnav/catalog/sites.json`)

The 23 sites and their reference values come from the following sources. Each entry in the catalog
stores its own `source_url`.

* **Artemis III candidate regions.**
  * NASA news release, 28 Oct 2024:
    https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/
  * George et al., LPSC 2026, NTRS 20250011660: https://ntrs.nasa.gov/citations/20250011660. Three
    region centres were measured on its region map.
  * Bertone et al. (2026) Zenodo README for the bounding boxes (see 6.2).
* **Landed missions.** LROC featured-image pages, ASU / NASA LRO:
  https://www.lroc.asu.edu/images/1408 and /1401 (IM-2), /1360 and /1321 (IM-1), /1314
  (Chandrayaan-3), /1374 (Chang'e-6) and /1087 (Chang'e-4).
* **Apollo 11, 15 and 17 lunar module positions.** NASA Space Science Data Coordinated Archive
  (NSSDCA):
  https://nssdc.gsfc.nasa.gov/nmc/spacecraft/display.action?id=1969-059C, `?id=1971-063C`,
  `?id=1972-096C`.
* **IAU / USGS Gazetteer of Planetary Nomenclature** (crater centres and landing-site station
  names): https://planetarynames.wr.usgs.gov/Feature/5450 (Shackleton),
  https://planetarynames.wr.usgs.gov/Feature/14502 (Haworth),
  https://planetarynames.wr.usgs.gov/Feature/16272 (Statio Shiv Shakti), and features 5684, 16328
  and 15781 as secondary checks.
* **Reference illumination values**:
  * Gläser, P. et al. (2018), "Illumination conditions at the lunar poles: implications for future
    exploration", Planetary and Space Science 162, 170-178, Tables 1 and 2. NTRS 20170007365:
    https://ntrs.nasa.gov/citations/20170007365
  * Mazarico, E. et al. (2011), Icarus 211, 1066, as tabulated in Gläser et al. (2018).
  * Speyerer, E.J. and Robinson, M.S. (2013), Icarus 222, 122, as tabulated in Gläser et al. (2018).
  * Barker, M.K. et al. (2021), Planetary and Space Science 203, 105119, for the region-of-interest
    centroids of "Site 1". The catalog also links NTRS 20205009660:
    https://ntrs.nasa.gov/citations/20205009660
  * Zuber, M.T. et al. (2012), Nature 486, 378, for the permanently shadowed floor of Shackleton.
* **Apollo 11 validation facts**:
  * Apollo 11 Mission Report MSC-00171, NTRS 19710015566:
    https://ntrs.nasa.gov/citations/19710015566
  * Apollo Lunar Surface Journal, post-landing transcript:
    https://www.nasa.gov/wp-content/uploads/static/history/alsj/a11/a11.postland.html

---

## 7. NASA-derived data files in this repository

Large NASA products are never committed. SPICE kernels, Moon Trek and PGDA DEMs, and illumination
maps are downloaded at run time into git-ignored folders (`data/kernels/`, `data/dem/`,
`data/cache/`). Some small files derived from NASA data are committed so that the tests can run
offline:

| Path | Content | Derived from |
|---|---|---|
| `tests/data/horizons_*.txt` (2 files) | Verbatim JPL Horizons API responses captured on 2026-11-13, used as parser fixtures. | JPL Horizons |
| `lunarnav/catalog/sites.json` (copies are in `backend/tests/jobs/*/lunarnav/catalog/`) | Site coordinates, region outlines, and reference and PGDA-sampled illumination values. | the sources in 6.3, PGDA product 69 |
| `backend/tests/fixtures/sample_2026Q1_spice_pgda/` | Small sample of our own run output for six sites, 2026 Q1: ephemerides, horizon masks, visibility, windows. | NAIF SPICE kernels, PGDA product 90 DEMs |
| `backend/src/fixtures/*.json`, `backend/contract/examples/*` | API fixtures and example responses computed by our code. | the same run data |
| `backend/tests/importer/fixtures/run_small/` | Synthetic toy geometry for tests. It contains no NASA data. | none |

---

## 8. Use of NASA data and names

NASA data are generally not subject to copyright in the United States. We use them according to the
NASA Images and Media Usage Guidelines (https://www.nasa.gov/nasa-brand-center/images-and-media/)
and the data policies of each archive. We credit the source of each dataset.

This project uses no NASA logos, insignia or other NASA branding. Names such as "NASA", "JPL",
"Moon Trek" and "PGDA" appear only to identify where data come from. NASA, JPL, GSFC, ASU and the
other data providers have not reviewed or endorsed this project.
