# Run it locally (detailed)

Short version: see the [README](../README.md#run-it-locally). This page has every verified step, timing and option.

Linux/macOS commands are shown first, Windows PowerShell below them. You need **Python ≥ 3.10**, **Node.js ≥ 24**,
**MongoDB 8** and an internet connection for the first run. Every step was run on a fresh clone on Windows 11 with
Python 3.13, Node.js 24.16 and MongoDB 8, in PowerShell; the bash forms of the API steps were also run in Git Bash
(where the venv is activated with `source .venv/Scripts/activate`). The timings below come from that machine.

## 1. Python package

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
  [`docs/OUTPUT_SPEC.md`](OUTPUT_SPEC.md).
* `analyse` prints the ranking (Apollo 11 score 81.53 and ridge C1 77.50 for these 3 days: C1 has 100 % sun but
  loses the Earth for 27 h).
* Data and output locations can be moved with the environment variables `LUNARNAV_DATA` and `LUNARNAV_OUTPUT`.
* The full 2026-2030 runs for all 23 sites (A and B, with a 4.6 GB Moon Trek download) are meant for Google Colab:
  [`notebooks/README.md`](../notebooks/README.md).

## 2. API (Node.js + MongoDB)

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

Scripts, environment variables, tests and deployment: [`backend/README.md`](../backend/README.md).
