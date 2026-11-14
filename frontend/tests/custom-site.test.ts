import { ApiError, apiError, jobReceiptUncertain, validateCustomWindow, windowFromInputs } from "../lib/api/client.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { cancelCustomSiteJob, createCustomSite, getCustomSiteCapability, getCustomSiteJob } from "../lib/api/custom-site.ts";

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
  const submitted = { start: "2026-11-14T00:30:00.000Z", end: "2026-11-15T02:25:00.000Z" };
  for (const params of [
    { start: "2026-11-14T00:30:00Z", end: "2026-11-15T02:25:00Z" },
    { start: "2026-11-14T00:00:00Z", end: "2026-11-15T03:00:00Z" },
  ]) {
    statusReply({ status: "succeeded", result, params });
    assert.deepEqual((await getCustomSiteJob(jobId, site, undefined, submitted)).result, result);
  }
  for (const params of [{ ...submitted, start: "2026-11-14T01:30:00Z" }, { ...submitted, end: "2026-11-15T02:24:59Z" }]) {
    statusReply({ status: "succeeded", result, params });
    await assert.rejects(getCustomSiteJob(jobId, site, undefined, submitted), /different job/);
  }
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


test("the custom coordinate form and permalink support up to 366 hourly days", () => {
  const request = windowFromInputs("2026-01-01T00:00", "2027-01-02T00:00", "3600", validateCustomWindow);
  assert.equal(validateCustomWindow(request).to, "2027-01-02T00:00:00Z");
  assert.throws(() => validateCustomWindow({ ...request, to: "2027-01-03T00:00:00Z" }), /366 days/);
  assert.throws(() => validateCustomWindow({ ...request, resolutionSeconds: 60 }), /hourly/);
});

test("explicit producer rejections and unconfirmed custom job receipts remain distinct", () => {
  const problem = (code: unknown, status: number) => ({ type: "about:blank", title: "Job request", detail: "Producer detail", code, status });
  for (const [status, code, uncertain] of [
    [503, "STORAGE_FULL", false], [501, "JOB_TYPE_UNAVAILABLE", false], [429, "QUOTA_EXCEEDED", false],
    [503, "SERVICE_UNAVAILABLE", true], [500, "INTERNAL", true], [504, "STORAGE_FULL", true],
  ] as const) {
    const error = apiError(problem(code, status), status);
    assert.equal(error.message, "Producer detail");
    assert.equal(error.code, code);
    assert.equal(jobReceiptUncertain(error), uncertain);
  }
  for (const body of [{ code: "STORAGE_FULL" }, problem("STORAGE_FULL", 501), problem(["STORAGE_FULL"], 503)]) {
    const error = apiError(body, 503);
    assert.equal(error.code, undefined);
    assert.equal(jobReceiptUncertain(error), true);
  }
  assert.equal(jobReceiptUncertain(apiError(new TypeError("failed to fetch"))), true);
  assert.equal(jobReceiptUncertain(apiError(undefined, 504)), true);
});

test("releases only the submitted custom-site subscription and validates both cancellation outcomes", async t => {
  let calls = 0, status = 200;
  let payload: Record<string, unknown> = {};
  const server = setupServer(http.delete("*/api/v1/jobs/:id", async ({ params, request }) => {
    calls++;
    assert.equal(params.id, jobId);
    assert.equal(await request.text(), "");
    return HttpResponse.json(payload, { status });
  }));
  server.listen({ onUnhandledFrame: "error" }); t.after(() => server.close());

  for (const [id, acceptedSite, range] of [
    ["bad-id", site, input], [jobId, "", input], [jobId, site, { start: input.end, end: input.start }],
  ] as const) await assert.rejects(cancelCustomSiteJob(id, acceptedSite, range));
  assert.equal(calls, 0);
  const submitted = { start: "2026-11-14T00:10:00Z", end: "2026-11-14T23:59:00Z" };
  for (const [state, clients] of [["cancelled", 0], ["running", 2], ["queued", 1]] as const) {
    payload = { ...queued, status: state, clients };
    assert.deepEqual(await cancelCustomSiteJob(jobId, site, submitted), { status: state, clients });
  }
  for (const bad of [
    { status: "cancelled", clients: 1 }, { status: "queued", clients: 0 }, { clients: 1.5 },
    { clients: -1 }, { clients: null }, { status: "failed" }, { type: "precompute" }, { job_id: "j_another1" },
    { site_id: "custom:12.0000:123.0000" }, { params: { ...input, end: "2026-11-16T00:00:00Z" } },
  ]) {
    payload = { ...queued, clients: 1, ...bad };
    await assert.rejects(cancelCustomSiteJob(jobId, site, submitted));
  }
  for (const [responseStatus, code] of [[403, "JOB_NOT_YOURS"], [409, "JOB_NOT_CANCELLABLE"]] as const) {
    status = responseStatus;
    payload = { type: "about:blank", title: "Cannot cancel this job", status, code };
    const before: number = calls;
    await assert.rejects(cancelCustomSiteJob(jobId, site, submitted),
      (e: unknown) => e instanceof ApiError && e.status === responseStatus && e.code === code);
    assert.equal(calls, before + 1);
  }
});
