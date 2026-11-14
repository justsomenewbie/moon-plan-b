# Moon Plan B

Shared repository for the team's NASA Space Apps 2026 project. The Next.js + Tailwind frontend supports site/date comparison, Sun/Earth tracks and visibility bands, dataset import, bounded API requests, job progress, source inspection, shareable selections and printing. **The default demo uses synthetic data. With a team backend configured, the frontend requests terrain-model results from `GET /api/v1/dataset`.** The home page also displays two saved weeks of terrain-model results for Odysseus and Athena. Select a UTC week to compare sites or a site to compare weeks. Each saved choice has a direct link that reopens its UTC intervals and source queries. Use **Print saved result** or print from that link for the sourced report. **Print report** in the workspace prints its current selection. The live comparison requests Odysseus and Athena for one UTC range and shows their supplied joint intervals, coverage and source run. You can also import a producer JSON export containing windows and metrics. See [backend status](docs/BACKEND_RECONCILIATION.md).

## Run the frontend

Use Node 24.22.3 or a later security-patched Node 24 release, with npm.

```sh
cd frontend
npm ci --ignore-scripts
npm test
npm run check
npm run build
npm start -- --port 3014
```

Open `http://127.0.0.1:3014`. For development use `npm run dev`. The scripts bind to loopback; publishing or exposing a server is a separate step. The lockfile pins the tested dependencies. On the original Mac, the verified runtime is `/Users/nns/.local/share/frontend-runtime/node-v24.22.3-darwin-arm64/bin`; other hosts must provide their own runtime.

Tests/development/build explicitly generate API types and prepare local MSW/Swagger assets. `--ignore-scripts` prevents dependency lifecycle telemetry; no dependency scripts are required by the checked commands. Use `/api-docs` for the interactive Swagger explorer. Its files are local and its online validator is disabled.

The default `NEXT_PUBLIC_API_BASE_URL=mock` runs the synthetic API. To use an agreed backend, set this one variable to its HTTP(S) origin, for example `http://127.0.0.1:8000`, then rebuild/restart. Never put credentials in it. Client requests remain same-origin `/api/*`; Next rewrites forward them. `NEXT_PUBLIC_*` values are embedded at build time. Backend errors do not trigger a synthetic fallback. Mock jobs simulate progress and return fixture data; they do not calculate entered coordinates.

In live mode, **Load windows** retrieves the terrain horizon, sampled Sun and Earth positions, full visibility intervals and metrics for both sites. Choose an observation site and move the sample slider to read its UTC time, azimuth, elevation and model visibility. The three time bands show when the Sun, Earth or both are visible. Each site shows the backend’s verdict for continuous overlap of at least 24, 72 and 168 hours. Open a threshold to read the producer’s reason. **Open comparison in a new tab** reopens the selected site and exact returned UTC sample, with the dates, sampling request and producer run ID. In mock mode, the editable UTC range and desired step feed both **Load windows** and the simulated job form. Editing these fields leaves the displayed result and its shared link unchanged until new results are opened. **Retry API request** repeats the failed request, including its retained job ID when present.

In the live workspace, open **Compare dates** to compare two UTC windows of equal duration at Odysseus or Athena. Set the first window's start and exclusive end, then the second start. Both results use the same model run. **Open date comparison in a new tab** provides a link with the selected site, both windows and the run. The linked page can be printed.

Under a live site's observations, open **Find alternative landing dates**. Enter the earliest and latest allowed landing times (both inclusive, in UTC), the mission duration and the minimum percentage of the mission when both bodies must be visible. Select **Search landing dates** to run the search. Each proposal gives its landing time, mission end and delay from the earliest allowed landing. **Inspect this mission window** reopens a supported hourly result on the same site and model run.

Browser Back/Forward restores the comparison encoded in a shared URL, including its date range. A bare URL opens the default request and comparison. An imported release can be reused while it remains loaded; a link alone cannot recover a missing local file.

**Language** defaults to English; choose **VI** for the Vietnamese interface. The choice is saved locally when browser storage is available. Switching keeps the comparison, timeline sample, edited request and running job intact. Exact UTC values, units and supplied scientific/source text are preserved. Original OpenAPI documentation remains English. Use the sun/moon button to switch appearance; **Auto** follows local time.

The homepage globe starts turning when its surface map loads. Dragging, pressing a direction or zoom control, or selecting a site takes control of the view. Use **Resume rotation** to start it again. Reduced-motion mode opens a still globe. **Return to photograph** switches back. Drag to turn the globe or use the four direction buttons and **Reset view**. Its center coordinates describe the view. The surface uses a fixed light and NASA’s photographic color map. [NASA CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/)

