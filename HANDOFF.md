# Current handoff — 14 November 2026

**Local frontend implemented and checked; synthetic data only.** Real backend agreement/data, deployment and submission remain outstanding. Repository: https://github.com/justsomenewbie/moon-plan-b · owner `justsomenewbie` · base `main` · branch `codex/frontend-kickoff` in `/Users/nns/Documents/ChatGPT/moon-plan-b`.

## Current decisions

Chung’s mandatory rules were read through Google Drive. Sơn confirmed no agreed OpenAPI exists, authorized a clearly marked draft, and reconfirmed during this task that API/data is not yet available. `contracts/openapi.draft.json` remains a proposal. Use generated types, centralized calls, TanStack Query, MSW, same-origin rewrites, UTC/degrees/hours, bounded requests, problem responses, job states and Swagger. See [contract](docs/FRONTEND_CONTRACT.md) and AGENTS. Do not relabel synthetic values as lunar measurements.

Site/date comparisons, tracks, visibility bands, horizon, playback, missing-data states, import, sources, share/print and job progress work locally. `NEXT_PUBLIC_API_BASE_URL=mock` is the default; a backend origin requires rebuild. No automatic synthetic fallback. Real job links depend on retained backend jobs. English caveats and AI attribution remain present.

## Checks and evidence

See [verification](docs/FRONTEND_VERIFICATION.md). **22 tests and final production build/TypeScript pass**; source review and test rerun were independent. The latest fix restores shared comparisons on Back/Forward, validates restored URLs, preserves available imported releases and ignores late results. Anchor navigation preserves the sample; pending reloads do not steal history focus. Ten in-app regression groups passed, including differing date ranges and malformed/missing-release recovery. A bare URL restores defaults. Existing request-input/retry/job-bound checks remain documented.

Four further controlled browser checks passed: terminal job failure, exhausted status retries, same-job recovery with original range/newer draft preserved, and rejected POST without automatic retry. Two 20,000-row imports completed; 160,329 active elements remain a performance limit. Independent source/evidence review supported retaining current code. This follow-up changes verification notes only; no new test/build claim.

Bounded independent security review found no supported findings in this history patch. Earlier formal scan `6aa27bb4-5b30-4ffc-aa79-83fc0d94161a` covers the preceding request patch only. The current redacted diff secret check passed. No contract, dependency, production fixture or configuration changed.

Native Safari on `76fd327` passed modes, share reopening, empty-range recovery and four A4 thumbnails. Import, exact breakpoint and owned-window closure remain unresolved after automation timeouts. Existing user tabs were not edited; no new Safari check occurred. In-app checks do not establish Safari or spoken assistive-technology behavior. Initial large-report DOM/device performance and four dependency-notice gaps remain documented limits.

Evidence: `/Users/nns/Documents/ChatGPT/nasa-preparation-deliverables/frontend-kickoff-2026-11-14/`, including `history-verification.json`, `initial-load-check.json` and `job-fault-check.json` with screenshots; unavailable elsewhere unless supplied. Private logs and generated design raster are excluded. Preparation checkpoint remains `5abda55a6d83bf89d6dd762fa6ceddfc3d265920`.

## Ownership and publication

Root completed the history fix with independent functional/security review. Code/documentation commit `16abe63a18c3d8336f60071a9a5385cbc6d5553c` is published on the authorized review branch; remote SHA and all three changed-file blob hashes match local Git. Previous verified review head: `65c1dce8ec552294b63b484b3e08a904e2748374`; this update adds acceptance notes. `main` remains `d7e9d6246a115257acbd3acf65200c9006d4ad4e`. No merge/deployment/submission. Product cloud checkout/SHA is unestablished. Preparation files unchanged; no preparation sync required. Ownership released; inspect Git before editing.

Next action under two minutes: check development-runtime startup and shared-link restoration under StrictMode replay. Production history is already checked. Integrate real data only after Chung supplies an agreed contract/example.
