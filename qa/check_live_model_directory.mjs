import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const origin = process.argv[2];
if (!origin) throw Error("Pass a frontend URL configured for the team API.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const read = file => readFile(new URL(file, import.meta.url), "utf8").then(JSON.parse);
const [catalog, example] = await Promise.all([
  read("../frontend/public/data/run-b2/catalog.json"),
  read("../lunar-navigator/backend/contract/examples/run_detail.json"),
]);
const { manifest, ...summary } = example;
const site = catalog.sites.find(row => row.id === "im2_athena");
// A second page forces the directory to use the producer's filtered count and offset.
const runs = Array.from({ length: 21 }, (_, i) => ({
  ...summary,
  run_id: i === 0 ? "fixture-B2" : i === 1 ? "fixture-A2" : `fixture-${i + 1}`,
  label: i === 0 ? "Default B2 fixture" : i === 1 ? "Alternative A2 fixture" : `Model fixture ${i + 1}`,
  kind: "precompute", is_default: i === 0, status: "ready", provider: i === 1 ? "horizons" : "spice",
  start_utc: "2026-01-01T00:00:00Z", end_utc: "2027-01-01T00:00:00Z", step_s: 3600, n_samples: 8760,
  n_sites: 1, site_ids: [site.id],
}));
const alternate = runs[1];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, chromiumSandbox: true });

try {
  const page = await browser.newPage({ serviceWorkers: "block", reducedMotion: "reduce" });
  const directories = [], details = [], sites = [], unexpected = [], errors = [];
  let outage = false;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === "GET") {
      if (url.pathname === "/api/v1/runs") {
        const params = Object.fromEntries(url.searchParams);
        directories.push(params);
        if (outage) return route.fulfill({ status: 503, json: { status: 503, title: "Test outage", detail: "Test outage" } });
        const offset = Number(params.offset), limit = Number(params.limit);
        return route.fulfill({ json: { default_run_id: runs[0].run_id, total: runs.length,
          limit, offset, runs: runs.slice(offset, offset + limit) } });
      }
      if (url.pathname === "/api/v1/runs/" + alternate.run_id) {
        details.push(alternate.run_id);
        return route.fulfill({ json: { ...alternate, manifest } });
      }
      if (url.pathname === "/api/v1/sites" && url.searchParams.get("run_id") === alternate.run_id) {
        sites.push(alternate.run_id);
        return route.fulfill({ json: { ...catalog, run_id: alternate.run_id, sites: [site] } });
      }
    }
    unexpected.push(request.method() + " " + url.pathname);
    return route.abort();
  });
  await page.route("**/guide/chat", route => { unexpected.push(route.request().url()); return route.abort(); });

  const dataUrl = new URL("/data", origin).href;
  const directory = page.locator("#live-model-runs");
  const runLink = id => directory.locator(`a[href="/plan?run_id=${id}"]`);
  const savedLink = page.locator('#run-b2 a[href="/plan?source=saved-b2&mode=sites"]');
  await page.goto(dataUrl);
  await runLink(alternate.run_id).waitFor();
  assert.equal(await directory.locator('a[href^="/plan?run_id="]').count(), 20);
  await directory.getByRole("heading", { name: "Live model runs" }).waitFor();
  for (const run of runs.slice(0, 20)) {
    const row = directory.getByRole("listitem").filter({ has: page.getByRole("link", { name: run.label, exact: true }) });
    assert.equal(await row.getByRole("link", { name: run.label, exact: true }).count(), 1);
    assert.equal(await row.getByText(run.run_id, { exact: true }).count(), 1);
    assert.deepEqual(await row.locator("time").evaluateAll(times => times.map(t => t.dateTime)), [run.start_utc, run.end_utc]);
    assert.equal(await row.getByText("· Default", { exact: true }).count(), run.is_default ? 1 : 0);
    assert.match(await row.innerText(), new RegExp(run.provider + " / " + run.dem));
    assert.match(await row.innerText(), /1 site · Model step 3600 s/);
  }
  await page.locator(".language-switch select").selectOption("vi");
  await page.waitForFunction(() => document.documentElement.lang === "vi");
  await directory.getByRole("heading", { name: "Các lần chạy mô hình trên API" }).waitFor();
  await directory.getByText("· Mặc định", { exact: true }).waitFor();
  const next = directory.getByRole("button", { name: "Trang tiếp", exact: true });
  await next.click();
  await runLink("fixture-21").waitFor();
  assert.equal(await runLink(runs[0].run_id).count(), 0);
  assert.equal(await directory.locator('a[href^="/plan?run_id="]').count(), 1);
  await directory.getByRole("button", { name: "Trang trước", exact: true }).click();
  await runLink(alternate.run_id).waitFor();
  const beforePlan = directories.length;
  await runLink(alternate.run_id).click();
  await page.locator(".plan-source code").getByText(alternate.run_id, { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("run_id"), alternate.run_id);
  assert.deepEqual(details, [alternate.run_id]);
  assert.deepEqual(sites, [alternate.run_id]);
  assert.equal(directories.length, beforePlan, "Opening a pinned run must not substitute a default-run lookup.");

  outage = true;
  await page.goto(dataUrl);
  const retry = directory.getByRole("button", { name: /thử lại/i });
  await retry.waitFor();
  await savedLink.waitFor();
  await savedLink.click();
  await page.locator(".plan-source").getByText(/Lần chạy B2 đã lưu/).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("source"), "saved-b2");
  await page.goto(dataUrl);
  await retry.waitFor();
  const failedCalls = directories.length;
  outage = false;
  await retry.click();
  await runLink(alternate.run_id).waitFor();
  assert.equal(directories.length, failedCalls + 1);
  for (const params of directories) {
    assert.deepEqual(params, { kind: "precompute", status: "ready", limit: "20", offset: params.offset });
    assert.ok(["0", "20"].includes(params.offset));
  }
  assert.ok(directories.some(params => params.offset === "20"));
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log("Live run directory: filtered pagination in EN/VI, pinned model, saved B2 during outage and retry passed.", browser.version());
} finally {
  await browser.close();
}
