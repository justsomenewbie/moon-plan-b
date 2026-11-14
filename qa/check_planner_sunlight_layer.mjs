import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
const execFile = promisify(execFileCallback);

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the URL of a frontend using the live planner API.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, chromiumSandbox: true });
try {
  for (const [locale, width] of [["en", 1280], ["vi", 375]]) {
    const page = await browser.newPage({ viewport: { width, height: 850 }, reducedMotion: "reduce", serviceWorkers: "block" });
    await page.addInitScript(l => localStorage.setItem("moon-plan-b-language", l), locale);
    // Optionally replay the existing public proxy's responses against a local production build.
    // No credentials are read; the deployed app handles its own producer connection.
    if (process.env.PLANNER_QA_PUBLIC_API === "1") {
      await page.route("**/api/v1/**", async route => {
        const target = new URL(route.request().url());
        target.protocol = "https:"; target.host = "moon-plan-b.vercel.app"; target.port = "";
        const { stdout } = await execFile("curl", ["--fail", "--silent", "--show-error", "--max-time", "45", target.href],
          { maxBuffer: 12_000_000 });
        await route.fulfill({ contentType: "application/json", body: stdout });
      });
    }
    const modelRequests = [];
    page.setDefaultTimeout(60000);
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/v1/")) modelRequests.push(request.url()); });
    const params = new URLSearchParams({ mode: "sites", from: "2026-11-14", to: "2026-11-21", priority: "joint" });
    await page.goto(new URL("/plan?" + params, origin).href);
    const form = page.locator("form.catalog-fields");
    const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/ranking" && r.ok());
    await form.locator("button[type=submit], button.primary").first().click();
    const ranking = await (await response).json();
    const map = page.locator(".plan-site-map");
    const toggle = map.getByRole("checkbox");
    await toggle.waitFor();
    assert(!await toggle.isChecked());
    const count = modelRequests.length;
    const originalRows = await page.locator(".plan-results tbody tr").allTextContents();
    await toggle.focus();
    await page.keyboard.press("Space");
    assert(await toggle.isChecked());
    const inspect = map.getByRole("combobox");
    const ids = ranking.ranking.map(row => row.site_id);
    for (const id of ["chandrayaan3_vikram", "im2_athena", "apollo17"]) {
      assert(ids.includes(id));
      await inspect.selectOption(id);
      const row = ranking.ranking.find(s => s.site_id === id);
      const expected = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(row.mean_power_tracking);
      await map.locator(".plan-map-inspector").getByText(expected, { exact: true }).waitFor();
      const globe = map.locator(".site-pin[data-site='" + id + "']");
      await globe.locator(".plan-pin-sun-ring").waitFor();
      assert.equal(await globe.locator("button").getAttribute("aria-pressed"), "true");
      const color = await globe.locator(".plan-pin-sun-ring").evaluate(n => getComputedStyle(n).borderTopColor);
      const bins = await map.locator(".plan-sun-legend li i").evaluateAll(ns => ns.map(n => getComputedStyle(n).borderTopColor));
      assert.equal(color, bins[Math.min(3, Math.floor(row.mean_power_tracking * 4))]);
      await map.getByRole("button", { name: locale === "en" ? "Flat map" : "Bản đồ phẳng", exact: true }).click();
      const mark = map.locator(".plan-map-point[data-site='" + id + "']");
      assert.equal(await mark.getAttribute("aria-pressed"), "true");
      assert.equal(await mark.locator("circle[stroke-width='3']").evaluate(n => getComputedStyle(n).stroke), color);
      if (id === "chandrayaan3_vikram") assert.equal(await mark.locator(".map-leader").count(), 1);
      await map.getByRole("button", { name: locale === "en" ? "3D globe" : "Quả cầu 3D", exact: true }).click();
    }
    await toggle.uncheck();
    assert.equal(await map.locator(".plan-pin-sun-ring").count(), 0);
    assert.deepEqual(await page.locator(".plan-results tbody tr").allTextContents(), originalRows);
    assert.equal(modelRequests.length, count);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await form.locator('[name="missionHours"]').fill("6");
    await form.locator("button.primary").click();
    await map.locator(".plan-sun-layer small").waitFor();
    assert.equal(await map.getByRole("checkbox").count(), 0);
    params.set("source", "saved-b2");
    await page.goto(new URL("/plan?" + params, origin).href);
    await map.locator(".plan-sun-layer small").waitFor();
    assert.equal(await map.getByRole("checkbox").count(), 0);
    await page.close();
    console.log(locale, width, "px: real tracking values, markers, unchanged ranking, unavailable windows and no extra map requests verified.");
  }
} finally { await browser.close(); }
