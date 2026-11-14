# Current handoff — 14 November 2026

## Mission Survival & Horizon Clearance Studio

Outcome: feature checkpoint `54386ef` refines the existing static-data studio without adding endpoints or dependencies. The simulated uniform clearance control now spans 0–10° in 0.1° steps with 0/2/5° educational presets. The ribbon keeps four known states plus explicit unavailable UTC intervals, shows hours and percentages, and never turns a null or cadence gap into blackout. Educational darkness endurance uses 24/100/150-hour assumptions; a Sun-masked span touching either evaluated-window boundary is unresolved instead of “within.” Producer intervals remain unchanged and separately labeled.

The synced HUD retains shortest-angle north wrapping, adds a side-elevation schematic, and labels its uniform mask as a sensitivity test rather than local terrain. Timeline and polar plots shade the selected clearance band. State patterns, always-mounted screen-reader interval text, 44px controls, forced-colors boundaries and printable studio results supplement color. English remains default with Vietnamese display translation; values, UTC and IDs are unchanged.

Evidence: **75 frontend tests passed**, including strict `elevation > θ`, linear crossings, `[start,end)`, missing cadence, explicit unavailable coverage, bounded versus clipped darkness and `359°→1° = 2°`. Next route type generation, strict TypeScript and the production build passed. Saved Chromium evidence from the prior implementation exists, but a fresh desktop/320px/print screenshot pass for this refinement remains pending because Windows Computer Use stopped when it could not establish the active Edge URL confidently. Owner: Minh.

## Product and backend state

The frontend compares dates at one site or sites in one UTC window, supports pinned terrain results, custom jobs, imports, saved links, EN/VI, printing and source inspection. Prior Chromium/Safari evidence covers live recovery, missing samples, UTC boundaries, globe fallback and the producer’s duration assessments. The team aggregate and per-site checks remain documented in [backend reconciliation](docs/BACKEND_RECONCILIATION.md); science owns physical validation and the data team owns Colab. Sun clearance is not a power model, and Earth visibility is not a radio-link budget.

## Pending

Run a fresh visual pass at desktop, 320px, print and forced colors; then preserve screenshots/results. Release licensing, science sign-off, three usability sessions and spoken screen-reader testing remain open. See the [freeze checklist](qa/docs/RUNBOOK.md). Historical backend-QA and pre-sync WIP remain in named local stashes and were not included in this product commit. Next action: visual-check the merged main build before submission freeze.
