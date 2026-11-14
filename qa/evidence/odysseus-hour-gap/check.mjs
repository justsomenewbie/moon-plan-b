import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Usage: node check.mjs [--compare-sites] <frontend-origin> [screenshot-directory]
const args = process.argv.slice(2);
const paired = args[0] === "--compare-sites";
if (paired) args.shift();
const [origin, evidenceDir] = args;
if (!origin) throw Error("Pass the URL of a running Moon Plan B frontend.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const fixtures = new URL(paired ? "../odysseus-athena-hour-gap/" : "./", import.meta.url);
const file = name => fileURLToPath(new URL(name + ".json", fixtures));
const load = async name => JSON.parse(await readFile(file(name), "utf8"));
const control = await load("control");
const gap = await load("gap");
const hours = [0, 1, 2, 3, 4];
const ids = paired ? ["odysseus-jan07", "athena-jan07"] : ["odysseus-jan07"];
assert.deepEqual(control.scenarios.map(s => s.id), ids);
assert.deepEqual(gap.scenarios.map(s => s.id), ids);
const affected = ids.length - 1;
for (const [index, s] of control.scenarios.entries()) {
  assert.deepEqual(s.samples.map(v => Date.parse(v.utc)), hours.map(h => Date.UTC(2026, 0, 7, h)));
  if (index === affected) assert.deepEqual(gap.scenarios[index].samples, s.samples.filter((_, i) => i !== 2));
  else assert.deepEqual(gap.scenarios[index], s);
  for (const body of ["sun", "earth"]) {
    const athena = index === 1;
    const raw = await readFile(new URL((athena ? "../odysseus-athena-hour-gap/" : "./") + body + "-response.json", import.meta.url));
    const source = control.sources.find(v => v.id === (athena ? "athena-" : "jpl-") + body);
    assert.equal(createHash("sha256").update(raw).digest("hex"), source.rawSha256);
    const table = JSON.parse(raw).result.match(/\$\$SOE\s*([\s\S]*?)\s*\$\$EOE/)[1];
    const angles = table.split(/\r?\n/).map(row => {
      const [time, , , azimuth, elevation] = row.trim().split(",");
      return [time.replace("2026-Jan-07 ", "2026-01-07T") + "Z", Number(azimuth), Number(elevation)];
    });
    assert.deepEqual(angles, s.samples.map(v => [v.utc, v[body].azimuthDeg, v[body].elevationDeg]));
  }
}
if (evidenceDir) await mkdir(evidenceDir, { recursive: true });

const viewport = { width: 1280, height: 860 };
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({ viewport, timezoneId: "UTC", reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(origin);
  await page.getByRole("button", { name: "Import data", exact: true }).waitFor();
  const observed = {};
  const cases = [["control", control], ["gap", gap]];
  if (paired) cases.push(["athena-primary", gap]);
  for (const [name, data] of cases) {
    const swapped = name === "athena-primary";
    if (!swapped) await page.getByLabel("Import JSON dataset").setInputFiles(file(name));
    await page.locator("#sources").getByText(data.datasetId, { exact: true }).waitFor({ state: "attached" });
    const compare = page.getByRole("button", { name: "Compare sites", exact: true });
    if (!swapped) await compare.click();
    assert.equal(await compare.getAttribute("aria-pressed"), "true");
    const primary = page.getByLabel(/^Primary site/);
    if (swapped) await primary.selectOption("athena-jan07");
    const scenarios = swapped ? data.scenarios.toReversed() : data.scenarios;
    assert.equal(await primary.inputValue(), scenarios[0].id);
    if (paired) assert.equal(await page.getByLabel(/^Alternative site/).inputValue(), scenarios[1].id);
    const details = page.locator("details").filter({ has: page.getByText("Inspect exact samples", { exact: true }) });
    if (!(await details.evaluate(el => el.open))) await details.locator("summary").click();
    const chart = page.locator(".timeline");
    const svg = chart.locator(".timeline-svg");
    const [, , width, height] = (await svg.getAttribute("viewBox")).split(" ").map(Number);
    assert.equal(await svg.locator("path.plot-line").count(), 2 * ids.length);
    observed[name] = {};
    for (const [index, scenario] of scenarios.entries()) {
      const samples = scenario.samples;
      const slots = data === gap && scenario.id === ids[affected] ? [0, 1, 3, 4] : hours;
      const role = index === 0 ? "Primary" : "Alternative";
      const table = details.getByRole("table", { name: new RegExp(role + " · " + scenario.id + " · " + scenario.coverage) });
      const rows = await table.locator("tbody tr").evaluateAll(rs => rs.map(r => Array.from(r.cells, c => c.textContent)));
      assert.deepEqual(rows, samples.map(s => [s.utc, s.sun.elevationDeg+"°", s.sun.azimuthDeg+"°", s.earth.elevationDeg+"°", s.earth.azimuthDeg+"°"]));
      const view = { utc: rows.map(r => r[0]), paths: {} };
      for (const body of ["sun", "earth"]) {
        const style = index === 0 ? ":not([stroke-dasharray])" : "[stroke-dasharray]";
        const line = await svg.locator("path."+body+style).getAttribute("d");
        const commands = slots.map((h, i) => {
          const pen = i === 0 || h !== slots[i-1]+1 ? "M" : "L";
          return pen + (width*h/4).toFixed(2) + "," + (height*(90-samples[i][body].elevationDeg)/180).toFixed(2);
        });
        assert.deepEqual(line.trim().split(/\s+/), commands, scenario.id+" "+body+" line");
        const fill = index === 0 ? "currentColor" : "var(--bg)";
        const markers = await chart.locator('.plot-markers .'+body+'[fill="'+fill+'"]').evaluateAll(es => es.map(e =>
          [e.getAttribute("cx") ?? e.getAttribute("x"), e.getAttribute("cy") ?? e.getAttribute("y")]));
        assert.equal(markers.length, slots.length);
        for (const [i, [x,y]] of markers.entries()) {
          assert.equal(x, slots[i]*25+"%");
          assert(y.endsWith("%") && Math.abs(parseFloat(y)-(90-samples[i][body].elevationDeg)/1.8)<1e-8);
        }
        view.paths[body] = line;
      }
      if (paired) observed[name][scenario.siteId] = view;
      else observed[name] = view;
      if (evidenceDir && !paired) await table.screenshot({ path: join(evidenceDir,name+"-table.png") });
    }
    if (evidenceDir && !swapped) await chart.screenshot({ path: join(evidenceDir,name+"-chart.png") });
    if (paired) {
      const slider = page.getByRole("slider", { name: "Timeline sample" });
      const sharedHours = data === gap ? [0, 1, 3, 4] : hours;
      assert.equal(await slider.getAttribute("max"), String(sharedHours.length - 1));
      await slider.press("Home");
      async function readAt(h) {
        const clock = String(h).padStart(2, "0") + ":00 UTC";
        const label = await slider.getAttribute("aria-valuetext");
        assert.match(label, new RegExp("^"+h+" hours? elapsed\\. Primary .*"+clock+"\\. Alternative .*"+clock+"$"));
        const visible = await page.locator(".sample-time").innerText();
        assert.match(visible, new RegExp("Primary: .*"+clock+" · Alternative: .*"+clock+"$"));
        return { visible, accessible: label };
      }
      const readouts = [];
      for (const h of sharedHours) {
        if (h) await slider.press("ArrowRight");
        readouts.push((await readAt(h)).visible);
        if (swapped && h === 3 && evidenceDir) await chart.screenshot({ path: join(evidenceDir,name+"-chart.png") });
      }
      observed[name].sharedHours = sharedHours;
      if (swapped) {
        observed[name].sliderReadouts = readouts;
        await slider.press("ArrowLeft"); // Move from the final sample to 03:00 UTC.
        const before = await readAt(3);
        await slider.press("ArrowLeft");
        const after = await readAt(1);
        observed[name].arrowLeft = { before, after };
      }
    }
  }
  if (paired) {
    assert.deepEqual(observed.gap.im1_odysseus, observed.control.im1_odysseus);
    for (const { siteId } of gap.scenarios) assert.deepEqual(observed["athena-primary"][siteId], observed.gap[siteId]);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ chromium: browser.version(), viewport, observed,
    scope: paired ? "Two-site browser QA: only the Athena copy omits 02:00 UTC." :
      "Browser rendering of two local imports only. The midpoint was intentionally removed for QA." }, null, 2));
} finally { await browser.close(); }
