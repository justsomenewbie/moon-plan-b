# Current handoff — 14 November 2026

**The lunar reference globe and date-first comparison work in English and Vietnamese. Comparison data is synthetic.** Repository: https://github.com/justsomenewbie/moon-plan-b · owner `justsomenewbie` · base `main` · review branch `codex/frontend-kickoff` · checkout `/Users/nns/Documents/ChatGPT/moon-plan-b`.

## Current decisions

Chung's mandatory rules and the clearly marked frontend draft remain recorded in AGENTS/FRONTEND_CONTRACT. Chung's evolving `WEB_BACKEND_PLAN.md` describes an unimplemented service. Read [reconciliation](docs/BACKEND_RECONCILIATION.md) before integration: naming, repository placement, terrain model, result transport and jobs differ from the earlier draft. No agreed exported OpenAPI, sourced fixture or running origin has been supplied. Do not silently change models or relabel illustrative values.

AI planning assistance remains a proposed backend capability, with server-side keys, explicit criteria/UTC interpretation and answers grounded in supplied releases. No provider/model/assistant endpoint is established. Richer terrain, 3D and alternate-date features remain open candidates; the synthetic baseline is not a feature ceiling.

## Current result and evidence

The hero opens with a credited NASA LRO photograph. **Rotate the Moon** loads the 457,942-byte NASA CGI Moon Kit color map on demand. Drag, direction buttons and reset change the view center. The reference globe has fixed shading. It requires no WebGL or new package. NASA credits and reuse terms are in [credits](docs/CREDITS.md).

Auto/Light/Dark follows local time or a saved manual choice. English is the default with a saved Vietnamese option. Animate UI supplies Share comparison’s press feedback.

**Compare sites** lists the producer’s assessments, reasons and source IDs for a published UTC window and selected threshold. Prior browser checks covered all three demo thresholds, swaps, partial coverage, absent sites, shared links and the 320px Vietnamese layout. Prior bilingual date reports were reviewed across ten Letter pages.

**32 tests and the production build including TypeScript passed.** Globe checks covered orientation, seam, poles, keyboard and drag input, a 320px Vietnamese layout, reduced motion and a failed image load followed by successful retry. The photograph and comparisons stayed available during the error. The accessibility status reflected keyboard rotation. See [verification](docs/FRONTEND_VERIFICATION.md).

Native Safari in a separate QA window loaded six observation windows and successfully imported the local synthetic fixture. Earlier keyboard criterion change passed. Language switching, exact CSS width, console and final window closure remain unconfirmed. No user-tab navigation/edit was issued. In-app checks are not Safari evidence.

External evidence: `/Users/nns/Documents/ChatGPT/nasa-preparation-deliverables/frontend-kickoff-2026-11-14/`, including `globe-recovery.json`, `globe-browser-first.json` and `site-finder-final.json`. Saved language applies after English hydration; theme may briefly show dark and Auto may lag one minute. In-flight press return may finish after reduced motion is enabled. Real science/backend, full release licensing and spoken screen-reader checks remain open.

## Ownership and publication

Root is the sole editor; agents reviewed read-only. Verified previous review head: `d8684ec5f3affdfb64503e313bf37763457d04f3`. External publication receipt records the new commit and remote readback. `main` remains `d7e9d6246a115257acbd3acf65200c9006d4ad4e`; no merge/deployment/submission. Product cloud SHA is unestablished. Preparation unchanged; no preparation sync required. Release edit ownership after publication verification.

Next action under two minutes: open the preview, select **Rotate the Moon**, then press the east arrow to inspect the surface.
