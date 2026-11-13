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

No external image, lunar texture/model, web font, soundtrack or copied UI component is included. System fonts are used. The project-level license is still a team decision; public GitHub visibility is not permission to reuse team code. Hosting and final release require the corresponding license/submission checks.
