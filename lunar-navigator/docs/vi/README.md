# docs/vi

Vietnamese-language working notes of the team; English docs are in [docs/](../).

These notes were written for internal coordination during NASA Space Apps Challenge 2026
("Lunar Landing Site Navigator") and are kept for transparency. They are not required to use or review the project.

| File | Contents |
|---|---|
| [FE_HANDOFF_API.md](FE_HANDOFF_API.md) | Self-contained handoff for the frontend team: how a Next.js app calls the production API (`https://api.lunavigator.com/api/v1`) |
| [FE_INTEGRATION.md](FE_INTEGRATION.md) | Detailed frontend integration guide (contract, examples, errors, jobs, auth) |
| [DEPLOY_VPS.md](DEPLOY_VPS.md) | Runbook for deploying the backend to a Linux VPS (Node, MongoDB, Python venv, pm2, HTTPS proxy) |
| [WEB_BACKEND_PLAN.md](WEB_BACKEND_PLAN.md) | Original design plan for the web backend |
| [KIEM_THU_DOI_CHIEU_NASA.md](KIEM_THU_DOI_CHIEU_NASA.md) | Cross-check of results against NASA tools (English version: [../NASA_TOOLS_CROSSCHECK.md](../NASA_TOOLS_CROSSCHECK.md)) |

The API contract itself (English) is [backend/contract/openapi.json](../../backend/contract/openapi.json).
