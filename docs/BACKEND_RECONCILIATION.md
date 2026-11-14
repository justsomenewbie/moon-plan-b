# Evolving backend plan and frontend handoff

Status on 14 November 2026: the team has selected the backend contract and a single aggregate GET for frontend integration. The live aggregate is available, with a scoped [producer contract](../contracts/openapi.dataset.json) for the frontend. The user supplied Chung's `WEB_BACKEND_PLAN.md` and confirmed that it may grow as more resources are discovered. It is a snapshot, not a feature ceiling or evidence of a deployed service. Its first paragraph says implementation has not started; its response numbers are illustrative. Source SHA-256: `d9062845466b1d093640026cf5b547965197a958e55f5dd0c34a3b9501e615c9`. The original internal document is not redistributed here.

Chung owns the production OpenAPI. The FE requests one aggregate per UTC range and can import the producer JSON export. A separate team member owns Colab execution and testing.

## Aggregate update on 14 November

At 14:05 Hanoi the team service documented 25 paths. SHA-256 of the retrieved OpenAPI document was `f77527a4f7d0df597dc12f9054ba0b08bb2e9ae6173a8310c490d675de698754`. A parameterless GET exceeded the default run’s 50,000-point limit and returned the documented HTTP 422. A bounded request returned HTTP 200. The frontend requests the following bounded comparison through its same-origin proxy. Changing the requested spacing affects the displayed series. Full visibility intervals still come from the source grid.

```text
GET /api/v1/dataset?site_ids=im1_odysseus,im2_athena&start=2026-11-14T00:00:00Z&end=2026-11-21T00:00:00Z&step_s=3600&horizon_step_deg=0.5&max_points=10000&include=horizon,series,windows,metrics
```

At 14:46 Hanoi the bare link again returned HTTP 422. Its detail reported 230,000 requested series points for 23 sites against a 50,000-point limit and suggested at most 2,173 per site. The error title was `Range outside run`, although the reported cause was the point limit. The bounded example above returned 200, with 168 UTC samples and 721 horizon points per site.

For a source cross-check, the data request pinned `run_id=B_spice_pgda_bruteforce_2026_2030`, requested `step_s=3600` and included all components. For November 14–21 and 21–28 UTC, 672 site-hours of flags and all returned intervals matched separate per-site series and windows. The full aggregate byte hashes were `9d0c272c78f24065157a551a6ce60305fbf5bbd2bc0d166e4e96f1a4fdae02a8` and `7b01480d90c9a314b6287cf90274badfc77b5f0e24cb410016055918c9f3db53`. The retrieved run manifest matched `35601268e464e2e610e3cf33cf7e7b8588e59e23877857708799f29a8ac615a4`. All five individual source checksums were null. This checks server consistency and the FE summary. Physical ephemeris validation belongs to the science team.

## Per-site checks before the aggregate was available

The team service returned HTTP 200 for Swagger and its JSON spec. `/docs/json` and `/api/v1/openapi.json` returned the same OpenAPI 3.1.0 document (`Lunar Landing Site Navigator API` version `1.0.0`, SHA-256 `f457e46fab414266f9647444350ead9cbd8e46d675217e889b903c18e914010d`). It documents 21 paths, including runs, sites, sky tracks, series, visibility windows and ranking. At 13:01 Hanoi (06:01 UTC), the selected aggregate route was absent. Both a direct GET and the frontend’s proxied GET returned the producer’s 404 `NOT_FOUND` with detail `no route GET /api/v1/dataset`. Keep the configured origin local to each environment.

For a bounded read-only check, the default run reported SPICE, PGDA terrain, brute-force horizons, a 2 m observer and hourly samples. For the Odysseus and Athena candidate sites we retrieved site details, hourly Sun/Earth/joint flags and all three interval lists over the week from 2026-11-14 00:00Z inclusive to 2026-11-21 00:00Z exclusive. Each list covered the requested half-open range. At all 168 samples per site the joint flag equalled the conjunction of the two body flags. Re-expanding every returned interval reproduced the corresponding hourly flags. The model returned one positive joint interval for Odysseus, starting November 19 at 15:00Z (33 hours in range), and one for Athena, starting November 15 at 05:00Z (139 hours in range). Both ended at the query boundary with `clipped_end=true`; the next seven days were checked separately below. The local evidence retains the raw responses, run ID, coordinate sources and SHA-256 for each response. This verifies the meaning and consistency of the responses consumed by FE. Independent ephemeris and terrain validation belongs to the science team.

Unlike the draft, the service uses snake_case, east longitude in [0, 360), terrain-aware upper-limb sunlight and Earth clearance. Preserve the producer’s `precision_h`, UTC bounds and clipped versus run-truncated flags in the eventual aggregate. The existing ideal-horizon importer cannot represent these semantics. The next integration input is the versioned aggregate response and its example.

## Reproduce the Odysseus and Athena weeks

