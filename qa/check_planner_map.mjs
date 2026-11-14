import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the URL of the production frontend.");
const catalog = JSON.parse(await readFile(new URL("../frontend/public/data/run-b2/catalog.json", import.meta.url)));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, chromiumSandbox: true });
try {
  const page = await browser.newPage({ viewport: { width: 375, height: 810 } });
  for (const [from, to, winners] of [
    ["14", "21", ["chandrayaan3_vikram"]],
    ["15", "16", ["apollo17", "chandrayaan3_vikram"]],
    ["13", "14", []],
  ]) {
    const params = new URLSearchParams({ mode: "sites", source: "saved-b2", priority: "joint",
      from: "2026-11-" + from, to: "2026-11-" + to });
    await page.goto(new URL("/plan?" + params, origin).href);
    const map = page.locator(".plan-site-map");
    await map.waitFor();
    assert.equal(await map.locator(".plan-map-point").count(), catalog.sites.length);
    const diamonds = await map.locator(".map-leader").evaluateAll(nodes => nodes.map(el => el.parentElement.dataset.site).sort());
    assert.deepEqual(diamonds, winners);
    const site = catalog.sites.find(s => s.id === "chandrayaan3_vikram");
    await map.getByRole("combobox").selectOption(site.id);
    const imagery = new URL(await map.getByRole("link", {name: /LROC/}).getAttribute("href"));
    assert.equal(Number(imagery.searchParams.get("c_lat")), site.lat_deg);
    assert.equal(Number(imagery.searchParams.get("c_lon")), site.lon_deg);
    await map.getByRole("button", {name: "Zoom in", exact: true}).click();
    assert.ok(await map.locator(".plan-map-zoom").getByText("2×").isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  console.log("Saved B2 planner map passed single, tied and zero-hour windows at 375 px.");
} finally { await browser.close(); }
