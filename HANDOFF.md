# Current handoff — 14 November 2026

**The opening globe locates two mission references and supported comparison sites. The bilingual date-first comparison and local sky use synthetic demo observations.** Repository: https://github.com/justsomenewbie/moon-plan-b · owner `justsomenewbie` · base `main` · review branch `codex/frontend-kickoff` · checkout `/Users/nns/Documents/ChatGPT/moon-plan-b`.

## Current decisions

The backend owns the production OpenAPI. Chung will add `GET /api/v1/dataset` after the backend workflow. The frontend already calls this aggregate route. A separate team member owns Colab execution and testing. FE needs the versioned response schema and one bounded sample. Terrain horizons and visibility definitions need review before display. See [reconciliation](docs/BACKEND_RECONCILIATION.md).

AI planning assistance remains a proposed backend capability, with server-side keys, explicit criteria/UTC interpretation and answers grounded in supplied releases. No provider/model/assistant endpoint is established. Richer terrain, 3D and alternate-date features remain open candidates; the synthetic baseline is not a feature ceiling.

## Current result and evidence

The hero loads the NASA CGI Moon Kit globe after hydration, with a credited photograph during loading and on texture failure. The site locator links mission coordinates to NASA/LROC and the selected comparison role to its sky. **Explore the 3D sky** follows the comparison cursor. Switch between primary and alternative samples, orbit the compass and read the supplied body angles at the selected site's UTC. The ideal horizon omits terrain. See [method](docs/METHOD.md) and [NASA credits](docs/CREDITS.md).

Auto/Light/Dark follows local time or a saved manual choice. English is the default with a saved Vietnamese option. Animate UI supplies Share comparison’s press feedback. Its redistribution restriction conflicts with the published judging terms. The team’s release decision remains open. See [credits](docs/CREDITS.md).

**Compare sites** lists the producer’s assessments, reasons and source IDs for a published UTC window and selected threshold. Checks covered demo thresholds, swaps, partial coverage, absent sites, share links and bilingual printing.

**36 tests, TypeScript and a production build passed.** The offline [joint-interval check](docs/METHOD.md) flags incomplete overlaps and longest-duration discrepancies for source review. A forced texture 404 preserved the photograph and credit. Retry restored the globe. The 3D sky passed checks for both roles, their UTC instants, missing samples, zero elevation, pointer and keyboard rotation, reduced motion and Vietnamese at 320px. See [verification](docs/FRONTEND_VERIFICATION.md).

Browser checks confirmed a later range edit survives a pending GET and a pending file import hides stale recovery controls. Native Safari imported synthetic JSON. In an isolated window English → Vietnamese → English passed with measured 320px viewport and document widths in both languages. The direct production page loaded six windows in Vietnamese with no visible console error. Safari’s Window menu confirmed the QA window was closed.

Evidence: `/Users/nns/Documents/ChatGPT/nasa-preparation-deliverables/frontend-kickoff-2026-11-14/`, including `native-safari-language-width.json` and `globe-retry-verified.json`. Appearance and language apply after hydration. Real science/backend, full release licensing and spoken screen-reader checks remain open.

## Ownership and publication

Root edited; agents reviewed. Prior verified GitHub checkpoint `f5e116a222d06abe15d1cfb1da1d0f7f025d3726`. Product cloud SHA is unestablished. No deployment or submission.

Next input for FE: Chung’s versioned OpenAPI and one sourced, bounded response from the backend/data team.
