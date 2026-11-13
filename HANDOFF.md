# Current handoff — 14 November 2026

**Local frontend implemented and checked; synthetic data only.** Real backend agreement/data, deployment and submission remain outstanding. Repository: https://github.com/justsomenewbie/moon-plan-b · owner `justsomenewbie` · base `main` · local branch `codex/frontend-kickoff` in `/Users/nns/Documents/ChatGPT/moon-plan-b`.

## Current decisions

Chung's mandatory frontend rules were read through Google Drive. Sơn confirmed no agreed OpenAPI exists and authorized a clearly marked draft. `contracts/openapi.draft.json` is that proposal, not Chung's actual API. Use generated types, centralized calls, TanStack Query, MSW, same-origin Next rewrites, UTC/degrees/hours, problem responses, bounded requests, job states and Swagger. See [contract](docs/FRONTEND_CONTRACT.md) and AGENTS. Do not silently change interfaces or relabel synthetic values as lunar measurements.

The frontend has site/date comparisons, tracks, supplied visibility bands and horizon, common-sample playback, missing-data states, import, sources, share/print, bounded API requests and job progress. `NEXT_PUBLIC_API_BASE_URL=mock` is the default; set a backend origin and rebuild to proxy live requests. No automatic synthetic fallback. Real job links require retained backend jobs. English product material, scientific caveats and AI attribution are present.

## Checks and evidence

See [verification](docs/FRONTEND_VERIFICATION.md) for detailed checks. **21 tests and production build/TypeScript pass**, with independent review. In-app checks cover API/import focus, repeated oversized-file rejection, retained data/selections, shared-release recovery, reduced motion and 320px layout. The exact-interval demo PDF retains all text in four reviewed pages. No contract, dependency or production-fixture changes. Native picker cancellation was not exercised. The formal security scan remains the earlier pre-API snapshot.

Native Safari on `76fd327` passed mode switching, share reopening, empty-range recovery and four-page A4 thumbnail inspection. Import, exact responsive breakpoint and window closure remain unresolved after automation timeouts. Existing user tabs were not edited. In-app checks do not establish Safari or assistive-technology behavior.

Earlier accepted-size check: memoization reduced median renderer JavaScript per step from 75.200 to 24.367 ms in five local CDP samples. The 20,000-row synthetic PDF retained every timestamp/angle across 873 pages, with seven visually sampled. Initial DOM remains large; native large-report printing and device performance are unverified.

Dependency notice review retained five pinned upstream license texts for six package entries; four gaps remain in [credits](docs/CREDITS.md#notice-recovery-check--14-november-2026). Original notice bytes are preserved, independently verified. This documentation-only update passed secret scanning; app/build checks were not repeated. Full target-platform binary notice coverage remains unresolved.

Raw evidence: `/Users/nns/Documents/ChatGPT/nasa-preparation-deliverables/frontend-kickoff-2026-11-14/`; not automatically available elsewhere. Private chat evidence and generated design raster are excluded. Prepared source remains [5abda55a6d83bf89d6dd762fa6ceddfc3d265920](https://github.com/justsomenewbie/space-apps-2026-preparation/tree/5abda55a6d83bf89d6dd762fa6ceddfc3d265920).

## Ownership and publication

Root Codex completed notice recovery with independent review. Documentation commit `13ee61556a71f3c1bbcb6d0bd7448e324adb61fa` is published on the authorized review branch; its remote SHA and all three changed-file blob hashes read back through GitHub match local Git. This handoff records publication. Frontend code remains `738e9b2c464ed07f441fa5d22811a387c156343c`; `main` remains `d7e9d6246a115257acbd3acf65200c9006d4ad4e`. No merge/deployment/submission. Product cloud checkout/SHA is unestablished. Preparation files were unchanged; no preparation sync is required. Ownership released; inspect Git before editing.

Next action under two minutes: review the draft endpoint/schema table with Chung and request his agreed OpenAPI plus a small sourced Colab export. Do not publish or integrate it as an agreed contract before that review.
