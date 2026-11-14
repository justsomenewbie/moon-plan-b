import assert from "node:assert/strict";
import { terrainFixture } from "./browser-terrain-fixture.mjs";

// Run against a local production build configured for live API mode. All API replies are intercepted.
const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the origin of a live-mode frontend.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const start = "2026-01-01T00:00:00Z", at = "2026-01-01T02:00:00Z", end = "2026-01-01T04:00:00Z";
const run = "retry-test", site = "im2_athena", step = "7200";
const sites = ["im1_odysseus", site];
const dataset = terrainFixture({ run, start, at, end });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });
const pinned = new URL("/compare", origin);
pinned.search = new URLSearchParams({ from: start, to: end, resolutionSeconds: step, run_id: run, view_site: site, at, saved: site });
pinned.hash = "terrain-observations";
const liveBrowserDeadline = 190_000;
const cases = [
  { fault: "404", attempts: 1, message: "Dataset temporarily unavailable" },
  { fault: "429", attempts: 1, message: "Dataset quota exhausted" },
  { fault: "500", attempts: 3, message: "Test server error" },
  { fault: "offline", attempts: 3, message: "The request could not be completed. Retry or check the connection." },
  { fault: "truncated", attempts: 3, message: "The API returned incomplete or invalid JSON. Please retry." },
  { fault: "504", attempts: 1, message: "The team API did not respond within 180 seconds. Please retry." },
  { fault: "timeout", attempts: 1, message: "The data request timed out after 190 seconds. Please retry." },
];

async function checkSelection(page) {
  assert.equal(await page.getByRole("combobox", { name: "Observation site" }).inputValue(), site);
  assert.equal(await page.locator("#terrain-sample-utc").getAttribute("datetime"), at);
  assert.equal(await page.getByRole("combobox", { name: "Compare saved results" }).inputValue(), site);
  assert.equal(page.url(), pinned.href);
}

async function checkSlowResponse() {
  const page = await browser.newPage({ serviceWorkers: "block" });
  const calls = [];
  try {
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      calls.push([route.request().method(), url.pathname, Object.fromEntries(url.searchParams)]);
      await new Promise(resolve => setTimeout(resolve, 16_500));
      await route.fulfill({ json: dataset });
    });
    await page.goto(pinned.href, { waitUntil: "domcontentloaded" });
    await checkSelection(page);
    assert.equal(calls.length, 1, "A successful live request lasting over 15 seconds must complete on the first GET");
    const [method, path, params] = calls[0];
    assert.deepEqual([method, path, params.run_id, params.start, params.end, params.site_ids, params.step_s],
      ["GET", "/api/v1/dataset", run, start, end, sites.join(","), step]);
    assert.equal(await page.locator("#data-error").count(), 0);
    console.log("16.5-second dataset response: one GET restored the pinned site and UTC sample");
  } finally { await page.close(); }
}

async function checkFault({ fault, attempts, message }) {
  const page = await browser.newPage({ serviceWorkers: "block" });
  const requests = [], pageErrors = [], demoFiles = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", req => { if (new URL(req.url()).pathname === "/data/demo.json") demoFiles.push(req.url()); });
  if (fault === "timeout") {
    // Chromium owns AbortSignal.timeout's clock. Advance only the expected deadline with its native abort path.
    await page.addInitScript(expected => {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      window.datasetDeadlines = [];
      AbortSignal.timeout = ms => {
        if (ms !== expected || window.datasetDeadlines.length) return timeout(ms);
        window.datasetDeadlines.push(ms);
        return timeout(500);
      };
    }, liveBrowserDeadline);
  }
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
    if (fault === "504") return route.fulfill({ status: 504, contentType: "application/problem+json",
      json: { type: "about:blank", title: "Upstream timeout", status: 504, code: "UPSTREAM_TIMEOUT", detail: message } });
    if (fault === "429") return route.fulfill({ status: 429, headers: { "Retry-After": "5" },
      json: { type: "about:blank", title: "Too many requests", status: 429, code: "RATE_LIMITED", detail: message } });
    return route.fulfill({ status: Number(fault), json: { detail: message } });
  });
  const alert = page.locator("#data-error[role=alert]");
  const retry = alert.getByRole("button", { name: "Retry API request", exact: true });
  async function rejectFile() {
    await page.getByRole("button", { name: "Import data", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Import JSON dataset").setInputFiles({
      name: "invalid.json", mimeType: "application/json", buffer: Buffer.from("{"),
    });
    await alert.getByText(/previous dataset has not changed/i).waitFor();
  }
  const began = Date.now();
  try {
    await page.goto(pinned.href, { waitUntil: "domcontentloaded" });
    await alert.locator("p").filter({ hasText: message }).waitFor({ timeout: 65000 });
    if (fault === "504") await alert.getByText("UPSTREAM_TIMEOUT", { exact: true }).waitFor();
    const elapsed = Date.now() - began;
    assert.equal(requests.length, attempts, fault);
    assert.equal(requests[0].run_id, run);
    assert.equal(requests[0].step_s, step);
    assert.equal(requests[0].start, start);
    assert.equal(requests[0].end, end);
    assert.equal(requests[0].site_ids, sites.join(","));
    assert.equal(await page.locator("#workspace[aria-busy=true], .terrain-result, .timeline-svg").count(), 0);
    assert.ok(await page.getByRole("button", { name: "Import data", exact: true }).isEnabled());
    if (fault === "timeout") assert.deepEqual(await page.evaluate(() => window.datasetDeadlines), [liveBrowserDeadline]);
    if (fault === "truncated") {
      await page.getByRole("combobox", { name: "Language" }).selectOption("vi");
      await alert.getByText("API trả về JSON không đầy đủ hoặc không hợp lệ. Vui lòng thử lại.", { exact: true }).waitFor();
      await page.getByRole("combobox", { name: "Ngôn ngữ" }).selectOption("en");
    }
    if (fault === "404" || fault === "offline") await rejectFile();
    if (fault === "429") {
      const countdown = alert.getByRole("button", { name: /Try again in/ });
      await countdown.waitFor();
      assert.equal(await countdown.isDisabled(), true);
      await page.getByText("Request observation windows", { exact: true }).click();
      const form = page.locator("form.request-fields");
      assert.equal(await form.getByRole("button", { name: /Try again in/ }).isDisabled(), true);
      await form.evaluate(element => element.requestSubmit());
      await rejectFile();
      assert.equal(await countdown.isDisabled(), true, "A local import error must preserve the server deadline");
      await retry.waitFor();
      assert.equal(requests.length, 1, "Expiry enables a manual retry without fetching");
    }
    if (fault === "offline") {
      assert.equal(await page.evaluate(() => navigator.onLine), false);
      await page.context().setOffline(false);
    }
    recovered = true;
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/dataset" && response.ok()),
      retry.click(),
    ]);
    await checkSelection(page);
    if (fault === "404") {
      await rejectFile();
      await checkSelection(page);
    }
    assert.equal(await retry.count(), 0);
    assert.deepEqual(requests, Array(attempts + 1).fill(requests[0]), fault + " retry must preserve the pinned request");
    assert.deepEqual(demoFiles, []);
    assert.deepEqual(pageErrors, []);
    console.log(fault, attempts, "failed requests then one successful manual retry;", elapsed, "ms to alert");
  } finally { await page.close(); }
}

try {
  await checkSlowResponse();
  for (const scenario of cases) await checkFault(scenario);
  console.log("Passed in Chromium", browser.version(), new Date().toISOString());
} finally { await browser.close(); }
