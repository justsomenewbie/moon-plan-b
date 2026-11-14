import assert from "node:assert/strict";
import { terrainFixture } from "./browser-terrain-fixture.mjs";

const origin = new URL(process.argv[2]).origin;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });

const run = "cancel-fixture", start = "2026-01-01T00:00:00Z", end = "2026-01-01T04:00:00Z";
const terrain = terrainFixture({ run, start, at: "2026-01-01T02:00:00Z", end });
const available = { available: true, reason: null };
const capabilities = { job_types: [{ type: "custom_site", implemented: true, ...available, limits: {} }],
  providers: { spice: available }, dems: { pgda: available }, horizon_methods: ["raymarch"] };

async function exercise(mode) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const vi = mode === "shared";
    if (vi) await context.addInitScript(() => localStorage.setItem("moon-plan-b-language", "vi"));
    let posts = 0, status = mode === "shared" ? "running" : "queued";
    const deletes = [], reads = [], unexpected = [];
    let jobId, siteId, params;
    function job(clients = 1) {
      return { job_id: jobId, type: "custom_site", site_id: siteId, status, params, clients,
        progress: { stage: status === "running" ? "python" : status === "queued" ? "queued" : "done", pct: null, lines: [] },
        result: status === "succeeded" ? { run_id: "job_" + jobId, site_id: siteId } : null, error: null,
        output: null, artifacts: [], created_at: start, started_at: null, finished_at: null, expires_at: null };
    }
    // Block every API call before navigation; no POST, polling request or DELETE reaches a live service.
    await context.route("**/api/**", route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (req.method() === "GET" && path === "/api/v1/dataset") return route.fulfill({ json: terrain });
      if (req.method() === "GET" && path === "/api/v1/capabilities") return route.fulfill({ json: capabilities });
      if (req.method() === "POST" && path === "/api/v1/jobs") {
        params = req.postDataJSON();
        assert.equal(params.type, "custom_site");
        assert.deepEqual([params.start, params.end], [start, end]);
        jobId = "j_cancel0" + ++posts;
        siteId = "custom:" + params.lat_deg.toFixed(4) + ":" + params.lon_deg.toFixed(4);
        if (posts > 1) status = "queued";
        return route.fulfill({ status: 202, json: { job_id: jobId, site_id: siteId, type: "custom_site",
          status, cached: vi, poll: "/api/v1/jobs/" + jobId } });
      }
      if (jobId && path === "/api/v1/jobs/" + jobId) {
        if (req.method() === "GET") {
          reads.push(jobId);
          return route.fulfill({ json: job() });
        }
        if (req.method() === "DELETE") {
          deletes.push(jobId);
          if (mode === "offline") return route.abort("internetdisconnected");
          if (mode === "uncertain") return route.abort("connectionreset");
          if (mode === "not-owner" || mode === "unconfirmed-owner") {
            const problem = { status: 403, code: "JOB_NOT_YOURS", detail: "Fixture ownership refusal." };
            if (mode === "not-owner") Object.assign(problem, { type: "about:blank", title: "Forbidden" });
            return route.fulfill({ status: 403, contentType: "application/problem+json", json: problem });
          }
          if (mode === "race") {
            return route.fulfill({ status: 409, contentType: "application/problem+json",
              json: { type: "about:blank", title: "Conflict", code: "JOB_NOT_CANCELLABLE", status: 409, detail: "Fixture job already completed." } });
          }
          if (mode !== "shared") status = "cancelled";
          return route.fulfill({ json: job(mode === "shared" ? 1 : 0) });
        }
      }
      unexpected.push(req.method() + " " + path);
      return route.abort();
    });

    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(origin + "/compare?" + new URLSearchParams({ run_id: run, from: start, to: end, resolutionSeconds: "3600" }));
    const form = page.locator("details").filter({ has: page.locator('input[name="latitude"]') }).last();
    await form.locator("summary").click();
    const submit = form.getByRole("button", { name: vi ? "Yêu cầu tính toán" : "Request calculation", exact: true });
    const cancel = form.getByRole("button", { name: vi ? "Hủy yêu cầu của tôi" : "Cancel my request", exact: true });
    assert.equal(await cancel.count(), 0);
    await form.locator('input[name="latitude"]').fill("-89.45");
    await form.locator('input[name="longitude"]').fill("222.69");
    await submit.click();
    await cancel.waitFor();
    await form.getByText(vi ? "Đang chạy — tính dữ liệu quan trắc" : "Queued — waiting for a worker", { exact: true }).waitFor();
    assert.equal(await submit.isDisabled(), true);
    const firstId = jobId, readsBeforeCancel = reads.length;
    assert.equal(posts, 1);
    assert.deepEqual(deletes, []);
    if (mode === "offline") {
      await context.setOffline(true);
      await page.waitForFunction(() => !navigator.onLine);
    }
    await cancel.click();

    if (mode === "race" || mode === "not-owner" || mode === "unconfirmed-owner") {
      const check = form.getByRole("button", { name: "Check job status", exact: true });
      await check.waitFor();
      await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/jobs/" + firstId &&
        r.request().method() === "GET"), check.click()]);
      assert.equal(await cancel.count(), mode === "unconfirmed-owner" ? 1 : 0);
      if (mode === "race") {
        status = "succeeded";
        await check.click();
        await form.getByRole("button", { name: "Open job results" }).waitFor();
      } else {
        await form.getByRole("button", { name: "Stop following this job", exact: true }).click();
      }
      assert(reads.length > readsBeforeCancel);
      assert.equal(await cancel.count(), 0);
    } else if (mode === "offline") {
      await form.getByRole("button", { name: "Stop following this job", exact: true }).click();
      await form.getByRole("status").filter({ hasText: "You stopped following this job." }).waitFor();
      assert.deepEqual(deletes, [firstId]);
      await context.setOffline(false);
      await page.waitForFunction(() => navigator.onLine);
    } else if (mode === "uncertain") {
      const check = form.getByRole("button", { name: "Check job status", exact: true });
      await check.waitFor();
      await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/jobs/" + firstId &&
        r.request().method() === "GET"), check.click()]);
      assert(reads.length > readsBeforeCancel);
      assert.deepEqual(deletes, [firstId]);
      await form.getByRole("button", { name: "Stop following this job", exact: true }).click();
    } else {
      await form.getByRole("status").filter({ hasText: vi ? "Bạn đã ngừng chờ tác vụ này. Tác vụ vẫn chạy cho những người khác." : "Your request was cancelled." }).waitFor();
      if (vi) assert.equal(status, "running");
      await cancel.waitFor({ state: "hidden" });
      const completedReads = reads.length;
      // Wait across one normal poll to distinguish a local detach from a still-subscribed client.
      await page.waitForTimeout(1800);
      assert.equal(reads.length, completedReads);
    }

    await form.locator('input[name="latitude"]').fill("-88");
    await submit.click();
    await form.getByText("j_cancel02", { exact: true }).waitFor();
    await cancel.waitFor();
    assert.equal(posts, 2);
    assert.deepEqual(deletes, [firstId]);
    assert.deepEqual(unexpected, []);
  } finally { await context.close(); }
}

try {
  for (const mode of ["exclusive", "shared", "race", "not-owner", "unconfirmed-owner", "uncertain", "offline"]) await exercise(mode);
  console.log("Custom-site cancellation, shared detach, definitive and uncertain refusals, completion race, offline cancellation and replacement request passed.");
} finally { await browser.close(); }
