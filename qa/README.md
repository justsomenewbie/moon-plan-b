# Minh — QA and integration verification

Offline Python 3.10+ QA for Moon Plan B. No Python packages, credentials, live API requests or frontend changes are required. All fixture angles, sites and raw-like files are **synthetic**, not JPL responses. OpenAI Codex assisted code, fixtures, documentation and agent review; human scientific and integration acceptance is still required.

From the repository root:

```sh
python -B -m qa.run_checks
python -B -m qa.verify_json_contract qa/fixtures/crossing_wrap.json --manifest qa/fixtures/crossing_wrap.manifest.json
python -B -m unittest qa.test_edge_cases -v
node --experimental-strip-types --test qa/frontend_integration.test.ts
```

`run_checks` returns nonzero on any unexpected result. Its negative control expects `--release` to reject synthetic data with exit 1. Evidence is written to ignored `qa/evidence/latest/`; use `--output qa/evidence/<reviewed-run-name>` for an intentional, shareable snapshot. The report includes commands, exit codes, runtime, timings, exact input hashes and terminal output. It does not grant release approval. The original QA host ran Node 24.22.1. The separate frontend retest below uses the supported runtime.

## Supported-runtime retest

On 14 November 2026 at 09:15 UTC, OpenAI Codex retested ENV-001 from a clean source archive of [product commit `3cef1a0`](https://github.com/justsomenewbie/moon-plan-b/commit/3cef1a0bf9f4c6a86a1b9bed44a155af6c4f7a11) on macOS arm64. Node 24.22.3 and npm 11.19.1 were first on PATH. From `frontend/`, `npm ci --offline --ignore-scripts --no-audit --no-fund` installed 130 packages from the local npm cache. SHA-256 of `package-lock.json` after installation matched the source: `04a470218052f5a64b3dcec13983e7e59ac5e4d1e6835ad76830a5975c93fdfe`. On a machine with an empty cache, use the install command in the [product README](../README.md).

With `NEXT_PUBLIC_API_BASE_URL=mock`, `npm test` passed all 82 frontend tests, `npm run check` passed route generation and strict TypeScript, and `npm run build` produced the production bundle. After `npm run start -- --port 3191`, Chromium 158.0.8127.18 ran the [paired Horizons replay](evidence/odysseus-hour-gap/check.mjs) with `--compare-sites` and the [file-rejection test](check_import_rejections.mjs) against that preview. Both site orders skipped Athena’s missing 02:00 sample, and the importer accepted the 5 MiB boundary. All eight offline QA checks passed. This verifies the named Mac build. The [release freeze](docs/RUNBOOK.md#release-freeze-gate--open-until-evidence-supplied) still requires its own commit and checks.

## Files and use

| Artifact | Purpose |
| --- | --- |
| `verify_json_contract.py` | Strict JSON, draft schema subset, scientific consistency, metadata/raw hash and row-level verification |
| `science.py` | Independent QA oracle for strict visibility, linear crossing duration boundaries, interval intersection and circular interpolation |
| `test_edge_cases.py` | Positive and adversarial tests; mutations must fail for the expected reason |
| `frontend_integration.test.ts` | Exercises the existing frontend importer, chart paths and same-UTC selection |
| `fixtures/*.json` | Import normal/crossing_wrap/partial/missing datasets directly into the frontend; `.manifest.json` files are QA sidecars, not UI datasets |
| `fixtures/invalid/` | Intentionally rejected schema/range/UTC/gap examples |
| `docs/` and `BUG_LOG.md` | Execution gates, manual evidence, stakeholder handoff and retest tracking |

`python -B -m qa.generate_fixtures --check` verifies reproducibility without writing. Omit `--check` only to regenerate the authored golden packages. Their fixed metadata timestamps describe the synthetic scenario, not a real retrieval. Generation does not compute expected intervals using the tested oracle: simple goldens are hand-calculated.

`qa/.gitattributes` preserves exact fixture/evidence bytes across Windows line-ending conversion. Do not recompute hashes merely to hide a corruption failure.

## Contract and limits

The offline Horizons validator uses the saved-file format `frontend-draft-2`. The live frontend uses Chung’s [producer contract](../docs/FRONTEND_CONTRACT.md) and can also import its JSON exports.

The Python validator consumes `contracts/openapi.draft.json` directly. It implements only the vocabulary reachable from its Dataset schema, rejects unknown keywords and adds semantic checks. It is not a general JSON Schema validator. The unchanged frontend's actual validator is also tested. Raw metadata lives in a sidecar because the dataset schema forbids new properties.

See the [QA sidecar contract](docs/CONTRACT.md), [release checklist](docs/RUNBOOK.md), [resilience checks](docs/UI_RESILIENCE.md) and [compliance record](docs/COMPLIANCE.md).

## Frontend integration retest

On 14 November 2026, OpenAI Codex built [`b8d3a60`](https://github.com/justsomenewbie/moon-plan-b/commit/b8d3a604704bfd08bc366a7eb040b7ed0e1505dc) with the [selected Next.js and Tailwind stack](../AGENTS.md). Chromium opened `/compare` and received HTTP 200 from the same-origin `/api/v1/dataset`. The `lunarnav-dataset-1` response and rendered result included Odysseus and Athena. The [integration record](../docs/BACKEND_RECONCILIATION.md#aggregate-update-on-14-november) gives the bounded request.

The [Horizons replay](evidence/odysseus-hour-gap/check.mjs), run with `--compare-sites`, imported a copy with only Athena’s 02:00 UTC sample removed. With each site selected as primary, both UTC labels stepped from 01:00 to 03:00 and back to 01:00. Both Athena curves broke at the gap, both Odysseus curves stayed continuous, and the marker coordinates matched the remaining observations.
