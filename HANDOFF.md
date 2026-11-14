# Current handoff — 15 November 2026

Sơn selected the 3D globe as the default planner map, with a flat-map toggle. The close-up and its LROC link share coordinates and layer, including off-site positions. The inspector and table link to the selected site’s saved report or hourly live observations. Home links to Compare, Plan and the illustrated guide. Its three steps open by default. The [orbit presentation](qa/check_orbit.mjs) remains available at `/orbit`. Live guide answers, saved site reports and date presets [preserve the live run](qa/check_planner_run_links.mjs) on return. The [guide](qa/check_astronaut_guide.mjs) uses the selected source for its hourly UTC reading. See [planner](qa/check_planner_map.mjs) and [home](qa/check_home_navigation.mjs).

## Live comparison

The comparison results link to the current run’s lunar globe and local 3D sky. Observations share the selected site and UTC across the globe, tracks, timeline, sky, polar plot and exact-sample table. The 0°/2°/5° controls, ribbon and direction diagrams use the returned angles. Terrain visibility uses the producer flags. Missing directions stay unavailable. [Live regression](qa/check_terrain_sky.mjs), [clearance QA](qa/docs/UI_RESILIENCE.md#horizon-clearance-and-direction-diagram). Owner: comparison integration.

## Current product, backend and QA state

[Native Safari](docs/FRONTEND_VERIFICATION.md#safari-import-narrow-windows-and-workspace-answers-on-november-15) passed import, language switching and narrow layout. The astronaut answers workspace questions from the [selected run](docs/BACKEND_RECONCILIATION.md#planning-from-an-imported-run). View from switches or overlays both local skies. Athena had two three-hour November proposals and none in December’s control. Date search distinguishes requested and grid times. Pinned imports validate run, site, UTC, cadence and observation. Instant lookups reject conflicting retained visibility. Custom jobs preserve UTC, shared releases and definitive cancellation refusals. Science owns physical validation; data owns Colab. [Backend findings](docs/BACKEND_RECONCILIATION.md).

[UI-01](qa/docs/UI_RESILIENCE.md#ui-01-pending-windows) verified slow-load history; [UI-02](qa/docs/UI_RESILIENCE.md#ui-02-import-retest) import rejection and recovery; [UI-03](qa/docs/UI_RESILIENCE.md#ui-03-live-api-failures) pinned Retry after 180-second relay timeouts; [UI-04 and UI-05](qa/docs/UI_RESILIENCE.md#ui-04-and-ui-05-plot-retest) missing data, 0° and north crossings; [UI-06](qa/docs/UI_RESILIENCE.md#ui-06-sharing-a-sample) exact shared UTC and provenance in both languages; and [UI-07](qa/docs/UI_RESILIENCE.md#ui-07-browser-retest) globe failures and comparison-preserving retry. [UI-10](qa/docs/UI_RESILIENCE.md#ui-10-invalid-workspace-links) covers malformed links, matching-file recovery and pinned retries.

Comparison globes expand from 1×, support location-centered zoom and retain the selected site. Saved globes show [dated sunlight](docs/GLOBE_SUNLIGHT.md).

The [Data catalog](docs/BACKEND_RECONCILIATION.md#live-run-directory-and-earth-visibility) opens live A2 and B2. Pair cards show coordinates, globe pins and LROC imagery. Haworth represents a region; Apollo 11 assumes a smooth horizon. UTC lookup distinguishes Earth-centre clearance and visible disc area. Retained responses passed EN/VI replay. [Confirmed routes](docs/FRONTEND_CONTRACT.md#published-route-scope).

[UI-09](qa/docs/UI_RESILIENCE.md#ui-09-keyboard-and-zoom) verified keyboard import, recovery, selection and gaps at 320px and 200% zoom. Reference cards remain on both pages. [Daylight clouds and planner map](docs/FRONTEND_VERIFICATION.md#planner-result-map-and-homepage-guide).

[Live API and Horizons replay](qa/README.md#frontend-integration-retest). [JPL replay](qa/docs/JPL_CHECK.md#november-b2-overlap-using-jpl-directions) matches both November windows using B2 terrain.

[Astronaut guide configuration](frontend/README.md#ask-the-astronaut).

**Plan and data** — B2 covers 23 sites and 43,824 hours per site, with EN/VI coordinate notes. The planner and astronaut rank fixed-duration visits inside travel dates. For November 14–21, 15 sites tie at 24/24 hours, while Vikram leads the whole week at 162/168. Smooth-sphere sites carry terrain caveats. Zero visibility yields no recommendation. [Evidence and backend hint](docs/BACKEND_RECONCILIATION.md#fixed-duration-visits-within-travel-dates) · [Archive](docs/B2_VISIBILITY_ARCHIVE.md).

## Pending

Release licensing, science sign-off, three usability sessions and screen-reader testing remain. See the [freeze checklist](qa/docs/RUNBOOK.md). Stashes retain backend-QA and pre-sync work. [Shared B2 sky](docs/FRONTEND_VERIFICATION.md#shared-local-sky-on-the-public-b2-planner) passed at 04:00 and 05:00 UTC for both sites.
