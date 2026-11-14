# Odysseus hourly gap in the browser

On 14 November 2026, Chromium 158.0.8127.18 at 1280 × 860 rendered two successive imports in a local production build of [Moon Plan B at cb50af2](https://github.com/justsomenewbie/moon-plan-b/commit/cb50af2803193499e095c11fa066ee7893451c2f).

| Input | 02:00 UTC on 7 January 2026 | Rendered Sun and Earth traces |
| --- | --- | --- |
| [Five original hourly samples](control.json) | Sun 8.471625735°, Earth 10.182261439° elevation | Five markers per body and one continuous line per body. [Control screenshot](control-chart.png) |
| [Copy with the middle row removed](gap.json) | Absent for both bodies | Four markers per body. Both lines end at 01:00 and resume at 03:00, leaving 02:00 blank. The dashed 0° reference line remains visible. [Gap screenshot](gap-chart.png) |

**Sources.** The [Sun](sun-response.json) and [Earth](earth-response.json) files are the original JPL Horizons JSON response bytes. The control records each request URL, retrieval instant and SHA-256. The two requests used apparent airless azimuth and elevation in degrees (quantity 4), hourly from 00:00 through 04:00 UTC. The lunar observer uses 80.13° S, 1.44° E and 2.579 km from the [NASA LRO site report](https://www.nasa.gov/missions/lro/nasas-lro-images-intuitive-machines-odysseus-lander/). Treating that height as relative to Horizons' 1737.4 km reference sphere is an assumption. The check covers rendering above the ideal horizon.

**Repeat.** Open the comparison tool, use **Import data** for the control, select **Compare sites**, then import the gap copy. **Inspect exact samples** shows the retained UTCs and angles. Both responses originally contain 02:00. Only the QA copy omits it and marks coverage partial, with durations and intervals unavailable.

For an automated replay, start the frontend and run the command below from the repository root with an available Playwright Chromium installation. If Playwright is installed outside the project, set `PLAYWRIGHT_MODULE` to its module path. An existing Chromium executable can be selected with `CHROMIUM_EXECUTABLE`.

```sh
node qa/evidence/odysseus-hour-gap/check.mjs http://127.0.0.1:3014
```

The [check](check.mjs) verifies both hashes, every control angle against the raw tables, all retained rows against the control, and the rendered UTC table, line segments and markers for both imports. An optional second argument names a screenshot directory. Two browser runs returned identical UTC rows and SVG paths. [Recorded output](result.json)

OpenAI Codex prepared the QA imports, browser check and report. NASA/JPL Horizons supplied the ephemerides.
