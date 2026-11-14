# Lunar Landing Site Navigator: computation backend and API

Team **Moon Plan B** · NASA Space Apps Challenge 2026 · challenge **"Lunar Landing Site Navigator"**

This folder is the data and API half of the project: the Python package **`lunarnav`** computes where the Sun and the
Earth are relative to the real terrain horizon of each candidate landing site, and the Node.js API in
[`backend/`](backend/) serves those results to the team web app (in `frontend/` of the team repository).

| | |
|---|---|
| Web app | https://lunavigator.com |
| Live API | https://api.lunavigator.com/api/v1 (health check: https://api.lunavigator.com/api/v1/health) |
| License | MIT ([`LICENSE`](LICENSE)); third-party software and data: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) |
| AI use | Disclosed in [`docs/AI_DISCLOSURE.md`](docs/AI_DISCLOSURE.md) |

`/api/v1/health` is public. Every other API route needs an `X-API-Key` header; keys are given privately to the
frontend team, and the Swagger UI at `/docs` is behind HTTP Basic auth. You do not need a key to review the project:
the [Run it locally](#run-it-locally) section starts the same API on your machine with authentication turned off.

---

## What it does

Near the lunar south pole the Sun stays within about 1.5° of the horizon and the Earth within about 7°, so **the
terrain decides everything**: a ridge a few kilometres away can hide the Sun for days or cut the radio link to Earth.
For each site and each hour from 2026 to 2030 we compute:

* **Sun visibility (power):** the fraction of the solar disc above the terrain horizon, solar-panel power proxies,
  and the longest dark period.
* **Earth visibility (direct-to-Earth comms):** whether the Earth is above the terrain horizon, and the longest
  communication gap.
* **Ranking:** a weighted score (% sun, % Earth, % both) to compare candidate sites.
* **Alternative landing dates:** if the launch slips, which later dates still give enough sunlight and Earth
  contact for the mission duration.

The answers are checked against independent methods and against NASA's own tools and maps (see
[Key results](#key-results)). The catalog has **23 sites**: 12 south-pole candidates (Artemis III candidate regions
and polar landings), 6 literature reference points, 3 Apollo sites and 2 far-side sites
([`docs/SITES.md`](docs/SITES.md)). The API can also compute any custom coordinate on request.

## How it works

```
  NASA data                     lunarnav (Python, precompute)               backend/ (Node.js)          frontend/ (team repo)
 ------------------          ----------------------------------          ---------------------      ---------------------
  JPL Horizons    --+        ephemeris: Sun / Earth az, el, dist
  NAIF SPICE      --+-->     (method A Horizons, B SPICE, C analytic)
                             terrain horizon mask per site       --> run    Fastify API  /api/v1  --> Next.js web app
  Moon Trek LOLA  --+-->     (raymarch | brute force | flat)          folder  + MongoDB (series,      https://lunavigator.com
  PGDA LOLA       --+        visibility, windows, metrics, ranking  (CSV/JSON)  windows, horizons)
                             `lunarnav check`: 0 violations      --> npm run import
                                                                     (gate: lunarnav check + sha256)
```

1. **Precompute** (`lunarnav precompute`, heavy runs on Google Colab) writes a deterministic **run folder**:
   `manifest.json` (parameters, data sources, sha256 of every file), `sites.json`, `summary.csv` and per-site
   `horizon_*.csv`, `ephemeris_*.csv.gz`, `visibility.csv.gz`, `windows.json`. Format: [`docs/OUTPUT_SPEC.md`](docs/OUTPUT_SPEC.md).
2. **Import** (`npm run import`) re-runs `lunarnav check`, verifies the checksums and loads the run into MongoDB.
3. **API** (Fastify 5 + zod, OpenAPI contract in [`backend/contract/openapi.json`](backend/contract/openapi.json))
   serves sites, time series, windows, sky diagrams, rankings, comparisons and alternative dates, and runs Python jobs
   for custom coordinates.
4. **Frontend** (Next.js, `../frontend` in the team repository) calls the API from its server side.

Two complete, independent datasets were computed for 23 sites, 2026-2030, hourly:

| Run | Ephemeris | Terrain | Role |
|---|---|---|---|
| **B** (default in the live API) | NAIF SPICE (DE440) | NASA GSFC PGDA LOLA DEM | default dataset, after the rim-site horizon fix (commit `676af9d`) |
| **A** | JPL Horizons API | NASA Moon Trek LOLA DEM | cross-check from the challenge's own resources |

More detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## NASA data and tools used

| Source | Used for | Link |
|---|---|---|
| JPL Horizons System | ephemeris method A (Sun and Earth seen from each site) | https://ssd.jpl.nasa.gov/horizons/ |
| NASA Moon Trek (LOLA polar DEMs) | terrain for run A | https://trek.nasa.gov/moon/ |
| NASA GSFC PGDA LOLA DEMs (product 90, Barker et al. 2023) | terrain for run B | https://pgda.gsfc.nasa.gov/products/90 |
| NASA GSFC PGDA illumination maps (product 69, Mazarico et al.) | validation of % sunlight and Earth visibility | https://pgda.gsfc.nasa.gov/products/69 |
| NAIF SPICE generic kernels (DE440, lunar PA/ME frames) | ephemeris method B | https://naif.jpl.nasa.gov/pub/naif/generic_kernels/ |
| LROC QuickMap | manual cross-check of heights, illumination and shadowed craters | https://quickmap.lroc.asu.edu/ |

How each source was read (formats, units, quirks): [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md) and
[`docs/HORIZONS_NOTES.md`](docs/HORIZONS_NOTES.md). Full credits and terms: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Key results

All numbers below are measured and documented in [`docs/VALIDATION.md`](docs/VALIDATION.md) (ephemeris) and
[`docs/VALIDATION_TERRAIN.md`](docs/VALIDATION_TERRAIN.md) (terrain).

**Sun and Earth positions** (three independent methods, 6 sites, 8652 samples each):

| Check | Measured | Limit |
|---|---|---|
| Horizons (A) vs SPICE (B), largest angle | Sun 0.0017″, Earth 0.0020″ | 0.02″ |
| A/B vs analytic model (C, no JPL data) | Sun 0.0040°, Earth 0.0034° | 0.02° |
| Negative controls (wrong frame, time scale, aberration, west longitude, ...) | every deliberate error caught | - |
| Apollo 11 landing, 1969-07-20 20:17:40 UTC, Sun elevation | 10.703° (A and B), 10.702° (C) | documented 10.8 ± 0.5° |

**Terrain and illumination:**

| Check | Measured | Limit |
|---|---|---|
| Two horizon algorithms (raymarch vs brute force), real terrain beyond 2 km | p95 0.015-0.070° | 0.1° |
| Sunlight in 30 permanently shadowed pixels vs NASA PGDA map | 0.000 % at all 30 | PASS |
| Sunlight in 30 well-lit pixels vs NASA PGDA map, 2 m mast | bias +1.6 pp, median abs 3.9 pp, p90 6.3 pp, r = 0.90 | 5 / 5 / 12 pp |
| Earth visibility vs NASA PGDA map, 60 pixels | mean abs difference 0.7-1.1 pp | 10 pp |
| Moon Trek vs PGDA terrain, 10 km around 2 sites | horizon p95 0.15 / 0.30° beyond 1 km; sunlight within 0.1-0.8 pp | consistent |

**Why exact site coordinates matter:** moving the Shackleton-de Gerlache connecting ridge point C1 by only 100 m can
drop average sunlight from 85 % to 20 %, while the same move on the flat de Gerlache Rim 2 region centre changes it by
less than 1 pp ([`docs/VALIDATION_TERRAIN.md`](docs/VALIDATION_TERRAIN.md) §4.2).

**Checked by hand with NASA web tools:** an 8-case sheet compares backend numbers with JPL Horizons, LROC QuickMap and
NASA Moon Trek, and anyone can repeat it in a browser ([`docs/NASA_TOOLS_CROSSCHECK.md`](docs/NASA_TOOLS_CROSSCHECK.md)).

Known limitations are listed in [`docs/VALIDATION_TERRAIN.md`](docs/VALIDATION_TERRAIN.md) §6. The main ones: sites
outside the polar DEMs (Apollo, far side) use a smooth-sphere horizon, and Artemis III entries are region centres,
not landing points.

## Repository layout

```
lunar-navigator/
  lunarnav/            Python package: ephem/ (Horizons, SPICE, analytic), terrain/ (Moon Trek, PGDA),
                       horizon.py, visibility.py, windows.py, analysis.py, precompute.py, validate*.py,
                       cli.py (`lunarnav precompute | analyse | alt-dates | check | validate`), catalog/sites.json
  tests/               pytest suite (markers `network`, `slow`)
  notebooks/           lunar_navigator_colab.ipynb: the heavy runs on Google Colab (+ README)
  scripts/             make_colab_bundle.py (code-only zip for Colab)
  backend/             Node.js API (Fastify + MongoDB): src/, tests/, contract/openapi.json, deploy/
  docs/                English documentation (index below); docs/vi/ = Vietnamese team notes
  data/, output/       created at run time, git-ignored (downloaded kernels/DEM tiles, precompute results)
```

---

## Run it locally

Linux/macOS commands are shown first, Windows PowerShell below them. You need **Python ≥ 3.10**, **Node.js ≥ 24**,
**MongoDB 8** and an internet connection for the first run. Every step was run on a fresh clone on Windows 11 with
Python 3.13, Node.js 24.16 and MongoDB 8, in PowerShell; the bash forms of the API steps were also run in Git Bash
(where the venv is activated with `source .venv/Scripts/activate`). The timings below come from that machine.

### 1. Python package

Linux / macOS:

```bash
cd lunar-navigator
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"            # extras: dev = pytest, notebook = matplotlib/nbclient for the Colab notebook

pytest -q -m "not network and not slow"     # offline tests, about 2.5 min
```

Windows PowerShell:

```powershell
cd lunar-navigator
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"

pytest -q -m "not network and not slow"
```

Result on the test machine: `391 passed, 2 skipped, 53 deselected in 154.88s`. The install itself took about 3 minutes.
`pytest -q -m "not slow"` also runs the network tests, which query JPL Horizons, NAIF and PGDA. On a fresh clone that
took 8 minutes (`441 passed, 5 deselected`), most of it for the first downloads, which are cached in `data/`.

A small precompute (2 sites, 3 days, hourly). It works the same in both shells:

```bash
lunarnav precompute --sites ref_connecting_ridge_c1,apollo11 --start 2026-01-07 --end 2026-01-10 --step-min 60 --provider spice --dem pgda --horizon-method raymarch --radius-km 60 --dem-fallback flat --out output/demo
lunarnav check output/demo
lunarnav analyse --sites ref_connecting_ridge_c1,apollo11 --start 2026-01-07 --end 2026-01-10 --step-min 60 --provider spice --dem pgda --horizon-method raymarch --radius-km 60 --dem-fallback flat --json output/demo_ranking.json
```

* On a fresh clone the first precompute takes about 2.5 minutes. It downloads the NAIF SPICE kernels
  (**44 MB**, to `data/kernels/`) and the PGDA DEM blocks around the polar site (**22 MB**, to `data/cache/pgda/`).
  Later runs reuse them, so `analyse` took 6 s.
* `--dem-fallback flat` is needed for sites outside the polar DEM (here Apollo 11), which get a smooth-sphere horizon.
* `lunarnav check` must print `output/demo: 0 violation(s)`. It re-checks every format and physics rule of
  [`docs/OUTPUT_SPEC.md`](docs/OUTPUT_SPEC.md).
* `analyse` prints the ranking (Apollo 11 score 81.53 and ridge C1 77.50 for these 3 days: C1 has 100 % sun but
  loses the Earth for 27 h).
* Data and output locations can be moved with the environment variables `LUNARNAV_DATA` and `LUNARNAV_OUTPUT`.
* The full 2026-2030 runs for all 23 sites (A and B, with a 4.6 GB Moon Trek download) are meant for Google Colab:
  [`notebooks/README.md`](notebooks/README.md).

### 2. API (Node.js + MongoDB)

The API needs a MongoDB 8 server on `127.0.0.1:27017`. Any local install works, or Docker:

```bash
docker run -d --name lunarnav-mongo -p 27017:27017 mongo:8
```

Linux / macOS:

```bash
cd backend
npm ci
cp .env.example .env                 # development defaults: no API keys, port 8000, database lunarnav_local
npm run import -- tests/fixtures/sample_2026Q1_spice_pgda --default
npm run dev                          # http://127.0.0.1:8000
```

Windows PowerShell:

```powershell
cd backend
npm ci
Copy-Item .env.example .env
npm run import -- tests/fixtures/sample_2026Q1_spice_pgda --default
npm run dev
```

* Do step 1 first: the importer runs `lunarnav check` with the Python of `../.venv`.
* `tests/fixtures/sample_2026Q1_spice_pgda` is a small real run that ships with the repository: 6 sites,
  2026-01-01 to 2026-04-01, hourly, SPICE + PGDA. The import takes about 3 s. `output/` is git-ignored, so a fresh
  clone has no other data.
* Variables already set in the environment win over `.env`. This section was verified on a free port with a scratch
  database (`PORT=3199 MONGODB_DB=lunarnav_readme_check npm run dev`; in PowerShell, set `$env:PORT="3199"` and
  `$env:MONGODB_DB="lunarnav_readme_check"` first).

Try it (use `curl.exe` in Windows PowerShell):

```bash
curl -s http://127.0.0.1:8000/api/v1/health
curl -s http://127.0.0.1:8000/api/v1/runs
curl -s "http://127.0.0.1:8000/api/v1/dataset?site_ids=ref_connecting_ridge_c1&start=2026-01-07T00:00:00Z&end=2026-01-14T00:00:00Z"
curl -s http://127.0.0.1:8000/api/v1/ranking
# Swagger UI: open http://127.0.0.1:8000/docs in a browser
```

`health` reports `"status":"ok"`, with `mongo.ok` and `python.ok` both true and the imported `default_run_id`.

**Import your own precompute** (from `lunarnav precompute` or a Colab export zip, unzipped):

```bash
npm run import -- ../output/demo --label "Local demo run"           # add --default to make it the default run
npm run import -- /path/to/<run>_B_... --default --label "Run B"    # one run folder of a Colab export
```

**Run with an API key locally** (the same authentication as production):

```bash
KEY=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
API_KEYS="dev:$KEY" npm run dev
curl -s -H "X-API-Key: $KEY" http://127.0.0.1:8000/api/v1/runs     # without the header: 401 UNAUTHORIZED
```

```powershell
$KEY = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
$env:API_KEYS = "dev:$KEY"; npm run dev
curl.exe -s -H "X-API-Key: $KEY" http://127.0.0.1:8000/api/v1/runs
```

Scripts, environment variables, tests and deployment: [`backend/README.md`](backend/README.md).

---

## Documentation

| File | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Module map, data flow, main algorithms |
| [`docs/OUTPUT_SPEC.md`](docs/OUTPUT_SPEC.md) | Run folder format: every file, column, unit, convention and invariant |
| [`docs/VALIDATION.md`](docs/VALIDATION.md) | Ephemeris validation: Horizons vs SPICE vs analytic, negative controls, Apollo 11 |
| [`docs/VALIDATION_TERRAIN.md`](docs/VALIDATION_TERRAIN.md) | Terrain validation: horizon algorithms, NASA illumination maps, Moon Trek vs PGDA, sensitivity |
| [`docs/NASA_TOOLS_CROSSCHECK.md`](docs/NASA_TOOLS_CROSSCHECK.md) | 8-case sheet to check results by hand in JPL Horizons, LROC QuickMap and Moon Trek |
| [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md) | Findings about Moon Trek, QuickMap and PGDA (formats, units, nodata) |
| [`docs/HORIZONS_NOTES.md`](docs/HORIZONS_NOTES.md) | Behaviour of the JPL Horizons API (frames, radius, limits) |
| [`docs/SITES.md`](docs/SITES.md) | The 23 catalog sites and the sources of their coordinates |
| [`docs/PYTHON_INTEGRATION.md`](docs/PYTHON_INTEGRATION.md) | Python tools exposed through the API (job types, tools, artifacts) |
| [`docs/AI_DISCLOSURE.md`](docs/AI_DISCLOSURE.md) | How AI was used |
| [`backend/README.md`](backend/README.md) | API: setup, scripts, configuration, authentication, tests |
| [`notebooks/README.md`](notebooks/README.md) | Google Colab notebook for the full runs |
| [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) | Open-source libraries, data sources, credits |
| [`LICENSE`](LICENSE) | MIT License |
| [`docs/vi/`](docs/vi/) | Vietnamese-language working notes of the team (frontend handoff, deployment runbook) |

## Use of AI

This part of the project was built with the help of an AI coding assistant, Anthropic's Claude (through Claude Code).
Under the direction of the team member responsible for backend and data, it wrote and reviewed most of the Python
package, the Node.js API, the tests, the deployment scripts and the documentation. The team member chose the
challenge, the NASA data sources and the methods, set the requirements, ran the computations and checked the
results. No number was produced or estimated by an AI model: every result comes from the deterministic `lunarnav`
code run on NASA data, and each run folder records code version, data sources and checksums in `manifest.json`.
There are no AI-generated images, audio or video. Details: [`docs/AI_DISCLOSURE.md`](docs/AI_DISCLOSURE.md).
The same disclosure is recorded in the package metadata (`[tool.lunarnav.ai_disclosure]` in `pyproject.toml`,
`aiDisclosure` in `backend/package.json`).

## License

MIT License, Copyright (c) 2026 Nguyen Trong Chung and the Moon Plan B team ([`LICENSE`](LICENSE)). NASA data and
third-party libraries keep their own terms ([`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)). The project uses
no NASA logos or branding; NASA, JPL, GSFC, ASU and the other data providers have not reviewed or endorsed it.

## Team and credits

* **Team:** Moon Plan B, NASA Space Apps Challenge 2026.
* **Backend and data (`lunarnav`, `backend/`):** Nguyen Trong Chung, Institute of Aerospace Technology, VNU University
  of Engineering and Technology, Hanoi.
* **Frontend:** the team web app in `frontend/` of the team repository has its own credits.
* **Data:** NASA/JPL (Horizons, NAIF SPICE), NASA GSFC Planetary Geodesy Data Archive (LOLA DEMs and illumination
  maps), NASA Moon Trek, LROC QuickMap (Arizona State University). Full list in
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
