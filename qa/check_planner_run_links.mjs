import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const origin = process.argv[2];
if (!origin) throw Error("Pass the URL of a frontend build configured for the team API.");
const retained = name => readFile(new URL("../frontend/public/data/run-b2/" + name, import.meta.url)).then(JSON.parse);
const [catalog, archive] = await Promise.all([retained("catalog.json"), retained("visibility.json")]);
const siteIds = catalog.sites.map(site => site.id);
let current = "release-a";
const run = id => ({ run_id: id, is_default: id === current, status: "ready", start_utc: archive.start,
  end_utc: archive.end, step_s: archive.stepSeconds, n_samples: archive.sampleCount, n_sites: siteIds.length, site_ids: siteIds });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, chromiumSandbox: true });
try {
  const page = await browser.newPage({ reducedMotion: "reduce", serviceWorkers: "block" });
  const calls = [], unexpected = [], errors = [];
  let retiredAvailable = false;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    calls.push(path + url.search);
    if (path === "/api/v1/runs") return route.fulfill({ json: { default_run_id: current, runs: [run(current)] } });
    if (path === "/api/v1/runs/release-a") return route.fulfill({ json: run("release-a") });
    if (path === "/api/v1/runs/retired") {
      if (retiredAvailable) return route.fulfill({ json: run("retired") });
      return route.fulfill({ status: 404, json: {
        status: 404, title: "Run not found", detail: "The selected run is unavailable.", type: "about:blank", code: "RUN_NOT_FOUND" } });
    }
    if (path === "/api/v1/sites") return route.fulfill({ json: { ...catalog, run_id: url.searchParams.get("run_id") } });
    if (path === "/api/v1/alt-dates" && req.method() === "POST") {
      const input = req.postDataJSON();
      assert.equal(input.run_id, "release-a");
      return route.fulfill({ json: { site_id: input.site_id, run_id: input.run_id, step_s: archive.stepSeconds,
        earliest_utc: input.earliest, latest_utc: input.latest, mission_duration_h: input.mission_h,
        constraints: input.constraints, cache_id: "a".repeat(64), precision_h: 1, n_evaluated: 20, n_feasible: 0,
        rejected_by: {}, candidates: [] } });
    }
    unexpected.push(path); return route.abort();
  });
  await page.goto(new URL("/plan", origin).href);
  await page.locator(".plan-source").getByText(/Model results from the team API/).waitFor();
  current = "release-b";
  await page.getByRole("button", { name: "Astronaut guide", exact: true }).click();
  const chat = page.getByRole("region", { name: "Ask the astronaut" });
  await chat.locator("textarea").fill("When should I land at Apollo 11 for 5 hours from 2026-11-15 to 2026-11-16?");
  await chat.locator("button[type=submit]").click();
  await chat.getByText(/No qualifying model window was returned.*Source run · release-a/s).waitFor();
  const link = chat.getByRole("link", { name: "Open planner" });
  const href = new URL(await link.getAttribute("href"), origin);
  assert.equal(href.searchParams.get("run_id"), "release-a");
  await link.click();
  const pinned = page.locator(".plan-source code").getByText("release-a", { exact: true });
  await pinned.waitFor();
  await page.reload();
  await pinned.waitFor();
  await page.getByRole("link", { name: "Open saved run B2" }).click();
  await page.locator(".plan-source").getByText(/Saved run B2/).waitFor();
  await page.getByRole("link", { name: "Return to the linked live run" }).click();
  await pinned.waitFor();
  assert.equal(calls.filter(call => call.startsWith("/api/v1/runs?")).length, 1);
  assert.ok(calls.filter(call => call === "/api/v1/runs/release-a").length >= 3);
  for (const source of ["saved-b2", "saved"]) {
    await page.goto(new URL("/plan?mode=sites&run_id=release-a&from=2026-11-14&to=2026-11-21", origin).href);
    await pinned.waitFor();
    await page.getByRole("link", { name: source === "saved" ? "Open the earlier run B archive" : "Open saved run B2" }).click();
    if (source === "saved") {
      await page.locator(".plan-presets a").first().click();
      assert.equal(new URL(page.url()).searchParams.get("run_id"), "release-a");
    }
    const siteLink = page.locator(".plan-results tbody a").first();
    await siteLink.click();
    await page.getByRole("link", { name: "Back to these site results" }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("run_id"), "release-a");
    assert.equal(new URL(page.url()).searchParams.get("source"), source);
    await page.getByRole("link", { name: "Back to these site results" }).click();
    await page.getByRole("link", { name: "Return to the linked live run" }).click();
    await pinned.waitFor();
  }
  assert.equal(calls.filter(call => call.startsWith("/api/v1/runs?")).length, 1);
  await page.goto(new URL("/plan?run_id=retired", origin).href);
  await page.getByRole("alert").filter({ hasText: "The linked model run could not be opened." }).waitFor();
  assert.equal(await page.locator(".plan-source").count(), 0);
  retiredAvailable = true;
  await page.getByRole("button", { name: "Retry site list" }).click();
  await page.locator(".plan-source code").getByText("retired", { exact: true }).waitFor();
  const beforeAmbiguous = calls.length;
  await page.goto(new URL("/plan?run_id=release-a&run_id=release-b", origin).href);
  await page.getByRole("alert").filter({ hasText: "The linked model run could not be opened." }).waitFor();
  assert.equal(calls.length, beforeAmbiguous);
  await page.getByRole("link", { name: "Open saved run B2" }).click();
  await page.locator(".plan-source").getByText(/Saved run B2/).waitFor();
  assert.equal(calls.filter(call => call.startsWith("/api/v1/runs?")).length, 1);
  await page.goto(new URL("/plan", origin).href);
  await page.locator(".plan-source").getByText(/Model results from the team API/).waitFor();
  assert.ok(calls.some(call => {
    const request = new URL(call, origin);
    return request.pathname === "/api/v1/sites" && request.searchParams.get("run_id") === "release-b";
  }));
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log("Guide result, pinned reload, archive round trip, missing run recovery and latest discovery passed.");
} finally {
  await browser.close();
}
