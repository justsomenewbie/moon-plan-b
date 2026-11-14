# Enterprise Feature Development — NEXUS-Sprint task adaptation

No external executable runbook with this name was supplied or found. This document implements the requested phase/evidence workflow for Minh's bounded QA task; it does not claim activation of an installed service. The goal is a reviewable QA commit, with product release gated separately.

## Phase gates and team coordination

Root is the only editor in this checkout. Three read-only agent streams provided architecture/API review, compliance review and independent evidence/quality review. Agent role review is not human stakeholder approval. Core roster responsibilities are consolidated below rather than claiming fifteen distinct agent executions.

| Phase | Roles / responsibility | Evidence required to advance |
| --- | --- | --- |
| 1 — Scope | Agents Orchestrator, Project Shepherd, Senior Project Manager, Sprint Prioritizer | Correct remote, clean base, branch Minh, actual time/runtime, owned paths and acceptance examples |
| 2 — Contract | Backend Architect, API Tester, UX Architect, UX Researcher, UI Designer | Draft sidecar, fixed units/time semantics, English error/fixture descriptions, current frontend integration surface; stakeholder acceptance separately pending |
| 3 — Build | Senior Developer, Frontend Developer, DevOps Automator | Changes limited to qa/ plus concise root HANDOFF; no backend/frontend source or shared draft edits; reproducible fixture generation and one-command verification |
| 4 — Verify | Evidence Collector, Reality Checker, Test Results Analyzer, Performance Benchmarker | Independent rerun, negative controls, full diff, raw byte checks, regression cases, timed commands, redacted secret review |
| 5 — Handoff | Project Shepherd, Legal Compliance Checker; Brand Guardian/Executive Summary duties consolidated into compliance summary | Clean local commit, exact evidence, AI attribution, open release gates; no implied deployment, merge or human approval |

Finance Tracker is not activated: no purchase or budget change. Experiment Tracker is not activated: no experiment participants enrolled. Workflow Optimizer responsibilities are covered by the reproducible runner and explicit retest process. Performance timings describe these small fixtures on this host, not load or device certification.

Gate 2 covered the proposed offline QA sidecar. The [producer contract](../../docs/FRONTEND_CONTRACT.md) governs live frontend integration. Gate 4 covers the checks actually run. The team reviews release evidence against the checklist below.

## Minh schedule — Hanoi UTC+07:00

Schedule is the requested team plan, not evidence these sessions occurred. Scientific data timestamps remain UTC `Z`.

| Window | Minh's work and owner input | Exit evidence / stop condition |
| --- | --- | --- |
| Nov 14 morning | Trace each site/Sun/Earth request to raw response and versioned JSON; Chung producer, Trang science review | Manifest validation, independent sample checks, frame/datum/units; synthetic success cannot close real-data gate |
| Nov 14 afternoon | Run both functional modes, exact-zero/wrap/gap/UTC controls, import/error/retry checks; Son frontend | Exact commit+dataset hash, automated report and browser screenshots/network; log defects with reproducible steps |
| Nov 14 evening | Three real users independently compare sites and explain one limitation; usability owner coordinates | Complete anonymized log below; do not invent users, sessions or outcomes |
| Nov 15 morning | Proposed freeze 09:00, repeat checks, owner reviews licences/AI/links/submission | Release gate checklist, immutable commit and dataset hashes; local submission target 10:30, recorded local cutoff 11:00; global 23:59 is separate |

## Three-user usability log — NOT RUN

Task A: find two candidate sites at the same UTC instant and explain which has a longer supplied joint window. Task B: switch to one site's timeline and identify an unknown interval. Task C: explain why an above-horizon result is not proof of usable power or communication. Suggested team target: core comparison in two minutes without coaching, not a NASA requirement.

| Participant (anonymous) | Commit / fixture hash / browser | Completion time / assistance | Misunderstanding / issue | Retest / outcome |
| --- | --- | --- | --- | --- |
| U01 | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| U02 | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| U03 | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

Record only consented, minimal observations; avoid names, recordings and personal data in the public repository. AI simulations do not count as user sessions.

## Release freeze gate — open until evidence supplied

- [x] Frontend integration uses the selected Next.js stack and Chung’s same-origin aggregate API. [Contract and Chromium retest](../README.md#frontend-integration-retest).
- [ ] At freeze, record Chung and Son’s acceptance of the release build and producer schema, and Trang’s sign-off on model assumptions, units and independent JPL sample checks.
- [ ] Sourced production package validates with `--release`; true query receipts, raw exports, parser compatibility and source authenticity reviewed. Synthetic labels remain on mocks.
- [ ] Supported-runtime install, full frontend test/typecheck/build and production-preview checks pass at the frozen commit; no unsupported Node waiver.
- [ ] Manual resilience/network/accessibility evidence and three real-user sessions recorded; no unresolved P0/P1 or scientific correctness defect. Exceptions require named human acceptance.
- [ ] Before submitting the Final Project or demo, review the public roster and contact block against the [NASA participant terms](https://www.spaceappschallenge.org/legal/). The working site shows team names. Exclude identifiable names and likenesses of anyone under 18 and personal phone numbers from the submission. Keep the portrait preview private.
- [ ] Licence/third-party notices, source and AI disclosures, current official rules and public links checked. Team Owner verifies portal rights, submits and retains receipt; Save Progress is not submission.

Next handoff input: one agreed, versioned two-site producer export with original requests/raw responses. Run the package validator, report incompatibilities, then let integration owners approve any adapter before changing shared contracts.

## Tool routing record

Git/PowerShell/apply_patch: used for controlled edits and status; Python standard library: used for QA/raw hashing; Node native test runner: used for actual frontend source smoke checks; primary JPL web docs: used for parameter/policy verification; three read-only agent reviews: used for independent checks. Gitleaks and Ruff unavailable on PATH; scoped redacted pattern review plus manual input-boundary review is a limited fallback, not a full security audit. No dependencies/lockfiles changed. The original host lacked the supported runtime and installed dependencies. The [subsequent Mac retest](../README.md#supported-runtime-retest) verified the build and Chromium preview on a named commit. No CodeGraph index found; ordinary source reads used. New visual/media/site/document generation tools and unrelated catalog packs are not applicable to this QA-only task. No paid tools, plugin installation, external messages or deployments were used.
