import assert from "node:assert/strict";
import { terrainFixture } from "./browser-terrain-fixture.mjs";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the origin of a live-mode production preview.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });
const run = "pinned-recovery", site = "im2_athena";
const bounds = { start: "2026-01-01T00:00:00Z", at: "2026-01-01T02:00:00Z", end: "2026-01-01T04:00:00Z" };
const source = terrainFixture({ run, ...bounds });
const wrongWindow = terrainFixture({ run, start: bounds.end, at: "2026-01-01T06:00:00Z", end: "2026-01-01T08:00:00Z" });
const pinned = new URL("/compare", origin);
pinned.search = new URLSearchParams({ from: bounds.start, to: bounds.end, resolutionSeconds: "7200", run_id: run, view_site: site, at: bounds.at });
pinned.hash = "terrain-observations";

try {
  const page = await browser.newPage({ serviceWorkers: "block" });
  const reads = [];
  await page.route("**/api/v1/dataset?*", async route => {
    reads.push(route.request().url());
    await route.fulfill({ status: 404, json: { title: "Test outage", detail: "Test outage" } });
  });
  const error = page.locator("#data-error");
  const recover = error.getByRole("button", { name: "Import the correct dataset" });
  const retry = error.getByRole("button", { name: "Retry API request" });
  async function importFile(button, value) {
    await button.click();
    const dialog = page.locator("#import-dialog");
    await dialog.getByLabel("Import JSON dataset").setInputFiles({
      name: "fixture.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)),
    });
  }

  await page.goto(pinned.href);
  await error.getByText("Test outage", { exact: true }).waitFor();
  const wrongStep = structuredClone(source);
  for (const row of wrongStep.sites) row.series.step_s = 3600;
  const noSample = structuredClone(source);
  noSample.sites[1].series.t[1] = "2026-01-01T03:00:00Z";
  for (const [file, reason] of [
    [wrongWindow, "different requested UTC range"],
    [{ ...source, run: { ...source.run, run_id: "different" } }, "model run differs"],
    [{ ...source, sites: source.sites.slice(0, 1) }, "sites do not match"],
    [wrongStep, "sampling step"],
    [noSample, "shared UTC sample"],
    [{ schemaVersion: "frontend-draft-2" }, "terrain export"],
  ]) {
    await importFile(recover, file);
    await error.getByText(new RegExp(reason)).waitFor();
    assert.equal(await page.locator("#workspace.terrain-result").count(), 0);
    assert.equal(await retry.count(), 1);
    assert.equal(page.url(), pinned.href);
  }
  await retry.click();
  await error.getByText("Test outage", { exact: true }).waitFor();
  assert.equal(reads.length, 2);
  assert.equal(reads[0], reads[1]);

  await importFile(recover, source);
  const sample = page.locator("#terrain-sample-utc");
  await sample.waitFor();
  assert.equal(await sample.getAttribute("datetime"), bounds.at);
  assert.equal(await page.locator("#terrain-observations select").inputValue(), site);
  assert.equal(page.url(), pinned.href);
  assert.equal(await error.count(), 0);
  assert.equal(await page.locator("#alternative-dates").count(), 0);
  assert.equal(reads.length, 2);

  await importFile(page.getByRole("button", { name: "Import data", exact: true }), wrongWindow);
  await page.waitForFunction(utc => document.querySelector("#terrain-sample-utc")?.dateTime === utc, bounds.end);
  assert.equal(new URL(page.url()).search, "");
  assert.equal(reads.length, 2);
  console.log("Pinned recovery rejected six incompatible files, retried the original GET, restored the exact sample offline, and kept manual import independent.", browser.version());
} finally { await browser.close(); }
