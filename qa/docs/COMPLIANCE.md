# Scientific, source and submission checks

This checklist separates engineering constraints from event requirements. It is not legal advice, eligibility certification or organizer approval. All unchecked items are pending.

## Engineering / scientific gates

- [ ] Browser never sends ephemeris API queries to JPL; attach exercised-path network evidence. Offline batch -> versioned static JSON is the mission brief's architecture; current Next.js same-origin API mode needs reconciliation.
- [ ] Offline producer uses serial requests, caching/reuse, appropriate backoff, application-specific User-Agent and API response-version checks. These controls belong to the producer, not the offline QA validator.
- [ ] Metadata preserves target 10/399, Moon `coord@301`, geodetic location/frame/datum, angles in degrees, elevation km, airless Q4, time-scale conversion, actual requests/raw responses and SHA-256 identities.
- [ ] Visible English disclaimer: "Body-center elevation above an ideal geometric horizon (> 0 degrees) does not account for local terrain or crater masking, guarantee usable solar power, validate a radio link, or certify landing safety."
- [ ] Synthetic data remains visibly labeled; a passing QA manifest is not independent astronomical verification. Trang reviews real samples and uncertainty/cadence before release.

Minh's QA work included serial JPL requests from the local command line and archived responses for an offline parser check. [JPL parser evidence](JPL_CHECK.md). The API policy prohibits embedding the APIs in websites. [JPL SSD API fair-use policy](https://ssd-api.jpl.nasa.gov/doc/index.php), [API parameters](https://ssd-api.jpl.nasa.gov/doc/horizons.html), [observer quantities](https://ssd.jpl.nasa.gov/horizons/manual.html#observer-table).

## Competition and rights gates

On 14 November the Hanoi organizer's guide confirmed the local judging deadline of 11:00 on 15 November and the demo format of seven slides or a 30-second video. [SEPA submission guide](https://sepa.org.vn/en/nasa-space-apps-hanoi-2026-submission-guide.htm). The two global NASA guides could not be freshly retrieved. Global items below carry forward the repository's dated 13 November review and need reconfirmation before submission. [NASA submission guide](https://www.spaceappschallenge.org/resources/project-submission-guide/), [NASA judging guide](https://www.spaceappschallenge.org/resources/judging-awards-guide/).

- [ ] Actually use and identify at least one NASA data/resource for Global Award consideration; invented QA values do not establish this. Name/version/link each resource used.
- [ ] Team-authored submission/linked materials in English; demo within the recorded seven-slide including title or 30-second video limit, final project link distinct; verify access without login.
- [ ] Confirm allowed likeness/content rules, including the recorded under-18 restriction; preserve third-party licences and exact asset permissions. No generated NASA branding.
- [ ] Disclose AI assistance in proposal history, code, data and documentation; retain applicable generated media marks/metadata. The recorded SI solution-idea interpretation remains unresolved; do not erase history or sign unsupported originality claims.
- [ ] Human owner selects a compatible project licence, resolves dependency notices and distribution rights, then records the decision. Public GitHub visibility alone is not a reuse licence.
- [ ] Team Owner verifies submission permissions and receipt, local deadline and current portal rules. No submission or organizer contact is authorized by running these checks.

Existing `docs/CREDITS.md` has an undecided project licence and notice gaps for `@img/sharp-libvips-darwin-arm64`, `@tybys/wasm-util`, `client-only`, and `is-node-process`. QA code does not silently resolve or overwrite these. No new third-party package or external asset was introduced by this QA task.

## AI contribution record

OpenAI Codex authored QA Python/TypeScript, synthetic fixtures and these operational documents from the user's brief. Read-only Backend Architect/API Tester, Legal Compliance Checker and Reality Checker/Evidence Collector/Test Results Analyzer agent streams reviewed the work. All computed fixture values are invented test inputs or simple test-model outputs, not measured lunar observations. Human contract/science/usability approval remains pending. This disclosure supplements existing `docs/CREDITS.md` and does not remove earlier assistance.
