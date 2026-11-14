import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../lib/api/client.ts";
import { getSiteInstant } from "../lib/api/site-instant.ts";
import { instantEventText } from "../lib/instant-events.ts";

const run = "unit", site = "custom:-89.4500:222.6900";
const time = "2026-11-19T15:00:00Z", inside = "2026-11-19T15:59:59Z";
const sun = { az_deg: 0, el_deg: 0, horizon_el_deg: 0.2, clearance_deg: -0.2, visible: true };
const earth = { az_deg: 359.9, el_deg: 3, horizon_el_deg: 2, clearance_deg: 1, visible: true };
const sample = { run_id: run, site_id: site, t: inside, sample_utc: time, sample_index: 45,
  step_s: 3600, precision_h: 1, sun: { ...sun, fraction: 0.08, power_tracking: 0.08 }, earth, both_visible: true };

test("shows UTC-relative modeled events, coverage limits and current states in both languages", async t => {
  // Replayed event fields from the public B2 Odysseus instant at 2026-01-07T00:30:00Z.
  const at = "2026-01-07T00:30:00Z", start = "2026-01-07T00:00:00Z", sunsetAt = "2026-01-11T00:00:00Z";
  const now = { hours: 0, at, state_now: true, lower_bound: false };
  const next = { sunset: { hours: 95.5, at: sunsetAt, state_now: true, lower_bound: false }, sunrise: now,
    earthset: { hours: 43679.5, at: null, state_now: true, lower_bound: true }, earthrise: now };
  let events: unknown = next;
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...sample, t: at, sample_utc: start,
    next_events: events, hours_until: { sunset: 96, sunrise: 0, earthset: null, earthrise: 0 } }));
  const read = () => getSiteInstant(run, site, at, 3600, start);
  const value = await read();
  assert.deepEqual(instantEventText("en", "sunset", value), { label: "Sunset", text: "In 95.5 h (±1 h)", at: sunsetAt });
  assert.match(instantEventText("vi", "sunset", value).text, /95,5 giờ \(±1 giờ\)/);
  assert.deepEqual(instantEventText("en", "earthset", value), { label: "Earthset", text: "At least 43,679.5 h · no event before model coverage ends", at: null });
  assert.equal(instantEventText("vi", "sunrise", value).text, "Đang nhìn thấy");
  for (const bad of [undefined, null, { ...next.sunset, state_now: false }, { ...next.sunset, hours: 96 },
    { ...next.sunset, at: "2026-02-30T00:00:00Z" }, { ...next.sunset, lower_bound: true }, now]) {
    events = { ...next, sunset: bad };
    const partial = await read();
    assert.deepEqual(instantEventText("vi", "sunset", partial), { label: "Mặt Trời lặn", text: "Chưa có dữ liệu", at: null });
    assert.deepEqual(partial.next_events.earthset, next.earthset);
  }
  events = undefined;
  assert.equal(instantEventText("en", "sunset", await read()).text, "Unavailable");
});

test("reads the containing model sample with pinned IDs and preserves visibility for a solar limb above the horizon", async t => {
  const calls: Request[] = [];
  const handler = t.mock.method(globalThis, "fetch", async (request: Request) => {
    calls.push(request);
    return Response.json({ ...sample, t: new URL(request.url).searchParams.get("t") });
  });
  const last = await getSiteInstant(run, site, inside, 3600, time);
  assert.equal(last.t, inside);
  assert.equal(last.sample_utc, time);
  assert.deepEqual(last.sun, { ...sun, fraction: 0.08 }); assert.deepEqual(last.earth, earth); assert.equal(last.both_visible, true);
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

test("preserves supplied tracking irradiance and disc fraction independently of optional-field availability", async t => {
  // Run B Athena /instant at 2026-11-15T05:00:00Z, including the partially visible solar disc.
  const source = {
    run_id: "B_spice_pgda_bruteforce_2026_2030", site_id: "im2_athena", t: "2026-11-15T05:00:00Z", sample_utc: "2026-11-15T05:00:00Z",
    step_s: 3600, precision_h: 1, both_visible: true,
    sun: { az_deg: 82.867692, el_deg: 2.2111, horizon_el_deg: 2.350644, clearance_deg: -0.139544, visible: true },
    earth: { az_deg: 327.936864, el_deg: 1.108645, horizon_el_deg: -1.457118, clearance_deg: 2.565763, visible: true },
  };
  let fields: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...source, sun: { ...source.sun, ...fields } }));
  const cases = [
    [{ fraction: 0.185915, irradiance_tracking_wm2: 259.149 }, { fraction: 0.185915, irradiance_tracking_wm2: 259.149 }],
    [{ fraction: 0, irradiance_tracking_wm2: 0 }, { fraction: 0, irradiance_tracking_wm2: 0 }],
    [{ fraction: 1.1, irradiance_tracking_wm2: 10 }, { irradiance_tracking_wm2: 10 }],
    [{ fraction: 0.5, irradiance_tracking_wm2: -1 }, { fraction: 0.5 }],
    [{ fraction: null, irradiance_tracking_wm2: "259.149" }, {}],
    [{}, {}],
  ] as const;
  for (const [input, expected] of cases) {
    fields = input;
    const value = await getSiteInstant(source.run_id, source.site_id, source.t, 3600, source.t);
    assert.deepEqual(value.sun, { ...source.sun, ...expected });
    assert.deepEqual(value.earth, source.earth);
  }
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

test("rejects conflicting visibility at the retained model sample and skips unsupplied samples", async t => {
  const hiddenEarth = { ...earth, visible: false };
  let reply = { ...sample, earth: hiddenEarth, both_visible: false };
  t.mock.method(globalThis, "fetch", async () => Response.json(reply));
  const series = { t: [time], sun_visible: [true], earth_visible: [false], both_visible: [false] };
  const read = (retained = series) => getSiteInstant(run, site, inside, 3600, time, undefined, retained);
  const mismatch = (e: unknown) => e instanceof ApiError && e.status === 502;

  assert.equal((await read()).sun.visible, true);
  // The joint flag stays false, so a Sun-only disagreement must still be detected.
  reply = { ...reply, sun: { ...sample.sun, visible: false } };
  await assert.rejects(read(), mismatch);
  assert.equal((await read({ ...series, t: ["2026-11-19T14:00:00Z"] })).sun.visible, false);
  reply = { ...sample, earth: hiddenEarth, both_visible: false };
  await assert.rejects(read({ ...series, earth_visible: [true], both_visible: [true] }), mismatch);
});
