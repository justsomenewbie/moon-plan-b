import test from "node:test";
import assert from "node:assert/strict";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { createCustomSite, getCustomSiteCapability, getCustomSiteJob } from "../lib/api/custom-site.ts";

const input = { lat_deg: -89.45, lon_deg: -137.31, observer_height_m: 2, start: "2026-11-14T00:00:00Z", end: "2026-11-15T00:00:00Z" };
const jobId = "j_demo123", site = "custom:-89.4500:222.6900";
const receipt = { job_id: jobId, type: "custom_site", site_id: site, poll: `/api/v1/jobs/${jobId}`, cached: false, status: "queued" };
const queued = { ...receipt, params: input, progress: { stage: "queued", pct: null, lines: ["private worker log"] }, result: null, error: null };

// All job mutations in this test are handled locally by MSW.
test("custom-site submissions validate input and the queued or cached producer receipt", async t => {
  let calls = 0;
  const server = setupServer(http.post("*/api/v1/jobs", async ({ request }) => {
    calls++;
    assert.deepEqual(await request.json(), { type: "custom_site", ...input, step_min: 60, provider: "spice", dem: "pgda", horizon_method: "raymarch" });
    return HttpResponse.json(receipt, { status: 202 });
  }));
  server.listen({ onUnhandledFrame: "error" }); t.after(() => server.close());
  for (const inputs of [{ lat_deg: 91 }, { lon_deg: Infinity }, { observer_height_m: -1 }, { end: input.start }]) {
    await assert.rejects(createCustomSite({ ...input, ...inputs }));
  }
  assert.equal(calls, 0);
  assert.deepEqual(await createCustomSite(input), { job_id: jobId, site_id: site, cached: false, status: "queued" });
  assert.equal(calls, 1);
  server.use(http.post("*/api/v1/jobs", () => HttpResponse.json({ ...receipt, status: "succeeded", cached: true })));
  assert.equal((await createCustomSite(input)).cached, true);
  for (const change of [{ job_id: "unbound-id" }, { poll: "https://invalid.example/job" }, { site_id: "custom:-89.4500:220.0000" }, { status: "succeeded" }]) {
    server.use(http.post("*/api/v1/jobs", () => HttpResponse.json({ ...receipt, ...change }, { status: 202 })));
    await assert.rejects(createCustomSite(input));
  }
  server.use(http.post("*/api/v1/jobs", () => HttpResponse.json({ detail: "Queue is full" }, { status: 429 })));
  await assert.rejects(createCustomSite(input), /Queue is full/);
});

test("custom-site status retains nullable progress, terminal states and matching result identifiers", async t => {
  const server = setupServer(); server.listen({ onUnhandledFrame: "error" }); t.after(() => server.close());
  const statusReply = (fields: Record<string, unknown>) => server.use(http.get("*/api/v1/jobs/:job_id", () => HttpResponse.json({ ...queued, ...fields })));
  statusReply({});
  const progress = (await getCustomSiteJob(jobId, site)).progress;
  assert.deepEqual(progress, { stage: "queued", pct: null });
  statusReply({ status: "running", progress: { stage: "import", pct: 55 } });
  assert.equal((await getCustomSiteJob(jobId)).progress.pct, 55);
  const result = { run_id: `job_${jobId}`, site_id: site };
  statusReply({ status: "succeeded", result });
  assert.deepEqual((await getCustomSiteJob(jobId, site)).result, result);
  await assert.rejects(getCustomSiteJob(jobId, "wrong-site"));
  const failed = { code: "PYTHON_FAILED", message: "Computation failed\nprivate line" };
  statusReply({ status: "failed", error: failed });
  assert.equal((await getCustomSiteJob(jobId)).error?.message, "Computation failed");
  statusReply({ status: "cancelled" });
  assert.equal((await getCustomSiteJob(jobId)).status, "cancelled");
  for (const fields of [{ status: "finished" }, { type: "precompute" }, { progress: { stage: "queued", pct: 102 } }, { status: "succeeded", result: { ...result, run_id: "other" } }, { status: "succeeded", result: { ...result, site_id: "other" } }, { result }, { status: "failed", error: null }]) {
    statusReply(fields); await assert.rejects(getCustomSiteJob(jobId, site));
  }
});

test("capabilities require the site job and its actual hourly terrain dependencies", async t => {
  const ok = { available: true, reason: null };
  const job = { type: "custom_site", implemented: true, ...ok, limits: { step_min_allowed: [60], max_range_days: 7, observer_height_m_max: 10 } };
  const sample = { job_types: [job], providers: { spice: ok }, dems: { pgda: ok }, horizon_methods: ["raymarch"] };
  const server = setupServer(); server.listen({ onUnhandledFrame: "error" }); t.after(() => server.close());
  const reply = (fields: Record<string, unknown>) => server.use(http.get("*/api/v1/capabilities", () => HttpResponse.json({ ...sample, ...fields })));
  reply({}); assert.deepEqual(await getCustomSiteCapability(), { ...ok, maxRangeDays: 7, maxObserverHeightM: 10 });
  reply({ dems: { pgda: { available: false, reason: "Missing terrain" } } }); assert.equal((await getCustomSiteCapability()).reason, "Missing terrain");
  reply({ horizon_methods: ["flat"] }); assert.equal((await getCustomSiteCapability()).available, false);
  reply({ job_types: [{ ...job, limits: { step_min_allowed: [120] } }] }); assert.equal((await getCustomSiteCapability()).available, false);
  reply({ providers: {} }); await assert.rejects(getCustomSiteCapability());
});
