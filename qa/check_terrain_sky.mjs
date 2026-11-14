import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { terrainFixture } from "./browser-terrain-fixture.mjs";

const [origin, imageDir] = process.argv.slice(2);
if (!origin) throw Error("Pass the live-mode frontend URL.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", err => errors.push(err.message));
  if (process.env.TERRAIN_DATASET_REPLAY) {
    const body = await readFile(process.env.TERRAIN_DATASET_REPLAY);
    await page.route("**/api/v1/dataset?**", route => route.fulfill({ contentType: "application/json", body }));
  }
  const loaded = page.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/dataset" && r.status() === 200);
  const url = new URL("/compare", origin);
  url.search = new URLSearchParams({ run_id: "B2_spice_pgda_bruteforce_2026_2030_fix676af9d",
    site_ids: "im1_odysseus,im2_athena", from: "2026-11-14T00:00:00Z", to: "2026-11-21T00:00:00Z",
    resolutionSeconds: "3600", view_site: "im1_odysseus", at: "2026-11-15T05:00:00Z" });
  url.hash = "local-sky";
  await page.goto(url.href);
  const raw = await (await loaded).json();
  const sky = page.locator("#local-sky"), globe = page.locator("#terrain-lunar-reference");
  await sky.waitFor();
  await globe.locator("canvas:not([hidden])").waitFor();
  const view = sky.getByRole("combobox", { name: "View from" });
  const observationSite = page.getByRole("combobox", { name: "Observation site" });
  async function checkSite(id) {
    const site = raw.sites.find(row => row.id === id), series = site.series;
    const at = await sky.locator("time").getAttribute("datetime");
    assert.equal(at, "2026-11-15T05:00:00Z");
    assert.equal(await globe.locator("select").inputValue(), id);
    assert.equal(await observationSite.inputValue(), id);
    const selected = new URL(page.url()).searchParams;
    assert.equal(selected.get("view_site"), id);
    assert.equal(selected.get("at"), at);
    const i = series.t.indexOf(at);
    assert.ok(i >= 0);
    for (const body of ["sun", "earth"]) {
      const marker = sky.locator('[data-sky-body="' + body + '"]');
      const label = await marker.getAttribute("aria-label");
      assert.ok(label.includes(site.name) && label.includes(at));
      assert.ok(label.includes("Az " + series[body + "_az_deg"][i] + "°"));
      assert.ok(label.includes("El " + series[body + "_el_deg"][i] + "°"));
      const expected = series[body + "_visible"][i] ? "Visible" : "Hidden";
      assert.ok((await sky.locator("#sky-body-readings > div").nth(body === "sun" ? 0 : 1).innerText()).includes("Terrain model: " + expected));
    }
  }
  await checkSite("im1_odysseus");
  await observationSite.selectOption("im2_athena");
  await checkSite("im2_athena");
  await globe.locator("select").selectOption("im1_odysseus");
  await checkSite("im1_odysseus");
  // These nearby polar pins overlap at 1×. Use the pin's native keyboard activation.
  await globe.locator('[data-site="im2_athena"] button').press("Enter");
  await checkSite("im2_athena");
  await view.selectOption("A");
  await checkSite("im1_odysseus");
  await view.selectOption("B");
  await checkSite("im2_athena");
  await view.selectOption("both");
  assert.equal(await sky.locator("[data-sky-body]").count(), 4);
  await sky.getByRole("button", { name: /^5°/ }).click();
  assert.equal(await sky.locator("#horizon-clearance-input").inputValue(), "5");
  assert.equal(await page.locator(".timeline .clearance-line").count(), 1);
  const slider = page.getByRole("slider", { name: "Observation sample" });
  await slider.press("ArrowRight");
  assert.equal(await sky.locator("time").getAttribute("datetime"), "2026-11-15T06:00:00Z");
  assert.equal(await sky.locator(".mission-ribbon").count(), 2);
  assert.equal(await sky.locator(".lander-side-svg").count(), 1);
  assert.equal(await page.locator(".skyplot").count(), 1);
  await page.getByText("Inspect exact samples", {exact:true}).click();
  const table = page.locator(".sample-table");
  await table.first().locator("tbody tr").first().waitFor();
  assert.equal(await table.first().locator("tbody tr").count(), raw.sites[0].series.t.length);
  await view.selectOption("A");
  await sky.getByRole("button", { name: /^0°/ }).click();
  await page.locator(".language-switch select").first().selectOption("vi");
  assert.equal(await sky.locator("h2").innerText(), "Bầu trời 3D tại điểm quan sát");
  if (imageDir) {
    await sky.evaluate(el => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: imageDir + "/compare-sky-vi.png" });
    await globe.scrollIntoViewIfNeeded();
    await globe.screenshot({ path: imageDir + "/compare-globe-vi.png" });
  }
  // For unequal returned grids, the matching UTC can move to a different index or be unavailable.
  const start = "2026-11-15T00:00:00Z", one = "2026-11-15T01:00:00Z", two = "2026-11-15T02:00:00Z";
  const sparse = terrainFixture({ run: "partial-utc-test", start, at: one, end: "2026-11-15T04:00:00Z" });
  sparse.sites[1].series.t = [one, two];
  await page.getByRole("button", { name: "Nhập dữ liệu", exact: true }).click();
  await page.locator("#import-dialog input[type=file]").setInputFiles({
    name: "partial-utc-test.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(sparse)),
  });
  const clock = page.locator("#terrain-sample-utc");
  const sparseSite = page.locator("#terrain-observations > label select");
  const sparseSample = page.locator('#terrain-observations .slider-label input');
  await page.waitForFunction(utc => document.querySelector("#terrain-sample-utc")?.getAttribute("datetime") === utc, start);
  await sparseSample.press("ArrowRight");
  await sparseSite.selectOption("im2_athena");
  assert.equal(await clock.getAttribute("datetime"), one);
  assert.equal(await sparseSample.inputValue(), "0");
  await sparseSample.press("ArrowRight");
  assert.equal(await clock.getAttribute("datetime"), two);
  await sparseSite.selectOption("im1_odysseus");
  assert.equal(await clock.getAttribute("datetime"), start);
  assert.deepEqual(errors, []);
  console.log("Live sky: both sites, exact UTC and four producer angles per site, overlay, clearance, sample slider, ribbon, HUD, sample table and lunar globe passed.");
} finally { await browser.close(); }
