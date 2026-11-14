# Bug reports and retests

Use one record per reproducible defect. P0: data/security loss or false scientific release claim; P1: core result incorrect/unusable; P2: degraded path with workaround; P3: minor presentation. These are team priorities, not NASA rules. Only the owner of the relevant component changes it.

## Template

```text
ID / title:
Priority / status (OPEN | FIXED_PENDING_RETEST | VERIFIED | BLOCKED):
Reporter / component owner / independent retester:
Reported UTC / local schedule zone:
Commit / branch / build / browser / OS:
Dataset ID / dataset SHA-256 / raw/request identity:
Mode / site(s) / exact UTC or [start,end):
Preconditions and minimal reproduction steps:
Expected behavior and source/contract clause:
Actual behavior (preserve null vs zero):
Impact / affected paths / workaround:
Evidence (redacted logs/screenshots/test command):
Fix commit / changed files:
Retest command / UTC / result / regression coverage:
Release decision / human owner / acceptance evidence:
```

## Task findings

| ID | Priority / status | Finding / owner | Evidence and retest |
| --- | --- | --- | --- |
| QA-001 | P1 / VERIFIED | A 1 ms serialization tolerance admitted overlaps, out-of-window ends and joint intervals starting before a body interval | Strict ordering, containment and boundary regression cases pass in the Python suite |
| QA-002 | P1 / VERIFIED | Windows line-ending conversion could invalidate fixture hashes | Fixture attributes disable conversion. All 25 staged blobs matched the generator byte for byte |
| QA-003 | P1 / VERIFIED | Initial synthetic raw header and step syntax differed from the service. Real output includes scientific notation in observer height | Corrected the fixtures and parser. Six rows from two live tables matched the independent CSV read. [Evidence](docs/JPL_CHECK.md) |
| UI-02a | P3 / VERIFIED | The importer reported missing boundary samples for a missing interior hour in a complete window. Both boundary rows were present. | The alert now identifies the skipped sample. [Browser retest](docs/UI_RESILIENCE.md#ui-02-import-retest) |
| UI-02b | P3 / VERIFIED | The size alert said “smaller than 5 MB”; the importer accepts up to 5 MiB inclusive. | The English and Vietnamese diagnostics state the inclusive limit. The browser accepted exactly 5 MiB and rejected one additional byte. [Browser retest](docs/UI_RESILIENCE.md#ui-02-import-retest) |
| INT-001 | P1 / BLOCKED for production integration | Brief requests Vite/static-only; existing app is Next.js with draft API; Chung/Son integration decision | No shared source changed. Recorded in CONTRACT/RUNBOOK; human acceptance pending |
| ENV-001 | P2 / BLOCKED for full build evidence | Host Node 24.22.1 below declared >=24.22.3; dependency install absent | Native source smoke tests only; supported-runtime full build pending |
| DATA-001 | P1 / BLOCKED for scientific release | No producer package with original JPL requests/raw responses supplied | All new fixtures synthetic; `--release` rejects them |

Unexecuted manual tests are not bugs by themselves. When a test is performed, create a defect only for an observed deviation and link the exact evidence. Do not turn an agent review or a prior-machine screenshot claim into a human sign-off.
