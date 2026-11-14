# Current handoff — 14 November 2026

## Mission Survival & Horizon Clearance Studio

Feature checkpoint `54386ef` refines the existing static-data studio without new endpoints or dependencies. The simulated uniform clearance control spans 0–10° in 0.1° steps with 0/2/5° educational presets. The ribbon keeps four known states plus explicit unavailable UTC intervals, shows hours and percentages, and never turns a null or cadence gap into blackout. Educational darkness endurance uses 24/100/150-hour assumptions; a boundary-clipped dark span stays unresolved unless its observed duration already exceeds the selected reference. Producer intervals remain unchanged and separately labeled.

The synced HUD retains shortest-angle north wrapping, adds a side-elevation schematic, and labels its uniform mask as a sensitivity test rather than local terrain. Timeline and polar plots shade the selected clearance band. State patterns, always-mounted screen-reader interval text, 44px controls, forced-colors boundaries and printable results supplement color. English remains default with optional Vietnamese display translation; values, UTC and IDs are unchanged. Sun clearance is not a power model, and Earth visibility is not a radio-link budget.

Evidence after the latest `main` synchronization: **82 frontend tests passed**, including the clearance, north-wrap, missing-data and new alternative-date cases. Route type generation, strict TypeScript and the production build also passed. Owner: Minh. The [QA replay](qa/docs/UI_RESILIENCE.md#horizon-clearance-and-direction-diagram) covers the side-view fix, 320px, desktop, forced colors, PDF and both orders of the archived Horizons comparison. On `65b7375`, both clocks skipped Athena’s missing 02:00 UTC in both directions.

## Current product, backend and QA state

The frontend compares dates at one site or sites in one UTC window, supports pinned terrain results, imports, saved links, EN/VI, printing and source inspection. Main now also provides guided imports and alternative landing-date search. Local sky opens on one observation; **View from** switches observations or overlays both. The live search found two three-hour Athena windows on 15 November and none in the December control; fractional backend bounds remain the next integration check. Custom jobs preserve UTC bounds and unknown progress. The team aggregate and per-site findings remain in [backend reconciliation](docs/BACKEND_RECONCILIATION.md); science owns physical validation and the data team owns Colab.

Wi-Fi mock jobs work. [UI-01](qa/docs/UI_RESILIENCE.md#ui-01-pending-windows) verified slow-load history; [UI-02](qa/docs/UI_RESILIENCE.md#ui-02-import-retest) import rejection and recovery; [UI-03](qa/docs/UI_RESILIENCE.md#ui-03-live-api-failures) pinned recovery after API faults; [UI-04 and UI-05](qa/docs/UI_RESILIENCE.md#ui-04-and-ui-05-plot-retest) missing data, 0° and north crossings; [UI-06](qa/docs/UI_RESILIENCE.md#ui-06-sharing-a-sample) exact shared UTC and provenance in both languages; and [UI-07](qa/docs/UI_RESILIENCE.md#ui-07-browser-retest) globe failures and comparison-preserving retry. [UI-10](qa/docs/UI_RESILIENCE.md#ui-10-invalid-workspace-links) covers malformed links, matching-file recovery and pinned retries.

Vietnamese labels and instructions now distinguish sites, UTC samples and apparent sky positions across home, comparison, import and errors. JSON syntax errors give a Vietnamese recovery step. Chromium verified the updated Vietnamese site selectors, restored UTC samples and clearance slider label.

[UI-09](qa/docs/UI_RESILIENCE.md#ui-09-keyboard-and-zoom) passed keyboard-only import, recovery, site selection and gap navigation at 320px and 200% Chromium zoom.

## Pending

Backend fractional bounds, release licensing, science sign-off, three usability sessions and spoken screen-reader testing remain open. See the [freeze checklist](qa/docs/RUNBOOK.md). Historical backend-QA and pre-sync WIP remain in named local stashes and were not included in this product merge.
