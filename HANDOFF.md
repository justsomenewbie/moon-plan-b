# Current handoff — 14 November 2026

## Minh creative QA update — 14 November, 12:36 UTC+07

Outcome: the validated frontend now shows producer-supplied simultaneous intervals as Golden windows, replaces the rectangular sky schematic with an accessible polar skyplot, and exposes a `?qa=true` inspector for complete/partial/missing fixture scenarios. Scientific results remain producer-owned; no readiness score or named Artemis data was fabricated. Evidence: 34 frontend tests, full offline `qa.run_checks`, TypeScript and Next production build passed; live Edge verified the inspector, Golden rows, skyplot semantics, missing state and persistent QA flag. Full record: `qa/LOCAL_WEB_DEEP_TEST_REPORT.md`. Owner: Minh. Git state: verified local implementation on branch `Minh`; remote publication not performed. Environment limit: Node 24.22.1 is below the declared 24.22.3 minimum. Pending: real producer export, OpenAPI agreement, browser network/fallback/mobile evidence. Next action: review `http://localhost:3001/?qa=true` and approve or revise the UI before any remote publication.

**Minh's QA branch** starts at fetched `origin/main` commit `4328c85329250d3f2e80fb7ae61ba7b9aa564458` in `justsomenewbie/moon-plan-b`. Owner: Minh. The team can test the offline validator, synthetic edge cases and the existing frontend importer with `python -B -m qa.run_checks`. [Instructions](qa/README.md) · [terminal evidence](qa/evidence/2026-11-14/terminal.txt) · [two JPL parser samples](qa/docs/JPL_CHECK.md).

## Current decisions

Chung's mandatory rules and the clearly marked frontend draft remain recorded in AGENTS/FRONTEND_CONTRACT. Chung's evolving `WEB_BACKEND_PLAN.md` describes an unimplemented service. Read [reconciliation](docs/BACKEND_RECONCILIATION.md) before integration: naming, repository placement, terrain model, result transport and jobs differ from the earlier draft. No agreed exported OpenAPI, sourced fixture or running origin has been supplied. Do not silently change models or relabel illustrative values.

AI planning assistance remains a proposed backend capability, with server-side keys, explicit criteria/UTC interpretation and answers grounded in supplied releases. No provider/model/assistant endpoint is established. Richer terrain, 3D and alternate-date features remain open candidates; the synthetic baseline is not a feature ceiling.

## Current result and evidence

The hero opens with a credited NASA LRO photograph. **Rotate the Moon** loads the 457,942-byte NASA CGI Moon Kit color map on demand. Drag, direction buttons and reset change the view center. Its bilingual caption identifies fixed-light reference imagery and excludes terrain and Sun/Earth visibility calculations. NASA credits and reuse terms are in [credits](docs/CREDITS.md).

Auto/Light/Dark follows local time or a saved manual choice. English is the default with a saved Vietnamese option. Animate UI supplies Share comparison’s press feedback.

**Compare sites** lists the producer’s assessments, reasons and source IDs for a published UTC window and selected threshold. Prior browser checks covered all three demo thresholds, swaps, partial coverage, absent sites, shared links and the 320px Vietnamese layout. Prior bilingual date reports were reviewed across ten Letter pages.

**32 tests and the production build including TypeScript passed.** Globe checks covered orientation, seam, poles, keyboard, drag, 320px Vietnamese and reduced motion. With a forced texture 404, both languages offered Retry. The photograph retained its NASA credit. Retry restored the globe and its map credit on HTTP 200 with the comparison still selected. The accessibility status reflected keyboard rotation. See [verification](docs/FRONTEND_VERIFICATION.md).

Native Safari in a separate QA window loaded six observation windows and successfully imported the local synthetic fixture. Earlier keyboard criterion change passed. Language switching, exact CSS width, console and final window closure remain unconfirmed. Existing tabs were untouched.

External evidence: `/Users/nns/Documents/ChatGPT/nasa-preparation-deliverables/frontend-kickoff-2026-11-14/`, including `globe-retry-verified.json` and `site-finder-final.json`. Saved language applies after hydration. Theme can flash dark, Auto can lag one minute, and a press animation can finish after reduced motion is enabled. Real science/backend, full release licensing and spoken screen-reader checks remain open.

## Ownership and publication

The earlier globe review used `dc6e179a9d2d277b9b7530dd73d5f08af1ff878e`. Minh's QA work is local. Production build, network trace, three usability sessions, licensing and science sign-off remain open. See the [freeze checklist](qa/docs/RUNBOOK.md).

Next input from Chung and Trang is one versioned site-pair export for a shared UTC window, with raw source responses and processing evidence for every joint interval.
