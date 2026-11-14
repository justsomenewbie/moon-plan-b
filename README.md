# Moon Plan B

Compare lunar landing sites by UTC dates, or find landing times for a chosen site and mission duration. The planner uses visibility of the Sun, Earth or both above the modeled horizon. [Open the planner](https://moon-plan-b.vercel.app/plan) · [Browse the data](https://moon-plan-b.vercel.app/data).

The public frontend requests data from the team’s [production API](https://api.lunavigator.com/docs). The [verified B2 archive](docs/B2_VISIBILITY_ARCHIVE.md) also supports offline visibility searches for all 23 sites across 43,824 hourly samples per site, from 1 January 2026 through 31 December 2030 UTC. Use `/compare` for observations, intervals, JSON imports, shareable links and printed reports. Historical B links retain their original run. [Backend verification](docs/BACKEND_RECONCILIATION.md).


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

Open **/data** for the producer’s manifest, file catalog and compact hourly visibility archive. The legacy [saved B comparisons](docs/SAVED_PLANNER.md) remain available alongside B2. Travel windows use an exclusive UTC end.

The default `NEXT_PUBLIC_API_BASE_URL=mock` runs the synthetic API. To use an agreed backend, set this one variable to its HTTP(S) origin, for example `http://127.0.0.1:8000`, then rebuild/restart. Never put credentials in it. Browser requests use same-origin `/api/*`. In LAN mode, Next.js rewrites forward them to the configured backend. `NEXT_PUBLIC_*` values are embedded at build time. Backend errors do not trigger a synthetic fallback. Mock jobs simulate progress and return fixture data; they do not calculate entered coordinates.

For the public Lunavigator service, build with `NEXT_PUBLIC_API_BASE_URL=https://api.lunavigator.com` and set `LUNARNAV_API_KEY` in the Next.js server's runtime environment. The Node.js route adds the key to approved dataset, catalog, ranking, instant, export, run-file, comparison and landing-date requests. Custom-site jobs are available through the team LAN workflow. Live queries can discover the producer’s default run, while the saved archive identifies its original run B.

In live mode, **Load windows** retrieves the terrain horizon, sampled Sun and Earth positions, full visibility intervals and metrics for both sites. Choose an observation site and move the sample slider to read its UTC time, azimuth, elevation and model visibility. The three time bands show when the Sun, Earth or both are visible. In **Look up a UTC instant**, enter a time in the evaluated range to see the model sample covering it, each body’s position relative to the local horizon and both visibility flags. **Sources & method** links to the pinned run record and its original file manifest. Compare the manifest file’s SHA-256 with the digest displayed in the report. Open **Site location** to inspect the model’s coordinates and heights. **Open site record (full run, JSON)** gives the catalog source and any location notes for that site. Each site shows the backend’s verdict for continuous overlap of at least 24, 72 and 168 hours. Open a threshold to read the producer’s reason. **Open selected observation in a new tab** reopens the selected site and exact returned UTC sample, with the dates, sampling request and producer run ID. In mock mode, the editable UTC range and desired step feed both **Load windows** and the simulated job form. Editing these fields leaves the displayed result and its shared link unchanged until new results are opened. **Retry API request** repeats the failed request, including its retained job ID when present.

In the live workspace, open **Compare dates** and choose a site from the current run to compare two UTC windows of equal duration. If the catalog fails to load, the current site stays available and **Retry site list** reloads the choices. Set the first window's start and exclusive end, then the second start. Both results use the same model run. **Open date comparison in a new tab** provides a link with the selected site, both windows and the run. The linked page can be printed.

To compare two sites in the displayed UTC window, open **Rank two sites for this UTC range**, choose two distinct sites and select **Compare this pair**. The score uses the displayed visibility weights. The cards show each site’s rank within the pair. **Open this ranked pair in a new tab** shares the two chosen sites in selection order, the run, the evaluated UTC window and the sampling step. The link reopens their observations and ranking. Select **Show catalog ranks** to see where those same sites rank across the run’s returned catalog, using the same UTC window and weights. For a site outside the elevation map, the horizon chart and result card identify the smooth-sphere model and its omission of local terrain shadows.

Each live result card has two CSV downloads for its site, run and evaluated UTC interval. **Download observations (CSV)** includes every source sample’s UTC, Sun and Earth angles, and visibility flags. **Download visibility windows (CSV)** includes both visible and hidden intervals and their boundary flags. Files retain the producer’s names, which omit the dates.

Under a live site's observations, open **Find alternative landing dates**. Enter the earliest and latest allowed landing times (both inclusive, in UTC), the mission duration and the minimum percentage of the mission when both bodies must be visible. Select **Search landing dates** to run the search. Each proposal gives its landing time, mission end and delay from the earliest allowed landing. **Inspect this mission window** reopens a supported hourly result on the same site and model run.

Browser Back/Forward restores the comparison encoded in a shared URL, including its date range. A bare URL opens the default request and comparison. An imported release can be reused while it remains loaded; a link alone cannot recover a missing local file.

**Language** defaults to English; choose **VI** for the Vietnamese interface. The choice is saved locally when browser storage is available. Switching keeps the comparison, timeline sample, edited request and running job intact. Exact UTC values, units and supplied scientific/source text are preserved. Original OpenAPI documentation remains English. Use the sun/moon button to switch appearance; **Auto** follows local time.

The homepage globe starts turning when its surface map loads. Drag it or focus it and use the arrow keys to turn it. Zoom, reset and the site list also work on the homepage. The comparison page has numbered map pins, four direction buttons and a pause/resume control. Reduced-motion mode opens a still globe. **Return to photograph** switches to the still image. Its center coordinates describe the view. The default view uses fixed lighting on NASA’s photographic color map. In a saved comparison, select **Modeled sunlight** to see the Sun’s direction at the start of the chosen week. [Dates, ephemeris and limits](docs/GLOBE_SUNLIGHT.md). [NASA CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/)

Use **Locate a site** under the globe to find the published landing regions of Odysseus and Athena and open the corresponding source. These mission references are available without importing data. Select **Primary** or **Alternative** to open that observation in the local sky. The globe can also mark a sourced comparison site when its declared coordinate convention matches the map. [Coordinate handling](docs/METHOD.md)

**Compare sites** starts with a published UTC window. Choose a joint visibility threshold to see every site’s supplied assessment, its longest joint interval when available, and the original explanation. Catalog sites without a result for those exact bounds appear separately. The primary and alternative selectors control the two tracks in the chart.

Choose **Explore the 3D sky** to see the directions supplied for one site and UTC sample. Switch between primary and alternative observations, rotate the sky around the site, or move the timeline. A dashed ray points below the ideal horizon. The 2D tracks and sample table remain available for reading the values.

The app opens a conspicuously labeled synthetic fixture. Switch between **Compare dates** and **Compare sites**, select an available window, and move the sample slider. `Find a later published match` searches only supplied assessments; it never treats unresolved earlier candidates as a confirmed first match. Missing observations remain missing. On the comparison page (`/compare`), **Import data** explains the two accepted JSON formats and offers a downloadable example. Choose a file up to 5 MiB. The browser validates it locally. The JavaScript API client limits JSON responses to 5 MiB. The landing-date search allows 35 seconds, and other requests allow 15 seconds. A selection link contains IDs/settings/request range, not the imported dataset. For a live custom location, open **Request a custom lunar location**, enter planetocentric latitude, east longitude and observer height in metres, then submit the selected UTC range. While it is queued or running, **Cancel my request** releases your request. If another client is waiting for the same calculation, their job continues. Once the backend completes the job, **Open job results** loads its site and run. A result link stays usable while the backend retains that run. A loopback link works only on the same computer.

### Ask the astronaut

Open the astronaut in the lower-right corner and type a question in English or Vietnamese. The guide starts with the saved rows when you open a saved comparison link, or with the displayed pair when you rank two sites. Use “Use data from” to choose another source. Your choice persists when you reopen the guide on the same page. You can ask which site has more joint visibility, check the source run, or request a change of comparison mode. Review the selected data before sending. The app sends the question, the preceding question if present, and a short summary to its own server. A suggested navigation or mode change takes effect when you choose it.

For a public deployment, set `OPENAI_API_KEY` as a secret in the Next.js **server** environment and set `ASTRONAUT_CHAT_ORIGIN` to the exact public origin, e.g. `https://moon.example.org`. Apply the settings to the production environment and restart or redeploy the server. The Node route `POST /guide/chat` calls OpenAI Chat Completions using `gpt-5.4-mini-2026-03-17` with Structured Outputs. It sends the current question, the preceding question if present, and the site names and UTC ranges needed to select rows. The app formats the scientific values locally. The OpenAI project needs API billing and access to the model. [OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-5.4-mini)

With no OpenAI key, the server uses Ollama with `qwen2.5:7b` at `127.0.0.1:11434` on the same host. Presets remain available if inference fails. Dated planning questions use the planner and the team backend. Both providers share the same per-process request budget. For a shared deployment, configure a per-client limit at ingress. The chat route requires a Node runtime.

Read the [draft frontend contract](docs/FRONTEND_CONTRACT.md), [method and limits](docs/METHOD.md), [credits](docs/CREDITS.md) and [verification record](docs/FRONTEND_VERIFICATION.md). The [producer aggregate contract](contracts/openapi.dataset.json) governs the live comparison. The draft contract governs the synthetic workspace and legacy JSON imports. Next.js runtime hosting versus static export is still an integration decision; this task does not select a hosting provider.

Start with [AGENTS.md](AGENTS.md) and [HANDOFF.md](HANDOFF.md). English remains the default interface and the language of team-authored documentation and submission materials; Vietnamese is an optional secondary interface.

## Collaboration

One repository holds the frontend, backend/data scripts, tests and product documentation. Frontend direction: Next.js + Tailwind CSS, reported by Sơn from Chung. The team service exposed its version 1.0.0 API on the local network. Read-only site and visibility responses were verified. The aggregate route returned sourced results for both verified weeks. The public preview connects to the production service with a server-side key. Do not guess an endpoint or copy private credentials into this repository.

This repository is public. Anyone may fork it and propose changes through a pull request. Named collaborators need to accept their invitations before direct push access works. Use one editor per checkout; independent reviewers read without writing. Frontend files live under `frontend/`, the proposed shared contract under `contracts/`; backend/data implementation remains with its assigned owner. Edit and agree the OpenAPI before real integration, regenerate types and run the checks. The draft's arbitrary endpoints and limits must not be presented as Chung's existing API.

## Event boundary

Implementation started after 14 November 2026 at 00:00 Hanoi time (UTC+07:00), based on the organizer reply supplied and reaffirmed by Sơn. Local submission is due 15 November at 11:00 Hanoi; the separate global cutoff is 23:59. Running this frontend does not submit the project.

Reviewed preparation source: [exact checkpoint](https://github.com/justsomenewbie/space-apps-2026-preparation/tree/5abda55a6d83bf89d6dd762fa6ceddfc3d265920). Preparation history is context, not proof of scientific validity, team acceptance or award eligibility.

## Status and credits

Codex assisted repository setup, frontend code, validation/tests, synthetic test fixtures and documentation. Built-in Image Gen produced an internal UI design reference; its raster output is not an app asset. The proposal also has prior AI-assisted history; preserve and disclose it truthfully. The current guide's restriction on SI supplying the solution idea remains unresolved for that history. No eligibility declaration has been made.

Product licensing must be selected and checked against submission terms and third-party compatibility before release; public visibility alone is not a reuse licence. Dependency permissions and actual AI contributions are recorded in [credits](docs/CREDITS.md). The app includes a credited NASA LRO photographic mosaic and a separate color map for the interactive reference globe. No lunar terrain asset, external font or music is included.
