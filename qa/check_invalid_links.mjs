import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { terrainFixture } from "./browser-terrain-fixture.mjs";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the URL of the live-mode frontend workspace.");
const file = fileURLToPath(new URL("./evidence/odysseus-athena-hour-gap/gap.json", import.meta.url));
const archive = JSON.parse(await readFile(file, "utf8"));
const [odysseus, athena] = archive.scenarios;
const spec = { run: "ui10-review", start: "2026-01-02T00:00:00Z", at: "2026-01-02T02:00:00Z", end: "2026-01-02T04:00:00Z" };
const terrain = terrainFixture(spec);
const request = { from: spec.start, to: spec.end, resolutionSeconds: "7200" };
const sample = "2026-01-07T03:00:00Z";
const comparison = { ...request, v: archive.datasetId, mode: "sites", a: athena.id, b: odysseus.id, duration: "4", h: "1", sample };
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ timezoneId: "UTC" });
  const reads = [], errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/v1/dataset?*", async route => {
    assert.equal(route.request().method(), "GET");
    reads.push(route.request().url());
    await route.fulfill({ json: terrain });
  });
  const alert = page.locator("#data-error[role=alert]");
  const retry = alert.getByRole("button", { name: "Retry API request", exact: true });
  const field = page.getByLabel("Import JSON dataset");
  const workspace = page.locator("#workspace.terrain-result, #workspace.workspace, .sample-time");
  async function visit(params) {
    const url = new URL("/compare", origin);
    url.search = new URLSearchParams(params).toString();
    await page.goto(url.href);
    await page.getByRole("button", { name: "Import data", disabled: false }).waitFor();
    return url.href;
  }
  async function rejected(url, reason, allowPinnedRetry = false) {
    await alert.getByText(reason).first().waitFor();
    assert.equal(page.url(), url);
    assert.equal(await workspace.count(), 0);
    if (!allowPinnedRetry) assert.equal(await retry.count(), 0, "Retry must not switch to a default request");
  }
  async function importFile(path) {
    await page.getByRole("button", { name: "Import data", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await field.setInputFiles(path);
  }
  const malformed = new URLSearchParams(comparison);
  malformed.delete("v");
  const duplicate = new URLSearchParams(comparison);
  duplicate.append("a", odysseus.id);
  const liveDuplicate = new URLSearchParams({ ...request, run_id: spec.run, view_site: athena.siteId });
  liveDuplicate.append("view_site", odysseus.siteId);
  const mixed = new URLSearchParams({ ...comparison, run_id: spec.run });
  for (const params of [malformed, duplicate, liveDuplicate, mixed, new URLSearchParams({ job: "" }), new URLSearchParams({ view_site: "absent-site" })]) {
    const count = reads.length;
    const url = await visit(params);
    await rejected(url, /incomplete|duplicate|version|required|mixes|invalid|needs a pinned/i);
    assert.equal(reads.length, count, "Malformed link fetched a default dataset");
  }

  const stale = await visit({ ...comparison, v: "retired-release" });
  const mismatch = /different dataset version|exact release|version.*(match|unavailable)/i;
  await rejected(stale, mismatch);
  await alert.getByRole("button", { name: "Import the correct dataset" }).click();
  await page.getByRole("dialog").waitFor();
  await field.setInputFiles({ name: "unrelated-terrain.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(terrain)) });
  // Wait for the attempted import to finish, even if it leaves the same incompatibility message.
  await page.waitForFunction(() => !document.querySelector('#workspace[aria-busy="true"]') && document.activeElement?.id === "data-error");
  await rejected(stale, mismatch);
  await importFile(file);
  await rejected(stale, mismatch);
  assert.doesNotMatch(await page.locator(".live-status").innerText(), /Dataset imported locally/);

  const missingSample = sample.replace("03:00", "02:00");
  for (const [change, reason] of [
    [{ a: "absent-scenario" }, /scenario|unavailable|not available/i],
    [{ mode: "dates" }, /pair.*incompatible|incompatible.*window/i],
    [{ duration: "8" }, /duration|window/i],
    [{ sample: missingSample }, /sample.*unavailable|unavailable.*sample/i],
  ]) {
    const url = await visit({ ...comparison, ...change });
    await importFile(file);
    await rejected(url, reason);
  }
  // Explicitly choose the supplied release's defaults after the unavailable 02:00.
  await alert.getByRole("button", { name: "Use loaded dataset" }).click();
  await page.locator("#workspace.workspace").waitFor();
  assert.equal(new URL(page.url()).searchParams.has("sample"), false);
  assert.equal(await alert.count(), 0);
  assert.equal(await page.locator("#local-sky time").getAttribute("datetime"), odysseus.startUtc);

  // Both scenario IDs exist in the demo, but these two sites cover different UTC dates.
  const demo = fileURLToPath(new URL("../frontend/public/data/demo.json", import.meta.url));
  const crossed = await visit({ ...request, v: "synthetic-ui-v2", mode: "sites",
    a: "ridge-1", b: "basin-2", duration: "24", h: "6" });
  await importFile(demo);
  await rejected(crossed, /pair.*incompatible|incompatible.*window/i);

  const before = reads.length;
  const absentSite = await visit({ ...request, run_id: spec.run, view_site: "absent-site", at: spec.at });
  await rejected(absentSite, /site.*unavailable|unavailable.*site/i, true);
  assert.equal(reads.length, before + 1);
  if (await retry.count()) {
    const replay = page.waitForResponse(response => response.url() === reads[before]);
    await retry.click();
    await replay;
    await rejected(absentSite, /site.*unavailable|unavailable.*site/i, true);
    assert.deepEqual(reads.slice(before), [reads[before], reads[before]]);
  }

  await visit(comparison);
  await importFile(file);
  await page.locator("#workspace.workspace").waitFor();
  assert.equal(await page.getByLabel(/^Primary site/).inputValue(), athena.id);
  assert.equal(await page.getByLabel(/^Alternative site/).inputValue(), odysseus.id);
  assert.equal(await page.locator("#local-sky time").getAttribute("datetime"), sample);
  assert.deepEqual(errors, []);
  console.log("Malformed and incompatible links rejected; explicit recovery and the original shared UTC verified.", browser.version());
} finally { await browser.close(); }
