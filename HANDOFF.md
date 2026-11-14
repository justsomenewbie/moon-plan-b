# Current handoff — 14 November 2026

**The lunar reference globe and date-first comparison work in English and Vietnamese. Comparison data is synthetic.** Repository: https://github.com/justsomenewbie/moon-plan-b · owner `justsomenewbie` · base `main` · review branch `codex/frontend-kickoff` · checkout `/Users/nns/Documents/ChatGPT/moon-plan-b`.

## Current decisions

Chung's mandatory rules and the clearly marked frontend draft remain recorded in AGENTS/FRONTEND_CONTRACT. Chung's evolving `WEB_BACKEND_PLAN.md` describes an unimplemented service. Read [reconciliation](docs/BACKEND_RECONCILIATION.md) before integration: naming, repository placement, terrain model, result transport and jobs differ from the earlier draft. No agreed exported OpenAPI, sourced fixture or running origin has been supplied. Do not silently change models or relabel illustrative values.

AI planning assistance remains a proposed backend capability, with server-side keys, explicit criteria/UTC interpretation and answers grounded in supplied releases. No provider/model/assistant endpoint is established. Richer terrain, 3D and alternate-date features remain open candidates; the synthetic baseline is not a feature ceiling.

## Current result and evidence

The hero opens with a credited NASA LRO photograph. **Rotate the Moon** loads the 457,942-byte NASA CGI Moon Kit color map on demand. Drag, direction buttons and reset change the view center. Its bilingual caption identifies fixed-light reference imagery and excludes terrain and Sun/Earth visibility calculations. NASA credits and reuse terms are in [credits](docs/CREDITS.md).

Auto/Light/Dark follows local time or a saved manual choice. English is the default with a saved Vietnamese option. Animate UI supplies Share comparison’s press feedback. Its redistribution restriction conflicts with the published judging terms. The team’s release decision remains open. See [credits](docs/CREDITS.md).

**Compare sites** lists the producer’s assessments, reasons and source IDs for a published UTC window and selected threshold. Prior browser checks covered all three demo thresholds, swaps, partial coverage, absent sites, shared links and the 320px Vietnamese layout. Prior bilingual date reports were reviewed across ten Letter pages.

**32 tests and the production build including TypeScript passed.** Globe checks covered orientation, seam, poles, keyboard, drag, 320px Vietnamese and reduced motion. With a forced texture 404, both languages offered Retry. The photograph retained its NASA credit. Retry restored the globe and its map credit on HTTP 200 with the comparison still selected. The accessibility status reflected keyboard rotation. See [verification](docs/FRONTEND_VERIFICATION.md).

Native Safari in a separate QA window loaded six observation windows and successfully imported the local synthetic fixture. Earlier keyboard criterion change passed. Language switching, exact CSS width, console and final window closure remain unconfirmed. Existing tabs were untouched.

External evidence: `/Users/nns/Documents/ChatGPT/nasa-preparation-deliverables/frontend-kickoff-2026-11-14/`, including `globe-retry-verified.json` and `site-finder-final.json`. Saved language applies after hydration. Theme can flash dark, Auto can lag one minute, and a press animation can finish after reduced motion is enabled. Real science/backend, full release licensing and spoken screen-reader checks remain open.

## Ownership and publication

Root edited; agents reviewed. The frontend was fast-forwarded to `main` and verified against GitHub at `4328c85329250d3f2e80fb7ae61ba7b9aa564458`. Main and review branch matched at that checkpoint. No deployment or submission. Product cloud SHA is unestablished.

Next input from Chung and Trang is one versioned site-pair export for a shared UTC window, with raw source responses and processing evidence for every joint interval.
