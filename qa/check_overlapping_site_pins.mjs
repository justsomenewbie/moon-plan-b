import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass a URL serving the Moon Plan B frontend.");
const catalog = JSON.parse(await readFile(new URL("../frontend/public/data/run-b2/catalog.json", import.meta.url)));
const athena = catalog.sites.find(site => site.id === "im2_athena");
const plateau = catalog.sites.find(site => site.id === "a3_mons_mouton_plateau");
const query = new URLSearchParams({ mode: "sites", source: "saved-b2", from: "2026-11-14", to: "2026-11-21", priority: "joint" });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, chromiumSandbox: true });
try {
  for (const [locale, width] of [["vi", 375], ["en", 1280]]) {
    const mobile = locale === "vi";
    const page = await browser.newPage({ viewport: { width, height: 812 }, hasTouch: mobile, isMobile: mobile, reducedMotion: "reduce" });
    await page.addInitScript(lang => localStorage.setItem("moon-plan-b-language", lang), locale);
    await page.goto(new URL("/plan?" + query, origin).href, { waitUntil: "domcontentloaded" });
    const map = page.locator(".plan-site-map");
    const globe = map.locator("#planner-lunar-globe");
    const inspect = map.getByRole("combobox");
    const chooser = page.getByRole("dialog", {
      name: mobile ? "Chọn địa điểm tại vị trí này" : "Choose a site at this point", exact: true,
    });
    // Click the projected coordinates. Locator.click() would wait for an obscured target.
    async function activateCenter(marker) {
      await marker.scrollIntoViewIfNeeded();
      const rect = await marker.boundingBox();
      assert(rect);
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      if (mobile) await page.touchscreen.tap(x, y);
      else await page.mouse.click(x, y);
    }
    async function chooseAthena(marker) {
      await activateCenter(marker);
      await chooser.waitFor();
      assert(await chooser.evaluate(node => node.matches("dialog:modal")));
      await chooser.getByRole("button", { name: plateau.name, exact: true }).waitFor();
      const choice = chooser.getByRole("button", { name: athena.name, exact: true });
      if (mobile) await choice.tap();
      else await choice.click();
      await chooser.waitFor({ state: "hidden" });
      assert.equal(await inspect.inputValue(), athena.id);
    }
    await globe.locator("canvas").waitFor();
    await globe.locator(".globe-expand").click();
    const expanded = globe.locator("dialog.globe-view:modal");
    const pin = id => expanded.locator('.site-pin[data-site="' + id + '"] button');
    const initial = await inspect.inputValue();
    await activateCenter(pin(athena.id));
    await chooser.waitFor();
    await page.keyboard.press("Escape");
    await chooser.waitFor({ state: "hidden" });
    assert(await expanded.isVisible());
    assert.equal(await expanded.locator(".site-pin button:focus").count(), 1);
    assert.equal(await inspect.inputValue(), initial);

    await chooseAthena(pin(athena.id));
    assert.equal(await pin(athena.id).getAttribute("aria-pressed"), "true");
    await pin(plateau.id).focus();
    await page.keyboard.press("Enter");
    assert.equal(await inspect.inputValue(), plateau.id);
    assert.equal(await pin(plateau.id).getAttribute("aria-pressed"), "true");
    assert.equal(await chooser.count(), 0);
    await page.keyboard.press("Escape");
    await expanded.waitFor({ state: "hidden" });
    assert.equal(await globe.locator(".globe-expand:focus").count(), 1);

    await map.getByRole("button", { name: mobile ? "Bản đồ phẳng" : "Flat map", exact: true }).click();
    const flatPin = id => map.locator('svg .plan-map-point[data-site="' + id + '"]');
    await activateCenter(flatPin(athena.id));
    await chooser.getByRole("button", { name: mobile ? "Hủy" : "Cancel", exact: true }).click();
    await chooser.waitFor({ state: "hidden" });
    assert.equal(await map.locator(".plan-map-point:focus").count(), 1);
    assert.equal(await inspect.inputValue(), plateau.id);
    await chooseAthena(flatPin(athena.id));
    assert.equal(await flatPin(athena.id).getAttribute("aria-pressed"), "true");
    await activateCenter(flatPin("change6"));
    assert.equal(await inspect.inputValue(), "change6");
    assert.equal(await chooser.count(), 0);
    await page.close();
    console.log(locale, width, "px: verified clustered globe and flat pins, cancellation, keyboard and isolated selection.");
  }
} finally {
  await browser.close();
}
