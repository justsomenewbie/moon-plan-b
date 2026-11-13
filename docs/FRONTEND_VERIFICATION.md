# Frontend verification — 14 November 2026

Scope: local frontend and a **proposed** API contract. No agreed backend schema, real Colab export, scientific validation, deployment or submission is established. Tests used synthetic data. English UI, provenance disclosures and AI attribution are present.

## Verified behavior

| Check | Result and limit |
| --- | --- |
| Node / packages | Node 24.22.3 official archive hash checked; exact package lock. Clean `npm ci --ignore-scripts` passes in 4 seconds, followed by all 17 test groups. TypeScript 5.9.3 satisfies the OpenAPI generator's peer range. Dependency scripts disabled during install. |
| Unit/API tests | 17 groups pass: malformed dates/angles/links/coverage, compatible comparisons, share state, gaps, interval consistency and linear work; typed API calls through MSW, bounded/empty ranges, all job states, malformed 202 IDs, problem responses, oversized responses and retry/poll decisions. |
| Type generation / build | OpenAPI 3.1 generates API types; `next typegen`, strict TypeScript and production build pass. Generated schema is committed; static spec, Swagger assets and worker are reproducibly prepared. |
| Chromium | Chromium 158.0.8127.18 production preview passes identity, content, comparison modes, keyboard slider, missing/partial data, import acceptance/rejection, share restoration, empty/error/retry/loading states and job progress. No unexpected console/page errors in recorded passes. |
| Job lifecycle | Actual MSW POST 202 → queued → running → done, 1.5-second polling, no extra polls during the observed 3.3 seconds after completion. Failed state and polling stop also covered by API tests. |
| Recovery regressions | Empty requested range returns to the default demonstration. Completed job range A survives a later range B request, opening A, sharing and reload. Old fixture release IDs reject clearly. |
| Responsive / print | Browser widths 320, 390, 768 and 1488 CSS pixels checked for page overflow; desktop/mobile screenshots inspected. Extended A4 report is four pages; all four rendered pages visually reviewed, including repeated table headers, sources and synthetic attribution. This is not a one-page report. |
| API documentation | Local Swagger UI displays the draft and executes a bounded request through MSW, HTTP 200 with four scenarios. No CDN, external fonts or online Swagger validator. Upstream bundle license and NOTICE are retained. |
| Request deadlines | Actual local HTTP tests stalled headers and body separately: ApiError 504 after 15,009 ms and 15,003 ms. Caller cancellation preserved. Measurements are this Mac's Node run, not a device guarantee. |
| Proxy / real-mode code path | A separate local backend substitute, without CORS headers, received requests through Next rewrites; browser had no MSW registration. Backend OpenAPI superseded bundled draft. Completed-job link reopened via GET without a second POST. This does **not** verify Chung's backend. |
| Advisories | npm audit: zero known findings. OSV explicit lock scan: 186 packages, zero results. Point-in-time advisory checks do not certify dependencies. |
| Secrets / generated artifacts | Gitleaks fully redacted scan of the intended 37-file source snapshot (608.79 KB): no leaks. Initial available Git history also passed. OpenAPI example equals the fixture; generated spec, MSW worker, Swagger assets and their notices match source bytes. |

The first browser recovery failure and two harness locator problems were retained in local evidence, corrected and retested. An empty Next development route-announcer alert caused an initial proxy-harness false failure; the check was narrowed to application error panels, then passed. No application failure was hidden by weakening an acceptance condition.

## Security review

Formal Codex Security diff scan `ac043bff-7c63-40c4-919f-26f3fff01f31` covered the **pre-API-migration snapshot** `859c9967445ff368b47c61d8bedb68ae2e98bf1aff160ecd10e5322ff9751c58`: all 11 prepared items / 13 semantic surfaces. It found one low/P3 issue: repeated interval searches could stall an importing tab. Original-validator 100/500/1000-interval cases took 23/485/2074 ms; the 10,000 case was not executed. The fix uses cached timestamps and monotonic cursors, with a regression that bounds timestamp work linearly. The sealed report remains historical and is not represented as a scan of later code.

A separate independent engineering review covered the API migration and identified missing job-ID type validation, missing request deadline and stale range in job-result sharing. Those fixes passed targeted tests and browser checks. No second formal scan or remote offensive testing was performed. Source checks cover the actual browser import, render, query, proxy configuration and request boundaries; scientific authenticity is outside that scope.

