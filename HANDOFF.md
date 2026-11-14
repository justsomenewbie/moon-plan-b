# Current handoff — 14 November 2026

## Combined frontend and QA

Minh’s `8b53003` added offline QA, supplied overlap bands, a polar skyplot and the `?qa=true` scenario inspector. [Minh’s QA report](qa/LOCAL_WEB_DEEP_TEST_REPORT.md) and [frontend verification](docs/FRONTEND_VERIFICATION.md) distinguish synthetic tests from release evidence.

English defaults with optional Vietnamese, lunar resources and local-time appearance. Compare dates at one site or sites within one UTC window. The timeline and local 3D sky follow the supplied samples. The NASA reference globe and photograph retain [credits](docs/CREDITS.md); the globe locates sites and does not calculate terrain or visibility. A failed texture keeps the photograph and Retry restores the globe. Earlier isolated native Safari checks covered JSON import, both languages, 320px width and window closure.

The combined revision passed 39 frontend tests, eight offline QA gates, TypeScript and the production build. Chromium verified all four saved comparisons, EN/VI and 320px layout. [Verification](docs/FRONTEND_VERIFICATION.md).

The [synthetic regression](frontend/tests/observations.test.ts) preserves genuine 0° markers. Chromium verified the [single-site gap](qa/evidence/odysseus-hour-gap/README.md) and [two-site comparison](qa/evidence/odysseus-athena-hour-gap/README.md) against JPL Horizons. Removing only Athena’s 02:00 UTC row split its Sun and Earth paths between 01:00 and 03:00. Odysseus kept five markers per body and both paths matched the complete control. The shared slider skipped 02:00.

## Backend integration

Chung’s OpenAPI 1.0.0 documents real per-site responses. The planned aggregate `GET /api/v1/dataset` was absent at 13:25 Hanoi and returned 404 directly and through the frontend. FE checked all 672 site-hours for two consecutive UTC weeks. Pick either week to compare sites, or either site to compare weeks. November 14–20 had 33/139 hours of overlap at Odysseus/Athena; November 21–27 had 168/168. The interface shows interval boundaries, durations and sources in English and Vietnamese. Direct links reopen the selected saved result independently of the interactive workspace. The science team owns physical validation. [Backend status and reproduction](docs/BACKEND_RECONCILIATION.md). Next input for FE: a versioned aggregate schema and one bounded sample. The data team owns Colab execution and testing.

## Open items and ownership

Recheck the member’s living IDEA document at each frontend integration. The corner astronaut, suggested questions and data-backed answers remain proposals. Globe zoom and the new multi-site marker suggestion are queued for review. Terrain close-ups and overlays need appropriate source data; Earth visibility alone does not establish radio strength. Contact and sponsor details need confirmation. Share now uses a native button and reduced-motion-aware CSS. The five unused packages were removed from the product; the local Animate UI skill and historical notices remain. Release licensing, science sign-off, the network trace, three usability sessions and spoken screen-reader testing remain open. See the [freeze checklist](qa/docs/RUNBOOK.md).

Root integrated native Share and saved-result links above verified main `6505d9b`. Frontend QA used the updated main `a76e42cc5f70c5bd1c4631b4e348a9f4735b0d91` for the final comparison. Open the two-site gap screenshot to inspect Athena beside Odysseus at 02:00 UTC.
