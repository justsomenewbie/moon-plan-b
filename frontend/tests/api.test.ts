import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw/http";
import { handlers } from "../lib/api/mock-handlers.ts";
import { ApiError, apiError, createJob, defaultWindow, getDataset, getJob, jobPollInterval, retryQuery, validateJob, validateWindow, windowFromInputs } from "../lib/api/client.ts";
const server = setupServer(...handlers);
const fixture = JSON.parse(readFileSync(new URL("../public/data/demo.json", import.meta.url), "utf8"));
const body = { ...defaultWindow, location: { latitudeDeg: 0, longitudeEastDeg: 0, elevationKm: 0, frame: "SYNTHETIC-FIXTURE", elevationDatum: "SYNTHETIC-FIXTURE" } };

test("typed client, mock contract and problem responses work end to end", async (t) => {
  server.listen({ onUnhandledFrame: "error" }); t.after(() => server.close());
  assert.equal((await getDataset(defaultWindow)).datasetId, fixture.datasetId);
  assert.equal((await getDataset({ ...defaultWindow, from: "2026-12-01T00:00:00Z", to: "2026-12-02T00:00:00Z" })).scenarios.length, 0);
  await assert.rejects(getDataset({ ...defaultWindow, to: "2031-01-01T00:00:00Z" }), /31 days/);
  await assert.rejects(getJob("missing", defaultWindow), (e: unknown) => e instanceof ApiError && e.status === 404);
  const accepted = await createJob(body);
  assert.equal((await getJob(accepted.jobId, defaultWindow)).status, "queued");
  for (const payload of [{}, { jobId: null }, { jobId: [] }, { jobId: 123 }]) {
    server.use(http.post("*/api/v1/jobs", () => HttpResponse.json(payload, { status: 202 })));
    await assert.rejects(createJob(body), /valid accepted job/);
  }
  for (const [status, progressPct, result, problem] of [
    ["running", 50, null, null], ["done", 100, fixture, null],
    ["failed", 20, null, { type: "about:blank", title: "Failed", status: 503, detail: "Worker unavailable" }],
  ] as const) {
    server.use(http.get("*/api/v1/jobs/:id", () => HttpResponse.json({ jobId: accepted.jobId, status, progressPct, result, problem })));
    const job = await getJob(accepted.jobId, defaultWindow);
    assert.equal(job.status, status); assert.equal(jobPollInterval(job), status === "running" ? 1500 : false);
  }
  const outside = { ...defaultWindow, from: "2026-12-01T00:00:00Z", to: "2026-12-02T00:00:00Z" };
  server.use(http.get("*/api/v1/jobs/:id", () => HttpResponse.json({ jobId: accepted.jobId, status: "done", progressPct: 100, result: fixture, problem: null })));
  await assert.rejects(getJob(accepted.jobId, outside), (e: unknown) => e instanceof ApiError && e.status === 502 && /outside the requested UTC range/.test(e.message));
  server.use(http.get("*/api/v1/jobs/:id", () => HttpResponse.json({ jobId: accepted.jobId, status: "done", progressPct: 100, result: { ...fixture, scenarios: [] }, problem: null })));
  const emptyJob = await getJob(accepted.jobId, outside);
  assert.equal(emptyJob.status === "done" && emptyJob.result.scenarios.length, 0);
  server.use(http.get("*/api/v1/dataset", () => HttpResponse.json({ type: "about:blank", title: "Unavailable", status: 503, detail: "Please retry", instance: "/request/1", extra: "allowed" }, { status: 503, headers: { "Content-Type": "application/problem+json" } })));
  await assert.rejects(getDataset(defaultWindow), (e: unknown) => e instanceof ApiError && e.status === 503 && e.message === "Please retry");
  server.use(http.get("*/api/v1/dataset", () => new HttpResponse("x".repeat(5 * 1024 * 1024 + 1))));
  await assert.rejects(getDataset(defaultWindow), (e: unknown) => e instanceof ApiError && e.status === 413);
});

test("editable UTC request fields retain seconds and validate both request actions", () => {
  assert.deepEqual(windowFromInputs("2026-11-15T00:00", "2026-11-17T00:00", "7200"), { from: "2026-11-15T00:00:00Z", to: "2026-11-17T00:00:00Z", resolutionSeconds: 7200 });
  assert.deepEqual(windowFromInputs("2026-11-15T00:00:12.5", "2026-11-16T00:00:12.05", "60"), { from: "2026-11-15T00:00:12.500Z", to: "2026-11-16T00:00:12.050Z", resolutionSeconds: 60 });
  for (const from of ["", "2026-02-30T00:00", "2026-11-15T00:00:12.5.6", "2026-11-15T00:00:12Z"]) assert.throws(() => windowFromInputs(from, "2026-11-17T00:00", "7200"));
  assert.throws(() => windowFromInputs("2026-11-15T00:00", "2026-11-15T00:00", "7200"), /increasing/);
  for (const resolution of ["", "abc", "59", "60.5", "86401"]) assert.throws(() => windowFromInputs("2026-11-15T00:00", "2026-11-17T00:00", resolution));
});

test("window and job boundaries reject invalid or contradictory data", () => {
  assert.throws(() => validateWindow({ ...defaultWindow, to: defaultWindow.from }), /increasing/);
  assert.throws(() => validateWindow({ ...defaultWindow, to: "2026-12-14T00:00:00Z", resolutionSeconds: 60 }), /10,000/);
  for (const value of [null, { jobId: "x", status: ["done"], progressPct: 100, result: fixture, problem: null }, { jobId: "x", status: "done", progressPct: 100, result: null, problem: null }, { jobId: "x", status: "failed", progressPct: 101, result: null, problem: null }, { jobId: "x", status: "queued", progressPct: 0, result: fixture, problem: null }]) assert.throws(() => validateJob(value));
  assert.equal(retryQuery(0, new ApiError("temporary", 503)), true);
  assert.equal(retryQuery(2, new ApiError("temporary", 503)), false);
  assert.equal(retryQuery(0, new ApiError("invalid", 422)), false);
  assert.equal(apiError("<html>private stack</html>", 500).message.includes("private"), false);
});