Use the team API with run `B_spice_pgda_bruteforce_2026_2030`. The candidate site IDs are `im1_odysseus` and `im2_athena`. The two equal windows begin at `2026-11-14T00:00:00Z` and `2026-11-21T00:00:00Z`. Each ends seven days later, at `2026-11-21T00:00:00Z` and `2026-11-28T00:00:00Z` respectively. Start is inclusive and end is exclusive. Each site returned 168 hourly samples per window. The windows endpoint reports boundary precision of ±1 hour. The table lists every positive joint interval within each queried week.

| Week starts (UTC) | Candidate site | Sun visible | Earth visible | Both visible (also the longest overlap in the week) | Joint interval, UTC |
| --- | --- | ---: | ---: | ---: | --- |
| Nov 14 | Odysseus · IM-1 | 33 h | 168 h | 33 h | Nov 19 15:00 to Nov 21 00:00 |
| Nov 14 | Athena · IM-2 | 139 h | 168 h | 139 h | Nov 15 05:00 to Nov 21 00:00 |
| Nov 21 | Odysseus · IM-1 | 168 h | 168 h | 168 h | Nov 21 00:00 to Nov 28 00:00 |
| Nov 21 | Athena · IM-2 | 168 h | 168 h | 168 h | Nov 21 00:00 to Nov 28 00:00 |

For each site, make these GET requests relative to the team service. Substitute the IDs and UTC values above for the placeholders.

```text
/api/v1/sites/{site_id}?run_id={run}
/api/v1/sites/{site_id}/series?run_id={run}&start={start}&end={end}&fields=sun_visible,earth_visible,both_visible&max_points=200&agg=sample
/api/v1/sites/{site_id}/windows?run_id={run}&start={start}&end={end}&kinds=sun,earth,both
```

Compare the two input flags with the joint flag at every hour. Check that each returned Sun, Earth and joint interval list tiles the full range, then expand each interval back to the hourly grid. The first week’s positive joint intervals have only `clipped_end=true`. Both second-week intervals have `clipped_start=true` and `clipped_end=true`. All four have `truncated_start=false` and `truncated_end=false`. The comparison reports durations within each query. The two sets of source responses were read at 05:52 and 06:25 UTC on November 14. The SHA-256 values below identify the original response bodies.

The site detail hashes apply to both weeks. The first set of series and window hashes covers November 14–21.

| Site | Response | SHA-256 |
| --- | --- | --- |
| im1_odysseus | detail | `073691186cb0b73e7f423dc4a05e3c2719ed4eda4d3e6d3ac3328d753240348d` |
| im1_odysseus | series | `8d55b5a2521f3c97f9957df9d75adda260ac2523201668583e6b997144152135` |
| im1_odysseus | windows | `427cc1877efee079d5e07c18d4796002048d0a1679b24cfec3a8f90a834c9c29` |
| im2_athena | detail | `ce0908ad5f4828599151b89b047b00594c2d903b31769659ef54e2bfeb86a753` |
| im2_athena | series | `d014688972332d022f9870c0eb7fe5ae837a1167c0e1d5317bbcc75d7fe0e264` |
| im2_athena | windows | `9daa9553fa01ade944506bf67fd115f5799f62931d89095f9d535bd445367f28` |

The second set covers November 21–28.

| Site | Response | SHA-256 |
| --- | --- | --- |
| im1_odysseus | series | `a09a37e815dd12ff3e931ec777a2ff107c21d15a65b933c8fb7c5e2387224a88` |
| im1_odysseus | windows | `7f1f105648fd56ca877302d35de2548b7a12c3d91346eb32ffc7f40c904a9181` |
| im2_athena | series | `deeac24a0ffa13be1001b1a4015589b7e570ceb271c60321cd933245857275c3` |
| im2_athena | windows | `440adde809d30ba01e5e900470da79452bdf6b93dcd105bfb14d7d8cee44526c` |

## Colab precompute and the first science comparison

The team supplied a precompute notebook on 14 November. Its full-run settings select 23 catalog sites, hourly UTC samples from 2026-01-01 inclusive to 2031-01-01 exclusive, and an observer 2 m above ground. A uses JPL Horizons, a Moon Trek elevation model and ray marching. B uses NAIF SPICE, a PGDA elevation model and a brute-force horizon calculation. These are configured methods and dates. The shared copy saved the settings and a failed Google Drive mount. Its precompute, validation and archive cells contain no saved results.

For a first comparison, obtain the run archive or a two-site slice with `RUN_INFO.json`, the manifests, the two site records, horizon masks, timestamped ephemeris and visibility tables, and the relevant rows of `checks.csv`. Preserve the raw source references and the code version. Validate the same UTC start and end for both sites, align the body observations, and independently compare every simultaneous interval, its total duration and the longest interval. Retain gaps, clipped bounds and the uncertainty of crossings between hourly samples. A sunlight percentage alone cannot establish joint visibility.

