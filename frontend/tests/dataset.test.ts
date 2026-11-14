import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { alternatives, chartPath, commonOffsets, initialSelection, laterMatch, publishedWindows, readSelection, sampleAt, selectionParams, skyPath, utcMillis, validateDataset } from "../lib/dataset.ts";
import type { Dataset } from "../lib/dataset.ts";

const fixture = () => JSON.parse(readFileSync(new URL("../public/data/demo.json", import.meta.url), "utf8")) as Dataset;

test("published windows group both UTC instants, retain duplicate site runs and sort chronologically", () => {
  const [ridge, later, basin] = fixture().scenarios;
  const duplicate = { ...ridge, id: "repeat", startUtc: ridge.startUtc.replace("Z", ".000Z") };
  const shorter = { ...basin, id: "short", endUtc: "2026-11-14T12:00:00Z" };
  const groups = publishedWindows([later, basin, duplicate, shorter, ridge]);
  assert.deepEqual(groups.map(group => group.map(s => s.id)), [["short"], ["basin-1", "repeat", "ridge-1"], ["ridge-2"]]);
});

test("fixture is explicitly synthetic and exercises complete, partial and missing coverage", () => {
  const d = validateDataset(fixture());
  assert.equal(d.evidence, "synthetic-fixture"); assert.equal(d.sources.length, 0);
  assert.ok(d.sites.every((s) => s.location === null));
  assert.deepEqual(d.scenarios.map((s) => s.coverage), ["complete", "complete", "complete", "complete", "partial", "missing"]);
});

test("real-data declarations cannot bypass provenance through enum coercion", () => {
  for (const value of [["computed-ephemeris"], {}, 0, null]) {
    const d = fixture(); (d as unknown as { evidence: unknown }).evidence = value;
    assert.throws(() => validateDataset(d), /evidence/);
  }
  const d = fixture(); d.evidence = "computed-ephemeris";
  assert.throws(() => validateDataset(d), /sources|location/);
});

test("coverage and assessment enums reject arrays, including otherwise valid text", () => {
  const d = fixture(); (d.scenarios[0] as unknown as { coverage: unknown }).coverage = ["complete"];
  assert.throws(() => validateDataset(d), /coverage/);
  const e = fixture(); (e.scenarios[0].criteria[0] as unknown as { result: unknown }).result = ["meets"];
  assert.throws(() => validateDataset(e), /Criterion/);
});

test("UTC rejects rolled dates, timezone ambiguity and duplicate samples", () => {
  for (const value of ["2026-02-30T00:00:00Z", "2026-11-14T24:00:00Z", "2026-11-14T00:00:00+00:00", "2026-11-14"]) assert.throws(() => utcMillis(value));
  assert.equal(utcMillis("2026-11-14T00:00:00Z"), utcMillis("2026-11-14T00:00:00.000Z"));
  const d = fixture(); d.scenarios[0].samples[1].utc = d.scenarios[0].samples[0].utc;
  assert.throws(() => validateDataset(d), /strictly increasing/);
});

test("missing, zero and invalid angles stay distinct", () => {
  const d = fixture(); assert.equal(validateDataset(d).scenarios[0].samples[2].sun!.elevationDeg, 0);
  d.scenarios[0].samples[2].sun = null; assert.throws(() => validateDataset(d), /non-null/);
  for (const value of [NaN, Infinity, 91]) {
    const e = fixture(); e.scenarios[0].samples[0].sun!.elevationDeg = value;
    assert.throws(() => validateDataset(e), /finite/);
  }
  const e = fixture(); e.scenarios[0].samples[0].sun!.azimuthDeg = 360;
  assert.throws(() => validateDataset(e), /below 360/);
});

test("the supplied horizon matches the supported model and covers all azimuths", () => {
  for (const curve of [[], [{ azimuthDeg: 0, elevationDeg: 0 }], [{ azimuthDeg: 0, elevationDeg: 1 }, { azimuthDeg: 360, elevationDeg: 0 }], [{ azimuthDeg: 0, elevationDeg: 0 }, { azimuthDeg: 180, elevationDeg: 0 }]]) {
    const d = fixture(); d.scenarios[0].horizonCurve = curve;
    assert.throws(() => validateDataset(d), /horizon|Horizon/);
  }
});

test("partial data cannot carry available metrics or definite assessments", () => {
  const d = fixture(); d.scenarios[4].metrics = { sunAboveHours: 0, earthAboveHours: 0, simultaneousLongestHours: 0 };
  assert.throws(() => validateDataset(d), /must keep metrics/);
  const e = fixture(); e.scenarios[4].criteria[0].result = "below";
  assert.throws(() => validateDataset(e), /coverage/);
});

test("intervals cannot overstate totals or invent joint visibility", () => {
  const d = fixture(); d.scenarios[0].metrics!.sunAboveHours = 11;
  assert.throws(() => validateDataset(d), /duration does not match/);
  const e = fixture(), s = e.scenarios[0];
  s.intervals!.simultaneous = [{ startUtc: "2026-11-14T00:00:00Z", endUtc: "2026-11-14T09:00:00Z", endClipped: false }];
  assert.throws(() => validateDataset(e), /contained in both/);
});

test("large ordered interval sets validate with linear timestamp work", (t) => {
  const d = fixture(), s = d.scenarios[0], count = 1000;
  d.scenarios = [s];
  const start = Date.parse(s.startUtc);
  const intervals = Array.from({ length: count }, (_, i) => ({ startUtc: new Date(start + i * 2000).toISOString(), endUtc: new Date(start + i * 2000 + 1000).toISOString(), endClipped: false }));
  s.intervals = { sun: intervals, earth: intervals, simultaneous: intervals };
  s.metrics = { sunAboveHours: count / 3600, earthAboveHours: count / 3600, simultaneousLongestHours: 1 / 3600 };
  s.criteria.forEach((v) => { v.result = "below"; });
  const parse = t.mock.method(Date, "parse");
  validateDataset(d);
  assert.ok(parse.mock.callCount() < 10 * count, "Timestamp parsing must grow linearly with intervals.");
});

