# One missing hour in a two-site comparison

Chromium 158.0.8127.18 displayed Odysseus as the **primary** site (solid lines) and Athena as the **alternative** (dashed lines) in **Compare sites** at 1280 × 860. The initial run used frontend `6505d9b`. An early replay used the local production build of [a76e42c](https://github.com/justsomenewbie/moon-plan-b/commit/a76e42cc5f70c5bd1c4631b4e348a9f4735b0d91).

Both sites originally have five hourly Sun and Earth observations from 00:00 through 04:00 UTC on 7 January 2026. The second import removes only Athena’s 02:00 row. Its original center elevations at that hour are 2.978801436° for the Sun and 5.176047085° for Earth.

| Site | [Full control](control.json) | [Copy with the Athena gap](gap.json) |
| --- | --- | --- |
| Odysseus | Five markers and one continuous line per body | The five UTC rows, markers and both paths match the control, including 02:00. |
| Athena | Five markers and one continuous line per body | Each body retains four markers. Each path ends at 01:00 and resumes at 03:00. No point appears at 02:00. |

The shared time slider skips from 01:00 to 03:00 in the second import. The exact-sample table for Odysseus still contains its 02:00 values. Compare the [control screenshot](control-chart.png), [gap screenshot](gap-chart.png) and [UTC rows and SVG paths](result.json).

**Reversing the sites.** With the same gap copy still loaded, selecting Athena in **Primary site** moved Odysseus to **Alternative site**. Only Athena’s solid Sun and Earth lines broke across 02:00. Odysseus retained both 02:00 markers and two continuous dashed paths. Starting at 01:00, one Right Arrow press moved the cursor to 03:00. The visible and accessible readouts showed 03:00 UTC for both sites. The check ran on the local production frontend from [main at 1fcb741](https://github.com/justsomenewbie/moon-plan-b/commit/1fcb7418916f9c96b2eb41eae387f79b1681ec85). [Chart with the cursor at 03:00](athena-primary-chart.png)

With Athena still primary, a subsequent Chromium run started at a verified 03:00 UTC and pressed Left Arrow once. Both site labels returned directly to 01:00 UTC. The visible text and slider accessibility value before and after the keypress are recorded under `athena-primary.arrowLeft`. [Browser readouts](result.json)

**Returning to Odysseus.** On the same loaded gap copy, selecting Odysseus again moved Athena to the alternative slot. At 03:00 UTC, pressing Left Arrow once returned the labels for both sites to 01:00 UTC. The visible times and the slider’s accessibility value agreed. The [browser record](result.json) includes both site IDs and the readouts under `odysseus-restored`.

**Round trip after Chung’s API integration.** Chromium loaded the live terrain comparison on [main at d19989e](https://github.com/justsomenewbie/moon-plan-b/commit/d19989e00b7d938904e794a46fa48339aa517fae). The browser received HTTP 200 and schema `lunarnav-dataset-1` for both sites. After importing the [Horizons gap copy](gap.json) and returning Odysseus to primary, the test started at 01:00 UTC, pressed Right Arrow once, then Left Arrow once. Both site labels showed 03:00 and then 01:00. The visible and accessible readings at each step are under `odysseus-restored.roundTrip`. [Browser record](result.json)

With Athena primary and Odysseus alternative, Chromium repeated those two keypresses on the [live-API build at 268e812](https://github.com/justsomenewbie/moon-plan-b/commit/268e81234e6aeb8ccfba8d552525e693b5df1a72). Both site labels moved from 01:00 UTC to 03:00 on Right Arrow and back to 01:00 on Left Arrow. The [browser record](result.json) includes the selected site IDs and all three visible and accessible readings under `athena-primary`.

**Data.** The test reuses the archived [Odysseus ephemerides](../odysseus-hour-gap/README.md). New, unmodified JPL Horizons responses for [Athena’s Sun](sun-response.json) and [Earth](earth-response.json) use the same UTCs, one-hour cadence and airless apparent azimuth/elevation in degrees (quantity 4). The observer coordinates are 84.7906° S, 29.1957° E with height 5.321 km. The assumed height datum is the Horizons lunar reference sphere. Request URLs, retrieval instants, model and SHA-256 hashes are in the control. [LROC site coordinates](https://lroc.im-ldi.com/featured_sites/im2/flip-book)

**Replay.** Start the frontend, import the control, select **Compare sites**, and select Odysseus as primary and Athena as alternative. Repeat with the gap copy, then change **Primary site** to Athena. Use the timeline slider’s Right Arrow to step from 01:00 to 03:00, then press Left Arrow once to return to 01:00. To repeat with Odysseus, select it as primary again, move to 03:00 and press Left Arrow once. For the Playwright check, run from the repository root with the [same browser setup as the single-site test](../odysseus-hour-gap/README.md).

```sh
node qa/evidence/odysseus-hour-gap/check.mjs --compare-sites http://127.0.0.1:3014
```

The check verifies the hashes and angles of both sites against their four archived responses, then checks the two tables and all four paths and marker sets on each import. OpenAI Codex prepared the imports, browser test and report. The deliberate omission exists only in the QA copy.