Use **Locate a site** under the globe to find the published landing regions of Odysseus and Athena and open the corresponding source. These mission references are available without importing data. Select **Primary** or **Alternative** to open that observation in the local sky. The globe can also mark a sourced comparison site when its declared coordinate convention matches the map. [Coordinate handling](docs/METHOD.md)

**Compare sites** starts with a published UTC window. Choose a joint visibility threshold to see every site’s supplied assessment, its longest joint interval when available, and the original explanation. Catalog sites without a result for those exact bounds appear separately. The primary and alternative selectors control the two tracks in the chart.

Choose **Explore the 3D sky** to see the directions supplied for one site and UTC sample. Switch between primary and alternative observations, rotate the sky around the site, or move the timeline. A dashed ray points below the ideal horizon. The 2D tracks and sample table remain available for reading the values.

The app opens a conspicuously labeled synthetic fixture. Switch between **Compare dates** and **Compare sites**, select an available window, and move the sample slider. `Find a later published match` searches only supplied assessments; it never treats unresolved earlier candidates as a confirmed first match. Missing observations remain missing. `Import data` validates a local JSON file up to 5 MiB; the file is not uploaded. API responses are limited to 5 MiB. The landing-date search allows 35 seconds, and other requests allow 15 seconds. A selection link contains IDs/settings/request range, not the imported dataset. For a live custom location, open **Request a custom lunar location**, enter planetocentric latitude, east longitude and observer height in metres, then submit the selected UTC range. Once the backend completes the job, **Open job results** loads its site and run. A result link stays usable while the backend retains that run. A loopback link works only on the same computer.

Read the [draft frontend contract](docs/FRONTEND_CONTRACT.md), [method and limits](docs/METHOD.md), [credits](docs/CREDITS.md) and [verification record](docs/FRONTEND_VERIFICATION.md). The [producer aggregate contract](contracts/openapi.dataset.json) governs the live comparison. The draft contract governs the synthetic workspace and legacy JSON imports. Next.js runtime hosting versus static export is still an integration decision; this task does not select a hosting provider.

Start with [AGENTS.md](AGENTS.md) and [HANDOFF.md](HANDOFF.md). English remains the default interface and the language of team-authored documentation and submission materials; Vietnamese is an optional secondary interface.

## Collaboration

One repository holds the frontend, backend/data scripts, tests and product documentation. Frontend direction: Next.js + Tailwind CSS, reported by Sơn from Chung. The team service exposed its version 1.0.0 API on the local network. Read-only site and visibility responses were verified. The aggregate route returned sourced results for both verified weeks. Public hosting remains undecided. Do not guess an endpoint or copy private credentials into this repository.

This repository is public. Anyone may fork it and propose changes through a pull request. Named collaborators need to accept their invitations before direct push access works. Use one editor per checkout; independent reviewers read without writing. Frontend files live under `frontend/`, the proposed shared contract under `contracts/`; backend/data implementation remains with its assigned owner. Edit and agree the OpenAPI before real integration, regenerate types and run the checks. The draft's arbitrary endpoints and limits must not be presented as Chung's existing API.

## Event boundary

Implementation started after 14 November 2026 at 00:00 Hanoi time (UTC+07:00), based on the organizer reply supplied and reaffirmed by Sơn. Local submission is due 15 November at 11:00 Hanoi; the separate global cutoff is 23:59. Running this frontend does not submit the project.

Reviewed preparation source: [exact checkpoint](https://github.com/justsomenewbie/space-apps-2026-preparation/tree/5abda55a6d83bf89d6dd762fa6ceddfc3d265920). Preparation history is context, not proof of scientific validity, team acceptance or award eligibility.

## Status and credits

Codex assisted repository setup, frontend code, validation/tests, synthetic test fixtures and documentation. Built-in Image Gen produced an internal UI design reference; its raster output is not an app asset. The proposal also has prior AI-assisted history; preserve and disclose it truthfully. The current guide's restriction on SI supplying the solution idea remains unresolved for that history. No eligibility declaration has been made.

Product licensing must be selected and checked against submission terms and third-party compatibility before release; public visibility alone is not a reuse licence. Dependency permissions and actual AI contributions are recorded in [credits](docs/CREDITS.md). The app includes a credited NASA LRO photographic mosaic and a separate color map for the interactive reference globe. No lunar terrain asset, external font or music is included.
