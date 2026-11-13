# Current handoff — 14 November 2026

**Local frontend implemented and checked; synthetic data only.** Real backend agreement/data, deployment and submission remain outstanding. Repository: https://github.com/justsomenewbie/moon-plan-b · owner `justsomenewbie` · base `main` · local branch `codex/frontend-kickoff` in `/Users/nns/Documents/ChatGPT/moon-plan-b`.

## Current decisions

Chung's mandatory frontend rules were read through Google Drive. Sơn confirmed no agreed OpenAPI exists and authorized a clearly marked draft. `contracts/openapi.draft.json` is that proposal, not Chung's actual API. Use generated types, centralized calls, TanStack Query, MSW, same-origin Next rewrites, UTC/degrees/hours, problem responses, bounded requests, job states and Swagger. See [contract](docs/FRONTEND_CONTRACT.md) and AGENTS. Do not silently change interfaces or relabel synthetic values as lunar measurements.

The frontend has site/date comparisons, tracks, supplied visibility bands and horizon, common-sample playback, missing-data states, import, sources, share/print, bounded API requests and job progress. `NEXT_PUBLIC_API_BASE_URL=mock` is the default; set a backend origin and rebuild to proxy live requests. No automatic synthetic fallback. Real job links require retained backend jobs. English product material, scientific caveats and AI attribution are present.

## Checks and evidence

Clean install with lifecycle scripts disabled, 17 unit/API test groups, generated types, TypeScript and production build pass. Chromium checks cover both modes, share/import/recovery/jobs/docs, 320–1488px layouts and console health. All four printed A4 pages inspected. Actual HTTP deadline/cancellation checks and a local backend-substitute proxy/job-link test pass. npm audit and OSV report no known findings. The formal pre-migration security scan found one low interval-complexity issue; linear fix is regression-tested. Independent API review's three issues were fixed and rechecked; this is not a new formal scan. Safari remains partial; real science/backend/devices unverified. See [verification](docs/FRONTEND_VERIFICATION.md).

Raw evidence: `/Users/nns/Documents/ChatGPT/nasa-preparation-deliverables/frontend-kickoff-2026-11-14/`; it is not automatically available elsewhere. Product source, notices and documentation are the intended local change set. No private chat evidence or generated design raster is included. Prepared source remains [5abda55a6d83bf89d6dd762fa6ceddfc3d265920](https://github.com/justsomenewbie/space-apps-2026-preparation/tree/5abda55a6d83bf89d6dd762fa6ceddfc3d265920).

## Ownership and publication

Root Codex completed editing; independent reviewers finished. Inspect Git before taking ownership. Sơn authorized publishing the review branch. Implementation commit `b9f2ead54cacb118f29bf064871a86c53a2243f2` was pushed to `codex/frontend-kickoff` and verified against the remote ref; the contract blob was read back through GitHub and matched. This follow-up handoff records that publication. `main` remains `d7e9d6246a115257acbd3acf65200c9006d4ad4e`; no merge/deployment/submission occurred. Product cloud checkout/SHA is unestablished. Preparation files were not changed; no preparation sync is required for this product-only task.

Next action under two minutes: review the draft endpoint/schema table with Chung and request his agreed OpenAPI plus a small sourced Colab export. Do not publish or integrate it as an agreed contract before that review.
