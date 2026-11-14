# Current handoff — 14 November 2026

## Combined frontend and QA

The frontend changes build on GitHub main `8b53003`, including Minh’s offline QA suite, producer-supplied Golden-window bands, accessible polar skyplot and optional `?qa=true` inspector. The inspector selects complete, partial and missing scenarios. [Minh’s QA report](qa/LOCAL_WEB_DEEP_TEST_REPORT.md) and [frontend verification](docs/FRONTEND_VERIFICATION.md) distinguish synthetic tests from release evidence.

The home page explains the comparison, links to the tool and lunar resources, and offers EN/VI and manual or local-time appearance. English is the default. Compare dates at one site or sites within one UTC window. The timeline and local 3D sky follow the supplied samples. The NASA reference globe and photograph retain [credits](docs/CREDITS.md); the globe locates sites and does not calculate terrain or visibility. A failed texture keeps the photograph and Retry restores the globe. Earlier isolated native Safari checks covered JSON import, both languages, 320px width and window closure.

The combined revision passed 38 frontend tests, all eight offline QA gates, TypeScript and live/mock production builds. Chromium exercised both the inspector and new home controls, the globe fallback/Retry, and recovery from the live aggregate 404. See [verification](docs/FRONTEND_VERIFICATION.md).

The [timeline regression](frontend/tests/observations.test.ts) uses the hourly partial QA fixture. Both Basin traces break at the omitted 02:00 UTC row and show no marker there. Ridge retains its supplied 0° Sun marker at 01:00 and its Earth marker when Sun is unavailable at 02:00. All 39 frontend tests, 12 QA integration tests and TypeScript passed on Node 24.22.3.

## Backend integration

Chung’s OpenAPI 1.0.0 documents real per-site responses. The planned aggregate `GET /api/v1/dataset` was absent at 13:01 Hanoi and returned 404 directly and through the frontend. The seven-day Odysseus/Athena check matched all 168 hourly joint flags per site against the returned intervals. The frontend now shows those saved model results in English and Vietnamese, with UTC intervals for both sites, a common time scale and reproducible source queries. The saved week stays accessible while loading, importing or recovering from the API. Site choice was for validation. Independent physical verification remains with the science team. [Backend status and reproduction](docs/BACKEND_RECONCILIATION.md). Next input for FE: a versioned aggregate schema and one bounded sample. The data team owns Colab execution and testing.

## Open items and ownership

Recheck the member’s living IDEA document at each frontend integration. The corner astronaut, suggested questions and data-backed answers remain proposals. Globe zoom and the new multi-site marker suggestion are queued for review. Terrain close-ups and overlays need appropriate source data; Earth visibility alone does not establish radio strength. Contact and sponsor details need confirmation. Animate UI’s submission-license decision stays open; its Share control is retained. Release licensing, science sign-off, the network trace, three usability sessions and spoken screen-reader testing remain open. See the [freeze checklist](qa/docs/RUNBOOK.md).

The timeline test was prepared on `codex/horizons-hour-gap` from verified GitHub main `d1689f70ad7ad5b80471952fe9da644e18c3a084`. Frontend QA owns the test. To repeat the visual check, import `qa/fixtures/partial.json` and inspect 02:00 UTC in the site comparison.
