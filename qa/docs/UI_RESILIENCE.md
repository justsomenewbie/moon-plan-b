# Frontend resilience — manual evidence checklist

The table records browser evidence. Minh’s original QA run exercised the importer and chart paths in Node. Record commit, dataset hash, UTC test time, browser/version, viewport, route, exact injection, observed result and evidence path for every row. Failures go to `../BUG_LOG.md` with owner and retest commit.

| ID | Procedure | Expected result | Status |
| --- | --- | --- | --- |
| UI-01 | Throttle initial data loading; change selection during pending load | Visible loading; no old data labeled as new; controls recover | NOT RUN |
| UI-02 | Import invalid JSON, each invalid fixture, wrong schema, >5 MiB and empty file | Accessible error, no crash or partial acceptance; prior valid dataset remains recoverable | [PASS in Chromium](#ui-02-import-retest) |
| UI-03 | Inject HTTP 404/500, network disconnect, timeout and truncated body on actual data route | Error/retry with bounded attempts; live mode must not silently show mocks | NOT RUN |
| UI-04 | Import partial and missing fixtures | Unknown text and null metrics, broken lines across missing samples; no zero-filled darkness | [PASS in Chromium](#ui-04-and-ui-05-plot-retest) |
| UI-05 | Import crossing_wrap; inspect both sites and zero values | North seam does not draw a full-width spike; exact-zero displayed accurately | [PASS in Chromium](#ui-04-and-ui-05-plot-retest) |
| UI-06 | Switch English/Vietnamese and share/reopen selection | Same UTC `Z`, source identity, degrees/km and dataset version; English default retained | NOT RUN |
| UI-07 | Block globe texture, simulate image decode failure and unavailable Canvas 2D context separately | Fallback/retry or explicit error; numeric tables and SVG charts still usable, selection retained | [PASS in Chromium](#ui-07-browser-retest) |
| UI-08 | If a WebGL renderer is introduced, deny WebGL and fire context-loss/recovery separately | Failure isolated from comparison/charts/table; retry or supported fallback | CONDITIONAL — current globe is Canvas 2D |
| UI-09 | Keyboard-only import/select/retry; zoom; 320px width; reduced motion | Visible focus, usable controls/labels, readable data; log actual screen-reader speech separately | NOT RUN |
| UI-10 | Use malformed/old-version share links, absent site and mismatched windows | Clear incompatibility; no nearest-time substitution or invented result | NOT RUN |

## UI-04 and UI-05 plot retest

On 14 November 2026 at 08:19 UTC, Playwright ran Chromium 158.0.8127.18 at 1280 × 720 on the production frontend at `/` with mock startup and imported fixtures. The [plot fix](https://github.com/justsomenewbie/moon-plan-b/commit/2dc97be8798dade778e51c989707f20c58b16194) removes a 1.5-step tolerance from the polar skyplot. On the old build, moving the partial basin's 01:00 sample to 01:15 joined both polar trails across 75 minutes despite the 60-minute cadence. The elevation chart already broke there. The corrected polar plot breaks both trails at that gap.

With the original partial and missing fixtures, all six summary values and interval labels reported unavailable. The exact-sample table retained Earth when only Sun was missing. The empty windows had no markers and a disabled slider. With `crossing_wrap`, the polar trails broke across north in both directions. A genuine 0° Sun lay exactly on the horizon ring. The [browser regression](../check_observation_plots.mjs) checks both sites. Replay with `node qa/check_observation_plots.mjs <frontend-origin>`.

## Horizon clearance and direction diagram

Minh introduced these controls in [d32bdd6](https://github.com/justsomenewbie/moon-plan-b/commit/d32bdd6c385de9f117fe529c0fd7df57a4a3e997). Chromium verified the [corrections](https://github.com/justsomenewbie/moon-plan-b/commit/d67d917ec819f6ddf1e5f0a2ba2f317a2f48ab09) at 08:19 UTC on the same build and viewport. The slider moved the threshold in both plots, both sites retained their original producer totals, and switching English/Vietnamese retained the selected angle and duration. At Sun elevations of 0.2° and 1°, the displayed ideal shadow lengths were 286.5 and 57.29 object heights. Neither a missing sample row nor a null Sun filled either neighboring ribbon interval. An absent body had no hardware direction. An independent browser replay also opened the two sites’ interval details in turn and verified the UTC list for each.

Replay with `node qa/check_mission_clearance.mjs <frontend-origin>`. [Frontend tests](../../frontend/tests/mission-studio.test.ts) check two threshold crossings in one step, exact touches, missing neighbors, minute cadence and shadow limits. OpenAI Codex assisted this work and the plot regression. Both checks use [synthetic QA fixtures](../fixtures/).

| Fixture | SHA-256 |
| --- | --- |
| normal | `0f7773320fa3e8b3da60841aa88d02e9d03a34c213cbf0af9e441b724d0b92fb` |
| partial | `da3aeafc87838922dcfc4faf1ef6fe6f4cd881b748854860644b0ffa2940929a` |
| missing | `f84ff67bef6cd9f79b45e0ca51f2a59589a05e095e70bc9201bd77e5c321116f` |
| crossing_wrap | `9224dbd8ec958aa58ddbd03e0b4f8a9e39f026d719fefdf39b1009a419e21f18` |

At 08:22 UTC, Chromium reran both scripts and the [paired Horizons replay](../evidence/odysseus-athena-hour-gap/README.md) on the [integrated build](https://github.com/justsomenewbie/moon-plan-b/commit/f2f7599235e118010f0b8317c264f0721327655c). The same-origin dataset API returned HTTP 200 with both sites and the browser rendered the terrain summary. Importing the checked Horizons copy with only Athena’s 02:00 UTC sample removed broke both Athena paths. Odysseus kept both continuous paths. With either site primary, pressing Right then Left gave 01:00 → 03:00 → 01:00 UTC on both visible and accessible time labels. The integrated source passed all 72 frontend tests and eight offline QA gates.

## UI-02 import retest

At 08:02 UTC on 14 November 2026, Chromium 158.0.8127.18 exercised the [corrected importer](https://github.com/justsomenewbie/moon-plan-b/commit/8ddc9bb1421b70629ec71817a1029d0f539ffeff) at `/` on a local production build with the mock startup API. The browser used its default 1280 × 720 viewport. It started with the [paired Horizons gap copy](../evidence/odysseus-athena-hour-gap/gap.json), SHA-256 `7acb4779b02e8c743f9f04d5c69da5b51e33a31eb2f6b525d2d1a87851a0579b`, with Athena primary and Odysseus alternative at 03:00 UTC.

All five invalid fixture files, a separate unsupported schema version, malformed JSON, an empty file and a valid JSON document padded to 5 MiB + 1 byte produced focused error alerts. Each rejection preserved the dataset ID, both site selections, both exact-sample tables and the visible and accessible time labels. The next valid file, padded to exactly 5 MiB, replaced the dataset and cleared the alert. No uncaught page errors occurred.

Replay with `node qa/check_import_rejections.mjs <frontend-origin>` using Playwright Chromium. OpenAI Codex prepared the [browser test](../check_import_rejections.mjs) and the diagnostic changes.

## UI-07 browser retest

On 14 November 2026 at 07:41 UTC, Chromium 158.0.8127.18 at 1280 × 860 exercised the production frontend at [9234822](https://github.com/justsomenewbie/moon-plan-b/commit/9234822d3c34f395737c4e547616c22ba6bec6e4), route `/`. The [Horizons fixture](../evidence/odysseus-athena-hour-gap/gap.json) had SHA-256 `7acb4779b02e8c743f9f04d5c69da5b51e33a31eb2f6b525d2d1a87851a0579b`.

The [Playwright check](../check_globe_recovery.mjs) separately returned HTTP 404 for the map, served invalid JPEG bytes with HTTP 200, and made the globe canvas return a null 2D context. Each fault showed the photograph and an accessible retry control. With Athena primary and Odysseus alternative, both exact-sample tables and all four SVG paths matched the working globe. The slider still stepped from 01:00 to 03:00 UTC. After moving back to 01:00 and pressing Retry, the globe rendered again with the original comparison and time. No uncaught page errors occurred.

Replay with `node qa/check_globe_recovery.mjs <frontend-origin>` against a running production build. OpenAI Codex wrote and ran this check.

## Browser-to-JPL isolation evidence

Source inspection is only a first check. On a fresh browser session, capture requests while loading, importing all valid fixtures, comparing sites/timelines, retrying failed requests, opening API docs and exercising live jobs if enabled. Inspect automatic requests to `ssd.jpl.nasa.gov`, `ssd-api.jpl.nasa.gov`, Horizons endpoints and any proxy destination. Ordinary user navigation to source documentation is distinct from browser ephemeris queries.

For the requested static-only architecture, also verify the tested build reads only released static JSON for data; the existing same-origin job/API mode does not by itself meet that requirement. State the exercised mode and pending architecture decision. Browser isolation from JPL does not prove a server proxy respects the offline design.

Record observed domains, request initiator and count, cache/service-worker state, errors and retry behavior. Preserve a redacted HAR/screenshot outside public sources when it contains cookies or machine/account information; publish only reviewed minimal evidence. Zero calls in one trace covers only the paths actually exercised. Do not mark compliance from a grep result alone.

### Chromium live-API replay, 14 November 2026

At 07:47 UTC Chromium 158.0.8127.18 exercised the production frontend from [0c6b8ab](https://github.com/justsomenewbie/moon-plan-b/commit/0c6b8ab4adae263ad2fa92cce224a4b125e9b058). A fresh context with HTTP caching disabled recorded **66 HTTP requests, all to the frontend loopback origin**. There were zero external requests, WebSockets, worker targets or transport failures. The separate page DevTools stream recorded 46 parser, 10 script and 13 other initiator events. These are separate counts from the context requests.

- Loaded the live two-site result, injected one local dataset 404, clicked Retry and received the comparison again.
- Imported all four QA observation fixtures, both single-site and both paired Horizons control/gap copies, and the bundled demo. Swapped primary and alternative sites where available, stepped through sampled windows, verified the unavailable slider for missing data and selected a different date comparison.
- Submitted the previously exercised three-hour custom site once. The producer reused the cached job (HTTP 200). Opened the single-site result, reloaded its permalink and loaded the producer’s OpenAPI specification in the Swagger iframe.

| Browser API requests | Count and result |
| --- | --- |
| GET dataset | 4 × 200, 1 × injected 404 |
| GET capabilities | 1 × 200 |
| POST jobs / GET job status | 1 × 200 each |
| GET OpenAPI specification | 1 × 200 |

An independent replay returned the same counts. A separate two-port loopback control confirmed that the context listener detected a dedicated worker fetching from another origin. The configured Next.js rewrite forwarded `/api/*` to the team producer; its OpenAPI title was verified directly. This trace covers browser traffic on these flows. Upstream processing and other deployments require their own evidence.

To replay, run `node qa/check_browser_network.mjs <frontend-origin>` on a live-configured production build with Playwright Chromium. It submits one bounded request; cache reuse depends on the producer. The [test](../check_browser_network.mjs) prints counts without recording headers, bodies, machine addresses or job identifiers. OpenAI Codex prepared the test and evidence.
