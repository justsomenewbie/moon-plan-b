# Current handoff — 14 November 2026

**Local frontend implemented and checked; synthetic data only.** Real backend agreement/data, deployment and submission remain outstanding. Repository: https://github.com/justsomenewbie/moon-plan-b · owner `justsomenewbie` · base `main` · local branch `codex/frontend-kickoff` in `/Users/nns/Documents/ChatGPT/moon-plan-b`.

## Current decisions

Chung's mandatory frontend rules were read through Google Drive. Sơn confirmed no agreed OpenAPI exists and authorized a clearly marked draft. `contracts/openapi.draft.json` is that proposal, not Chung's actual API. Use generated types, centralized calls, TanStack Query, MSW, same-origin Next rewrites, UTC/degrees/hours, problem responses, bounded requests, job states and Swagger. See [contract](docs/FRONTEND_CONTRACT.md) and AGENTS. Do not silently change interfaces or relabel synthetic values as lunar measurements.

The frontend has site/date comparisons, tracks, supplied visibility bands and horizon, common-sample playback, missing-data states, import, sources, share/print, bounded API requests and job progress. `NEXT_PUBLIC_API_BASE_URL=mock` is the default; set a backend origin and rebuild to proxy live requests. No automatic synthetic fallback. Real job links require retained backend jobs. English product material, scientific caveats and AI attribution are present.

## Checks and evidence

See [verification](docs/FRONTEND_VERIFICATION.md). **22 tests and production build/TypeScript pass**, with independent code review and test rerun. GET and job submission share editable UTC inputs; jobs/share links retain accepted request identities. Retry preserves the failed range/job; completed jobs outside that range are rejected. Twelve synthetic in-app checks cover these transitions, preserved focused edits, precise timestamps and 320px controls. Codex Security scan `6aa27bb4-5b30-4ffc-aa79-83fc0d94161a` reviewed the four-file patch: zero findings, sealed report read back. This is not a rescan of unchanged API code. Contract, dependencies, production fixture and configuration are unchanged.

Native Safari on `76fd327` passed mode switching, share reopening, empty-range recovery and four-page A4 thumbnail inspection. Import, exact responsive breakpoint and window closure remain unresolved after automation timeouts. Existing user tabs were not edited. In-app checks do not establish Safari or assistive-technology behavior.

Earlier accepted-size check: memoization reduced median renderer JavaScript per step from 75.200 to 24.367 ms in five local CDP samples. The 20,000-row synthetic PDF retained every timestamp/angle across 873 pages, with seven visually sampled. Initial DOM remains large; native large-report printing and device performance are unverified.

Upstream notices supplement six package entries; four gaps and full target-platform binary notice coverage remain unresolved. See [credits](docs/CREDITS.md#notice-recovery-check--14-november-2026). Original notice bytes were independently verified as preserved.

Raw evidence: `/Users/nns/Documents/ChatGPT/nasa-preparation-deliverables/frontend-kickoff-2026-11-14/`; not automatically available elsewhere. Private chat evidence and generated design raster are excluded. Prepared source remains [5abda55a6d83bf89d6dd762fa6ceddfc3d265920](https://github.com/justsomenewbie/space-apps-2026-preparation/tree/5abda55a6d83bf89d6dd762fa6ceddfc3d265920).

## Ownership and publication

Root Codex completed request-state fixes with independent functional/security review. Commit `27eec7f96e28e551fff1cd217f5dfd1186356835` is published on the authorized review branch; its remote SHA and all six changed-file blob hashes read back through GitHub match local Git. This handoff records publication. `main` remains `d7e9d6246a115257acbd3acf65200c9006d4ad4e`. No merge/deployment/submission. Product cloud checkout/SHA is unestablished. Preparation files were unchanged; no preparation sync is required. Ownership released; inspect Git before editing.

Next action under two minutes: reproduce browser Back/Forward restoration after sharing and in-page navigation. Source review raised a possible stale-selection case; browser confirmation is pending.
