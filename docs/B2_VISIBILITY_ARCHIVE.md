# Offline B2 visibility

The team API identifies the run as `B2_spice_pgda_bruteforce_2026_2030_fix676af9d`. Its native grid covers 23 sites at one-hour intervals from 2026-01-01T00:00:00Z through the exclusive end 2031-01-01T00:00:00Z. Each hour describes modelled visibility at the surface observer. The producer's definitions and data sources are included verbatim in the manifest. The earlier saved B comparisons use a different run and manifest.

The app carries four downloadable files under `/data/run-b2/`.

| File | Contents | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `manifest.json` | Original producer manifest with individual raw-file hashes | 13,800 | `96ed56f42e6a49ce53e5c92aba6649d7e916cf4b37ae2e2eff7869c35bd1d0e7` |
| `catalog.json` | Original producer site catalog, pinned to B2 | 10,849 | `a5e2bc19c57dbc414ded2ff6a6f80032ec5568b75ddd0f7eb837d5ce42bf9980` |
| [`sites.json`](../frontend/public/data/run-b2/sites.json) | Original coordinate notes and sources for all 23 sites | 25,691 | `d9abf8bd751813f7f83ed06682267aaeee3fd6ba18fddec328b821aab58acb6b` |
| `visibility.json` | Compact positive intervals from each site's verified original `windows.json` | 51,981 | `f734253b2364cdf704c3f10fbd1e5bc5b7dd377199036dc73ed8f06d4ae901f2` |

In `visibility.json`, each site's `sun`, `earth` and `both` arrays contain consecutive pairs of integer hour indices. A pair `[a,b]` covers hours `a` through `b-1`, counted from the UTC start. The builder verifies explicit positive and negative states spanning every source hour before compacting. An empty array represents zero visible hours in this verified run. The compact format serves the offline planner. The comparison workspace's file importer accepts the separate producer aggregate format `lunarnav-dataset-1`.

The site comparison sums visible hours in the selected range. A site-first search considers each whole-hour start for which the entire requested mission fits. Starts tied for greatest visibility share the same standing, with earlier times shown first. These are model samples with one-hour resolution. Surface hazard, solar power and radio performance require their own evidence.

## Verify the published files

To reproduce, save the B2 responses into one local directory from the [production team API](https://api.lunavigator.com). Save `GET /api/v1/runs/{run_id}` as `run.json`, `GET /api/v1/sites?run_id={run_id}&format=json` as `catalog.json` and the run's original manifest as `manifest.json`. For every site ID in that manifest, fetch its listed `sites/{site_id}/windows.json` from the run-file endpoint using the URL-encoded file path. Save each response as `windows-{site_id}.json`. Each window supplies its original site record. The builder puts these records in manifest order and verifies the resulting sites.json against its producer SHA-256. The following check reads local files and compares the generated archive byte for byte.

```sh
python3 -B qa/build_archive_b2.py --verify /path/to/b2-responses
```

The archived source files contained 2,018,290 original bytes in total for the 23 sites. All masks tiled their source time range, reproduced the catalog percentages and satisfied the simultaneous Sun/Earth overlap check. Additional production aggregate and ranking calls were compared at every site for 2026-11-14 to 2026-11-15, 2026-12-01 to 2026-12-04 and 2028-04-17 to 2028-04-23. OpenAI Codex assisted archive compilation, frontend queries and tests. The producer supplied the visibility observations.

After the local rebuild passes, compare the hosted downloads with the verified files from the repository root.

```sh
python3 - <<'PYTHON'
from pathlib import Path
from urllib.request import urlopen

for name in ("manifest.json", "catalog.json", "sites.json", "visibility.json"):
    with urlopen(f"https://moon-plan-b.vercel.app/data/run-b2/{name}", timeout=30) as response:
        if response.read() != (Path("frontend/public/data/run-b2") / name).read_bytes():
            raise SystemExit(f"Published bytes differ for {name}")
    print(f"Matched {name}")
PYTHON
```

On November 15, 2026, the native rebuild covered 1,007,952 site-hours. The manifest, catalog and visibility downloads matched the hosted files (76,630 bytes). Adding the original coordinate file brings the archive to 102,321 bytes. A direct download of the producer’s sites.json matched the rebuilt coordinate file byte for byte. The B2 manifest lists 94 source paths. The rebuild checks the 23 original window files, the assembled coordinate records, the run record, catalog and manifest. Git preserves the bytes of the published B and B2 JSON files across checkout line-ending settings.
