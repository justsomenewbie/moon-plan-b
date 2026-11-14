# Frontend resilience — manual evidence checklist

The table records browser evidence. Minh’s original QA run exercised the importer and chart paths in Node. Record commit, dataset hash, UTC test time, browser/version, viewport, route, exact injection, observed result and evidence path for every row. Failures go to `../BUG_LOG.md` with owner and retest commit.

| ID | Procedure | Expected result | Status |
| --- | --- | --- | --- |
| UI-01 | Throttle initial data loading; change selection during pending load | Visible loading; no old data labeled as new; controls recover | NOT RUN |
| UI-02 | Import invalid JSON, each invalid fixture, wrong schema, >5 MiB and empty file | Accessible error, no crash or partial acceptance; prior valid dataset remains recoverable | NOT RUN |
| UI-03 | Inject HTTP 404/500, network disconnect, timeout and truncated body on actual data route | Error/retry with bounded attempts; live mode must not silently show mocks | NOT RUN |
| UI-04 | Import partial and missing fixtures | Unknown text and null metrics, broken lines across missing samples; no zero-filled darkness | NOT RUN |
| UI-05 | Import crossing_wrap; inspect both sites and zero values | North seam does not draw a full-width spike; exact-zero displayed accurately | NOT RUN |
| UI-06 | Switch English/Vietnamese and share/reopen selection | Same UTC `Z`, source identity, degrees/km and dataset version; English default retained | NOT RUN |
| UI-07 | Block globe texture, simulate image decode failure and unavailable Canvas 2D context separately | Fallback/retry or explicit error; numeric tables and SVG charts still usable, selection retained | [PASS in Chromium](#ui-07-browser-retest) |
| UI-08 | If a WebGL renderer is introduced, deny WebGL and fire context-loss/recovery separately | Failure isolated from comparison/charts/table; retry or supported fallback | CONDITIONAL — current globe is Canvas 2D |
| UI-09 | Keyboard-only import/select/retry; zoom; 320px width; reduced motion | Visible focus, usable controls/labels, readable data; log actual screen-reader speech separately | NOT RUN |
| UI-10 | Use malformed/old-version share links, absent site and mismatched windows | Clear incompatibility; no nearest-time substitution or invented result | NOT RUN |

## UI-07 browser retest

On 14 November 2026 at 07:41 UTC, Chromium 158.0.8127.18 at 1280 × 860 exercised the production frontend at [9234822](https://github.com/justsomenewbie/moon-plan-b/commit/9234822d3c34f395737c4e547616c22ba6bec6e4), route `/`. The [Horizons fixture](../evidence/odysseus-athena-hour-gap/gap.json) had SHA-256 `7acb4779b02e8c743f9f04d5c69da5b51e33a31eb2f6b525d2d1a87851a0579b`.

The [Playwright check](../check_globe_recovery.mjs) separately returned HTTP 404 for the map, served invalid JPEG bytes with HTTP 200, and made the globe canvas return a null 2D context. Each fault showed the photograph and an accessible retry control. With Athena primary and Odysseus alternative, both exact-sample tables and all four SVG paths matched the working globe. The slider still stepped from 01:00 to 03:00 UTC. After moving back to 01:00 and pressing Retry, the globe rendered again with the original comparison and time. No uncaught page errors occurred.

Replay with `node qa/check_globe_recovery.mjs <frontend-origin>` against a running production build. OpenAI Codex wrote and ran this check.

## Browser-to-JPL isolation evidence

Source inspection is only a first check. On a fresh browser session, capture requests while loading, importing all valid fixtures, comparing sites/timelines, retrying failed requests, opening API docs and exercising live jobs if enabled. Inspect automatic requests to `ssd.jpl.nasa.gov`, `ssd-api.jpl.nasa.gov`, Horizons endpoints and any proxy destination. Ordinary user navigation to source documentation is distinct from browser ephemeris queries.

For the requested static-only architecture, also verify the tested build reads only released static JSON for data; the existing same-origin job/API mode does not by itself meet that requirement. State the exercised mode and pending architecture decision. Browser isolation from JPL does not prove a server proxy respects the offline design.

Record observed domains, request initiator and count, cache/service-worker state, errors and retry behavior. Preserve a redacted HAR/screenshot outside public sources when it contains cookies or machine/account information; publish only reviewed minimal evidence. Zero calls in one trace covers only the paths actually exercised. Do not mark compliance from a grep result alone.
