import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { terrainFixture } from "./browser-terrain-fixture.mjs";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass a live-mode frontend URL. The browser intercepts all API requests.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const start = "2026-01-01T00:00:00Z", at = "2026-01-01T02:00:00Z", end = "2026-01-01T04:00:00Z";
const run = "guide-test", fixture = terrainFixture({ run, start, at, end });
const site = fixture.sites[1].id;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });
try {
  for (const locale of ["en", "vi"]) {
    const page = await browser.newPage({ serviceWorkers: "block", reducedMotion: "reduce" });
    await page.addInitScript(l => localStorage.setItem("moon-plan-b-language", l), locale);
    const dataset = { ...fixture, sites: [fixture.sites[1]] };
    let action, expectedContext = "terrain", catalogGets = 0;
    await page.route("**/api/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/dataset")) return route.fulfill({ json: dataset });
      if (path.endsWith("/sites")) { catalogGets++; return route.fulfill({ status: 404, json: { detail: "Catalog unavailable" } }); }
      return route.fulfill({ status: 404, json: {} });
    });
    await page.route("**/guide/chat", route => {
      assert.equal(route.request().postDataJSON().context.kind, expectedContext);
      return route.fulfill({ json: { answer: "Fixture action", action } });
    });
    const url = new URL("/compare", origin);
    url.search = new URLSearchParams({ from: start, to: end, resolutionSeconds: "3600", run_id: run, site_id: site });
    await page.goto(url.href);
    await page.locator("#terrain-pair").waitFor({ timeout: 20000 });
    const panel = page.locator("aside[popover]");
    const modes = locale === "en" ? { compareSites: "Compare sites", compareDates: "Compare dates" }
      : { compareSites: "So sánh hai địa điểm", compareDates: "So sánh hai khoảng thời gian" };
    async function ask(mode, context = "terrain", source) {
      action = mode;
      expectedContext = context;
      await page.locator("button[popovertarget]").first().click();
      await panel.getByText(locale === "en" ? "Ask the astronaut" : "Hỏi phi hành gia", { exact: true }).click();
      if (source) await panel.locator("select").selectOption(source);
      await panel.locator("textarea").fill(mode);
      await panel.locator('button[type="submit"]').click();
      await panel.getByRole("log").getByText("Fixture action", { exact: false }).waitFor();
      return panel.getByRole("button", { name: modes[mode], exact: true });
    }
    for (const [mode, detail] of [["compareSites", "#terrain-pair"], ["compareDates", "#terrain-dates details"]]) {
      await (await ask(mode)).click({ timeout: 2000 });
      assert.equal(await page.locator(detail).evaluate(el => el.open && el.querySelector("summary") === document.activeElement), true);
      if (mode === "compareSites") assert.ok(await page.locator("#terrain-pair button[type=submit]").isDisabled());
    }
    assert.ok(catalogGets > 0);

    await (await ask("compareSites", "saved", "saved")).click();
    assert.equal(new URL(page.url()).hash, "#observed-week");
    const file = page.locator("input[type=file]");
    await file.setInputFiles({ name: "offline.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)) });
    await page.locator("#terrain-pair").waitFor({ state: "detached" });
    assert.equal(await (await ask("compareSites", "terrain", "workspace")).count(), 0);
    assert.equal(await panel.getByRole("link", { name: modes.compareSites, exact: true }).count(), 0);
    await page.keyboard.press("Escape");
    await file.setInputFiles(fileURLToPath(new URL("../frontend/public/data/demo.json", import.meta.url)));
    await page.locator(".mode-switch").waitFor();
    await (await ask("compareSites", "synthetic")).click();
    assert.equal(await page.locator(".mode-switch button").last().getAttribute("aria-pressed"), "true");
    await page.close();
  }
  console.log("Terrain panel focus, unavailable catalog, offline import, saved and scenario actions passed in English and Vietnamese.");
} finally { await browser.close(); }
