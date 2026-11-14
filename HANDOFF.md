# Current handoff — 15 November 2026

Planner maps open in 3D and switch to flat. Both show [start-date Sun direction](docs/GLOBE_SUNLIGHT.md#sun-direction-on-the-planner-maps); live catalogs also show mean sunlight. LROC links follow the close-up. The inspector links to site reports or hourly live observations. The home guide compares sites or weeks in three illustrated steps. [Public planner](https://moon-plan-b.vercel.app/plan). The [orbit presentation](qa/check_orbit.mjs) opens at `/orbit`. Live guide answers, saved site reports and date presets [preserve the live run](qa/check_planner_run_links.mjs) on return. The [guide](qa/check_astronaut_guide.mjs) retains the source for hourly readings and [site choices](qa/check_guide_imported_planning.mjs). See [planner](qa/check_planner_map.mjs) and [home](qa/check_home_navigation.mjs).

## Live comparison

The comparison results link to the current run’s lunar globe and local 3D sky. Observations share the selected site and UTC across the globe, tracks, timeline, sky, polar plot and exact-sample table. Site changes retain matching UTC samples. Instant results pair compass bearings with sunlight levels. Terrain visibility uses producer flags. [Live regression](qa/check_terrain_sky.mjs), [clearance QA](qa/docs/UI_RESILIENCE.md#horizon-clearance-and-direction-diagram). Owner: comparison integration.

## Current product, backend and QA state

[Native Safari](docs/FRONTEND_VERIFICATION.md#safari-import-narrow-windows-and-workspace-answers-on-november-15) passed import, language switching and narrow layout. The astronaut answers workspace questions from the [selected run](docs/BACKEND_RECONCILIATION.md#planning-from-an-imported-run). View from switches or overlays both local skies. Athena had two three-hour November proposals and none in December’s control. Date search distinguishes requested and grid times. Import guides show the required scenario release or terrain run, sites, UTC and cadence. Instant lookups reject conflicting retained visibility. Custom jobs preserve UTC, shared releases and definitive cancellation refusals. Science owns physical validation; data owns Colab. [Backend findings](docs/BACKEND_RECONCILIATION.md).

[UI-01](qa/docs/UI_RESILIENCE.md#ui-01-pending-windows) verified slow-load history; [UI-02](qa/docs/UI_RESILIENCE.md#ui-02-import-retest) import rejection and recovery; [UI-03](qa/docs/UI_RESILIENCE.md#ui-03-live-api-failures) pinned Retry after 180-second timeouts and rate limits; [UI-04 and UI-05](qa/docs/UI_RESILIENCE.md#ui-04-and-ui-05-plot-retest) missing data, 0° and north crossings; [UI-06](qa/docs/UI_RESILIENCE.md#ui-06-sharing-a-sample) exact shared UTC and provenance in both languages; and [UI-07](qa/docs/UI_RESILIENCE.md#ui-07-browser-retest) globe failures and comparison-preserving retry. [UI-10](qa/docs/UI_RESILIENCE.md#ui-10-invalid-workspace-links) covers malformed links, matching-file recovery and pinned retries.

Comparison globes expand from 1×, support location-centered zoom and retain the selected site. Saved globes show [dated sunlight](docs/GLOBE_SUNLIGHT.md).

The [Data catalog](docs/BACKEND_RECONCILIATION.md#live-run-directory-and-earth-visibility) opens live A2 and B2. Pair cards show coordinates, globe pins and LROC imagery. Haworth represents a region; Apollo 11 assumes a smooth horizon. UTC lookup distinguishes Earth-centre clearance and visible disc area. Retained responses passed EN/VI replay. [Confirmed routes](docs/FRONTEND_CONTRACT.md#published-route-scope).

[UI-09](qa/docs/UI_RESILIENCE.md#ui-09-keyboard-and-zoom) verified keyboard import, recovery, selection and gaps at 320px and 200% zoom. Reference cards remain on both pages. [Daylight clouds and planner map](docs/FRONTEND_VERIFICATION.md#planner-result-map-and-homepage-guide).

[Live API and Horizons replay](qa/README.md#frontend-integration-retest). [JPL replay](qa/docs/JPL_CHECK.md#november-b2-overlap-using-jpl-directions) matches both November windows using B2 terrain.

[Astronaut guide configuration](frontend/README.md#ask-the-astronaut).

**Plan and data** — [Five-year B2 rankings](docs/B2_VISIBILITY_ARCHIVE.md#five-year-planner-comparison) match archived intervals for all 23 sites. Long astronaut queries open the summary. Planner and astronaut rank fixed-duration visits and [uninterrupted visibility](docs/BACKEND_RECONCILIATION.md#longest-uninterrupted-joint-visibility). For November 14–21, 15 sites tie at 24/24 hours, while Vikram leads the whole week at 162/168. Smooth-sphere sites carry terrain caveats. Zero visibility yields no recommendation. [Evidence and backend hint](docs/BACKEND_RECONCILIATION.md#fixed-duration-visits-within-travel-dates) · [Four-file archive replay](docs/B2_VISIBILITY_ARCHIVE.md#verify-the-published-files).

## Pending

Release licensing, science sign-off, three usability sessions and screen-reader testing remain. See the [freeze checklist](qa/docs/RUNBOOK.md). Stashes retain backend-QA and pre-sync work. [Shared B2 sky](docs/FRONTEND_VERIFICATION.md#shared-local-sky-on-the-public-b2-planner) passed at 04:00 and 05:00 UTC for both sites.
