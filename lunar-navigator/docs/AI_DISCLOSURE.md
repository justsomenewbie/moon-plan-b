# AI use disclosure

The NASA Space Apps Challenge asks teams to acknowledge any use of artificial intelligence (AI) in
the descriptive text and the metadata of their code and data. This page covers the
`lunar-navigator/` part of the Moon Plan B project for the 2026 challenge "Lunar Landing Site
Navigator". That part is the Python package `lunarnav` and the Node.js API in `backend/`.

The team frontend in `frontend/` of the team repository was built by another team member. It is not
covered here. Its credits are in
[`docs/CREDITS.md`](https://github.com/justsomenewbie/moon-plan-b/blob/main/docs/CREDITS.md) of the team repository.

## AI tool used

| Tool | Provider | Model |
|---|---|---|
| Claude Code (command-line coding assistant) | Anthropic | Claude Opus |

No other AI tool was used for this part of the project.

## What the AI did

Under the direction of the team member responsible for the backend and data (Nguyen Trong Chung),
Claude wrote and reviewed most of the following:

* the Python package `lunarnav`, which covers ephemerides, terrain readers, horizon masks,
  visibility, windows, precompute and validation;
* the Node.js backend in `backend/`, with its API, importer, jobs and OpenAPI contract;
* the Python and Node.js test suites;
* the deployment scripts in `backend/deploy/`;
* the documentation in `docs/` and the README files.

## What the team member did

* Chose the challenge.
* Chose the data sources from the challenge Resources tab and the NASA archives listed in
  [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
* Set the requirements.
* Picked between the design options that were proposed. Examples are using two independent methods
  (run A: JPL Horizons with NASA Moon Trek LOLA terrain; run B: NAIF SPICE with NASA GSFC PGDA LOLA
  terrain), making run B the default dataset, and the site list.
* Ran the computations.
* Checked and accepted the results.

The long precompute runs were executed on Google Colab. Colab is a hosted notebook service, not an
AI tool.

## Where the numbers come from

Every result served by the API or stored in the run outputs comes from deterministic code (the
`lunarnav` package) run on NASA data. Examples are Sun and Earth elevation, horizon masks,
visibility percentages and windows. The NASA data are JPL Horizons, the NAIF SPICE kernels, and
LRO LOLA terrain from Moon Trek and PGDA.

No number was produced or estimated by an AI model. Running the same code version on the same
input data gives the same output, and every run directory records the code version, the data
sources and file checksums in its `manifest.json`.

The results were checked against independent NASA tools and data. The method and the measured
differences are documented in:

* [`docs/VALIDATION.md`](VALIDATION.md): ephemeris and visibility validation, including a comparison
  with JPL Horizons;
* [`docs/VALIDATION_TERRAIN.md`](VALIDATION_TERRAIN.md): terrain and horizon validation, including
  Moon Trek against PGDA and our results against the PGDA product 69 illumination maps;
* [`docs/NASA_TOOLS_CROSSCHECK.md`](NASA_TOOLS_CROSSCHECK.md): manual cross-checks with the NASA web
  tools (Horizons, Moon Trek, LROC QuickMap).

## Media

This part of the project contains no AI-generated images, audio or video. Any figures are plots
that our code makes from the computed data.

## Metadata

The AI use is also recorded in a machine-readable form:

* **Git history.** Commits written with AI assistance end with a `Co-Authored-By: Claude ...`
  trailer, for example `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
* **`pyproject.toml`.** This file has a `[tool.lunarnav.ai_disclosure]` table:

  ```toml
  tool = "Anthropic Claude (Claude Code)"
  scope = "code, tests, documentation"
  doc = "docs/AI_DISCLOSURE.md"
  ```

* **`backend/package.json`.** This file has a top-level field:

  ```json
  "aiDisclosure": {
    "tool": "Anthropic Claude (Claude Code)",
    "scope": "code, tests, documentation",
    "doc": "../docs/AI_DISCLOSURE.md"
  }
  ```

  You can read it with `npm pkg get aiDisclosure`.
