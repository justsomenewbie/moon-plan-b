import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass a running frontend origin.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const gap = new URL("./evidence/odysseus-athena-hour-gap/gap.json", import.meta.url);
const gapData = JSON.parse(await readFile(gap, "utf8"));
const normal = await readFile(new URL("./fixtures/normal.json", import.meta.url));
const invalid = new URL("./fixtures/invalid/", import.meta.url);
const reasons = {
  "azimuth_360.json": /Azimuth must be below 360 degrees/,
  "corrupted_schema.json": /model must be an object/,
  "duplicate_utc.json": /Samples must be strictly increasing/,
  "missing_timestamp.json": /Complete coverage cannot skip a scheduled sample/,
  "timezone_offset.json": /Sample timestamp must be an ISO UTC timestamp ending in Z/,
};
assert.deepEqual((await readdir(invalid)).filter(file => file.endsWith(".json")).sort(), Object.keys(reasons).sort());
const limit = 5 * 1024 * 1024;
const atLimit = Buffer.alloc(limit, " ");
normal.copy(atLimit);
const cases = Object.entries(reasons).map(([name, reason]) => [name, fileURLToPath(new URL(name, invalid)), reason]);
for (const [name, buffer, reason] of [
  ["wrong-version", Buffer.from(JSON.stringify({ ...JSON.parse(normal), schemaVersion: "unknown" })), /Unsupported schema/],
  ["malformed", Buffer.from("{broken}"), /JSON|property name/i],
  ["empty", Buffer.alloc(0), /end of JSON/i],
  ["over-limit", Buffer.concat([atLimit, Buffer.from(" ")]), /5 MiB or less/],
]) cases.push([name, { name: name + ".json", mimeType: "application/json", buffer }, reason]);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ timezoneId: "UTC", reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  const button = page.getByRole("button", { name: "Import data", exact: true, disabled: false });
  async function choose(file) {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), button.click()]);
    await chooser.setFiles(file);
  }
  await choose(fileURLToPath(gap));
  const sources = page.locator("#sources");
  await sources.getByText(gapData.datasetId, { exact: true }).waitFor({ state: "attached" });
  await page.getByRole("button", { name: "Compare sites", exact: true }).click();
  const primary = page.getByLabel(/^Primary site/);
  await primary.selectOption("athena-jan07");
  const slider = page.getByRole("slider", { name: "Timeline sample" });
  await slider.press("Home");
  await slider.press("ArrowRight");
  await slider.press("ArrowRight");
  const exact = page.locator("details").filter({ has: page.getByText("Inspect exact samples", { exact: true }) });
  async function selection() {
    if (!await exact.evaluate(el => el.open)) await exact.locator("summary").click();
    return {
      primary: await primary.inputValue(), alternative: await page.getByLabel(/^Alternative site/).inputValue(),
      clock: await page.locator(".sample-time").innerText(), accessible: await slider.getAttribute("aria-valuetext"),
      tables: await exact.getByRole("table").allInnerTexts(),
    };
  }
  const before = await selection();
  assert.equal(before.primary, "athena-jan07");
  assert.equal(before.alternative, "odysseus-jan07");
  assert.match(before.clock, /Primary: .*03:00 UTC · Alternative: .*03:00 UTC$/);
  assert.equal(before.tables.length, 2);
  const alert = page.getByRole("alert").filter({ hasText: "Import rejected:" });
  for (const [name, file, reason] of cases) {
    await choose(file);
    await alert.filter({ hasText: reason }).waitFor();
    assert.match(await alert.innerText(), /The previous dataset has not changed/);
    assert.ok(await alert.evaluate(el => document.activeElement === el), name + " alert must receive focus");
    await sources.getByText(gapData.datasetId, { exact: true }).waitFor({ state: "attached" });
    assert.deepEqual(await selection(), before, name);
    console.log(name, "rejected");
  }
  await choose({ name: "exact-limit.json", mimeType: "application/json", buffer: atLimit });
  await sources.getByText(JSON.parse(normal).datasetId, { exact: true }).waitFor({ state: "attached" });
  assert.equal(await alert.count(), 0);
  await page.getByRole("button", { name: "Compare sites", exact: true }).click();
  assert.equal(await primary.inputValue(), "ridge-1");
  assert.deepEqual(errors, []);
  console.log("Exact 5 MiB accepted.", "Chromium", browser.version(), new Date().toISOString());
} finally { await browser.close(); }
