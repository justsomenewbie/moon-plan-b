# Local web deep test and creative enhancement report

Date: 2026-11-14 (UTC+07:00)

Branch: `Minh`
Scope: frontend-only synthetic baseline; no connected producer backend

## Result

The existing comparison flow remains valid and three judge-facing enhancements were added without moving scientific computation into the browser:

1. The timeline now highlights producer-supplied `intervals.simultaneous` as **Golden window** bands for both scenarios. It does not derive or repair boundaries.
2. The previous Cartesian sky schematic is now an accessible polar lunar skyplot: north-up, east-right, ideal horizon at the rim, zenith at the center, Sun circle, Earth square, and gap/north-wrap-safe trails.
3. `?qa=true` opens a local QA & Judge Inspector. It reports schema/evidence/coverage, identifies supplied scenarios with horizon crossings or north wrap, and switches through complete/partial/missing scenarios using the normal validated selection path. The query flag survives local selection resets.

## Existing behavior exercised

- Dataset validation: strict UTC `Z`, ordered samples, angle bounds, coverage rules, interval containment, source safety and provenance gates.
- Comparison: date mode, same-UTC site mode, supplied thresholds, partial/missing states, exact samples and exact half-open intervals.
- Resilience: import validation, API loading/error/retry states, Canvas Moon fallback implementation, responsive CSS and reduced-motion handling.
- Compliance boundary: browser code uses same-origin `/api/v1/*`; it does not call JPL Horizons. Synthetic content remains conspicuously labeled.

## Automated evidence

- Frontend Node tests: **34 passed**, 0 failed.
- Offline QA runner: fixture reproducibility, Python edge tests, manifests, release-negative control and frontend integration all passed.
- Type generation and `tsc --noEmit`: passed.
- Next.js production build: passed; `/`, `/api-docs` and static assets generated.
- Live Edge verification on `localhost:3001`: QA panel rendered after hydration, Golden window rows and polar skyplot exposed accessible descriptions, missing coverage displayed unavailable intervals, and `qa=true` survived scenario selection.
- QA gate output remains intentionally: `PASS; product release: NOT_GRANTED`.

## Scientific edge cases

The existing QA package covers strict elevation `> 0°`, half-open `[start,end)` intervals, `0°` contact, `-0.01°/+0.01°` crossing, missing cadence, azimuth north wrap, duplicate/offset timestamps, corrupted fields and reproducible manifests. New skyplot trails split on gaps and `>180°` azimuth changes. Golden bands display only validated supplied intervals.

## How to review

1. Open `http://localhost:3001/?qa=true`.
2. Use the inspector scenario buttons to move through complete, partial and missing coverage.
3. Inspect the Golden window row below the elevation chart.
4. Move the timeline slider and verify the polar skyplot and exact numeric readout update together.
5. Switch to Vietnamese and a narrow viewport; exact UTC values and scientific identifiers must remain unchanged.

## Known limits and unresolved gates

- All bundled observations remain fictional synthetic fixtures. They are not Shackleton, de Gerlache, Malapert or Apollo 11 observations.
- No readiness score was invented. It requires a reviewed producer field, formula/version and unknown-state semantics in the OpenAPI contract.
- Artemis/STEM named presets were not added because no sourced named-site release exists; disabled storytelling would not exercise science.
- The app uses Canvas 2D, not WebGL. Existing fallback code handles image/context failure, but a new browser-level forced-failure recording is still pending.
- A static search supports zero direct JPL calls, but an exercised Playwright network capture is pending.
- Leap-boundary, spoken screen-reader and final mobile-device evidence remain pending. Edge was exercised on the host configured for UTC+07, but a dedicated clock-boundary recording remains pending.
- Current host Node is 24.22.1, below the declared minimum 24.22.3. Tests/build passed, but this does not waive the engine requirement.
- Chung's Python/OpenAPI wire contract remains unagreed. Do not connect or rename fields until the integration owner reviews it.

## Release decision

Suitable for local judging/demo review with synthetic labeling. Not approved as a scientific product or competition release until real NASA/JPL-derived data, provenance, independent sample checks, contract agreement and remaining browser evidence are supplied.
