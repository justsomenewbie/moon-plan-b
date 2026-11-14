import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Usage: node check.mjs <frontend-origin> [screenshot-directory]
const [origin, evidenceDir] = process.argv.slice(2);
if (!origin) throw Error("Pass the URL of a running Moon Plan B frontend.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const fixture = (name) => fileURLToPath(new URL(name + ".json", import.meta.url));
const original = JSON.parse(await readFile(fixture("control"), "utf8"));
const control = original.scenarios[0].samples;
const gap = JSON.parse(await readFile(fixture("gap"), "utf8")).scenarios[0].samples;
const hours = [0, 1, 2, 3, 4];
assert.deepEqual(control.map(s => Date.parse(s.utc)), hours.map(h => Date.UTC(2026, 0, 7, h)));
assert.deepEqual(gap, control.filter((_, i) => i !== 2));
// Check the five source rows before using the complete import as the browser oracle.
for (const body of ["sun", "earth"]) {
  const raw = await readFile(fixture(body + "-response"));
  const source = original.sources.find(s => s.id === "jpl-" + body);
  assert.equal(createHash("sha256").update(raw).digest("hex"), source.rawSha256);
  const table = JSON.parse(raw).result.match(/\$\$SOE\s*([\s\S]*?)\s*\$\$EOE/)[1];
  const angles = table.split(/\r?\n/).map(row => {
    const [time, , , azimuth, elevation] = row.trim().split(",");
    return [time.replace("2026-Jan-07 ", "2026-01-07T") + "Z", Number(azimuth), Number(elevation)];
  });
  assert.deepEqual(angles, control.map(s => [s.utc, s[body].azimuthDeg, s[body].elevationDeg]));
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
  for (const [name, samples, slots] of [
    ["control", control, hours], ["gap", gap, [0, 1, 3, 4]],
  ]) {
    await page.getByLabel("Import JSON dataset").setInputFiles(fixture(name));
    await page.getByText(/Dataset imported locally/).waitFor();
    await page.locator(".sample-table caption").filter({ hasText: name === "control" ? "complete coverage" : "partial coverage" }).first().waitFor({ state: "attached" });
    await page.getByRole("button", { name: "Compare sites", exact: true }).click();
    const details = page.locator("details").filter({ has: page.getByText("Inspect exact samples", { exact: true }) });
    if (!(await details.evaluate(el => el.open))) await details.locator("summary").click();
    const table = details.locator("table").first();
    const rows = await table.locator("tbody tr").evaluateAll(rs => rs.map(r => Array.from(r.cells, c => c.textContent)));
    assert.deepEqual(rows, samples.map(s => [s.utc, s.sun.elevationDeg+"°", s.sun.azimuthDeg+"°", s.earth.elevationDeg+"°", s.earth.azimuthDeg+"°"]));
    const chart = page.locator(".timeline");
    const svg = chart.locator(".timeline-svg");
    const width = Number((await svg.getAttribute("viewBox")).split(" ")[2]);
    const height = Number((await svg.getAttribute("viewBox")).split(" ")[3]);
    observed[name] = { utc: rows.map(r => r[0]), paths: {} };
    for (const body of ["sun", "earth"]) {
      const line = await svg.locator("path."+body).getAttribute("d");
      const commands = slots.map((h, i) => {
        const pen = i === 0 || h !== slots[i-1]+1 ? "M" : "L";
        return pen + (width*h/4).toFixed(2) + "," + (height*(90-samples[i][body].elevationDeg)/180).toFixed(2);
      });
      assert.deepEqual(line.trim().split(/\s+/), commands, name+" "+body+" line");
      const markers = await chart.locator(".plot-markers ."+body).evaluateAll(es => es.map(e =>
        [e.getAttribute("cx") ?? e.getAttribute("x"), e.getAttribute("cy") ?? e.getAttribute("y")]));
      assert.equal(markers.length, slots.length);
      for (const [i, [x,y]] of markers.entries()) {
        assert.equal(x, slots[i]*25+"%");
        assert(y.endsWith("%") && Math.abs(parseFloat(y)-(90-samples[i][body].elevationDeg)/1.8)<1e-8);
      }
      observed[name].paths[body] = line;
    }
    if (evidenceDir) {
      await chart.screenshot({ path: join(evidenceDir,name+"-chart.png") });
      await table.screenshot({ path: join(evidenceDir,name+"-table.png") });
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ chromium: browser.version(), viewport, observed,
    scope: "Browser rendering of two local imports only. The midpoint was intentionally removed for QA." }, null, 2));
} finally { await browser.close(); }
