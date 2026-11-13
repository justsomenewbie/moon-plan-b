# Moon Plan B

Shared repository for the team's NASA Space Apps 2026 project. The Next.js + Tailwind frontend supports site/date comparison, Sun/Earth tracks and visibility bands, dataset import, bounded API requests, job progress, source inspection, shareable selections and printing. **The included mock API and demonstration are synthetic, not lunar data. The OpenAPI contract is a frontend proposal awaiting Chung's agreement.** No real backend integration, validated scientific dataset, deployment or submitted entry is established.

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

The app opens a conspicuously labeled synthetic fixture. Switch between **Compare dates** and **Compare sites**, select an available window, and move the sample slider. `Find a later published match` searches only supplied assessments; it never treats unresolved earlier candidates as a confirmed first match. Missing observations remain missing. `Import data` validates a local JSON file up to 5 MiB; the file is not uploaded. API response reads are capped at 5 MiB and 15 seconds. A selection link contains IDs/settings/request range, not the imported dataset. Real job links also identify the completed job and depend on backend retention/access. A loopback link works only on the same computer.

Read the [draft frontend contract](docs/FRONTEND_CONTRACT.md), [method and limits](docs/METHOD.md), [credits](docs/CREDITS.md) and [verification record](docs/FRONTEND_VERIFICATION.md). The data producer must review the contract before real-data integration. Next.js runtime hosting versus static export is still an integration decision; this task does not select a hosting provider.

Start with [AGENTS.md](AGENTS.md) and [HANDOFF.md](HANDOFF.md). All team-authored product and submission materials must be in English.

## Collaboration

One repository holds the frontend, backend/data scripts, tests and product documentation. Frontend direction: Next.js + Tailwind CSS, reported by Sơn from Chung. Chung's separate backend/server work is user-reported; its source, API contract, deployment and access have not been verified. Do not guess an endpoint or copy private credentials into this repository.

This repository is public. Anyone may fork it and propose changes through a pull request. Named collaborators need to accept their invitations before direct push access works. Use one editor per checkout; independent reviewers read without writing. Frontend files live under `frontend/`, the proposed shared contract under `contracts/`; backend/data implementation remains with its assigned owner. Edit and agree the OpenAPI before real integration, regenerate types and run the checks. The draft's arbitrary endpoints and limits must not be presented as Chung's existing API.

## Event boundary

Implementation started after 14 November 2026 at 00:00 Hanoi time (UTC+07:00), based on the organizer reply supplied and reaffirmed by Sơn. Local submission is due 15 November at 11:00 Hanoi; the separate global cutoff is 23:59. Running this frontend does not submit the project.

Reviewed preparation source: [exact checkpoint](https://github.com/justsomenewbie/space-apps-2026-preparation/tree/5abda55a6d83bf89d6dd762fa6ceddfc3d265920). Preparation history is context, not proof of scientific validity, team acceptance or award eligibility.

## Status and credits

Codex assisted repository setup, frontend code, validation/tests, synthetic test fixtures and documentation. Built-in Image Gen produced an internal UI design reference; its raster output is not an app asset. The proposal also has prior AI-assisted history; preserve and disclose it truthfully. The current guide's restriction on SI supplying the solution idea remains unresolved for that history. No eligibility declaration has been made.

Product licensing must be selected and checked against submission terms and third-party compatibility before release; public visibility alone is not a reuse licence. Dependency permissions and actual AI contributions are recorded in [credits](docs/CREDITS.md). No NASA imagery, lunar terrain asset, external font or music is included.
