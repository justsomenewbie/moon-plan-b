import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../lib/api/client.ts";
import { getSiteInstant } from "../lib/api/site-instant.ts";

const run = "unit", site = "custom:-89.4500:222.6900";
const time = "2026-11-19T15:00:00Z", inside = "2026-11-19T15:59:59Z";
const sun = { az_deg: 0, el_deg: 0, horizon_el_deg: 0.2, clearance_deg: -0.2, visible: true };
const earth = { az_deg: 359.9, el_deg: 3, horizon_el_deg: 2, clearance_deg: 1, visible: true };
const sample = { run_id: run, site_id: site, t: inside, sample_utc: time, sample_index: 45,
  step_s: 3600, precision_h: 1, sun: { ...sun, fraction: 0.08, power_tracking: 0.08 }, earth, both_visible: true };

test("reads the containing model sample with pinned IDs and preserves visibility for a solar limb above the horizon", async t => {
  const calls: Request[] = [];
  const handler = t.mock.method(globalThis, "fetch", async (request: Request) => {
    calls.push(request);
    return Response.json({ ...sample, t: new URL(request.url).searchParams.get("t") });
  });
  const last = await getSiteInstant(run, site, inside, 3600, time);
  assert.equal(last.t, inside);
  assert.equal(last.sample_utc, time);
  assert.deepEqual(last.sun, sun); assert.deepEqual(last.earth, earth); assert.equal(last.both_visible, true);
  for (const at of ["2026-11-19T15:00", "2026-11-19T15:00:00", time]) {
    assert.equal((await getSiteInstant(run, site, at, 3600, time)).t, time);
  }
  assert.equal(calls.length, 4);
  for (const request of calls) {
    const url = new URL(request.url);
    assert.equal(request.method, "GET"); assert.equal(url.pathname, "/api/v1/sites/" + encodeURIComponent(site) + "/instant");
    assert.equal(url.searchParams.get("run_id"), run);
  }
  handler.mock.mockImplementation(async () => Response.json({ ...sample, sample_index: undefined }));
  assert.equal((await getSiteInstant(run, site, inside, 3600, time)).sample_index, undefined);
});

test("rejects invalid identity, UTC sample boundaries, cadence and body data", async t => {
  let reply: Record<string, unknown> = sample;
  t.mock.method(globalThis, "fetch", async () => Response.json(reply));
  for (const diff of [
    { run_id: "other" }, { site_id: "other" }, { t: time }, { step_s: 7200 }, { precision_h: 0 },
    { sample_index: null }, { sample_index: -1 }, { sample_index: 0.1 },
    { sample_utc: "2026-11-19T14:59:59Z" }, { sample_utc: "2026-11-19T16:00:00Z" }, { sample_utc: "invalid" },
    { sun: null }, { sun: { ...sun, az_deg: 360 } }, { earth: { ...earth, az_deg: -1 } },
    { sun: { ...sun, el_deg: null } }, { earth: { ...earth, horizon_el_deg: 91 } },
    { sun: { ...sun, clearance_deg: 0.2 } }, { sun: { ...sun, visible: 1 } }, { both_visible: false },
  ]) {
    reply = { ...sample, ...diff };
    await assert.rejects(getSiteInstant(run, site, inside, 3600, time), (e: unknown) => e instanceof ApiError && e.status === 502);
  }
});

test("requires the sample to be on the supplied grid even when its interval contains the request", async t => {
  let sampleUtc = "2026-11-19T15:30:00Z", calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ ...sample, sample_utc: sampleUtc }); });
  await assert.rejects(getSiteInstant(run, site, inside, 3600, "2026-11-19T14:00"),
    (e: unknown) => e instanceof ApiError && e.status === 422);
  assert.equal(calls, 0);
  const laterGridPoint = "2026-11-19T16:00:00Z";
  await assert.rejects(getSiteInstant(run, site, inside, 3600, laterGridPoint),
    (e: unknown) => e instanceof ApiError && e.status === 502);
  sampleUtc = time;
  assert.equal((await getSiteInstant(run, site, inside, 3600, laterGridPoint)).sample_utc, time);
});

test("invalid inputs and abort avoid the request; producer rejections retain their status, code and detail", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ type: "about:blank", title: "Outside run", code: "OUT_OF_RANGE", detail: "Pick a time in this run", status: 422 }, { status: 422 });
  });
  for (const [runId, siteId, at, step] of [
    ["bad/run", site, time, 3600], [run, "bad/site", time, 3600], [run, site, time, 0],
    [run, site, "2026-02-30T00:00:00Z", 3600], [run, site, "2026-11-19T15:00:00.500Z", 3600],
    [run, site, "2026-11-19T15:00:00+07:00", 3600],
  ] as const) await assert.rejects(getSiteInstant(runId, siteId, at, step, time), (e: unknown) => e instanceof ApiError && e.status === 422);
  await assert.rejects(getSiteInstant(run, site, time, 3600, time, AbortSignal.abort()), { name: "AbortError" });
  assert.equal(calls, 0);
  await assert.rejects(getSiteInstant(run, site, time, 3600, time), (e: unknown) =>
    e instanceof ApiError && e.status === 422 && e.code === "OUT_OF_RANGE" && e.message === "Pick a time in this run");
  assert.equal(calls, 1);
});
