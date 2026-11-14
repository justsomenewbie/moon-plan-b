# Sources, permissions and AI contributions

## Team-authored implementation

Codex generated and revised the frontend implementation, runtime validator, tests, documentation and synthetic demonstration fixture after the recorded event start. Independent Codex reviewers inspected code, checked the fixture numerically and reran tests. Built-in Image Gen generated an internal design concept labeled as AI-generated; that raster is not shipped in the app. The app's simple icon and scientific diagrams are code-native SVG, also AI-assisted. No generated content includes NASA branding.

The proposal had AI-assisted history before implementation. Preserve that history in submission disclosure. The NASA guide's condition about SI supplying solution ideas remains unresolved for this history; no originality or award-eligibility declaration is made here.

## Scientific material

`frontend/public/data/demo.json` is **synthetic, not lunar data**. It includes no real location or observational source claims. JPL Horizons documentation informed intended field labels and limits, not fixture values. Sources attached to a future imported release must identify the exact data/resource actually used and its permitted distribution. An empty Sources list must not be replaced with decorative NASA links to imply data use.

Reference documentation: [JPL Horizons manual](https://ssd.jpl.nasa.gov/horizons/manual.html#observer-table), [W3C guidance for complex images](https://www.w3.org/WAI/tutorials/images/complex/), [Next.js installation](https://nextjs.org/docs/app/getting-started/installation), [Tailwind Next.js setup](https://tailwindcss.com/docs/installation/framework-guides/nextjs).

## Dependency permissions

The application uses published npm packages through their normal distribution, pinned in `frontend/package-lock.json`. Direct packages: Next.js 16.4.6 (MIT), React/React DOM 19.3.1 (MIT), Tailwind CSS and its PostCSS plugin 4.3.5 (MIT), PostCSS 8.5.32 (MIT), TanStack React Query 5.107.1 (MIT) and openapi-fetch 0.17.0 (MIT). Development tools: TypeScript 5.9.3 (Apache-2.0), openapi-typescript 7.13.0 (MIT), MSW 3.0.5 (MIT), Swagger UI dist 5.35.0 (Apache-2.0) and DefinitelyTyped Node/React type declarations (MIT). TypeScript 5.9.3 satisfies the generator's declared peer requirement. Preserve package copyright/license files and required notices when redistributing dependencies or a release bundle; see the retained [third-party notices](THIRD_PARTY_NOTICES.txt).

Swagger assets are copied locally during preparation, with their license; online validation is disabled. Install with `npm ci --ignore-scripts` to avoid dependency lifecycle telemetry, then run the explicit project generation/build commands. MSW's generated service worker retains its upstream notice. The OpenAPI proposal, mock behavior and generated-type integration were AI-assisted. API conventions came from Chung's rules supplied by Sơn; the exact endpoints and payload remain an unagreed frontend proposal.

System fonts are used; no external web font, soundtrack, 3D model or copied UI component is included. The project-level license is still a team decision; public GitHub visibility is not permission to reuse team code. Hosting and final release require the corresponding license/submission checks.

## Lunar reference image — 14 November 2026

The hero uses the existing [Moon Mosaic, NASA SVS ID 5001](https://svs.gsfc.nasa.gov/5001/), released 5 May 2022. Credit: **NASA's Scientific Visualization Studio**. It combines LRO Narrow Angle Camera images collected in 2018; it is a photographic mosaic, not AI-generated imagery. The app labels it as context, separate from current illumination, selected-site evidence and synthetic comparison values.

Original [1024 × 1024 JPEG](https://svs.gsfc.nasa.gov/vis/a000000/a005000/a005001/moon_mosaic_print.jpg) retained unchanged as `frontend/public/images/moon-mosaic.jpg`: 252,499 bytes, SHA-256 `36fbe604043f1403acbc4db6fbd36d04db1db1c8a3749aa81d1e6ffea072a5fa`. Retrieved and visually inspected 14 November 2026. Display scales it within a circular frame; no generated pixels, logos or people were added.

Permission basis checked on that date: [SVS reuse FAQ](https://svs.gsfc.nasa.gov/help/) permits reuse/redistribution unless an item states otherwise; the item shows no separate restriction. [NASA media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/) permit factual educational/informational web use with acknowledgment and no implied endorsement, excluding marked third-party copyrighted works. This supports the educational app, linked source repository and informational demo/judging use of this item, not an eligibility declaration or permission for unrelated branding/merchandise. Preserve its credit/source if reused in slides or recordings.

Codex implemented the appearance controls, layout and reference links. No AI image generation was used for this refresh. The synthetic dataset and AI-assisted proposal history remain unchanged.

### Notice recovery check — 14 November 2026

Ten installed package entries lack package-root license/notice files. The notice file now retains five upstream repository license texts covering six of those entries: `@next/env` and `@next/swc-darwin-arm64` 16.4.6, `@redocly/openapi-core` 1.34.24, `@tailwindcss/oxide-wasm32-wasi` 4.3.5, `@napi-rs/wasm-runtime` 1.2.2 and `change-case` 5.4.4. Each supplement records its exact source commit, Git blob hash and package-version association. Registry `gitHead` identifies three sources; Next.js and Tailwind use resolved official version tags. These are upstream supplements, not files found in the npm installation. Original retained notices are unchanged.

Four entries still lack complete retained notices:

| Package | Verified source and remaining gap |
| --- | --- |
| `@img/sharp-libvips-darwin-arm64@1.3.4` | Its installed README's library/license table is retained verbatim. The [exact upstream README](https://github.com/lovell/sharp-libvips/blob/ebb95f8add54eee8bed840e3fb587e4cbec857d7/README.md) distinguishes Apache-2.0 packaging scripts from the libraries' various licenses. Copying that repository's Apache license would not resolve the native binary's full notices or corresponding-source requirements. |
| `@tybys/wasm-util@0.10.3` | [Exact npm gitHead package metadata](https://github.com/toyobayashi/wasm-util/blob/efb17cc128a30fb16b58127738f09c8871a3f7d1/package.json) declares MIT. The installed package and complete upstream tree contain no license/notice file; no full version-matched notice was recovered. |
| `client-only@0.0.1` | [Exact npm metadata](https://registry.npmjs.org/client-only/0.0.1) declares MIT but supplies no repository or gitHead. Its three-file archive contains no license/copyright notice. No parent-project copyright was assumed. |
| `is-node-process@1.2.0` | [Exact tagged source](https://github.com/mswjs/is-node-process/blob/8a6152c795d8705be97166bd5167e70ac6efc67c/package.json) declares MIT; shipped source maps match that source. Neither the seven-file archive nor the complete tagged tree contains a license/notice file. |

This check records evidence, not a completed release-license audit. The supplements do not establish notice coverage for every dependency compiled into native or JavaScript bundles. Before distributing a runnable release, inspect the actual target-platform artifact, retain its required notices/source arrangements and resolve the remaining gaps. No dependencies were removed or upgraded, no generic copyright was invented, and no maintainer was contacted. External evidence is listed in `FRONTEND_VERIFICATION.md`.
