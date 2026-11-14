# Saved planner coverage

The saved planner reads results from team run `B_spice_pgda_bruteforce_2026_2030` (hourly SPICE ephemerides, PGDA terrain horizon). UTC intervals include the start and exclude the end. [Run manifest](../frontend/public/data/run-b/manifest.json) · [Catalog](../frontend/public/data/run-b/catalog.json)

| Coverage | Available question |
| --- | --- |
| All 23 catalog sites, 2026-01-01 to 2031-01-01 as one complete range | Compare the percentage of all 43,824 model hours with Sun, Earth, or both visible. |
| All 23, 2026-11-14 to 2026-11-15 and 2026-12-01 to 2026-12-04, as two exact ranges | Compare those same three visibility measures over 24 or 72 model hours. |
| Odysseus and Athena, 2026-11-14 to 2026-11-28 | Compare any hour-aligned subrange, or compare every hour-aligned start for a fixed whole-hour mission that fits inside the requested range. |

Each catalog percentage uniquely identifies an integer sample count. The builder checks that the recovered count reproduces each published percentage within half a unit of its sixth decimal place. For the two short ranges it checks all 23 rows across two independently captured weighting configurations, plus the selected sites' separate comparison responses. The full-run catalog matches the documented default-weight summary, the manifest's 23 site IDs and the four retained individual site records. The public catalog reports percentages over the full run. It supplies no event timing within that span.

The two-site hourly archive retains visible intervals in all three categories. The builder checks every native-hour flag against the standalone series, standalone on/off windows and aggregate metrics, including each week's boundaries. Adjacent intervals are joined only at equal endpoints. A local landing-window search sorts all fitting starts by visibility hours and then earliest UTC, retaining ties. No constraints on terrain, power, landing-time sunlight, visibility thresholds or minimum candidate spacing are implied by this calculation.

[Compact observations and source response digests](../frontend/lib/saved-planner-data.json) · [Builder](../qa/build_saved_planner.py) · [Boundary checks](../frontend/tests/saved-planner.test.ts)

To reproduce from retained original API bytes, organize the captures using the filenames in the builder, then run `python3 qa/build_saved_planner.py /path/to/captures --check`. The program verifies the manifest fingerprint, source identity, denominators, site set, hours and the exact committed compact representation. SHA-256 digests in that representation refer to the exact HTTP response bytes. Output may be reproduced with the same values but different digests if a server release changes its serialization. The site records and source manifest are credited in the product data directory. This frontend-derived archive and verification code were assembled with assistance from OpenAI Codex.
