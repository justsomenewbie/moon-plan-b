import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the frontend URL.");
const manifest = JSON.parse(await readFile(new URL("../frontend/public/data/run-b2/manifest.json", import.meta.url)));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, chromiumSandbox: true });

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(new URL("/data", origin).href);
  const download = page.locator('#run-b2 a[download][href$="/sites.json"]');
  const response = await page.request.get(new URL(await download.getAttribute("href"), origin).href);
  assert.equal(response.status(), 200);
  const body = await response.body();
  assert.equal(createHash("sha256").update(body).digest("hex"), manifest.files["sites.json"]);
  const { sites } = JSON.parse(body);
  assert.equal(new Set(sites.map(site => site.id)).size, 23);
  const haworth = sites.find(site => site.id === "a3_haworth");

  for (const locale of ["en", "vi"]) {
    await page.goto(new URL("/data", origin).href);
    await page.locator(".language-switch select").first().selectOption(locale);
    const title = locale === "en" ? "Coordinate note" : "Ghi chú về tọa độ";
    const section = page.locator('section[aria-labelledby="source-files"]');
    const note = section.getByText(title, { exact: true }).locator("..").locator("dd");
    const citation = section.locator('dd[lang="en"]');
    await note.waitFor();
    for (const site of sites) {
      await section.getByRole("combobox").selectOption(site.id);
      await page.waitForFunction(expected => document.querySelector('section[aria-labelledby="source-files"] dd[lang="en"]').textContent === expected, site.source);
      const displayed = await note.innerText();
      assert.equal(await citation.innerText(), site.source);
      if (locale === "en") assert.equal(displayed, site.note);
      else {
        assert.ok(displayed.trim() && displayed !== site.note, site.id);
        if (site.id === haworth.id) assert.match(displayed, /20–50 km/);
      }
    }
    assert.equal(await page.locator('section[aria-labelledby="bundled-data"] a[href*="run-b2"]').count(), 0);

    for (const source of ["saved-b2", "saved"]) {
      const params = new URLSearchParams({ source, site: haworth.id, priority: "joint", from: "2026-11-14", to: "2026-11-15" });
      await page.goto(new URL("/plan/site?" + params, origin).href);
      await page.locator("#site-location").waitFor();
      const location = page.locator('section[aria-labelledby="site-location"]');
      if (source === "saved-b2") {
        assert.equal(await location.locator('dd[lang="en"]').innerText(), haworth.source);
        assert.equal(await location.getByText(title, { exact: true }).count(), 1);
      } else {
        assert.equal(await location.getByText(title, { exact: true }).count(), 0);
        assert.equal(await location.locator('dd[lang="en"]').count(), 0);
        assert.equal(await page.locator('main a[href*="/data/run-b2/"]').count(), 0);
      }
    }
  }
  console.log("EN/VI coordinate notes and original citations passed for all 23 B2 sites; earlier B reports retained their own sources.");
} finally { await browser.close(); }
