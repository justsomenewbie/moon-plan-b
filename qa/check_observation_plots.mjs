import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass a running frontend origin.");
const load = async name => JSON.parse(await readFile(new URL("./fixtures/" + name + ".json", import.meta.url), "utf8"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ timezoneId: "UTC", reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(new URL("/compare", origin).href);
  await page.getByRole("button", { name: "Import data", disabled: false }).waitFor();
  const slider = page.getByRole("slider", { name: "Timeline sample" });
  const paths = page.locator(".timeline-svg path.plot-line");
  const segments = locator => locator.evaluateAll(lines => lines.map(line => (line.getAttribute("d").match(/[ML]/g) || []).join("")));
  const trail = body => segments(page.locator(".skyplot path." + body));
  const primary = page.getByLabel(/^Primary site/);
  const details = page.locator("details").filter({ has: page.getByText("Inspect exact samples", { exact: true }) });
  async function compare(data) {
    await page.getByLabel("Import JSON dataset").setInputFiles({ name: data.datasetId + ".json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(data)) });
    await page.locator("#sources").getByText(data.datasetId, { exact: true }).waitFor({ state: "attached" });
    await page.getByRole("button", { name: "Compare sites", exact: true }).click();
    assert.equal(await primary.inputValue(), "ridge-1");
    if (!await details.evaluate(el => el.open)) await details.locator("summary").click();
  }
  async function checkUnknown() {
    assert.deepEqual(await page.locator(".comparison tbody td").allTextContents(), Array(6).fill("Unavailable"));
    assert.equal(await page.locator(".visibility-bands").getByText("Intervals unavailable", { exact: true }).count(), 6);
    assert.equal(await page.locator(".comparison .assessment.unknown").count(), 2);
  }
  const partial = await load("partial");
  await compare(partial);
  await checkUnknown();
  assert.deepEqual(await segments(paths), ["MLML", "MLLLL", "MLML", "MLML"]);
  const missingSun = details.getByRole("row").filter({ hasText: "2026-11-14T02:00:00Z" });
  assert.deepEqual(await missingSun.getByRole("cell").allTextContents(), ["Unavailable", "Unavailable", "1°", "182°"]);
  const sunMarkers = page.locator(".plot-markers circle.sun");
  const positions = await sunMarkers.evaluateAll(markers => markers.map(m => m.getAttribute("cx")));
  assert.deepEqual(positions, ["0%", "25%", "75%", "100%", "0%", "25%", "75%", "100%"]);
  const zeros = await sunMarkers.evaluateAll(markers =>
    markers.filter(m => m.getAttribute("cy") === "50%").map(m => m.getAttribute("cx")));
  assert.deepEqual(zeros, ["25%", "75%"]);
  await primary.selectOption("basin-1");
  assert.deepEqual(await trail("sun"), ["ML", "ML"]);
  assert.deepEqual(await trail("earth"), ["ML", "ML"]);

  await compare(await load("missing"));
  await checkUnknown();
  assert.deepEqual(await segments(paths), ["", "", "", ""]);
  assert.equal(await page.locator(".plot-markers > *, .skyplot .plot-line, .skyplot g.sun, .skyplot g.earth").count(), 0);
  assert.equal(await details.getByText("No observations in this window.", { exact: true }).count(), 2);
  assert.ok(await slider.isDisabled());
  assert.equal(await slider.getAttribute("aria-valuetext"), "No shared samples");

  await compare(await load("crossing_wrap"));
  // The ridge Sun is below the horizon at the first and last sample; both seam crossings break the trail.
  assert.deepEqual(await trail("sun"), ["M", "M", "M"]);
  assert.deepEqual(await trail("earth"), ["MLLLL"]);
  await slider.press("Home");
  assert.equal(await page.locator(".skyplot g.sun").count(), 0);
  await slider.press("ArrowRight");
  const marker = page.locator(".skyplot g.sun circle");
  const distance = await marker.evaluate(el => Math.hypot(Number(el.getAttribute("cx")) - 100, Number(el.getAttribute("cy")) - 100));
  assert.ok(Math.abs(distance - 82) < 1e-6);
  const ridge = details.getByRole("table", { name: /^Primary · ridge-1/ });
  assert.equal(await ridge.getByRole("cell", { name: "0°", exact: true }).count(), 2);
  assert.match(await page.locator(".sky .angle-readout").innerText(), /El 0\.0°/);
  await primary.selectOption("basin-1");
  assert.deepEqual(await trail("sun"), ["ML", "M", "ML"]);
  assert.deepEqual(await trail("earth"), ["MLLLL"]);

  // A 75-minute gap also exceeds this partial fixture's nominal hourly cadence.
  partial.datasetId = "qa-partial-irregular";
  partial.scenarios[1].samples[1].utc = "2026-11-14T01:15:00Z";
  await compare(partial);
  await primary.selectOption("basin-1");
  assert.deepEqual(await segments(paths).then(lines => lines.slice(0, 2)), ["MMML", "MMML"]);
  for (const body of ["sun", "earth"]) assert.deepEqual(await trail(body), ["M", "M", "ML"]);
  assert.deepEqual(errors, []);
  console.log("Partial, missing, north wrap, exact zero and irregular cadence passed.", "Chromium", browser.version(), new Date().toISOString());
} finally { await browser.close(); }
