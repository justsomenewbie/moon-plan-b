# Current handoff — 14 November 2026

**Local frontend implemented and checked; synthetic data only.** Real backend agreement/data, deployment and submission remain outstanding. Repository: https://github.com/justsomenewbie/moon-plan-b · owner `justsomenewbie` · base `main` · local branch `codex/frontend-kickoff` in `/Users/nns/Documents/ChatGPT/moon-plan-b`.

## Current decisions

Chung's mandatory frontend rules were read through Google Drive. Sơn confirmed no agreed OpenAPI exists and authorized a clearly marked draft. `contracts/openapi.draft.json` is that proposal, not Chung's actual API. Use generated types, centralized calls, TanStack Query, MSW, same-origin Next rewrites, UTC/degrees/hours, problem responses, bounded requests, job states and Swagger. See [contract](docs/FRONTEND_CONTRACT.md) and AGENTS. Do not silently change interfaces or relabel synthetic values as lunar measurements.

The frontend has site/date comparisons, tracks, supplied visibility bands and horizon, common-sample playback, missing-data states, import, sources, share/print, bounded API requests and job progress. `NEXT_PUBLIC_API_BASE_URL=mock` is the default; set a backend origin and rebuild to proxy live requests. No automatic synthetic fallback. Real job links require retained backend jobs. English product material, scientific caveats and AI attribution are present.

## Checks and evidence

Clean install, generated types and previous Chromium/API/deadline/proxy/advisory checks are recorded in [verification](docs/FRONTEND_VERIFICATION.md). The local follow-up fixes sky tracks bridging missing time spans; **18 unit/API groups and production build/TypeScript pass**. An independent reviewer reran 16 dataset tests. CUA in-app import/render checks confirm both path breaks, clear captured logs and single-column controls without overflow at 320 CSS pixels. No contract/dependency/production-fixture changes. The formal security scan remains the earlier pre-API snapshot; its low interval-complexity issue was fixed.

Native Safari follow-up on published `76fd327` passed mode switching, share reopening, empty-range recovery and four-page A4 thumbnail inspection. Import stayed disabled; exact responsive breakpoint and window closure remain unverified after native automation timeouts. Existing user tabs were not edited. In-app browser evidence is not a Safari pass. Real science/backend/devices remain unverified.

Accepted-size check: a 2.49 MB synthetic import with 20,000 samples exposed repeated table/marker work. Memoization preserves all values; median renderer JavaScript per slider step measured 75.200 → 24.367 ms in five local CDP samples. Replacement/mode checks, 18 tests and build pass. Full in-app PDF export produced 873 A4 pages (43.4 MB); all 20,000 timestamp/angle rows match, seven pages visually sampled. Native large-report printing and device performance remain unverified; initial DOM remains large.

Raw evidence: `/Users/nns/Documents/ChatGPT/nasa-preparation-deliverables/frontend-kickoff-2026-11-14/`; not automatically available elsewhere. Private chat evidence and generated design raster are excluded. Prepared source remains [5abda55a6d83bf89d6dd762fa6ceddfc3d265920](https://github.com/justsomenewbie/space-apps-2026-preparation/tree/5abda55a6d83bf89d6dd762fa6ceddfc3d265920).

## Ownership and publication

Root Codex and read-only reviewer finished the rendering follow-ups. Sky-gap commit `7590bc9` and memoization commit `c9cd7ac287ca0d968751c0e70090500f5505297a` were published to the existing authorized review branch. Its remote ref was verified; both corrected source-file blob hashes read back through GitHub match local Git. This handoff records that publication. `main` remains `d7e9d6246a115257acbd3acf65200c9006d4ad4e`. No merge/deployment/submission. Product cloud checkout/SHA is unestablished. Preparation files were not changed; no preparation sync is required. Inspect Git before taking ownership.

Next action under two minutes: review the draft endpoint/schema table with Chung and request his agreed OpenAPI plus a small sourced Colab export. Do not publish or integrate it as an agreed contract before that review.
