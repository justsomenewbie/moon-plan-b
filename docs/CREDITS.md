# Sources, permissions and AI contributions

## Team-authored implementation

Codex generated and revised the frontend implementation, runtime validator, tests, documentation and synthetic demonstration fixture after the recorded event start. Independent Codex reviewers inspected code, checked the fixture numerically and reran tests. Built-in Image Gen generated an internal design concept labeled as AI-generated; that raster is not shipped in the app. The app's simple icon and scientific diagrams are code-native SVG, also AI-assisted. No generated content includes NASA branding.

Codex assisted the bilingual home and astronaut guide, site selection, globe zoom and sky comparison controls. OpenAI Codex scripted an original fictional astronaut in Blender for the 60 × 70 px guide button. Its 34 rendered poses use a sculpted suit, a copper visor with two animated cyan indicators and separate head, shoulder, elbow and wrist motion. The still image and wave frames carry a visible AI label and embedded source metadata. Earlier versions used NASA/Michael D. Carbajal’s [EMU model](https://science.nasa.gov/3d-resources/extravehicular-mobility-unit/) and the [MakeHuman hm08 mesh](https://github.com/makehumancommunity/makehuman/blob/a8bc2d54ff0ac92e78ff71431b1023eda42bf482/makehuman/data/3dobjs/base.obj) under [CC0](licenses/MakeHuman-CC0.md). The guide uses prepared explanations and reports time-stamped values from the saved model or loaded terrain result. Codex assisted the UTC lookup, chat integration and tests. For free-text questions, a separately installed Qwen2.5 7B model served by Ollama identifies the topic and relevant data rows. The app formats the answer using the selected model results and source IDs. Neither the inference runtime nor the model weights are distributed in this repository.

The proposal had AI-assisted history before implementation. Preserve that history in submission disclosure. The NASA guide's condition about SI supplying solution ideas remains unresolved for this history; no originality or award-eligibility declaration is made here.

## Scientific material

`frontend/public/data/demo.json` is **synthetic, not lunar data**. It includes no real location or observational source claims. JPL Horizons documentation informed intended field labels and limits, not fixture values. Sources attached to a future imported release must identify the exact data/resource actually used and its permitted distribution. An empty Sources list must not be replaced with decorative NASA links to imply data use.

Reference documentation: [JPL Horizons manual](https://ssd.jpl.nasa.gov/horizons/manual.html#observer-table), [W3C guidance for complex images](https://www.w3.org/WAI/tutorials/images/complex/), [Next.js installation](https://nextjs.org/docs/app/getting-started/installation), [Tailwind Next.js setup](https://tailwindcss.com/docs/installation/framework-guides/nextjs).

## Dependency permissions

The application uses published npm packages through their normal distribution, pinned in `frontend/package-lock.json`. Direct packages: Next.js 16.4.6 (MIT), React/React DOM 19.3.1 (MIT), Tailwind CSS and its PostCSS plugin 4.3.5 (MIT), PostCSS 8.5.32 (MIT), TanStack React Query 5.107.1 (MIT) and openapi-fetch 0.17.0 (MIT). Development tools: TypeScript 5.9.3 (Apache-2.0), openapi-typescript 7.13.0 (MIT), MSW 3.0.5 (MIT), Swagger UI dist 5.35.0 (Apache-2.0) and DefinitelyTyped Node/React type declarations (MIT). TypeScript 5.9.3 satisfies the generator's declared peer requirement. Preserve package copyright/license files and required notices when redistributing dependencies or a release bundle; see the retained [third-party notices](THIRD_PARTY_NOTICES.txt).

Swagger assets are copied locally during preparation, with their license; online validation is disabled. Install with `npm ci --ignore-scripts` to avoid dependency lifecycle telemetry, then run the explicit project generation/build commands. MSW's generated service worker retains its upstream notice. The OpenAPI proposal, mock behavior and generated-type integration were AI-assisted. API conventions came from Chung's rules supplied by Sơn; the exact endpoints and payload remain an unagreed frontend proposal.

System fonts are used; no external web font, soundtrack, 3D model or copied UI component is included. The project-level license is still a team decision; public GitHub visibility is not permission to reuse team code. Hosting and final release require the corresponding license/submission checks.

## Lunar reference image — 14 November 2026

The lunar comparison uses the existing [Moon Mosaic, NASA SVS ID 5001](https://svs.gsfc.nasa.gov/5001/), released 5 May 2022. Credit: **NASA's Scientific Visualization Studio**. It combines LRO Narrow Angle Camera images collected in 2018; it is a photographic mosaic, not AI-generated imagery. The app labels it as context, separate from current illumination, selected-site evidence and synthetic comparison values.

Original [1024 × 1024 JPEG](https://svs.gsfc.nasa.gov/vis/a000000/a005000/a005001/moon_mosaic_print.jpg) retained unchanged as `frontend/public/images/moon-mosaic.jpg`: 252,499 bytes, SHA-256 `36fbe604043f1403acbc4db6fbd36d04db1db1c8a3749aa81d1e6ffea072a5fa`. Retrieved and visually inspected 14 November 2026. Display scales it within a circular frame; no generated pixels, logos or people were added.

Permission basis checked on that date: [SVS reuse FAQ](https://svs.gsfc.nasa.gov/help/) permits reuse/redistribution unless an item states otherwise; the item shows no separate restriction. [NASA media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/) permit factual educational/informational web use with acknowledgment and no implied endorsement, excluding marked third-party copyrighted works. This supports the educational app, linked source repository and informational demo/judging use of this item, not an eligibility declaration or permission for unrelated branding/merchandise. Preserve its credit/source if reused in slides or recordings.

Codex implemented the appearance controls, layout and reference links. No AI image generation was used for this refresh. The synthetic dataset and AI-assisted proposal history remain unchanged.

## Animate UI — 14 November 2026

Earlier builds used `@animate-ui/react` 2.4.3 and `motion` 14.14.0 for Share comparison. During judging preparation, the team identified Animate UI’s MIT + Commons Clause redistribution restriction and selected a native HTML button with original CSS. The current frontend uses that button. Its manifest and lockfile exclude Animate UI, Motion, framer-motion, motion-dom and motion-utils. The [historical package notices](THIRD_PARTY_NOTICES.txt) remain verbatim for earlier revisions. [Pinned package license](https://github.com/imskyleen/animate-ui/blob/22a9236ae107328f8564edb7e3299375da3247af/LICENSE.md) · [NASA participant terms](https://www.spaceappschallenge.org/legal/) · [Open Source Definition](https://opensource.org/osd)

The official Animate UI skill remains installed locally at [upstream revision 22a9236](https://github.com/imskyleen/animate-ui/tree/22a9236ae107328f8564edb7e3299375da3247af/skills/animate-ui). Its local NOTICE and license are retained. The separate dependency-notice gaps below still require release review.

## Interface languages — 14 November 2026

Codex also implemented the user-requested English-default/Vietnamese-secondary interface, authored the Vietnamese UI translations and added localization checks. Independent AI review checked terminology and state preservation; no human translation certification is claimed. Scientific/source text and exact data values remain original. No translation service or new dependency was added.

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

## Interactive lunar reference globe

The interactive comparison globe uses the 2025 surface color map from NASA’s CGI Moon Kit, SVS ID 4720. Required credit is **NASA’s Scientific Visualization Studio**. The unchanged JPEG in `frontend/public/images/lroc-color-2k.jpg` is 2048 × 1024 pixels, 457,942 bytes, SHA-256 `f7130a1822681fa7512d7dcfd40db8c10b9ba4f06777910348698260ed7a2170`. Retrieved 14 November 2026. [Item and credits](https://svs.gsfc.nasa.gov/4720/) · [Exact JPEG](https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_2k.jpg)

NASA adapted the color map from LRO Wide Angle Camera imagery and used lower-resolution laser reflectance near the poles. NASA describes its color processing and gap filling as intended for visualization. The application samples these pixels onto a smooth sphere with fixed display shading. Codex assisted the projection, controls, translations and tests. The photographic texture was downloaded directly from NASA. Neither lunar image supplies values to the comparison. [Processing notes](https://svs.gsfc.nasa.gov/4720/)

The SVS reuse FAQ permits redistribution unless an item specifies another restriction. The item requests acknowledgment and lists no separate copyright restriction for this texture. NASA’s guidelines cover educational web pages and computer simulations using texture maps, subject to acknowledgment and its endorsement and third-party restrictions. Preserve the credit in educational demos, judging materials and repository copies that use the asset. [SVS FAQ](https://svs.gsfc.nasa.gov/help/) · [NASA media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/)

## Decorative cloud photographs

OlegVegan photographed the clouds and released [Realistic transparent clouds (41)](https://olegvegan.itch.io/realistic-transparent-clouds) under [CC0](https://creativecommons.org/publicdomain/zero/1.0/). The day and night themes use images 3, 18, 25 and 26 from the `cloud_second_day` series. The original 1280-pixel widths and transparent edges are retained in WebP. Night mode dims the same photographs. These Earth clouds are part of the interface decoration. Codex assisted selection, conversion and integration.

## Night theme star map

The decorative background uses the celestial-coordinate map from *Deep Star Maps 2020*, SVS item 4851. Credit: NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC. The selected image shows the stars without constellation figures. The map stays stationary behind decorative clouds. Four CSS stars vary in brightness at fixed positions, and four CSS meteor paths alternate in the night sky. These effects supply no site, time or observation values. Codex assisted their implementation. [Item and credits](https://svs.gsfc.nasa.gov/4851/) · [8K OpenEXR source](https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/starmap_2020_8k.exr)

NASA's 8192 × 4096 linear OpenEXR has SHA-256 `dc6c4f413e85707a29a25a9451148154554ecca2c996f84fa8f47b65ef9ff7c4`. The plate carrée atlas stretches stars near the celestial poles. Codex used FFmpeg to apply the sRGB transfer and render stereographic views suitable for a flat background. Both views use yaw 65°, pitch −10° and roll 12°. The landscape field is 130° × 78.861° at 4096 × 2304 with 2048 × 1152 and 1024 × 576 reductions. The portrait field is 82° × 134.445° at 1440 × 2560. The browser loads one JPEG or WebP rendition for the active dark theme. Checked 14 November 2026. The SVS FAQ permits reuse and redistribution unless an item states otherwise. Item 4851 requests the credits above and lists no separate restriction for this map. Keep the credit with app, demo and repository copies. [SVS reuse FAQ](https://svs.gsfc.nasa.gov/help/) · [NASA media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/)