test("links and identifiers cannot create unsafe navigation or ambiguous sources", () => {
  const d = fixture(); d.sources = [{ id: "test", title: "Test", url: "javascript:alert(1)", version: "1", retrievedAtUtc: "2026-11-14T00:00:00Z", rawSha256: null }];
  assert.throws(() => validateDataset(d), /HTTP/);
  d.sources[0].url = "https://user:pass@example.org"; assert.throws(() => validateDataset(d), /credentials/);
  const e = fixture(); e.sites[1].id = e.sites[0].id; assert.throws(() => validateDataset(e), /unique/);
  const f = fixture(); f.scenarios[0].siteId = "unknown"; assert.throws(() => validateDataset(f), /unknown site/);
});

test("different-date and same-UTC comparisons preserve their invariants", () => {
  const d = fixture(), a = d.scenarios[0];
  assert.deepEqual(alternatives(d, a, "sites").map((s) => s.id), ["basin-1"]);
  assert.ok(alternatives(d, a, "dates").every((s) => s.siteId === a.siteId && s.startUtc !== a.startUtc));
  d.scenarios[2].startUtc = "2026-11-14T00:00:00.000Z"; d.scenarios[2].endUtc = "2026-11-15T00:00:00.000Z";
  assert.equal(alternatives(d, a, "sites")[0].id, "basin-1");
  const duplicate = structuredClone(a); duplicate.id = "same-time"; duplicate.startUtc = "2026-11-14T00:00:00.000Z";
  d.scenarios.push(duplicate); assert.ok(!alternatives(d, a, "dates").some((s) => s.id === duplicate.id));
});

test("sharing round-trips exact release and controls; malformed links never silently reset", () => {
  const d = fixture(), selection = initialSelection(d)!;
  const params = selectionParams(d, selection);
  assert.deepEqual(readSelection(params, d), selection);
  for (const [key, value] of [["v", "old-release"], ["mode", "bad"], ["a", "none"], ["b", "basin-2"], ["duration", "2"], ["h", "7"]]) {
    const modified = new URLSearchParams(params); modified.set(key, value);
    assert.throws(() => readSelection(modified, d));
  }
  params.append("a", selection.a); assert.throws(() => readSelection(params, d), /duplicate/);
  assert.throws(() => readSelection(new URLSearchParams("mode=dates"), d), /incomplete/);
});

test("charts break paths on nulls; cursor uses actual shared samples only", () => {
  const d = fixture(), partial = d.scenarios[4];
  assert.equal((chartPath(partial, "sun").match(/M/g) ?? []).length, 2);
  assert.equal(chartPath(d.scenarios[5], "sun"), "");
  assert.deepEqual(commonOffsets(d.scenarios[0], d.scenarios[5]), []);
  assert.equal(commonOffsets(d.scenarios[0], d.scenarios[1]).length, 9);
  assert.equal(sampleAt(d.scenarios[0], 3600000), undefined);
  assert.equal(sampleAt(d.scenarios[0], 0)?.sun?.azimuthDeg, 350);
  const gap = fixture(); gap.scenarios[0].samples.splice(3, 1);
  assert.throws(() => validateDataset(gap), /Complete coverage/);
  assert.equal((chartPath(gap.scenarios[0], "sun").match(/M/g) ?? []).length, 2);
});

test("sky tracks break time gaps and nulls while preserving cadence and north-wrap behavior", () => {
  const d = fixture(), s = d.scenarios[0];
  assert.match(skyPath(s, "sun"), /M350,120 M14,105 L38,90 L62,75 L86,60/);
  s.coverage = "partial"; s.metrics = null; s.intervals = null;
  s.criteria.forEach((c) => { c.result = "unknown"; });
  s.samples.splice(3, 1);
  validateDataset(d);
  assert.match(skyPath(s, "sun"), /L38,90 M86,60/);
  s.samples[1].earth = null;
  validateDataset(d);
  assert.match(skyPath(s, "earth"), /M20,110\s+M38,70/);
  assert.equal(skyPath(d.scenarios[5], "sun"), "");
});

test("an empty release remains valid and has no fabricated default selection", () => {
  const d = fixture(); d.sites = []; d.scenarios = [];
  assert.equal(initialSelection(validateDataset(d)), null);
});

test("later-match search uses supplied same-site candidates and never skips unresolved predecessors silently", () => {
  const d = fixture(), a = d.scenarios[0];
  assert.equal(laterMatch(d, a, 6).candidate?.id, "ridge-2");
  assert.equal(laterMatch(d, a, 6).unresolvedBefore, false);
  assert.deepEqual(laterMatch(d, a, 12), { unresolvedBefore: true });
  const future = structuredClone(d.scenarios[1]); future.id = "later";
  future.startUtc = "2026-11-18T00:00:00Z"; future.endUtc = "2026-11-19T00:00:00Z";
  d.scenarios[1].criteria[0].result = "below"; d.scenarios.push(future);
  const result = laterMatch(d, a, 6);
  assert.equal(result.candidate?.id, "later"); assert.equal(result.unresolvedBefore, true);
  d.scenarios = [a, d.scenarios[2]];
  assert.deepEqual(laterMatch(d, a, 6), { unresolvedBefore: false });
});
