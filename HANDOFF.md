# Current handoff — 14 November 2026

## Combined frontend and QA

Wi-Fi mock jobs work. [UI-02](qa/docs/UI_RESILIENCE.md#ui-02-import-retest) verified nine rejections and 5 MiB recovery. [Chromium](qa/check_pinned_retry.mjs) verified rejected imports preserve pinned retries and selections.

Minh added offline QA, supplied overlap bands, the polar plot, a scenario inspector and horizon clearance controls. [UI-04 and UI-05](qa/docs/UI_RESILIENCE.md#ui-04-and-ui-05-plot-retest) passed missing data, 0° and north crossings. The [clearance replay](qa/docs/UI_RESILIENCE.md#horizon-clearance-and-direction-diagram) verifies threshold crossings, gaps and the flat-ground shadow display. QA monitors Minh’s GitHub submissions.

English defaults with optional Vietnamese. Compare dates at one site or sites within one UTC window. [UI-07](qa/docs/UI_RESILIENCE.md#ui-07-browser-retest) passed texture, decoding and Canvas failures with comparison-preserving retry. Native Safari checks covered JSON import, both languages, 320px width and window closure. Chromium checked four saved comparisons. [Frontend verification](docs/FRONTEND_VERIFICATION.md).

The JPL [single-site](qa/evidence/odysseus-hour-gap/README.md) and [paired](qa/evidence/odysseus-athena-hour-gap/README.md) replays check missing samples against retained source values. Removing Athena’s 02:00 UTC row broke only its two paths. Odysseus kept five markers per body. The latest clearance build passed 67 frontend tests and eight offline QA gates.

## Backend integration

At 14:46 Hanoi the bounded aggregate returned 200. The bare URL returned 422 for its point limit with a misleading range title. Both weeks matched per-site endpoints across 672 site-hours. November 14–21 returned 33/139 overlap hours and November 21–28 returned 168/168. Custom jobs preserve unknown progress, verify the submitted or hourly-rounded UTC interval, and open the single-site result pinned to its run. One live job returned 202 and reopened with three matching UTC samples. The live chart shows the supplied horizon, per-site UTC positions, model flags and three full interval bands. Shared chart links restore the site and exact UTC after reload. Summary-only imports and offline comparisons work. The science team owns physical validation, the data team owns Colab. [Reproduction](docs/BACKEND_RECONCILIATION.md#aggregate-update-on-14-november).

## Open items and ownership

Member feedback owner: IDEA chat. [Status by item](docs/FRONTEND_VERIFICATION.md#member-feedback-status-14-november-2026) records prior fixes, new changes and outstanding inputs. The bilingual guide reports the latest covered model sample when opened and the selected saved comparison. Visitors can inspect two globe pins, zoom 1–4× and select either site's Sun or Earth direction in the sky plot. Clouds drift visibly in both themes. Night uses a responsive NASA map up to 4K, four fixed twinkling stars and an occasional meteor. Sky motion respects pause and reduced motion. Footer links to feedback. Sponsor links, terrain close-ups, signal strength and live measurements still need evidence. Share uses the native button. The [browser trace](qa/docs/UI_RESILIENCE.md#chromium-live-api-replay-14-november-2026) recorded zero direct JPL requests. Release licensing, science sign-off, three usability sessions and spoken screen-reader testing remain open. See the [freeze checklist](qa/docs/RUNBOOK.md).

Saved-result links print the selected UTC intervals and source. Chromium verified seven English/Vietnamese PDFs and workspace overrides. On `268e812`, [both site orders](qa/evidence/odysseus-athena-hour-gap/result.json) skipped Athena’s gap (01:00 → 03:00 → 01:00 UTC). Chromium also verified [leap day, midnight and both New York clock changes](qa/LOCAL_WEB_DEEP_TEST_REPORT.md#utc-boundary-retest).
