# Current handoff — 14 November 2026

## Combined frontend and QA

Synthetic jobs work over Wi-Fi HTTP. [UI-02](qa/docs/UI_RESILIENCE.md#ui-02-import-retest) verified nine rejected imports, comparison retention and recovery at exactly 5 MiB.

Minh’s `8b53003` added offline QA, supplied overlap bands, a polar skyplot and the `?qa=true` scenario inspector. [Minh’s QA report](qa/LOCAL_WEB_DEEP_TEST_REPORT.md) and [frontend verification](docs/FRONTEND_VERIFICATION.md) distinguish synthetic tests from release evidence.

English defaults with optional Vietnamese, lunar resources and local-time appearance. Compare dates at one site or sites within one UTC window. The timeline and local 3D sky follow the supplied samples. The NASA reference globe and photograph retain [credits](docs/CREDITS.md); the globe locates sites and does not calculate terrain or visibility. [UI-07](qa/docs/UI_RESILIENCE.md#ui-07-browser-retest) passed texture, decoding and Canvas failures with comparison-preserving retry. Earlier isolated native Safari checks covered JSON import, both languages, 320px width and window closure.

The combined revision passed 58 frontend tests, eight offline QA gates, TypeScript and both production builds. Chromium verified all four saved comparisons, EN/VI and 320px layout. [Verification](docs/FRONTEND_VERIFICATION.md).

The [synthetic regression](frontend/tests/observations.test.ts) preserves 0° markers. Chromium checked the JPL [single-site](qa/evidence/odysseus-hour-gap/README.md) and [two-site](qa/evidence/odysseus-athena-hour-gap/README.md) gap cases. Removing Athena’s 02:00 UTC row broke both paths and skipped that hour on the shared slider. Odysseus retained five original markers per body.

## Backend integration

At 14:46 Hanoi the bounded aggregate returned 200. The bare URL returned 422 for its point limit with a misleading range title. Both weeks matched per-site endpoints across 672 site-hours. November 14–21 returned 33/139 overlap hours and November 21–28 returned 168/168. Custom jobs preserve unknown progress, verify the submitted or hourly-rounded UTC interval, and open the single-site result pinned to its run. One live job returned 202 and reopened with three matching UTC samples. The live chart shows the supplied horizon, per-site UTC positions, model flags and three full interval bands. Shared chart links restore the site and exact UTC after reload. Summary-only imports and offline comparisons work. The science team owns physical validation, the data team owns Colab. [Reproduction](docs/BACKEND_RECONCILIATION.md#aggregate-update-on-14-november).

## Open items and ownership

The member suggestions chat owns IDEA. [Status by item](docs/FRONTEND_VERIFICATION.md#member-feedback-status-14-november-2026) records prior fixes, new changes and outstanding inputs. The bilingual guide reports the latest covered model sample when opened and the selected saved comparison. Visitors can inspect two globe pins, zoom 1–4× and select either site's Sun or Earth direction in the sky plot. Both themes have slow, pausable cloud motifs in a fixed sky. Night adds the credited NASA star map. The footer links to project feedback. Sponsor links, terrain close-ups, signal strength and live measurements still need evidence. Share uses the native button. The [browser trace](qa/docs/UI_RESILIENCE.md#chromium-live-api-replay-14-november-2026) recorded zero direct JPL requests. Release licensing, science sign-off, three usability sessions and spoken screen-reader testing remain open. See the [freeze checklist](qa/docs/RUNBOOK.md).

Saved-result links print the selected UTC intervals and source. Chromium verified seven English/Vietnamese PDFs and workspace overrides. On `268e812`, [both site orders](qa/evidence/odysseus-athena-hour-gap/result.json) skipped Athena’s gap (01:00 → 03:00 → 01:00 UTC). Chromium also verified [leap day, midnight and both New York clock changes](qa/LOCAL_WEB_DEEP_TEST_REPORT.md#utc-boundary-retest).
