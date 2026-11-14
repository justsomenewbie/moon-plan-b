# Current handoff — 14 November 2026

## Mission Survival & Horizon Clearance Studio

Feature checkpoint `54386ef` refines the existing static-data studio without adding endpoints or dependencies. The simulated uniform clearance control spans 0–10° in 0.1° steps with 0/2/5° educational presets. The ribbon keeps four known states plus explicit unavailable UTC intervals, shows hours and percentages, and never turns a null or cadence gap into blackout. Educational darkness endurance uses 24/100/150-hour assumptions; a Sun-masked span touching either evaluated-window boundary is unresolved instead of “within.” Producer intervals remain unchanged and separately labeled.

The synced HUD retains shortest-angle north wrapping, adds a side-elevation schematic, and labels its uniform mask as a sensitivity test rather than local terrain. Timeline and polar plots shade the selected clearance band. State patterns, always-mounted screen-reader interval text, 44px controls, forced-colors boundaries and printable studio results supplement color. English remains default with optional Vietnamese display translation; values, UTC and IDs are unchanged.

Evidence after the latest main synchronization: **76 frontend tests passed**, including strict `elevation > θ`, linear crossings, `[start,end)`, missing cadence, explicit unavailable coverage, bounded versus clipped darkness and `359°→1° = 2°`. Route type generation, strict TypeScript and the production build also passed. Owner: Minh.

## Current product and QA state

The frontend compares dates at one site or sites in one UTC window, supports pinned terrain results, custom jobs, imports, saved links, EN/VI, printing and source inspection. Wi-Fi mock jobs work. [UI-01](qa/docs/UI_RESILIENCE.md#ui-01-pending-windows) verified history during slow loads; [UI-02](qa/docs/UI_RESILIENCE.md#ui-02-import-retest) verified import rejection and recovery; [UI-03](qa/docs/UI_RESILIENCE.md#ui-03-live-api-failures) verified pinned recovery after API faults. [UI-04 and UI-05](qa/docs/UI_RESILIENCE.md#ui-04-and-ui-05-plot-retest) cover missing data, 0° and north crossings. [UI-06](qa/docs/UI_RESILIENCE.md#ui-06-sharing-a-sample) restored the exact shared UTC and provenance in both languages; [UI-07](qa/docs/UI_RESILIENCE.md#ui-07-browser-retest) covered globe failures and comparison-preserving retry.

The team aggregate and per-site checks remain documented in [backend reconciliation](docs/BACKEND_RECONCILIATION.md); science owns physical validation and the data team owns Colab. Sun clearance is not a power model, and Earth visibility is not a radio-link budget.

## Pending

Run a fresh visual pass at desktop, 320px, print and forced colors, then preserve evidence. Release licensing, science sign-off, three usability sessions and spoken screen-reader testing remain open. See the [freeze checklist](qa/docs/RUNBOOK.md). Historical backend-QA and pre-sync WIP remain in named local stashes and were not included in this product merge.
