import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the URL of the frontend built for the live team API.");
const retained = name => readFile(new URL("../frontend/public/data/run-b2/" + name, import.meta.url), "utf8").then(JSON.parse);
const [catalog, archive] = await Promise.all([retained("catalog.json"), retained("visibility.json")]);
const run = { run_id: catalog.run_id, is_default: true, status: "ready", start_utc: archive.start, end_utc: archive.end,
  step_s: archive.stepSeconds, n_samples: archive.sampleCount, n_sites: catalog.sites.length, site_ids: catalog.sites.map(s => s.id) };
const formKeys = ["minContinuousSun", "minContinuousEarth", "minSunElevation"];
const apiKeys = ["min_continuous_sun_h", "min_continuous_earth_h", "min_sun_el_at_landing_deg"];
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });

try {
  for (const locale of ["en", "vi"]) {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const calls = [], unexpected = [], pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    let reject = false;
    // Only the run and catalog come from retained B2. Intercept all producer traffic, including mutations.
    await page.route("**/api/**", async route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (req.method() === "GET" && path === "/api/v1/runs")
        return route.fulfill({ json: { default_run_id: run.run_id, runs: [run] } });
      if (req.method() === "GET" && path === "/api/v1/sites") return route.fulfill({ json: catalog });
      if (req.method() !== "POST" || path !== "/api/v1/alt-dates") {
        unexpected.push(req.method() + " " + path); return route.abort();
      }
      const request = req.postDataJSON(), constraints = request.constraints;
      calls.push(apiKeys.map(key => constraints[key]));
      if (reject) return route.fulfill({ status: 422, contentType: "application/problem+json", json: {
        type: "about:blank", code: "VALIDATION_ERROR", title: "Invalid constraint", status: 422, detail: "Check the angle.",
        errors: [{ path: "constraints.min_sun_el_at_landing_deg", message: "Test elevation feedback." }],
      } });
      return route.fulfill({ json: { site_id: request.site_id, run_id: run.run_id, step_s: run.step_s,
        earliest_utc: request.earliest, latest_utc: request.latest, mission_duration_h: request.mission_h,
        constraints, cache_id: "a".repeat(64), precision_h: 1, n_evaluated: 1, n_feasible: 0, rejected_by: {}, candidates: [] } });
    });
    await page.goto(new URL("/plan?mode=dates&site=apollo11&from=2026-11-15&to=2026-11-16", origin).href);
    await page.locator(".language-switch select").selectOption(locale);
    const form = page.locator("form").filter({ has: page.locator("[name=landingSite]") });
    const inputs = formKeys.map(name => form.locator('[name="' + name + '"]'));
    async function showFields() {
      await form.waitFor();
      // Scope inside the form again after navigating back from the archive.
      if (!(await inputs[0].isVisible())) await form.locator("details summary").click();
    }
    async function submit(expected, fieldError = false) {
      const done = page.waitForResponse(r => r.url().endsWith("/api/v1/alt-dates"));
      await form.locator("button[type=submit]").click();
      await done;
      assert.deepEqual(calls.at(-1), expected);
      if (!fieldError) await results.getByRole("status").filter({ hasText: /0 of 1|0 trong số 1/ }).waitFor();
    }
    await showFields();
    const results = page.getByRole("region", { name: locale === "en" ? "Landing search results" : "Kết quả tìm thời điểm hạ cánh" });
    const rows = results.getByRole("listitem");
    const entered = ["8", "12.5", "-3.5"];
    for (let i = 0; i < inputs.length; i++) await inputs[i].fill(entered[i]);
    const saved = page.locator('a[href*="source=saved-b2"]').first();
    const dest = new URL(await saved.getAttribute("href"), origin);
    assert.deepEqual(formKeys.map(k => dest.searchParams.get(k)), entered);
    await saved.click();
    await page.locator("form [name=savedLandingSite]").waitFor();
    await page.getByText(/Additional live constraints|điều kiện bổ sung/i).waitFor();
    assert.equal(await page.locator(".plan-results").count(), 0);
    assert.equal(calls.length, 0);
    await page.getByRole("link", { name: locale === "en" ? "Check live data" : "Kiểm tra dữ liệu trực tiếp" }).click();
    await showFields();
    assert.deepEqual(await Promise.all(inputs.map(input => input.inputValue())), entered);
    await submit([8, 12.5, -3.5]);
    assert.deepEqual(await rows.allTextContents().then(texts => texts.map(text => text.split(" · ").at(-1))), ["8 h", "12.5 h", "-3.5°"]);
    for (const i of [0, 1]) await inputs[i].fill("");
    await inputs[2].fill("0");
    await submit([0, 0, 0]);
    assert.equal(await rows.count(), 1); assert.match(await rows.innerText(), / · 0°$/);
    await inputs[2].fill("");
    await submit([0, 0, null]);
    assert.equal(await rows.count(), 0);
    await inputs[2].fill("-91");
    assert.equal(await inputs[2].evaluate(el => el.validity.rangeUnderflow), true);
    await inputs[2].fill("90"); reject = true;
    await submit([0, 0, 90], true);
    await page.getByText("Test elevation feedback.", { exact: false }).waitFor();
    assert.equal(await inputs[2].getAttribute("aria-invalid"), "true");
    const fieldMessage = await inputs[2].getAttribute("aria-describedby");
    assert.match(await page.locator('[id="' + fieldMessage + '"]').innerText(), /Test elevation feedback/);
    assert.equal(calls.length, 4); assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
    await page.close();
    console.log(locale + ": round-trip, zero and empty thresholds, negative elevation and field feedback passed.");
  }
} finally { await browser.close(); }
