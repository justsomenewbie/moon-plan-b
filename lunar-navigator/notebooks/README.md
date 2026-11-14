# Google Colab notebook: `lunar_navigator_colab.ipynb`

This notebook runs the whole heavy pipeline (heavy run) on Google Colab: get the code, mount Google Drive, download the
Moon Trek LOLA DEMs, run the tests, precompute with two independent methods, check the results, run the validation,
build a PASS/FAIL table, draw quick sanity plots and zip the results to Drive.

## 1. Preparing the code

Choose **one** of the two options:

* **Git:** set `REPO_URL` (and `REPO_BRANCH` if needed) in the `PARAMS` cell. The notebook runs `git clone` into
  `/content/lunar-navigator`.
* **Zip bundle** (when the repository is not online): on the development machine run

  ```bash
  ./.venv/Scripts/python scripts/make_colab_bundle.py
  # -> dist/lunarnav_colab_bundle.zip: code + tests + docs only, no data/, output/, .venv/
  ```

  then put the file on Drive at `MyDrive/lunarnav/lunarnav_colab_bundle.zip`, or in `/content/`, or leave it out and
  upload it when the notebook asks. The zip is deterministic (same code gives the same bytes) and contains
  `BUNDLE_INFO.json` with `code_sha256`. The script refuses any file > 5 MB, so DEMs and caches cannot slip in.

The notebook then runs `pip install -e ".[dev,notebook]"`. No runtime restart is needed: the notebook adds the
repository to `sys.path`, and every subprocess (CLI, pytest) receives `PYTHONPATH`.

## 2. Main parameters (PARAMS cell)

| Parameter | Default (full) | Meaning |
|---|---|---|
| `LIGHT_MODE` | `True` | `True` = smoke test of a few minutes; `False` = full run |
| `SITES` | `"all"` | the whole catalog: south pole + reference + Apollo + far side (23 sites); or `group:apollo`, a list of ids |
| `START_UTC`, `END_UTC`, `STEP_MIN` | 2026-01-01, 2031-01-01 (exclusive), 60 | 5 years hourly = 43 824 samples / site |
| `PRIMARY` | Horizons + `trek` + `raymarch` | method A (Resources tab) |
| `CROSSCHECK` | SPICE + `pgda` + `bruteforce` | method B: different DEM, different horizon algorithm |
| `DEM_FALLBACK` | `flat` | sites outside the polar DEMs get a smooth-sphere horizon (recorded in `dem_source`) |
| `TREK_LABELS` | 3 Trek files (5 m, 30 m, 100 m) | ~4.6 GB in total |
| `DEM_LOCAL_COPY` | `True` | copy the DEMs from Drive to the local `/content` disk for fast reads |
| `RUN_TESTS`, `TEST_MARKERS` | `True`, `"not slow"` | pytest |
| `RUN_VALIDATION`, `RUN_TERRAIN_VALIDATION` | `True`, `True` | `validate.run_all` + `validate_terrain.run` |
| `RESUME` | `True` | `--resume` for precompute |
| `FAIL_ON_ERROR` | `True` | the last cell raises if a required check FAILs |

`LIGHT_MODE = True` overrides: 2 sites (`ref_connecting_ridge_c1`, `apollo11`), 3 days (2026-01-07..10, with one
earthset at C1), PGDA for both A and B, 60 km radius, no Trek download, tests `-m "not slow and not network"`, and a
light terrain validation (Trek header + Trek ImageServer vs PGDA at 1 site) instead of `validate_terrain.run`.

## 3. Layout on Google Drive

```
MyDrive/lunarnav/
  lunarnav_colab_bundle.zip   (when using the bundle)
  data/                        LUNARNAV_DATA (persistent): cache/ (Horizons, PGDA, Trek header...), kernels/ (SPICE), dem/ (Trek DEM)
  output/                      LUNARNAV_OUTPUT: <run>_A_..., <run>_B_..., <run>_validation/ (reports, checks.csv, PNG)
  exports/<run>.zip            zip of the 3 folders above + RUN_INFO.json
```

With `DEM_LOCAL_COPY=True`, `LUNARNAV_DATA=/content/lunarnav_data`: `cache/` and `kernels/` are symlinks to Drive,
while `dem/` is a local copy (random reads through Drive FUSE are slow). A downloaded DEM is also saved to Drive, so a
later session only has to copy it back (~1-2 minutes) instead of downloading it again.

Space needed: ~4.6 GB of DEMs on Drive (and on the local Colab disk); results are about 4-5 MB per site for 5 years
hourly (A + B ≈ 0.2 GB for 23 sites).

## 4. Check results (PASS/FAIL)

Each check is one row of the table, saved in `<run>_validation/checks.csv`:

* `PASS` / `FAIL`: required checks (test suite, precompute exit code, `check_output` 0 violations, A vs B ephemeris,
  validation A/B/C, negative controls, Apollo 11, lunar day, raymarch vs bruteforce, comparison with NASA maps...).
* `KNOWN`: a known, explained difference, not a code error. Currently: illumination of a 0 m observer compared with the
  NASA map (see `docs/VALIDATION_TERRAIN.md` §2.3).
* `REVIEW`: soft criteria that need a human look (% sun A vs B at sites with terrain > 5 pp; Trek vs PGDA beyond 2 m /
  0.5° / 3 pp).
* `INFO`, `SKIP`: information, skipped.

## 5. Expected run time

* LIGHT_MODE: ~2 minutes on the development machine with a warm cache (smoke run on 2026-11-13: ~2 minutes, 33 PASS,
  0 FAIL); on Colab with a cold cache add a few minutes (SPICE kernels ~45 MB, PGDA blocks, Trek headers ~16 MB).
* Full: 4.6 GB DEM download (depends on Moon Trek bandwidth, cannot be resumed), tests ~2-5 minutes, terrain
  validation ~25 minutes (cold cache), precompute A and B several hours (not yet measured on Colab). Colab sessions
  have a time limit: run *Run all* again after a disconnect; `--resume` skips the sites that are already done.

## 6. Local smoke test (not Colab)

Outside Colab the notebook skips the Drive mount / clone / pip cells by itself (detected with
`"google.colab" in sys.modules`), uses the repository that contains the notebook (or the `LUNARNAV_REPO` environment
variable) and `LUNARNAV_DATA` / `LUNARNAV_OUTPUT` if set (default: the repository's `data/` and `output/`). Run it
with nbclient from the repository root:

```bash
cd lunar-navigator
./.venv/Scripts/python -m pip install -e ".[dev,notebook]"
./.venv/Scripts/python - <<'EOF'
import asyncio, sys, nbformat
from nbclient import NotebookClient
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
nb = nbformat.read("notebooks/lunar_navigator_colab.ipynb", as_version=4)
NotebookClient(nb, timeout=1800, kernel_name="python3", resources={"metadata": {"path": "notebooks"}}).execute()
nbformat.write(nb, "output/lunar_navigator_colab.executed.ipynb")
print("OK")
EOF
```

(`./.venv/Scripts/python` is the Windows virtual-environment layout; on Linux/macOS use `./.venv/bin/python`.)

Keep `LIGHT_MODE = True` when running locally. In full mode `download_product` refuses to download Trek files larger
than 100 MB outside Colab, and the download step records `FAIL`.
