# Frontend API and import formats

The [producer OpenAPI extract](../contracts/openapi.dataset.json) defines the live aggregate, run-specific site catalog, capability discovery, custom-site job submission, job status and the landing-date search. It uses `lunarnav-dataset-1` with terrain-model metadata, site coverage and half-open UTC intervals. The [integration record](BACKEND_RECONCILIATION.md#aggregate-update-on-14-november) documents the request parameters and checked responses. Producer exports with windows and metrics open in the same viewer. A supplied `horizon` adds an azimuth/elevation profile and a supplied `series` adds a sample inspector. Each site has its own ordered UTC timestamps. A coarser request can retain extra samples at transitions. The inspector uses the timestamps actually returned, while the three visibility bands use the full supplied interval lists.

### Published route scope

On November 14 the backend owner confirmed two groups for frontend development. All paths below are relative to `/api/v1`. The live OpenAPI lists 30 HTTP operations on 29 paths. This table records the producer scope. The [tracked extract](../contracts/openapi.dataset.json) covers the operations the frontend calls.

| Area | Confirmed HTTP operations |
| --- | --- |
| Observations and site catalog | GET `/dataset`, `/sites`, `/sites/{site_id}`, and the site's `instant`, `windows`, `series`, `sky` and `horizon` resources |
| Runs, ranking and exports | GET `/ranking`, `/runs`, `/runs/{run_id}`, `/runs/{run_id}/files/{file_path}`, `/export/summary.csv`, `/sites/{site_id}/export/series.csv` and `/sites/{site_id}/export/windows.csv` |
| Service discovery | GET `/meta`, `/capabilities` and `/health` |
| Comparison and landing dates | POST `/compare` and `/alt-dates` |
| Custom sites | POST `/jobs` with `type=custom_site`. GET or DELETE `/jobs/{job_id}`. GET its `events`, `artifacts` and `artifacts/{name}` resources. |

The planner reads the default run from the producer. The upstream API requires a server-side API key. The public Swagger explorer calls the same-origin relay and needs no browser credentials. If the producer rejects the server credential, the relay returns HTTP 502 to the browser. Shared links pin the run that produced their results. Battery survival, panel/antenna pointing, ephemeris and horizon tools, and other job types remain provisional for frontend planning. Compare a local producer OpenAPI export with the tracked extract using `python3 -B -m qa.check_producer_openapi /path/to/openapi.json`. It checks the selected operations and their referenced components and identifies differences for review.

The live UTC lookup calls `GET /sites/{site_id}/instant` on submission with the displayed `run_id` and a whole-second UTC `t` within the evaluated range. It shows the requested time and the native model sample separately. The sample must align with the evaluated grid and cover `t` in `[sample_utc, sample_utc + step_s)`. When the aggregate retains the same sample, its Sun, Earth and joint visibility must agree with the instant response. For a sample omitted from the series, the lookup uses the producer’s visibility flags. Solar centre clearance can be negative while part of the disc is visible. File imports use their supplied observations only.

Live observation links use `view_site` for the inspected site and `at` for its returned UTC. A single-site link uses `site_id`. A pair link uses a single `site_ids` value with two distinct IDs in selection order and an explicit run, UTC window and sampling step. At `#terrain-pair`, the workspace loads that aggregate and replays the read-only ranking request. At `#terrain-observations`, it opens the chosen observation. Recovering a pinned request with an imported export checks site order and stays local. The browser restores the selected observation after the pinned run loads. A site or timestamp absent from that response raises a selection error. Older links default to the first available observation. The live workspace and the two-date report link to `GET /runs/{run_id}` and the original `GET /runs/{run_id}/files/manifest.json`. The downloadable path must match the displayed run exactly. Imported producer files keep their source path and checksum as text.

Live aggregate links accept UTC boundaries with up to nine fractional digits. The workspace keeps the original bounds in the request form and displays the evaluated grid separately. A sub-millisecond endpoint stays editable as UTC text. Opening the date comparison from that result starts its date controls at the evaluated grid bounds.

The November 14 update changed the default ephemeris provider for custom-site jobs to Horizons. The frontend explicitly requests SPICE, PGDA and hourly ray marching, as shown on the form. A structured `503 STORAGE_FULL` or `501 JOB_TYPE_UNAVAILABLE` confirms that the requested calculation was refused. A lost or ambiguous submission response offers manual retry of the same payload.

**Cancel my request** sends one `DELETE /jobs/{job_id}` for the active custom-site submission. The client checks the returned job ID, site, submitted UTC bounds and client count. A cancelled job with zero clients or a still-active job with other clients ends local polling and makes the form available again. If cancellation fails, the UI reads job status. A job that completed during cancellation can still be opened. After a failed cancellation, **Stop following this job** ends local tracking without sending another DELETE.

The standalone date comparison at `/compare-dates` requires `run_id`, `site_id`, `from`, `to`, `from2` and `to2`. The live form loads IDs, names, horizon methods and terrain-map sources with `GET /sites` when opened. A site outside map coverage uses the producer’s smooth-sphere fallback. The date report labels this and its effect on local shadows. A failed catalog read leaves the pinned site available and offers retry. Each query field occurs once. Each window has the same positive duration, up to 31 days. Opening the link loads one summary per UTC range, each pinned to the same run and single site, with `include=windows,metrics,criteria` and `criteria_hours=24,72,168`. The client checks site, run, manifest identity, sampling step and returned UTC bounds before displaying the pair. The two-date workflow uses the existing aggregate contract.

The two-site form submits the displayed evaluated UTC window, its run ID and two different catalog IDs to `POST /compare`. It requests all Sun, Earth and joint state intervals. The response supplies weights, pair-local ranks, scores and per-site warnings. Complete coverage requires intervals for each state timeline to span the evaluated window. With incomplete coverage the viewer withholds the pair ranking and marks unavailable percentages.

After a complete pair comparison, **Show catalog ranks** sends one unfiltered `GET /ranking` with its run ID, evaluated UTC bounds and explicit score weights. The client checks the returned range, sample count, weights, unique ranked sites, and both selected sites’ scores and metrics against the pair response. The denominator counts the sites returned for that query. The UI compares every ranked site ID with the catalog for the same run before displaying the denominator. Changing the pair clears its catalog ranks. A failed catalog request can be retried while the pair remains visible.

Live and imported observation cards identify the per-site horizon method and elevation source when provided. A run may use terrain modeling overall while a site outside elevation-map coverage uses a smooth sphere. Its chart labels the supplied horizon accordingly.

Each aggregate site card shows the supplied planetocentric latitude, east longitude, model surface height and the run’s height above the surface. The report retains the producer’s coordinate and height conventions. Signed latitude, east longitude above 180° and zero model height remain as supplied. Older imports without these fields still open. A single-site date comparison also checks that the two returned locations and heights agree. Live site, pair and date cards link to the pinned `GET /sites/{site_id}?run_id=…`. Its rank and metrics cover the entire run; date-specific values are displayed separately in the comparison.

For the site's two CSV downloads the browser opens a same-origin GET and the backend supplies the attachment. Both links include the exact `run_id` and evaluated half-open `start` and `end`. Series columns are UTC, Sun and Earth azimuth/elevation, and the three visibility flags at native cadence. Windows request `kinds=sun,earth,both`, including hidden intervals and clipping/truncation flags. Two-date results use each card’s own interval. Imported and mock results are local and show no producer CSV links.

Submitting the live landing-date form sends one `POST /api/v1/alt-dates` for the selected site and run. Its `earliest` and `latest` are inclusive landing bounds in UTC. The client accepts whole seconds and requires a mission duration divisible by the model step. The producer supplies ranks, visibility percentages, grid-relative delays and rejection counts. The viewer shows the requested inclusive bounds, any inward-aligned search grid, and candidate delays measured from the user’s earliest allowed landing. A search with zero feasible starts returns HTTP 200. One start may fail several constraints. Opening a proposed hourly mission window loads its pinned aggregate by GET.

For each live site, the aggregate supplies `minimum_hours`, `longest_both_h` as the metric, `value_h`, `value_clipped`, `result` and `reason`. Live requests check all requested thresholds. The importer accepts other threshold lists supplied by the producer and older exports without a criteria section. The display retains the reason in its original language.

On the public frontend, series and windows CSV filenames identify the site, run and requested UTC bounds, including fractional seconds. A short suffix distinguishes the requested fields or visibility kinds. Summary CSV filenames identify the requested run. Omitted parameters are labeled as defaults. Original run files keep their published basename. The relay streams the producer’s original file bytes.

## Synthetic API and legacy ideal-horizon imports

The structural definition for this format is [`contracts/openapi.draft.json`](../contracts/openapi.draft.json), OpenAPI 3.1. `npm run generate:api` produces `frontend/lib/api/schema.d.ts`; API types must not be handwritten. Semantic checks remain in [`frontend/lib/dataset.ts`](../frontend/lib/dataset.ts) and `frontend/lib/api/client.ts`; generated TypeScript is not runtime validation. The OpenAPI response example and [`frontend/public/data/demo.json`](../frontend/public/data/demo.json) are **invented UI fixtures**, never NASA datasets.

## Proposed API and transport

| Endpoint | Behavior |
| --- | --- |
| GET `/api/v1/dataset` | Agreed route. The mock accepts `from`, `to`, `resolutionSeconds`. Chung’s production OpenAPI will specify the query and response. |
| POST `/api/v1/jobs` | Explicit coordinate request; HTTP 202 returns `jobId`. |
| GET `/api/v1/jobs/{id}` | `queued`, `running`, `done` or `failed`, with `progressPct` 0–100. Done requires a dataset; failed requires a problem. |
| GET `/api/v1/openapi.json` | Contract served by mock/static copy or the configured backend. |

Request limits are **frontend proposals**, pending agreement: increasing UTC range, at most 31 days, 60–86400 seconds requested resolution, at most 10,000 requested samples per series, and at most 5 MiB per API response/import. Actual cadence is reported in `sampleStepSeconds`. The mock filters fixture scenarios to the requested range and retains native cadence; it performs no scientific resampling or coordinate calculation. Empty windows return an empty scenario list.

JSON requests and common `application/problem+json` handling live in `frontend/lib/api/`. Headers and body share one deadline, 35 seconds for the synchronous landing-date search and 15 seconds for other requests. Caller cancellation applies to both. TanStack Query caches bounded window requests and retries transient failures up to twice. Job GET polling runs every 1.5 seconds and stops on terminal status or exhausted errors; POST is never retried automatically. Loading, empty, rejected-data and failure states remain visible.

Live planner and comparison forms display the producer's problem title, detail, stable code, recovery hint and up to five field errors when supplied. Planner fields identify their corresponding validation message. For 429 or 503 responses, the client displays the retry time in UTC when the server supplies a valid `Retry-After` header. The producer's `RATE_LIMITED.retry_after_s` also supplies the wait when the header is absent. Affected planner and comparison submit buttons count down, then accept a manual retry. Queries with a server-specified wait skip automatic retries.

One setting switches modes: `NEXT_PUBLIC_API_BASE_URL=mock` (default) or an HTTP(S) backend **origin**, without credentials/path/query. Browser calls always use same-origin `/api/*`; Next.js rewrites proxy backend mode. Rebuild/restart after changing this build-time variable. Failed backend requests never fall back to synthetic results. MSW is deliberately available in the local synthetic production preview, not restricted to development. `/api-docs` initializes mocking before opening the locally hosted Swagger explorer. No online Swagger validator/CDN is used.

## Release envelope

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Exactly `frontend-draft-2`. A breaking producer change needs an explicit adapter or schema revision. |
| `datasetId` | Immutable release identity, included in selection links and reports. A different release must use a different ID. |
| `evidence` | `synthetic-fixture` or `computed-ephemeris`. The latter is a producer declaration, never frontend proof of validity. |
| `attribution` | Human-readable generation/processing attribution, shown with sources. |
| `model` | `id: ideal-horizon-center-v1`, human label, definition and nonempty limitations. This draft does not mix terrain-resolved and ideal-horizon products. |
| `criteriaHours` | Unique positive thresholds evaluated by the producer for every scenario. The UI cannot invent another H. |
| `sites`, `scenarios`, `sources` | Catalogs with unique URL-safe IDs and checked references. Empty catalogs produce an empty state, not results. |

## Site and source requirements

Each site has `id`, `name`, `location`, `sourceIds`. Synthetic locations may be null. Computed ephemerides require latitude in degrees, east longitude normalized to [-180, 180], elevation in **km**, a named body-fixed frame and elevation datum, and actual location-source references. The frontend displays these fields without converting or validating their scientific interpretation.

Sources carry `id`, `title`, an HTTP(S) `url` without embedded credentials, `version`, `retrievedAtUtc`, and `rawSha256`. The hash can be null for descriptive sources. Every computed scenario must reference at least one raw-response hash and provide `evidenceUrl` for processing evidence. Links are ordinary external navigation, never automatically fetched by the importer.

Processing evidence must retain the actual request and response identity, target/observer, location/frame/elevation convention, time scale and UTC conversion, quantity definitions, cadence/coverage, any transformation and independent sample checks. A URL or SHA-256 string alone does not prove these checks happened.

## Scenario requirements

Each scenario contains `id`, `siteId`, `startUtc`, `endUtc`, `coverage`, `sampleStepSeconds`, `horizonCurve`, `samples`, `intervals`, `metrics`, `criteria`, `sourceIds`, `evidenceUrl`. The supplied horizon curve covers azimuth 0 through 360 degrees in increasing order; this model only accepts a flat zero-degree horizon. A terrain-aware model requires a reviewed contract/model change. The sky plot displays that curve and supplied Sun/Earth tracks.

- Time strings must be real ISO UTC instants with seconds and `Z`; optional milliseconds use exactly three digits. End follows start. Comparison logic uses instants, not textual equality. Windows are half-open [start, end); the sample at end supports boundary evaluation and adds no duration.
- Samples are strictly increasing and within the window. Each Sun/Earth observation is null or `{azimuthDeg,elevationDeg}`. Angles are finite: azimuth [0,360), clockwise north through east; elevation [-90,90]. `0` is a real boundary value, not missing data. These semantics must match the producer's source quantities.
- `sampleStepSeconds` is the nominal maximum separation of adjacent observations. Complete coverage needs both boundaries, no null observations and no gap larger than this step. Partial data may have nulls or longer gaps; chart paths break at either. The UI never fills gaps or computes extra observations. Isolated observations remain visible as markers.
- `intervals` provides ordered, disjoint positive-length Sun, Earth and simultaneous interval arrays, each with `startUtc`, `endUtc`, `endClipped`. A clipped end must equal the window boundary; it does not prove a setting event. Joint intervals must be contained in both body interval sets.
- `metrics` provides `sunAboveHours`, `earthAboveHours`, `simultaneousLongestHours`. Structural checks compare these to supplied intervals; the frontend does not derive scientific intervals from samples. Partial/missing scenarios require null intervals/metrics and unknown assessments. A missing scenario has no samples. Complete zero results remain numeric zero with empty intervals.
- `criteria` contains one `{minimumHours,result,reason}` for every released H. Results are `meets`, `below`, `borderline`, or `unknown`. Definite results must agree with the supplied metric; near-threshold classification and its explanation belong to the producer.

## Comparison and persistence

Date comparison fixes site and window duration and uses elapsed time; each side retains its real UTC labels. Site comparison fixes the absolute start/end instants and uses distinct sites. The synchronized cursor visits actual shared sample offsets only; it never interpolates a missing angle. Line segments visually connect supplied points and are labeled as such.

Selection links use `v`, `mode`, `a`, `b`, `duration`, `h`, plus bounded request `from`, `to`, `resolutionSeconds`. When the pair has shared samples, `sample` identifies the primary UTC instant on the timeline. Reopening the link restores that exact sample and the alternative at the same elapsed offset. An unavailable instant raises an error. Older links without `sample` open at the first shared sample. Completed real-job links include `job` and reopen via GET without starting another calculation; backend retention/access remains a required agreement. Mock job results reopen through the deterministic fixture range, not an expiring mock job ID. Incomplete, duplicate, stale or incompatible selections display an error. Imported comparison fields and live terrain target fields are mutually exclusive. On the live build, a versioned comparison waits for its matching file. A Retry reissues the original API request only when one was made. Importing the requested release can restore a link. `Use loaded dataset` explicitly clears a saved selection if the user wants the imported release's defaults. Imported data is held in page memory and is not embedded in the link or persisted automatically.

Later-match navigation searches only later same-site/same-duration candidates in the current release, using producer assessments. An earlier unknown/borderline candidate blocks a “first match” claim. No claim applies to dates outside the published candidate set.

## Handoff to the producer

Review the draft endpoints, request limits, release envelope, job payload/state contract, model and error examples with Chung. Replace or reconcile the OpenAPI **before** real integration, regenerate types and rerun acceptance checks. Supply a reviewed Colab release with provenance and complete/empty/partial/missing/failure examples. Confirm time/frame/units, interval boundaries, thresholds and hosting/proxy behavior. Do not copy credentials into this repository or a browser environment variable.
