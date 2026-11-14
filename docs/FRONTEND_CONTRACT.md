# Frontend API and import formats

The [producer OpenAPI extract](../contracts/openapi.dataset.json) defines the live aggregate, capability discovery, custom-site job submission and status reads. It uses `lunarnav-dataset-1` with terrain-model metadata, site coverage and half-open UTC intervals. The [integration record](BACKEND_RECONCILIATION.md#aggregate-update-on-14-november) documents the request parameters and checked responses. Producer exports with windows and metrics open in the same viewer. A supplied `horizon` adds an azimuth/elevation profile and a supplied `series` adds a sample inspector. Each site has its own ordered UTC timestamps. A coarser request can retain extra samples at transitions. The inspector uses the timestamps actually returned, while the three visibility bands use the full supplied interval lists.

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

All calls and common `application/problem+json` handling live in `frontend/lib/api/`. Header/body reads share a 15-second deadline and preserve caller cancellation. TanStack Query caches bounded window requests and retries transient failures up to twice. Job GET polling runs every 1.5 seconds and stops on terminal status or exhausted errors; POST is never retried automatically. Loading, empty, rejected-data and failure states remain visible.

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

Selection links use `v`, `mode`, `a`, `b`, `duration`, `h`, plus bounded request `from`, `to`, `resolutionSeconds`. Completed real-job links include `job` and reopen via GET without starting another calculation; backend retention/access remains a required agreement. Mock job results reopen through the deterministic fixture range, not an expiring mock job ID. Incomplete, duplicate, stale or incompatible selections display an error. Importing the requested release can restore a link. `Use loaded dataset` explicitly clears a saved selection if the user wants the imported release's defaults. Imported data is held in page memory and is not embedded in the link or persisted automatically.

Later-match navigation searches only later same-site/same-duration candidates in the current release, using producer assessments. An earlier unknown/borderline candidate blocks a “first match” claim. No claim applies to dates outside the published candidate set.

## Handoff to the producer

Review the draft endpoints, request limits, release envelope, job payload/state contract, model and error examples with Chung. Replace or reconcile the OpenAPI **before** real integration, regenerate types and rerun acceptance checks. Supply a reviewed Colab release with provenance and complete/empty/partial/missing/failure examples. Confirm time/frame/units, interval boundaries, thresholds and hosting/proxy behavior. Do not copy credentials into this repository or a browser environment variable.
