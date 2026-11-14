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

The site comparison reports both the total joint visibility and the longest uninterrupted joint window within the selected UTC range. At the de Gerlache crater rim in November 2026, two intervals contribute 73 and 344 hours. Their total is 417 hours and the longest is 344 hours. A site-first search considers each whole-hour start for which the entire requested mission fits. Starts tied for greatest visibility share the same standing, with earlier times shown first. These are model samples with one-hour resolution. Surface hazard, solar power and radio performance require their own evidence.

## Five-year planner comparison

On November 15 the public planner compared all 23 B2 sites from January 1, 2026 at 00:00 UTC up to January 1, 2031 at 00:00 UTC (exclusive). The dataset and ranking requests both returned HTTP 200. Total joint visibility and the longest continuous window at every site agreed with the archived intervals. Apollo 15 LM Falcon had the highest total at 21,988 of 43,824 hours. The de Gerlache rim had the longest continuous window at 406 hours. The B2 model uses a smooth horizon at Apollo 15. These totals describe Sun and Earth visibility in the model. [Open the five-year comparison](https://moon-plan-b.vercel.app/plan?run_id=B2_spice_pgda_bruteforce_2026_2030_fix676af9d&mode=sites&priority=joint&from=2026-01-01&to=2031-01-01).

## Verify the published files

To reproduce without credentials, make the following GET requests under [the public frontend](https://moon-plan-b.vercel.app), which relays them to the team API. Save the responses in one local directory. Save `GET /api/v1/runs/{run_id}` as `run.json`, `GET /api/v1/sites?run_id={run_id}&format=json` as `catalog.json` and the run's original manifest as `manifest.json`. For every site ID in that manifest, fetch its listed `sites/{site_id}/windows.json` from the run-file endpoint using the URL-encoded file path. Save each response as `windows-{site_id}.json`. Each window supplies its original site record. The builder puts these records in manifest order and verifies the resulting sites.json against its producer SHA-256. The following check reads local files and compares the generated archive byte for byte.

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

At 03:51 Hanoi on November 15, 2026, a fresh download of 27 responses (2,084,296 bytes) supplied the run record, catalog, manifest, original site records and 23 original window files. Rebuilding covered 1,007,952 site-hours. The four outputs matched both Git and all four public downloads byte for byte (102,321 bytes altogether). The original `sites.json` also matched the site records reconstructed from the windows. The B2 manifest lists 94 raw paths. The 23 window file checksums and the four output digests above cover this replay. [Verified repository snapshot](https://github.com/justsomenewbie/moon-plan-b/tree/996d0eb9884429933967f17241eb6944ecc83479/frontend/public/data/run-b2)

The source replay checks agreement with the team model. The [independent JPL sample comparison](../qa/docs/JPL_CHECK.md#november-b2-overlap-using-jpl-directions) covers two sites and one November week. The release checklist calls for another archive readback at the chosen freeze commit.
