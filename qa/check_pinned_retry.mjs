import assert from "node:assert/strict";

// Run against a local production build configured for live API mode. All API replies are intercepted.
const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the origin of a live-mode frontend.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const start = "2026-01-01T00:00:00Z", at = "2026-01-01T02:00:00Z", end = "2026-01-01T04:00:00Z";
const run = "retry-test", site = "im2_athena", step = "7200";
const sites = ["im1_odysseus", site];
// Invented partial coverage and zero visibility keep this regression independent of scientific data.
const dataset = {
  schema_version: "lunarnav-dataset-1", evidence: "computed-ephemeris", dataset_id: "retry-test.range", attribution: "Synthetic browser test",
  include: ["windows", "metrics", "series", "horizon", "criteria"], criteria_hours: [24, 72, 168],
  range: { start, end, requested_start: start, requested_end: end, step_s: 3600, n_samples: 4 },
  run: { run_id: run, label: "Test", provider: "test", dem: "test", horizon_method: "test", code_version: "test",
    run_timestamp_utc: start, observer_height_m: 2, min_earth_clearance_deg: 0, git_commit: null,
    manifest_sha256: "a".repeat(64), manifest_url: "/api/v1/runs/retry-test/files/manifest.json" },
  model: { id: "lunarnav-terrain-horizon-v1", label: "Test", definition: "Test only", limits: ["Invented data"] },
  sources: [{ id: "fixture", title: "Fixture", url: "https://example.org/fixture", sha256: null }],
  sites: sites.map(id => ({ id, name: id, coverage: "partial", coverage_in_range: "partial", metrics: null,
    criteria: [24, 72, 168].map(minimum_hours => ({
      minimum_hours, metric: "longest_both_h", value_h: 0, value_clipped: false, result: "below", reason: "Invented test result",
    })),
    windows: { sun: [], earth: [], both: [] },
    horizon: { method: "test", dem_source: "test", step_deg: 180, source_step_deg: 180, az_deg: [0, 180, 360],
      el_deg: [0, 0, 0], min_el_deg: 0, max_el_deg: 0 },
    series: { t: [start, at], step_s: 7200, decimated: true, n_transitions: 0, sun_az_deg: [0, 0], earth_az_deg: [0, 0],
      sun_el_deg: [-1, -1], earth_el_deg: [-1, -1], sun_visible: [false, false], earth_visible: [false, false], both_visible: [false, false] },
  })),
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });
const pinned = new URL(origin);
pinned.search = new URLSearchParams({ from: start, to: end, resolutionSeconds: step, run_id: run, view_site: site, at, saved: site });
pinned.hash = "terrain-observations";
const cases = [
  { fault: "404", attempts: 1, message: "Dataset temporarily unavailable" },
  { fault: "500", attempts: 3, message: "Test server error" },
  { fault: "offline", attempts: 3, message: "The request could not be completed. Retry or check the connection." },
  { fault: "truncated", attempts: 3, message: "The API returned incomplete or invalid JSON. Please retry." },
  { fault: "timeout", attempts: 3, message: "The API did not respond within 15 seconds. Please retry." },
];

async function checkFault({ fault, attempts, message }) {
  const page = await browser.newPage({ serviceWorkers: "block" });
  const requests = [], pageErrors = [], demoFiles = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", req => { if (new URL(req.url()).pathname === "/data/demo.json") demoFiles.push(req.url()); });
  let recovered = false;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    assert.equal(url.pathname, "/api/v1/dataset");
    assert.equal(route.request().method(), "GET");
    requests.push(Object.fromEntries(url.searchParams));
    if (recovered) return route.fulfill({ json: dataset });
    if (fault === "timeout") return; // Hold the actual fetch until the client aborts it.
    if (fault === "offline") {
      if (requests.length === 1) await page.context().setOffline(true);
      return route.abort("internetdisconnected");
    }
    if (fault === "truncated") return route.fulfill({ status: 200, contentType: "application/json", body: '{"schema_version":' });
    return route.fulfill({ status: Number(fault), json: { detail: message } });
  });
  const alert = page.locator("#data-error[role=alert]");
  const retry = alert.getByRole("button", { name: "Retry API request", exact: true });
  async function rejectFile() {
    await page.getByLabel("Import JSON dataset").setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from("{") });
    await alert.getByText(/previous dataset has not changed/i).waitFor();
  }
  async function checkSelection() {
    assert.equal(await page.getByRole("combobox", { name: "Observation site" }).inputValue(), site);
    assert.equal(await page.locator("#terrain-sample-utc").getAttribute("datetime"), at);
    assert.equal(await page.getByRole("combobox", { name: "Compare saved results" }).inputValue(), site);
    assert.equal(page.url(), pinned.href);
  }
  const began = Date.now();
  try {
    await page.goto(pinned.href, { waitUntil: "domcontentloaded" });
    await alert.getByText(message, { exact: true }).waitFor({ timeout: 65000 });
    const elapsed = Date.now() - began;
    assert.equal(requests.length, attempts, fault);
    assert.equal(requests[0].run_id, run);
    assert.equal(requests[0].step_s, step);
    assert.equal(requests[0].start, start);
    assert.equal(requests[0].end, end);
    assert.equal(requests[0].site_ids, sites.join(","));
    assert.equal(await page.locator("#workspace[aria-busy=true], .terrain-result, .timeline-svg").count(), 0);
    assert.ok(await page.getByRole("button", { name: "Import data", exact: true }).isEnabled());
    if (fault === "timeout") assert.ok(elapsed >= 45000, "All three real 15-second deadlines must elapse");
    if (fault === "truncated") {
      await page.getByRole("combobox", { name: "Language" }).selectOption("vi");
      await alert.getByText("API trả về JSON không đầy đủ hoặc không hợp lệ. Vui lòng thử lại.", { exact: true }).waitFor();
      await page.getByRole("combobox", { name: "Ngôn ngữ" }).selectOption("en");
    }
    if (fault === "404" || fault === "offline") await rejectFile();
    if (fault === "offline") {
      assert.equal(await page.evaluate(() => navigator.onLine), false);
      await page.context().setOffline(false);
    }
    recovered = true;
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/dataset" && response.ok()),
      retry.click(),
    ]);
    await checkSelection();
    if (fault === "404") {
      await rejectFile();
      await checkSelection();
    }
    assert.equal(await retry.count(), 0);
    assert.deepEqual(requests, Array(attempts + 1).fill(requests[0]), fault + " retry must preserve the pinned request");
    assert.deepEqual(demoFiles, []);
    assert.deepEqual(pageErrors, []);
    console.log(fault, attempts, "failed requests then one successful manual retry;", elapsed, "ms to alert");
  } finally { await page.close(); }
}

try {
  for (const scenario of cases) await checkFault(scenario);
  console.log("Passed in Chromium", browser.version(), new Date().toISOString());
} finally { await browser.close(); }
