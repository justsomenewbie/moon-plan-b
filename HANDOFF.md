# Current handoff — 14 November 2026

## Combined frontend and QA

Wi-Fi mock jobs work. [UI-02](qa/docs/UI_RESILIENCE.md#ui-02-import-retest) verified nine rejections and 5 MiB recovery. [Chromium](qa/check_pinned_retry.mjs) verified rejected imports preserve pinned retries and selections.

Minh added offline QA, supplied overlap bands, the polar plot, a scenario inspector and horizon clearance controls. [UI-04 and UI-05](qa/docs/UI_RESILIENCE.md#ui-04-and-ui-05-plot-retest) passed missing data, 0° and north crossings. The [clearance replay](qa/docs/UI_RESILIENCE.md#horizon-clearance-and-direction-diagram) verifies threshold crossings, gaps and the flat-ground shadow display. QA monitors Minh’s GitHub submissions.

English defaults with optional Vietnamese. Compare dates at one site or sites within one UTC window. [UI-07](qa/docs/UI_RESILIENCE.md#ui-07-browser-retest) passed texture, decoding and Canvas failures with comparison-preserving retry. Native Safari checks covered JSON import, both languages, 320px width and window closure. Chromium checked four saved comparisons. [Frontend verification](docs/FRONTEND_VERIFICATION.md).

The JPL [single-site](qa/evidence/odysseus-hour-gap/README.md) and [paired](qa/evidence/odysseus-athena-hour-gap/README.md) replays check retained source values. Removing Athena’s 02:00 UTC row breaks only its two paths. Odysseus keeps five markers per body. [Synthetic tests](frontend/tests/observations.test.ts) distinguish 0° from missing. Previous integration checks cover TypeScript, both production builds, EN/VI and 320px layout.

## Backend integration

Checked at 15:21 Hanoi. The bare aggregate still reports a point limit as a date-range error. Both November weeks matched per-site endpoints across 672 site-hours (33/139 then 168/168 overlap hours). Shared live chart links restore the site and UTC. A pinned link opens two equal-duration requests at one site. The comparison rejects requests that evaluate to the same model window. At Athena, 1–4 and 18–21 December returned 0 and 72 joint hours. Custom jobs verify the submitted or hourly-rounded UTC range, preserve unknown progress and reopen a pinned run. One real job returned 202 with three matching samples. 73 tests passed. Chromium and Safari verified the producer’s 24/72/168-hour assessments, including a 24-hour borderline case. Summary-only imports and offline comparisons work. [Partial coverage](qa/check_terrain_criteria_coverage.mjs) preserves observed successes and leaves unmet duration thresholds unknown. Science owns physical validation and the data team owns Colab. [Reproduction](docs/BACKEND_RECONCILIATION.md#aggregate-update-on-14-november).

## Open items and ownership

Member feedback owner: IDEA chat. [Status by item](docs/FRONTEND_VERIFICATION.md#member-feedback-status-14-november-2026) records prior fixes, new changes and outstanding inputs. The bilingual guide reports the latest covered model sample when opened and the selected saved comparison. Visitors can inspect two globe pins, zoom 1–4× and select either site's Sun or Earth direction in the sky plot. Four 1280-pixel cloud photographs drift in both themes. Night uses a responsive NASA map up to 4K, four fixed twinkling stars and two alternating meteor paths. Sky motion respects pause and reduced motion. Footer links to feedback. Sponsor links, terrain close-ups, signal strength and live measurements still need evidence. Share uses the native button. The [browser trace](qa/docs/UI_RESILIENCE.md#chromium-live-api-replay-14-november-2026) recorded zero direct JPL requests. Release licensing, science sign-off, three usability sessions and spoken screen-reader testing remain open. See the [freeze checklist](qa/docs/RUNBOOK.md).

Saved-result links print the selected UTC intervals and source. Chromium verified seven English/Vietnamese PDFs and workspace overrides. On `268e812`, [both site orders](qa/evidence/odysseus-athena-hour-gap/result.json) skipped Athena’s gap (01:00 → 03:00 → 01:00 UTC). Chromium also verified [leap day, midnight and both New York clock changes](qa/LOCAL_WEB_DEEP_TEST_REPORT.md#utc-boundary-retest).
