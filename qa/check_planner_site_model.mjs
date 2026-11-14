import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const origin = process.argv[2];
if (!origin) throw Error("Pass the URL of a frontend build configured for the team API.");
const data = name => readFile(new URL("../frontend/public/data/run-b2/" + name, import.meta.url)).then(JSON.parse);
const catalog = await data("catalog.json"), archive = await data("visibility.json");
const ids = catalog.sites.map(site => site.id);
const run = { run_id: catalog.run_id, is_default: true, status: "ready", start_utc: archive.start, end_utc: archive.end,
  step_s: archive.stepSeconds, n_samples: archive.sampleCount, n_sites: ids.length, site_ids: ids };
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, chromiumSandbox: true });
try {
  for (const locale of ["en", "vi"]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    const requests = [];
    await page.addInitScript(value => localStorage.setItem("moon-plan-b-language", value), locale);
    await page.route("**/api/v1/**", route => {
      const path = new URL(route.request().url()).pathname;
      requests.push(route.request().method() + " " + path);
      if (path === "/api/v1/runs") return route.fulfill({ json: { default_run_id: run.run_id, runs: [run] } });
      if (path === "/api/v1/sites") return route.fulfill({ json: catalog });
      return route.abort();
    });
    const warning = page.getByText(locale === "vi" ? /không tính bóng đổ của địa hình/ : /omits local terrain shadows/);
    const query = new URLSearchParams({ mode: "dates", site: "apollo11", from: "2026-11-14", to: "2026-11-21", priority: "joint", missionHours: "5" });
    for (const source of ["saved-b2", "live"]) {
      if (source === "live") query.delete("source"); else query.set("source", source);
      await page.goto(new URL("/plan?" + query, origin).href);
      const site = page.locator(source === "live" ? 'select[name="landingSite"]' : 'select[name="savedLandingSite"]');
      await warning.waitFor();
      assert.equal(await site.inputValue(), "apollo11");
      assert.equal(await warning.count(), 1);
      await site.selectOption("a3_haworth");
      await warning.waitFor({ state: "hidden" });
      await site.selectOption("apollo17");
      await warning.waitFor();
      if (source === "saved-b2") {
        await page.locator('form:has(select[name="savedLandingSite"]) button[type="submit"]').click();
        await page.locator(".plan-results h3").waitFor();
        assert.equal(await warning.count(), 1);
        assert.deepEqual(requests, []);
      }
    }
    for (const site of ["apollo11", "a3_haworth"]) {
      const report = new URLSearchParams({ source: "saved-b2", site, from: "2026-11-14", to: "2026-11-21", priority: "joint" });
      await page.goto(new URL("/plan/site?" + report, origin).href);
      const metadata = catalog.sites.find(row => row.id === site);
      const sources = page.locator("section[aria-labelledby=site-sources]");
      await sources.waitFor();
      assert((await sources.innerText()).includes(metadata.dem_source));
      assert.equal(await warning.count(), site === "apollo11" ? 1 : 0);
    }
    assert.deepEqual(requests, ["GET /api/v1/runs", "GET /api/v1/sites"]);
    await page.close();
  }
  console.log("Site-first terrain warnings passed in EN/VI for the saved catalog, replayed live catalog and saved site reports.");
} finally { await browser.close(); }
