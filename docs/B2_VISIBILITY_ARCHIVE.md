# Offline B2 visibility

The team API identifies the run as `B2_spice_pgda_bruteforce_2026_2030_fix676af9d`. Its native grid covers 23 sites at one-hour intervals from 2026-01-01T00:00:00Z through the exclusive end 2031-01-01T00:00:00Z. Each hour describes modelled visibility at the surface observer. The producer's definitions and data sources are included verbatim in the manifest. The earlier saved B comparisons use a different run and manifest.

The app carries three downloadable files under `/data/run-b2/`.

| File | Contents | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `manifest.json` | Original producer manifest with individual raw-file hashes | 13,800 | `96ed56f42e6a49ce53e5c92aba6649d7e916cf4b37ae2e2eff7869c35bd1d0e7` |
| `catalog.json` | Original producer site catalog, pinned to B2 | 10,849 | `a5e2bc19c57dbc414ded2ff6a6f80032ec5568b75ddd0f7eb837d5ce42bf9980` |
| `visibility.json` | Compact positive intervals from each site's verified original `windows.json` | 51,981 | `f734253b2364cdf704c3f10fbd1e5bc5b7dd377199036dc73ed8f06d4ae901f2` |

In `visibility.json`, each site's `sun`, `earth` and `both` arrays contain consecutive pairs of integer hour indices. A pair `[a,b]` covers hours `a` through `b-1`, counted from the UTC start. The builder verifies explicit positive and negative states spanning every source hour before compacting. An empty array represents zero visible hours in this verified run. The compact format serves the offline planner. The comparison workspace's file importer accepts the separate producer aggregate format `lunarnav-dataset-1`.

The site comparison sums visible hours in the selected range. A site-first search considers each whole-hour start for which the entire requested mission fits. Starts tied for greatest visibility share the same standing, with earlier times shown first. These are model samples with one-hour resolution. Surface hazard, solar power and radio performance require their own evidence.

To reproduce, save the B2 responses into one local directory from the [production team API](https://api.lunavigator.com). Save `GET /api/v1/runs/{run_id}` as `run.json`, `GET /api/v1/sites?run_id={run_id}&format=json` as `catalog.json` and the run's original manifest as `manifest.json`. For every site ID in that manifest, fetch its listed `sites/{site_id}/windows.json` from the run-file endpoint using the URL-encoded file path. Save each response as `windows-{site_id}.json`. The following check reads local files and compares the generated archive byte for byte.

```sh
python3 -B qa/build_archive_b2.py --verify /path/to/b2-responses
```

The archived source files contained 2,018,290 original bytes in total for the 23 sites. All masks tiled their source time range, reproduced the catalog percentages and satisfied the simultaneous Sun/Earth overlap check. Additional production aggregate and ranking calls were compared at every site for 2026-11-14 to 2026-11-15, 2026-12-01 to 2026-12-04 and 2028-04-17 to 2028-04-23. OpenAI Codex assisted archive compilation, frontend queries and tests. The producer supplied the visibility observations.
