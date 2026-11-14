# One missing hour in a two-site comparison

Chromium 158.0.8127.18 displayed Odysseus as the **primary** site (solid lines) and Athena as the **alternative** (dashed lines) in **Compare sites** at 1280 × 860. The initial run used frontend `6505d9b`. The final replay used the local production build of [a76e42c](https://github.com/justsomenewbie/moon-plan-b/commit/a76e42cc5f70c5bd1c4631b4e348a9f4735b0d91).

Both sites originally have five hourly Sun and Earth observations from 00:00 through 04:00 UTC on 7 January 2026. The second import removes only Athena’s 02:00 row. Its original center elevations at that hour are 2.978801436° for the Sun and 5.176047085° for Earth.

| Site | [Full control](control.json) | [Copy with the Athena gap](gap.json) |
| --- | --- | --- |
| Odysseus | Five markers and one continuous line per body | The five UTC rows, markers and both paths match the control, including 02:00. |
| Athena | Five markers and one continuous line per body | Each body retains four markers. Each path ends at 01:00 and resumes at 03:00. No point appears at 02:00. |

The shared time slider skips from 01:00 to 03:00 in the second import. The exact-sample table for Odysseus still contains its 02:00 values. Compare the [control screenshot](control-chart.png), [gap screenshot](gap-chart.png) and [UTC rows and SVG paths](result.json).

**Data.** The test reuses the archived [Odysseus ephemerides](../odysseus-hour-gap/README.md). New, unmodified JPL Horizons responses for [Athena’s Sun](sun-response.json) and [Earth](earth-response.json) use the same UTCs, one-hour cadence and airless apparent azimuth/elevation in degrees (quantity 4). The observer coordinates are 84.7906° S, 29.1957° E with height 5.321 km. The assumed height datum is the Horizons lunar reference sphere. Request URLs, retrieval instants, model and SHA-256 hashes are in the control. [LROC site coordinates](https://lroc.im-ldi.com/featured_sites/im2/flip-book)

**Replay.** Start the frontend, import the control, select **Compare sites**, and select Odysseus as primary and Athena as alternative. Repeat with the gap copy. For the Playwright check, run from the repository root with the [same browser setup as the single-site test](../odysseus-hour-gap/README.md).

```sh
node qa/evidence/odysseus-hour-gap/check.mjs --compare-sites http://127.0.0.1:3014
```

The check verifies the hashes and angles of both sites against their four archived responses, then checks the two tables and all four paths and marker sets on each import. OpenAI Codex prepared the imports, browser test and report. The deliberate omission exists only in the QA copy.
