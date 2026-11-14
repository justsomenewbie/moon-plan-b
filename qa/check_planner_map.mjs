import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the URL of the production frontend.");
const catalog = JSON.parse(await readFile(new URL("../frontend/public/data/run-b2/catalog.json", import.meta.url)));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });
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
    assert.equal(await map.getByRole("button", { name: "3D globe", exact: true }).getAttribute("aria-pressed"), "true");
    const globe = map.locator("#planner-lunar-globe");
    await globe.locator("canvas").waitFor();
    const selector = map.getByRole("combobox");
    for (const id of winners) {
      await selector.selectOption(id);
      await globe.locator(`.site-pin[data-site="${id}"][data-leading="true"] button[aria-pressed="true"]`).waitFor();
    }
    if (!winners.length) assert.equal(await globe.locator('[data-leading="true"]').count(), 0);
    await selector.selectOption("apollo11");
    await globe.getByRole("button", { name: /Inspect Apollo 11/ }).waitFor();
    await globe.getByRole("button", { name: "Zoom in", exact: true }).click();
    await globe.locator(".globe-center").getByText(/2×/).waitFor();
    await map.getByRole("button", { name: "Flat map", exact: true }).click();
    assert.equal(await selector.inputValue(), "apollo11");
    assert.equal(await map.locator(".plan-map-point").count(), catalog.sites.length);
    const diamonds = await map.locator(".map-leader").evaluateAll(nodes => nodes.map(el => el.parentElement.dataset.site).sort());
    assert.deepEqual(diamonds, winners);
    const fallbackSites = catalog.sites.filter(s => s.horizon_method === "flat" && s.dem_source.startsWith("none:outside-"));
    const fallbackWinners = fallbackSites.filter(s => winners.includes(s.id));
    const caveat = page.locator(".plan-results .data-notice").getByText(/Local terrain shadows are omitted for/);
    assert.equal(await caveat.count(), fallbackWinners.length ? 1 : 0);
    for (const s of fallbackWinners) assert.ok((await caveat.textContent()).includes(s.name));
    const notice = map.getByText(/Outside elevation-map coverage/);
    await map.getByRole("combobox").selectOption("apollo11");
    assert.ok(await notice.isVisible());
    const site = catalog.sites.find(s => s.id === "chandrayaan3_vikram");
    await map.getByRole("combobox").selectOption(site.id);
    assert.equal(await notice.count(), 0);
    const imagery = new URL(await map.getByRole("link", {name: /LROC/}).getAttribute("href"));
    assert.equal(Number(imagery.searchParams.get("c_lat")), site.lat_deg);
    assert.equal(Number(imagery.searchParams.get("c_lon")), site.lon_deg);
    await map.getByRole("button", {name: "Zoom in", exact: true}).click();
    assert.ok(await map.locator(".plan-map-zoom").getByText("2×").isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const table = page.locator(".plan-results table");
    assert.equal(await table.getByRole("columnheader").count(), 4);
    assert.equal(await table.locator("tbody tr").count(), catalog.sites.length);
    const labelled = table.getByRole("rowheader").filter({hasText: "Smooth-sphere horizon"});
    assert.deepEqual((await labelled.getByRole("link").allTextContents()).sort(), fallbackSites.map(s => s.name).sort());
    assert.ok(await table.evaluate(el => el.getBoundingClientRect().top >= document.querySelector(".plan-site-map").getBoundingClientRect().bottom));
    const detail = catalog.sites.find(s => s.id === "apollo11");
    const detailLink = map.getByRole("link", {name:"Site details", exact:true});
    assert.equal(await detailLink.getAttribute("href"), await table.getByRole("link", {name:site.name, exact:true}).getAttribute("href"));
    await map.getByRole("combobox").selectOption(detail.id);
    assert.equal(await detailLink.getAttribute("href"), await table.getByRole("link", {name:detail.name, exact:true}).getAttribute("href"));
    await (from === "14" ? detailLink : table.getByRole("link", {name:detail.name, exact:true})).click();
    await page.waitForURL(url => url.pathname === "/plan/site" && url.searchParams.get("site") === detail.id);
    assert.equal(await page.locator("#site-title").innerText(), detail.name);
    await page.getByRole("link", { name: "Back to these site results" }).click();
    await map.waitFor();
    assert.equal(await map.getByRole("combobox").inputValue(), detail.id);
  }
  console.log("Saved B2 planner map passed single, tied and zero-hour windows at 375 px.");
} finally { await browser.close(); }
