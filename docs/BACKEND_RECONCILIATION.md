# Evolving backend plan and frontend handoff

Status on 14 November 2026: the team has selected the backend contract and a single aggregate GET for frontend integration. The payload and science model are pending. The user supplied Chung's `WEB_BACKEND_PLAN.md` and confirmed that it may grow as more resources are discovered. It is a snapshot, not a feature ceiling or evidence of a deployed service. Its first paragraph says implementation has not started; its response numbers are illustrative. Source SHA-256: `d9062845466b1d093640026cf5b547965197a958e55f5dd0c34a3b9501e615c9`. The original internal document is not redistributed here.

Chung owns the production OpenAPI and will add **GET `/api/v1/dataset`** after the current backend workflow. The frontend already calls this route once per requested window through its typed API client. Once Chung supplies the versioned schema and a bounded example, regenerate the client types and adapt the API layer. Preserve the current UI where the meanings match. Where the backend supplies a different horizon model, review the affected labels and validation before displaying it. A separate team member owns Colab execution and testing.

## Colab precompute and the first science comparison

The team supplied a precompute notebook on 14 November. Its full-run settings select 23 catalog sites, hourly UTC samples from 2026-01-01 inclusive to 2031-01-01 exclusive, and an observer 2 m above ground. A uses JPL Horizons, a Moon Trek elevation model and ray marching. B uses NAIF SPICE, a PGDA elevation model and a brute-force horizon calculation. These are configured methods and dates. The shared copy saved the settings and a failed Google Drive mount. Its precompute, validation and archive cells contain no saved results.

For a first comparison, obtain the run archive or a two-site slice with `RUN_INFO.json`, the manifests, the two site records, horizon masks, timestamped ephemeris and visibility tables, and the relevant rows of `checks.csv`. Preserve the raw source references and the code version. Validate the same UTC start and end for both sites, align the body observations, and independently compare every simultaneous interval, its total duration and the longest interval. Retain gaps, clipped bounds and the uncertainty of crossings between hourly samples. A sunlight percentage alone cannot establish joint visibility.

The notebook uses a terrain horizon, solar semidiameter and Earth clearance. The existing importer expects a flat horizon and body centers. A producer release under the existing model can use the importer directly. Terrain-resolved flags require an agreed model and interface before display. For discrepant rim sites, compare identical coordinates, observer height, window and visibility definition, then compare the horizon masks in the directions actually crossed by the Sun. For example, Table 1 in Gläser et al. lists 81.0% and 86.7% maximum average illumination at two different surface locations on Shackleton rim. Its separate solar visibility column measures the time any part of the Sun is visible. Compare like quantities and heights before choosing a pipeline. [Gläser et al., Table 1 and method](https://ntrs.nasa.gov/api/citations/20170007365/downloads/20170007365.pdf)

## Decisions to reconcile with Chung

| Area | Backend plan | Current frontend / proposed next step |
| --- | --- | --- |
| Public fields | `snake_case`, matching OUTPUT_SPEC | Earlier mandatory rules say `camelCase`. Use the published backend schema to settle the wire format and regenerate types. Do not mechanically rename without checking semantics. |
| Repository | Assumes a separate frontend repository | User selected one shared product repository. Bring intended backend/data source into that repository with explicit ownership; preserve both existing checkouts. |
| Scientific model | Terrain horizon, Sun fractions, power/irradiance, longitude [0,360), observer height in metres | Existing draft is flat-horizon body-centre only, with longitude [-180,180] and elevation in km. Version the model and document frames/units. Observer height and site elevation are different quantities. |
| Results | Separate runs/sites/horizon/series/windows/compare; implicit sample times, snapped bounds and downsampling | Existing `/dataset` envelope has explicit times and boundary/coverage checks. Use the agreed aggregate GET and map the versioned response in the client; retain actual bounds, gaps, clipping, cadence and provenance. |
| Jobs | Cached 200, `succeeded`/`cancelled`, potentially unknown percentage, result references run/site | Current draft expects 202, `done`, a percentage and an embedded dataset. Revise types, validation, polling and result loading together. Unknown progress stays indeterminate; cancellation is not success. |

Frontend answers already available: Next.js 16.4.6, TypeScript 5.9.3, TanStack Query 5.107.1, openapi-fetch 0.17.0, generated OpenAPI types and MSW. Same-origin `/api/*` proxy is prepared. Hosting is still undecided.

Minimum next input: exported `openapi.json` at a known commit, the referenced OUTPUT_SPEC/model definitions, and a small sourced two-site/two-window fixture with complete/gap/empty and job terminal examples. A tested origin or reproducible mock unlocks integration. No need to finish every optional endpoint first.

## AI planning assistant — proposed addition

The frontend now answers the structured version using **Compare sites**. A visitor selects a published UTC interval and threshold. The view lists producer-supplied results, reasons and available source references for that release. Free-text questions and model-generated explanations still depend on the backend contract below.

Desired interaction: “For this UTC interval, which published sites fit my chosen criteria?” The backend plan has no LLM provider/model or assistant endpoint. Its `provider: spice` means ephemeris computation; an optional jobs API key is not an AI-provider integration.

Propose a backend-owned assistant after the owner agrees its contract. The model should explain backend-produced comparisons, identify the release, actual UTC interval, chosen criteria and supporting scenario/source IDs, and preserve ties, missing coverage and uncertainty. “Best” needs a declared objective; no landing-safety conclusion follows from a visibility score. Dates beyond available data must return an explicit inability to answer. Natural-language local dates need an explicit timezone and confirmation of the interpreted UTC range.

Keep provider credentials server-side, outside public environment variables, URLs, browser storage and bundles. Use the existing API client and a mutation without automatic POST retries. The backend needs input/output limits, rate/cost limits and safe text rendering. Do not add a local Next `/api` handler without revisiting the existing live proxy, which forwards that path to the backend. Attribute model output to the model, preserve source links, and do not imply NASA review or endorsement.

This is a proposal, not a new endpoint promise or a simulated chatbot presented as AI. Provider/model, payload, grounding, runtime and key configuration remain undecided. No key is needed in chat.

## Open feature path

Time-based appearance and credited lunar imagery can ship independently now. Terrain views, 3D, alternate-date search, richer criteria and AI explanations remain candidates as backend resources arrive. Add them in useful, reviewable slices without removing the working comparison or confusing reference imagery with scientific results.

Next action: share the exported OpenAPI and one small example when available; reconcile only the fields needed for the first real comparison.
