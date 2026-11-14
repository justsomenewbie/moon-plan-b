# Current handoff — 14 November 2026

The bilingual homepage illustrates crater shadows and opens Athena (139 h) and Odysseus (33 h) for 14–20 November UTC. [Homepage QA](qa/check_home_navigation.mjs).

## Mission Survival & Horizon Clearance Studio

The clearance control spans 0–10° in 0.1° steps with 0/2/5° educational presets. The ribbon keeps four known states plus explicit unavailable UTC intervals, shows hours and percentages, and never turns a null or cadence gap into blackout. Educational darkness endurance uses 24/100/150-hour assumptions; a boundary-clipped dark span stays unresolved unless its observed duration already exceeds the selected reference. Producer intervals remain unchanged and separately labeled.

The HUD and plots label the simulated clearance. Solar visibility is not power; Earth visibility is not a radio-link budget. [Clearance QA](qa/docs/UI_RESILIENCE.md#horizon-clearance-and-direction-diagram).

## Current product, backend and QA state

Imports, saved links, EN/VI, printing and sources work. View from switches or overlays both local skies. Athena had two three-hour November proposals and none in December’s control. Date search distinguishes requested and grid times. Pinned imports validate run, site, UTC, cadence and observation. Instant lookups reject conflicting retained visibility. Custom jobs preserve UTC, shared releases and definitive cancellation refusals. Science owns physical validation; data owns Colab. [Backend findings](docs/BACKEND_RECONCILIATION.md).

Wi-Fi mock jobs work. [UI-01](qa/docs/UI_RESILIENCE.md#ui-01-pending-windows) verified slow-load history; [UI-02](qa/docs/UI_RESILIENCE.md#ui-02-import-retest) import rejection and recovery; [UI-03](qa/docs/UI_RESILIENCE.md#ui-03-live-api-failures) pinned recovery after API faults; [UI-04 and UI-05](qa/docs/UI_RESILIENCE.md#ui-04-and-ui-05-plot-retest) missing data, 0° and north crossings; [UI-06](qa/docs/UI_RESILIENCE.md#ui-06-sharing-a-sample) exact shared UTC and provenance in both languages; and [UI-07](qa/docs/UI_RESILIENCE.md#ui-07-browser-retest) globe failures and comparison-preserving retry. [UI-10](qa/docs/UI_RESILIENCE.md#ui-10-invalid-workspace-links) covers malformed links, matching-file recovery and pinned retries.

Saved globes show [dated sunlight](docs/GLOBE_SUNLIGHT.md). Markers select body readings. Mobile QA covers contacts, imports, selection, UTC, clearance and API.

Run B [ranked 23 sites](docs/BACKEND_RECONCILIATION.md#ranking-two-sites-in-one-window). Pair cards show coordinates, globe pins and LROC imagery. Haworth represents a region; Apollo 11 assumes a smooth horizon. UTC lookup labels optional solar-disc fraction and Sun-facing irradiance. Retained responses passed EN/VI replay; the LAN producer was unreachable on retest. [Confirmed routes](docs/FRONTEND_CONTRACT.md#published-route-scope).

[UI-09](qa/docs/UI_RESILIENCE.md#ui-09-keyboard-and-zoom) verified keyboard import, recovery, selection and gaps at 320px and 200% zoom. Globe focus visible. Sources reopen. [Home navigation](qa/check_home_navigation.mjs) reaches members and methods. Site selection: comparisons. [Sky projection](docs/CREDITS.md#night-theme-star-map), cloud shading and four meteor paths.

[Live API and Horizons replay](qa/README.md#frontend-integration-retest). [Raw checks](qa/docs/JPL_CHECK.md#archived-four-response-check).

The astronaut waves, greets on opening and glances sideways while answering. Pause and reduced motion use still expressions. Its open guide refreshes at modeled sample boundaries. About links to the six team members; the footer includes the school’s Facebook page. [OpenAI/Ollama configuration](frontend/README.md#ask-the-astronaut).

**Plan and data:** B2 covers 23 sites and 43,824 hourly samples each. Long catalog links include downloadable visibility summaries. Switching sources retains the requested dates, site and priority. The public explorer lists 13 relay operations. All 17 upstream operations match the production contract. [Archive](docs/B2_VISIBILITY_ARCHIVE.md) · [Hosted CSV filename and cache retest](docs/BACKEND_RECONCILIATION.md).

## Pending

Release licensing, science sign-off, three usability sessions and screen-reader testing remain. See the [freeze checklist](qa/docs/RUNBOOK.md). Stashes retain backend-QA and pre-sync work.
