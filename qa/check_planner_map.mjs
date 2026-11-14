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
    await map.locator(".plan-globe-pins").waitFor();
    const list = page.locator(".plan-rank-list");
    assert.equal(await list.locator("tbody tr").count(), catalog.sites.length);
    const highlighted = await map.locator("select option").evaluateAll(nodes => nodes.filter(el => el.textContent.startsWith("◆")).map(el => el.value).sort());
    assert.deepEqual(highlighted, winners);
    for (const id of winners) {
      await list.getByRole("button", {name: catalog.sites.find(s => s.id === id).name, exact:true}).click();
      await map.locator(`[data-site="${id}"][aria-pressed="true"] .map-leader`).waitFor();
    }
    if (!winners.length) assert.equal(await map.locator(".map-leader").count(), 0);
    const site = catalog.sites.find(s => s.id === "chandrayaan3_vikram");
    await map.getByRole("combobox").selectOption(site.id);
    const pin = map.locator(`[data-site="${site.id}"]`);
    await map.locator("canvas").press("ArrowRight");
    await list.getByRole("button", {name:site.name, exact:true}).click();
    await page.waitForFunction(id => document.querySelector(`[data-site="${id}"]`)?.getAttribute("transform") === "translate(192 192)", site.id);
    await pin.click();
    const imagery = new URL(await map.getByRole("link", {name: /LROC/}).getAttribute("href"));
    assert.equal(Number(imagery.searchParams.get("c_lat")), site.lat_deg);
    assert.equal(Number(imagery.searchParams.get("c_lon")), site.lon_deg);
    await map.getByRole("button", {name: "Zoom in", exact: true}).click();
    assert.ok(await map.locator(".plan-map-zoom").getByText("2×").isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await map.getByRole("link", {name:"Site details", exact:true}).click();
    await page.waitForURL(url => url.pathname === "/plan/site" && url.searchParams.get("site") === site.id);
    assert.equal(await page.locator("#site-title").innerText(), site.name);
    const back = page.locator('a[href^="/plan?"]').first();
    await back.click();
    await map.locator(".plan-globe-pins").waitFor();
    assert.equal(await map.getByRole("combobox").inputValue(), site.id);
  }
  console.log("Saved B2 planner map passed single, tied and zero-hour windows at 375 px.");
} finally { await browser.close(); }
