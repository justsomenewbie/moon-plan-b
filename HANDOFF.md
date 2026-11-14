# Current handoff — 14 November 2026

## Combined frontend and QA

Chromium completed a synthetic job over plain HTTP and opened its results with the Wi-Fi compatibility fix.

Minh’s `8b53003` added offline QA, supplied overlap bands, a polar skyplot and the `?qa=true` scenario inspector. [Minh’s QA report](qa/LOCAL_WEB_DEEP_TEST_REPORT.md) and [frontend verification](docs/FRONTEND_VERIFICATION.md) distinguish synthetic tests from release evidence.

English defaults with optional Vietnamese, lunar resources and local-time appearance. Compare dates at one site or sites within one UTC window. The timeline and local 3D sky follow the supplied samples. The NASA reference globe and photograph retain [credits](docs/CREDITS.md); the globe locates sites and does not calculate terrain or visibility. A failed texture keeps the photograph and Retry restores the globe. Earlier isolated native Safari checks covered JSON import, both languages, 320px width and window closure.

The combined revision passed 49 frontend tests, eight offline QA gates, TypeScript and the production build. Chromium verified all four saved comparisons, EN/VI and 320px layout. [Verification](docs/FRONTEND_VERIFICATION.md).

The [synthetic regression](frontend/tests/observations.test.ts) preserves genuine 0° markers. Chromium verified the [single-site gap](qa/evidence/odysseus-hour-gap/README.md) and [two-site comparison](qa/evidence/odysseus-athena-hour-gap/README.md) against JPL Horizons. Removing only Athena’s 02:00 UTC row split its Sun and Earth paths between 01:00 and 03:00. Odysseus kept five markers per body and both paths matched the complete control. The shared slider skipped 02:00.

## Backend integration

At 14:05 Hanoi, Chung’s producer aggregate returned HTTP 200 for Odysseus and Athena. The bare URL returned the documented 422 size limit. FE matched both weeks to the separate site endpoints across 672 site-hours. November 14–21 returned 33/139 overlap hours and November 21–28 returned 168/168. Live custom coordinates use the backend job API, preserve unknown progress, and open a single-site result pinned to the returned run. One bounded live job returned 202, succeeded and reopened with three matching UTC samples. The live catalog workspace requests terrain-model intervals for a bounded UTC range; the importer also accepts aggregate exports with windows and metrics. The offline saved comparisons remain available. The science team owns physical validation, the data team owns Colab. [Reproduction](docs/BACKEND_RECONCILIATION.md#aggregate-update-on-14-november).

## Open items and ownership

The member suggestions chat owns IDEA. The bilingual guide reads the selected saved week or site. Visitors can inspect two globe pins, zoom 1–4× and select either site's Sun or Earth direction in the sky plot. Both themes have slow, pausable cloud motifs in a fixed sky. Night adds the credited NASA star map. The footer links to project feedback. Sponsor links, terrain close-ups, signal strength and live status still need evidence. Share uses the native button. Release licensing, science sign-off, the network trace, three usability sessions and spoken screen-reader testing remain open. See the [freeze checklist](qa/docs/RUNBOOK.md).

Saved-result links print the selected UTC intervals and source. Chromium verified seven English/Vietnamese PDFs and workspace overrides. On live-API build `268e812`, frontend QA verified the imported Athena gap with each site as primary. Right Arrow then Left Arrow moved both visible and accessible UTC labels from 01:00 to 03:00 and back to 01:00. Open the [keyboard readouts](qa/evidence/odysseus-athena-hour-gap/result.json).
