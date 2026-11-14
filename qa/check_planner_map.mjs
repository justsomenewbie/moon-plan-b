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
    await page.goto(new URL("/plan?" + params, origin).href, { waitUntil: "domcontentloaded" });
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
    if (from === "14") {
      const requests = [];
      await page.route("https://wms.im-ldi.com/**", route => {
        requests.push(new URL(route.request().url()).searchParams);
        if (requests.length === 1) return route.abort();
        return route.fulfill({contentType: "image/png", body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jtwAAAABJRU5ErkJggg==", "base64")});
      });
      const duration = page.getByRole("spinbutton", {name: "Mission duration in hours (optional)", exact: true});
      assert.equal(await duration.getAttribute("aria-describedby"), "catalog-duration-help");
      const fields = page.locator(".catalog-fields :is(input,select)");
      for (const width of [375, 1100]) {
        await page.setViewportSize({width, height: 810});
        const boxes = await fields.evaluateAll(els => els.map(el => {
          const r = el.getBoundingClientRect(); return [r.width, r.height, r.top];
        }));
        assert.equal(boxes.length, 4);
        for (const [w, h, y] of boxes) {
          assert.ok(Math.abs(w - boxes[0][0]) < 1 && h === boxes[0][1]);
          if (width === 1100) assert.equal(y, boxes[0][2]);
        }
      }
      await page.setViewportSize({width: 375, height: 810});
      await map.getByRole("button", {name: "Surface close-up", exact: true}).click();
      const region = map.locator(".plan-regional-view");
      await region.getByRole("button", {name: "Retry image"}).click();
      await region.locator(".plan-regional-center").waitFor();
      assert.equal(requests[1].get("BBOX"), "-40000,-40000,40000,40000");
      assert.equal(requests[1].get("SRS"), requests[0].get("SRS"));
      await region.getByRole("button", {name: "Zoom in"}).click();
      await region.locator(".plan-regional-center").waitFor();
      assert.equal(requests.at(-1).get("BBOX"), "-20000,-20000,20000,20000");
      assert.ok(await region.getByRole("button", {name: "Zoom in"}).isDisabled());
      const far = catalog.sites.find(s => s.id === "change4");
      await selector.selectOption(far.id);
      await region.getByRole("img", {name: "Lunar surface around " + far.name}).waitFor();
      await region.locator(".plan-regional-center").waitFor();
      assert.equal(requests.at(-1).get("SRS"), `IAU2000:30166,9001,${far.lon_deg},${far.lat_deg}`);
      await region.getByRole("button", {name: "Terrain relief", exact: true}).click();
      await region.locator(".plan-regional-center").waitFor();
      assert.equal(requests.at(-1).get("LAYERS"), "luna_wac_dtm");
      assert.equal(requests.at(-1).get("BBOX"), "-20000,-20000,20000,20000");
      assert.equal(requests.at(-1).get("SRS"), `IAU2000:30166,9001,${far.lon_deg},${far.lat_deg}`);
      for (const width of [80, 160]) {
        await region.getByRole("button", {name: "Zoom out"}).click();
        await region.locator(".plan-regional-center").waitFor();
        assert.equal(await region.locator("output").innerText(), width + " km across");
      }
      assert.ok(await region.getByRole("button", {name: "Zoom out"}).isDisabled());
      await selector.selectOption("apollo11");
      await region.locator(".plan-regional-center").waitFor();
      const siteSrs = requests.at(-1).get("SRS");
      await map.getByRole("button", {name: "3D globe", exact: true}).click();
      await globe.locator("canvas").waitFor();
      await globe.getByRole("button", {name: "Look east"}).click();
      await globe.getByRole("button", {name: "Close-up at map center"}).click();
      await region.locator(".plan-regional-center").waitFor();
      assert.notEqual(requests.at(-1).get("SRS"), siteSrs);
      assert.match(await region.locator("figcaption strong").innerText(), /Map location/);
      await map.getByRole("button", {name: "Flat map", exact: true}).click();
      await map.locator(".plan-map-surface image").click({position: {x: 15, y: 20}});
      await region.locator(".plan-regional-center").waitFor();
      assert.match(await region.locator("figcaption strong").innerText(), /Map location/);
      assert.equal(await selector.inputValue(), "apollo11");
    }
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