Tool-reported formal-scan rollout usage: 17,940,344 total tokens, comprising 17,877,207 input (17,483,648 cached) and 63,137 output across three threads. This is the tool's rollout aggregate, not unique context, money spent or the incremental cost of one fix.

## Design and tool coverage

The original internal Image Gen reference informed the deep-ink background, warm Sun/cool Earth palette, left-side comparison controls, central timeline and compact comparison table. The implemented version adds actual release/UTC labels, exact-value tables, conspicuous synthetic disclosure and collapsible API/job controls. These are intentional information requirements. No generated reference raster is shipped. Native SVG/CSS is sufficient; 3D/animation/video/audio routes were assessed and deferred pending validated data and a requested deliverable.

Used Google Drive to read Chung's rules, official package/docs research, frontend builder/testing/React guidance, data-visualization/accessibility guidance, Context Mode for selected long preparation sources, GitHub read checks, multi-agent source/browser review, Codex Security, Gitleaks/advisory tooling and Agent SkillGuard for selected skills. CodeGraph was skipped because no index exists. Browser plugin unavailable; existing scoped Playwright/Chromium provided the checked fallback. No blanket tool invocation, paid provider, deployment or external teammate message occurred.

Local raw evidence is outside the public source tree at `/Users/nns/Documents/ChatGPT/nasa-preparation-deliverables/frontend-kickoff-2026-11-14/`, including `api-browser-review.json`, `api-browser-regression-results.json`, `api-deadline-results.json`, `backend-browser-results.json`, audit files and print captures. These paths do not exist automatically on another host.

## Remaining limits

Native Safari 26.6.2 follow-up used a separate test window and the published `76fd327` preview. Comparison switching, a share link reopened in a new test tab with its original sites/range/release, and empty-range recovery passed. The native print dialog showed four A4 pages; all four page thumbnails were inspected, without printing. This does not replace the earlier full-page Chromium PDF review. Existing user tabs were not edited.

Two Safari checks remain unresolved: the file picker kept Upload disabled for the readable `.json` fixture, and a responsive toolbar value of 320 × 800 still rendered two control columns rather than the expected one. Source and live CSS checks did not explain either observation. A refresh corrected an initially inconsistent selected-button appearance. Window closure was attempted but not confirmed; subsequent native app/screenshot calls timed out. No permissions or system preferences were changed, and another browser's results are not counted as Safari evidence. Native keyboard/select behavior, complete Safari console capture and physical mobile devices remain unverified.

## Sky-track gap correction

A later independent source review and root reproduction found that the sky-position track connected samples across a time gap larger than `sampleStepSeconds`, although the elevation timeline correctly broke it. A validated synthetic partial fixture omitting the 09:00 sample reproduced a false segment from 06:00 to 12:00 at a nominal three-hour cadence. `skyPath` now starts a new segment after such gaps while preserving null and north-wrap breaks. The regression asserts the actual SVG move command, not only the segment count.

All **18 unit/API test groups** and the production build, including TypeScript, passed after this correction. An independent reviewer read the full code/test diff and reran all 16 dataset tests. The rebuilt production app at `http://127.0.0.1:3014/` was checked through CUA's separate in-app browser: a local synthetic import succeeded; both rendered SVG paths broke at the omitted sample; meaningful page content and the updated explanation were present; captured error/warning logs were empty. At an actual 320 CSS-pixel viewport the controls used one column and the page had no horizontal overflow. Desktop and narrow screenshots were inspected. The temporary tab was closed and its viewport override reset. This is not a Safari pass.

Evidence outside the repository: `sky-gap-before.json`, `sky-gap-fixture.json`, `sky-gap-after.jpg`, `sky-gap-after-320.jpg` and `sky-gap-verification.json` in the local evidence directory above. No contract, package, production fixture or scientific-source change was needed.

Real source accuracy, backend contract agreement, retained job access/expiry, deployment exposure, accessibility with assistive technology and production load remain unverified. Third-party notices retain package files from the local installation snapshot; ten entries in that inventory lack root notice files. This is not a completed binary-distribution license audit. A team project license and the recorded AI-origin submission question still need resolution before release.
