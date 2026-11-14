# Frontend resilience — manual evidence checklist

The table records browser evidence. Minh’s original QA run exercised the importer and chart paths in Node. Record commit, dataset hash, UTC test time, browser/version, viewport, route, exact injection, observed result and evidence path for every row. Failures go to `../BUG_LOG.md` with owner and retest commit.

| ID | Procedure | Expected result | Status |
| --- | --- | --- | --- |
| UI-01 | Throttle initial data loading; change selection during pending load | Visible loading; no old data labeled as new; controls recover | [PASS in Chromium](#ui-01-pending-windows) |
| UI-02 | Import invalid JSON, each invalid fixture, wrong schema, >5 MiB and empty file | Accessible error, no crash or partial acceptance; prior valid dataset remains recoverable | [PASS in Chromium](#ui-02-import-retest) |
| UI-03 | Inject HTTP 404/500, network disconnect, timeout and truncated body on actual data route | Error/retry with bounded attempts; live mode must not silently show mocks | [PASS in Chromium](#ui-03-live-api-failures) |
| UI-04 | Import partial and missing fixtures | Unknown text and null metrics, broken lines across missing samples; no zero-filled darkness | [PASS in Chromium](#ui-04-and-ui-05-plot-retest) |
| UI-05 | Import crossing_wrap; inspect both sites and zero values | North seam does not draw a full-width spike; exact-zero displayed accurately | [PASS in Chromium](#ui-04-and-ui-05-plot-retest) |
| UI-06 | Switch English/Vietnamese and share/reopen selection | Same UTC `Z`, source identity, degrees/km and dataset version; English default retained | [PASS in Chromium](#ui-06-sharing-a-sample) |
| UI-07 | Block globe texture, simulate image decode failure and unavailable Canvas 2D context separately | Fallback/retry or explicit error; numeric tables and SVG charts still usable, selection retained | [PASS in Chromium](#ui-07-browser-retest) |
| UI-08 | If a WebGL renderer is introduced, deny WebGL and fire context-loss/recovery separately | Failure isolated from comparison/charts/table; retry or supported fallback | CONDITIONAL — current globe is Canvas 2D |
| UI-09 | Keyboard-only import/select/retry; zoom; 320px width; reduced motion | Visible focus, usable controls/labels, readable data; log actual screen-reader speech separately | [PASS in Chromium](#ui-09-keyboard-and-zoom); speech pending |
| UI-10 | Use malformed/old-version share links, absent site and mismatched windows | Clear incompatibility; no nearest-time substitution or invented result | [PASS in Chromium](#ui-10-invalid-workspace-links) |

## UI-09 keyboard and zoom

At 09:12 UTC on 14 November 2026, Playwright Chromium 158.0.8127.18 ran the [keyboard test](../check_keyboard_comparison.mjs) on the [production build](https://github.com/justsomenewbie/moon-plan-b/commit/5552b52228079df7f6c21b9e5865aed88d198608), route `/compare`, at 320 × 720 CSS pixels with reduced motion. A controlled 404 then a successful synthetic terrain response tested Retry with the same request URL. Tab and Enter followed the skip link to the alert, activated Retry and brought the result heading into view. On the previous build, focus moved to the tall results container but the heading was over 3,000 CSS pixels above the viewport at 320 × 700. Six additional replays with three fragment settings confirmed the heading remained visible. Moving focus to another control during the request preserved that focus.

Keyboard input opened the import dialog and file chooser. The [archived Horizons copy](../evidence/odysseus-athena-hour-gap/gap.json), SHA-256 `7acb4779b02e8c743f9f04d5c69da5b51e33a31eb2f6b525d2d1a87851a0579b`, supplied the observations. With Athena primary, both labels stepped 01:00 → 03:00 → 01:00 UTC and the English slider used “1 hour elapsed.” Playback was disabled under reduced motion. Both exact-sample tables remained keyboard-scrollable locally, with four Athena rows and five Odysseus rows.

A separate run of the same flow used actual Chromium tab zoom at 200% in a disposable profile. The outer window remained 640 pixels, the layout viewport narrowed to 320 CSS pixels, the device pixel ratio doubled and pinch scale remained 1. The page had no horizontal overflow. The focus indicators remained visible. Speech from a screen reader has not been tested. OpenAI Codex assisted the fixes and browser checks.

## UI-10 invalid workspace links

On 14 November 2026 at 08:54 UTC, Playwright ran Chromium 158.0.8127.18 at 1280 × 720 UTC on the live-mode [integrated build](https://github.com/justsomenewbie/moon-plan-b/commit/8e5ddee7473682cde08c9649dc6dbe1c8133de8f), route `/compare`. The test intercepted the same-origin dataset GET with a [synthetic terrain response](../browser-terrain-fixture.mjs). Local imports used the [paired Horizons copy](../evidence/odysseus-athena-hour-gap/gap.json), SHA-256 `7acb4779b02e8c743f9f04d5c69da5b51e33a31eb2f6b525d2d1a87851a0579b`, and the [demo](../../frontend/public/data/demo.json), SHA-256 `650bff2d8016a846fe1b330a93f1368e51def508864cec8878f0cc2979016722`.

Before the fix, an incomplete selection could display Odysseus at the default time, and Retry on an invalid observation link could silently load a different range. The [browser regression](../check_invalid_links.mjs) now verifies that missing versions, duplicate parameters, mixed live/imported fields, empty job IDs and unpinned live observations display an error with no dataset request. Stale release links keep their URL when supplied another dataset, including a terrain export. Missing scenarios, wrong duration, mismatched UTC windows and the absent Athena 02:00 sample display no comparison.

For a pinned live site absent from the response, Retry issued the same GET and kept the original URL. Explicitly choosing the loaded release’s defaults cleared an invalid selection. Supplying the requested archive on a valid link restored Athena and Odysseus at exactly 03:00 UTC. The homepage’s saved-report selector has its own documented default-week behavior. Replay with `node qa/check_invalid_links.mjs <live-mode-frontend-origin>`. OpenAI Codex assisted the corrections and test.

## UI-06 sharing a sample

On 14 November 2026 at 08:44 UTC, Chromium 158.0.8127.18 tested the [shared-sample fix](https://github.com/justsomenewbie/moon-plan-b/commit/c73a884ea794beffaf0e3d94eb7e83ddde942a0b) at 1280 × 720 in the Asia/Ho_Chi_Minh timezone. The [browser replay](../check_shared_sample.mjs) imported the archived [paired Horizons copy](../evidence/odysseus-athena-hour-gap/gap.json), SHA-256 `7acb4779b02e8c743f9f04d5c69da5b51e33a31eb2f6b525d2d1a87851a0579b`. Only Athena lacks the 02:00 UTC sample on January 7. The test intercepted the initial API request with a 404, then used the normal local import and share controls.

With Athena primary and Odysseus alternative, the English and Vietnamese clocks, slider labels and sky timestamp all showed 03:00 UTC. Before the fix, reopening the shared URL and supplying the same file reset the clocks to 00:00. The new link restored 03:00 in another Vietnamese tab; after pressing Left and sharing again, a clean browser context defaulted to English and restored 01:00. The source links, four Horizons raw hashes, site coordinates in degrees, heights in km, schema and dataset ID matched the imported file. Changing the link to 02:00 produced an error and no selected sample. Imported releases still travel separately from their links. An independent Chromium run with the bundled demo on November 14 and 15 restored 03:00 UTC on each date. Removing the optional sample field reopened each date at 00:00 UTC.

Replay with `node qa/check_shared_sample.mjs <live-mode-frontend-origin>`. The [dataset tests](../../frontend/tests/dataset.test.ts) also cover different dates, missing offsets and older links. OpenAI Codex implemented the link change and regression.

## UI-01 pending windows

On 14 November 2026 at 08:37 UTC, Chromium 158.0.8127.18 (1280 × 720, UTC) tested the [history fix](https://github.com/justsomenewbie/moon-plan-b/commit/974175e76d599e72e1ce1843d2bfb8604be738ac) at `/` on a local production build configured for the live API. Playwright intercepted the dataset GET and held the January 1 response. The loading heading remained visible, both load and import were disabled, and the saved-results selector still switched to Athena. Both cards showed Athena’s saved results. The live workspace displayed no result during loading.

Browser Back first undid the saved selection, then opened January 2 at 02:00 UTC with Athena pinned. January 2 completed before January 1. Neither a late successful response nor a late 404 for January 1 replaced the selected run, UTC, range or URL. Back to January 3 then returned a current 404. Before the fix, January 2’s terrain plot and table reappeared under the January 3 address. After the fix, the error appeared without the previous live result. One manual retry rendered January 3 at 00:00 UTC and re-enabled the controls. Each replay made four dataset requests.

The intercepted fixtures are synthetic. SHA-256 of the January 1, 2 and 3 JSON responses, respectively: `05392b6ce87f76f9db8a655f0cbe0bb9ec887ba847527f604bc3de5ab1ae2c1e`, `23e936ec82f5ee5286615ae2dff25afa41655de8c1e805d679ed7d06c1488cce`, `f398e4c0f6998606e4578ef3bf44bd13a36e877c97a35da80518d03a9f9ccffb`. OpenAI Codex wrote the [regression](../check_pending_windows.mjs) and the fix. Replay with `node qa/check_pending_windows.mjs <live-mode-frontend-origin>`.

## UI-03 live API failures

On 14 November 2026 at 08:31 UTC, Playwright opened a pinned Athena result at 02:00 UTC on a local live-mode production build (Chromium 158.0.8127.18, 1280 × 720). The [regression](../check_pinned_retry.mjs) intercepts the same-origin `GET /api/v1/dataset`. Each case starts in a fresh browser context. On the [integrated revision](https://github.com/justsomenewbie/moon-plan-b/commit/3878e1107e58e5da453e11c4da061fcb8a00d72b), the successful synthetic response has SHA-256 `0950b2162f5486a30cc741042116cec8eaf38d0b40e7d28b405cbefe64be8dbd`.

| Injected fault | Requests before the error alert | Observed behavior |
| --- | --- | --- |
| HTTP 404 with a problem detail | 1 | Showed the server's detail immediately. |
| HTTP 500 with a problem detail | 3 | Showed the detail after two automatic retries. |
| Browser switched offline during the first request, dataset connections aborted | 3 | Showed the connection error and enabled local file import while the browser was still offline. Rejecting an invalid local file preserved the pinned retry. |
| HTTP 200 with an incomplete JSON object | 3 | Displayed an actionable error in English and Vietnamese. |
| No response to each of three requests | 3 | Each reached the frontend's real 15-second deadline. The final alert appeared after 47.2 seconds. |

After each fault, one manual retry recovered the same requested run, site selection, saved comparison, cadence and exact UTC. While the error was visible, the workspace showed neither a terrain result nor a synthetic timeline. The browser made no request for the demo JSON. These injections exercise client recovery. An independent smoke check reached the live backend and rendered the two-site dataset.

Replay with `node qa/check_pinned_retry.mjs <live-mode-frontend-origin>`. Allow about one minute for the five cases. OpenAI Codex extended the regression and corrected the offline and malformed-response paths.

## UI-04 and UI-05 plot retest

On 14 November 2026 at 08:19 UTC, Playwright ran Chromium 158.0.8127.18 at 1280 × 720 on the production frontend at `/` with mock startup and imported fixtures. The [plot fix](https://github.com/justsomenewbie/moon-plan-b/commit/2dc97be8798dade778e51c989707f20c58b16194) removes a 1.5-step tolerance from the polar skyplot. On the old build, moving the partial basin's 01:00 sample to 01:15 joined both polar trails across 75 minutes despite the 60-minute cadence. The elevation chart already broke there. The corrected polar plot breaks both trails at that gap.

With the original partial and missing fixtures, all six summary values and interval labels reported unavailable. The exact-sample table retained Earth when only Sun was missing. The empty windows had no markers and a disabled slider. With `crossing_wrap`, the polar trails broke across north in both directions. A genuine 0° Sun lay exactly on the horizon ring. The [browser regression](../check_observation_plots.mjs) checks both sites. Replay with `node qa/check_observation_plots.mjs <frontend-origin>`.

## Horizon clearance and direction diagram

Minh introduced these controls in [d32bdd6](https://github.com/justsomenewbie/moon-plan-b/commit/d32bdd6c385de9f117fe529c0fd7df57a4a3e997). Chromium verified the [corrections](https://github.com/justsomenewbie/moon-plan-b/commit/d67d917ec819f6ddf1e5f0a2ba2f317a2f48ab09) at 08:19 UTC on the same build and viewport. The slider moved the threshold in both plots, both sites retained their original producer totals, and switching English/Vietnamese retained the selected angle and duration. At Sun elevations of 0.2° and 1°, the displayed ideal shadow lengths were 286.5 and 57.29 object heights. Neither a missing sample row nor a null Sun filled either neighboring ribbon interval. An absent body had no hardware direction. An independent browser replay also opened the two sites’ interval details in turn and verified the UTC list for each.

On 14 November at 09:03 UTC, Chromium 158.0.8127.18 exercised the [combined production build](https://github.com/justsomenewbie/moon-plan-b/commit/65b7375eebc790abbd342af54cc4f0f268b3a05d) on `/compare`. The side view previously drew body rays and the clearance edge at different angular scales. At 0.2° solar elevation the rendered ray now sits above a 0.1° mask, on a 0.2° mask and below a 0.5° mask. The accessible state and dash style agreed. The partial fixtures each showed a two-hour unavailable interval from 01:00 to 03:00 UTC. The empty fixtures each showed four hours unavailable. The test switched between one and both observations and retained the chosen threshold and reference duration across English and Vietnamese.

On the [display fix](https://github.com/justsomenewbie/moon-plan-b/commit/0c634f2), Chromium showed the complete two-line side-view caption in both languages and five distinct system-color legend patterns. The 1280px and 320px layouts had no horizontal overflow. The seven-page A4 PDF contained both site names, the reference duration, states and direction panel. On the combined build the [paired Horizons replay](../evidence/odysseus-hour-gap/check.mjs) checked both site orders through the import dialog. Only Athena’s two paths broke at 02:00 UTC. Both clocks stepped 01:00 → 03:00 → 01:00 and every plotted value matched the archived source. A separate live startup request returned both producer sites with HTTP 200.

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