The notebook uses a terrain horizon, solar semidiameter and Earth clearance. The legacy draft importer expects a flat horizon and body centers. A producer release under the existing model can use the importer directly. Terrain exports now use the producer’s separate model and summary view. For discrepant rim sites, compare identical coordinates, observer height, window and visibility definition, then compare the horizon masks in the directions actually crossed by the Sun. For example, Table 1 in Gläser et al. lists 81.0% and 86.7% maximum average illumination at two different surface locations on Shackleton rim. Its separate solar visibility column measures the time any part of the Sun is visible. Compare like quantities and heights before choosing a pipeline. [Gläser et al., Table 1 and method](https://ntrs.nasa.gov/api/citations/20170007365/downloads/20170007365.pdf)

## Decisions to reconcile with Chung

| Area | Backend plan | Current frontend / proposed next step |
| --- | --- | --- |
| Public fields | `snake_case`, matching OUTPUT_SPEC | Earlier mandatory rules say `camelCase`. Use the published backend schema to settle the wire format and regenerate types. Do not mechanically rename without checking semantics. |
| Repository | Assumes a separate frontend repository | User selected one shared product repository. Bring intended backend/data source into that repository with explicit ownership; preserve both existing checkouts. |
| Scientific model | Terrain horizon, Sun fractions, power/irradiance, longitude [0,360), observer height in metres | Existing draft is flat-horizon body-centre only, with longitude [-180,180] and elevation in km. Version the model and document frames/units. Observer height and site elevation are different quantities. |
| Results | Separate runs/sites/horizon/series/windows/compare; implicit sample times, snapped bounds and downsampling | Existing `/dataset` envelope has explicit times and boundary/coverage checks. Use the agreed aggregate GET and map the versioned response in the client; retain actual bounds, gaps, clipping, cadence and provenance. |
| Jobs | Cached 200, `succeeded`/`cancelled`, potentially unknown percentage, result references run/site | Current draft expects 202, `done`, a percentage and an embedded dataset. Revise types, validation, polling and result loading together. Unknown progress stays indeterminate; cancellation is not success. |

Frontend answers already available: Next.js 16.4.6, TypeScript 5.9.3, TanStack Query 5.107.1, openapi-fetch 0.17.0, generated OpenAPI types and MSW. Same-origin `/api/*` proxy is prepared. Hosting is still undecided.

The aggregate schema and two bounded responses have been checked. The production client also uses the producer’s custom-site job contract.

## Live custom-coordinate jobs

Opening the form fetches `GET /api/v1/capabilities` and checks the custom-site job type, SPICE, PGDA, ray marching and hourly sampling. The form uses the selected UTC range, planetocentric latitude, east-positive longitude and observer height above the surface in metres. `POST /api/v1/jobs` returns a job receipt. The client accepts 202 for queued or running work and 200 for an already completed matching job. It polls the same job ID every 1.5 seconds. A null percentage is shown as indeterminate. Failed and cancelled jobs have separate terminal states. A successful job identifies the resulting site and run. Opening the result performs a bounded aggregate GET for that one site, and its permalink retains the site ID, run ID and UTC range. Once the backend expires the run, the link may become unavailable.

## AI planning assistant — proposed addition

The frontend now answers the structured version using **Compare sites**. A visitor selects a published UTC interval and threshold. The view lists producer-supplied results, reasons and available source references for that release. Free-text questions and model-generated explanations still depend on the backend contract below.

Desired interaction: “For this UTC interval, which published sites fit my chosen criteria?” The backend plan has no LLM provider/model or assistant endpoint. Its `provider: spice` means ephemeris computation; an optional jobs API key is not an AI-provider integration.

Propose a backend-owned assistant after the owner agrees its contract. The model should explain backend-produced comparisons, identify the release, actual UTC interval, chosen criteria and supporting scenario/source IDs, and preserve ties, missing coverage and uncertainty. “Best” needs a declared objective; no landing-safety conclusion follows from a visibility score. Dates beyond available data must return an explicit inability to answer. Natural-language local dates need an explicit timezone and confirmation of the interpreted UTC range.

Keep provider credentials server-side, outside public environment variables, URLs, browser storage and bundles. Use the existing API client and a mutation without automatic POST retries. The backend needs input/output limits, rate/cost limits and safe text rendering. Do not add a local Next `/api` handler without revisiting the existing live proxy, which forwards that path to the backend. Attribute model output to the model, preserve source links, and do not imply NASA review or endorsement.

This is a proposal, not a new endpoint promise or a simulated chatbot presented as AI. Provider/model, payload, grounding, runtime and key configuration remain undecided. No key is needed in chat.

## Open feature path

Time-based appearance and credited lunar imagery can ship independently now. Terrain views, 3D, alternate-date search, richer criteria and AI explanations remain candidates as backend resources arrive. Add them in useful, reviewable slices without removing the working comparison or confusing reference imagery with scientific results.

Next action: review the aggregate response definition and one small aggregate example when available; reconcile only the fields needed for the first real comparison.
