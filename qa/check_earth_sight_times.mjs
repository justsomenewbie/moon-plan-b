import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { terrainFixture } from "./browser-terrain-fixture.mjs";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass a frontend URL with access to run B2, or set TERRAIN_DATASET_REPLAY.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, chromiumSandbox: true });
const from = "2026-11-07", to = "2026-11-14";
const expected = [
  ["2026-11-07T00:00:00Z", "2026-11-07T13:00:00Z"],
  ["2026-11-12T11:00:00Z", "2026-11-14T00:00:00Z"],
];
const url = (path, params) => new URL(path + "?" + new URLSearchParams(params), origin).href;
const replay = process.env.TERRAIN_DATASET_REPLAY && await readFile(process.env.TERRAIN_DATASET_REPLAY);
const labels = {
  en: { summary: "When is Earth in direct view?", total: "50 of 168 h", empty: /no direct view/, absent: /Exact times are unavailable/, end: /ends just before/, precision: /approximate \(±1 h\)/ },
  vi: { summary: "Khi nào có đường nhìn thẳng tới Trái Đất?", total: "50 trên 168 giờ", empty: /không ghi nhận thời điểm nào/, absent: /Chưa có mốc giờ cụ thể/, end: /trước mốc kết thúc/, precision: /sai số ±1 giờ/ },
};

async function inspect(page, region, copy, state, bounds) {
  const box = region.locator("details.earth-sight-times");
  const summary = box.getByText(copy.summary, { exact: true });
  await summary.waitFor();
  if (!(await box.evaluate(node => node.open))) {
    await summary.focus();
    await page.keyboard.press("Enter");
  }
  assert(await box.evaluate(node => node.open));
  if (state === "split" || state === "whole") {
    await box.getByText(copy.end).waitFor();
    const intervals = await box.getByRole("listitem").evaluateAll(items =>
      items.map(item => [...item.querySelectorAll("time")].map(time => time.dateTime)));
    assert.deepEqual(intervals, state === "split" ? expected : [bounds]);
  } else {
    await box.getByText(copy[state]).waitFor();
    assert.equal(await box.getByRole("listitem").count(), 0);
  }
  assert.equal(await box.getByText(copy.precision).count(), state === "split" ? 1 : 0);
  assert(await box.evaluate(node => node.scrollWidth <= node.clientWidth), "Interval content overflows");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Page overflows");
}

try {
  for (const [locale, width] of [["en", 1280], ["vi", 320]]) {
    const page = await browser.newPage({ viewport: { width, height: 850 }, reducedMotion: "reduce", serviceWorkers: "block" });
    await page.addInitScript(lang => localStorage.setItem("moon-plan-b-language", lang), locale);
    if (replay) await page.route("**/api/v1/dataset?**", route => route.fulfill({ contentType: "application/json", body: replay }));
    const copy = labels[locale];
    const query = { mode: "sites", source: "saved-b2", from, to, priority: "earth", site: "im2_athena" };
    await page.goto(url("/plan", query));
    const inspector = page.locator(".plan-map-inspector");
    const site = inspector.getByRole("combobox");
    await site.selectOption("im2_athena");
    await inspector.getByText(new RegExp(copy.total)).waitFor();
    await inspect(page, inspector, copy, "split");
    await site.selectOption("apollo11");
    await inspect(page, inspector, copy, "whole", [expected[0][0], expected[1][1]]);
    await site.selectOption("change4");
    await inspect(page, inspector, copy, "empty");
    await site.selectOption("im2_athena");
    await inspector.locator('a[href*="/plan/site?"]').click();
    const report = page.locator('section[aria-labelledby="site-visibility"]');
    await report.getByText(copy.total, { exact: true }).waitFor();
    await inspect(page, report, copy, "split");
    await page.goto(url("/plan/site", { source: "saved", site: "apollo11", from: "2026-11-14", to: "2026-11-15", priority: "earth" }));
    await inspect(page, report, copy, "absent");

    // Within Apollo 11's winning 24-hour mission, both interval edges are mission bounds.
    await page.goto(url("/plan", { ...query, site: "apollo11", missionHours: "24" }));
    await site.selectOption("apollo11");
    await inspect(page, inspector, copy, "whole", [expected[0][0], "2026-11-08T00:00:00Z"]);

    await page.goto(url("/plan", { mode: "dates", source: "saved-b2", site: "a3_nobile_rim_1", from: "2026-11-14", to: "2026-11-21", missionHours: "24", priority: "joint" }));
    const candidate = page.locator(".plan-results tbody tr").first();
    const earth = candidate.locator("details.earth-sight-times");
    await earth.locator("summary").press("Enter");
    assert.match(await earth.locator("summary").innerText(), /^18 /);
    assert.deepEqual(await earth.locator("li time").evaluateAll(times => times.map(time => time.dateTime)),
      ["2026-11-19T21:00:00Z", "2026-11-20T15:00:00Z"]);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Opened candidate overflows page");

    const dataset = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/dataset" && response.ok());
    await page.goto(url("/compare", { run_id: "B2_spice_pgda_bruteforce_2026_2030_fix676af9d",
      site_id: "im2_athena", view_site: "im2_athena", from: from + "T00:00:00Z", to: to + "T00:00:00Z", resolutionSeconds: "3600" }) + "#terrain-observations");
    const data = await (await dataset).json();
    assert.equal(data.range.n_samples, 168);
    const athena = data.sites.find(row => row.id === "im2_athena");
    assert.deepEqual(athena.windows.earth.map(w => [w.start, w.end]), expected);
    await inspect(page, page.locator(".visibility-bands"), copy, "split");
    if (locale === "en") {
      // This synthetic import deliberately has a half-hour native grid and a two-hour series stride.
      const stamp = hours => `2026-01-01T0${hours}:00:00Z`;
      const fixture = terrainFixture({ run: "test-precision", start: stamp(0), at: stamp(2), end: stamp(4) });
      fixture.range.step_s = 1800;
      fixture.range.n_samples = 8;
      const site = fixture.sites[0];
      const span = { start: stamp(1), end: stamp(4), duration_h: 3, clipped_start: false, clipped_end: true };
      for (const body of ["sun", "earth", "both"]) {
        site.windows[body] = [span];
        site.series[body + "_visible"] = [false, true];
      }
      site.series.n_transitions = 1;
      site.criteria.forEach(criterion => Object.assign(criterion, { value_h: 3, value_clipped: true }));
      await page.getByLabel("Choose JSON file").setInputFiles({
        name: "precision.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)),
      });
      const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: site.name, exact: true }) });
      await card.getByText(/approximate \(±0\.5 h\)/).waitFor();
      await card.getByText(/End clipped/).waitFor();
      assert.deepEqual(await card.locator("li time").evaluateAll(times => times.map(time => time.dateTime)), [span.start, span.end]);
      const empty = page.getByRole("article").filter({ has: page.getByRole("heading", { name: fixture.sites[1].name, exact: true }) });
      assert.equal(await empty.getByText(/±/).count(), 0);
    }
    await page.close();
    console.log(locale, width, "px: verified two Earth sight intervals, zero visibility and unavailable times.");
  }
} finally {
  await browser.close();
}
