import assert from "node:assert/strict";
import test from "node:test";
import { terrainFixture } from "../../qa/browser-terrain-fixture.mjs";
import { parseTerrainSummary } from "../lib/api/terrain-summary.ts";
import { terrainSkyScenario } from "../lib/terrain-sky.ts";

const utc = (hour: number) => `2026-01-01T0${hour}:00:00Z`;
const raw = terrainFixture({ run: "test-run", start: utc(0), at: utc(2), end: utc(4) });
raw.sites[0].series.sun_az_deg = [359, 2];
raw.sites[0].series.sun_el_deg = [2, -1];
raw.sites[0].horizon.el_deg = [4, 4, 4];
raw.sites[0].horizon.min_el_deg = raw.sites[0].horizon.max_el_deg = 4;
const result = parseTerrainSummary(raw);
const site = result.sites[0];

test("keeps apparent angles and UTCs distinct from terrain visibility and decimation", () => {
  const sky = terrainSkyScenario(result, site)!;
  assert.equal(sky.id, site.id);
  assert.equal(sky.siteId, site.id);
  assert.equal(sky.startUtc, utc(0));
  assert.equal(sky.endUtc, utc(3));
  assert.equal(sky.sampleStepSeconds, 3600);
  assert.equal(sky.coverage, "partial");
  assert.deepEqual(sky.samples.map(sample => sample.utc), [utc(0), utc(2)]);
  assert.equal(site.series!.sun_visible[0], false);
  assert.deepEqual(sky.samples[0].sun, { azimuthDeg: 359, elevationDeg: 2 });
  assert.deepEqual(sky.samples[0].earth, { azimuthDeg: 0, elevationDeg: -1 });
  assert.deepEqual(sky.samples[1].sun, { azimuthDeg: 2, elevationDeg: -1 });
});

test("an isolated observation supports the HUD without adding a trailing interpolated hour", () => {
  const one = { ...raw, range: { ...raw.range, end: utc(1), requested_end: utc(1), n_samples: 1 } };
  const model = parseTerrainSummary({ ...one, sites: one.sites.map(row => ({
    ...row, series: { ...row.series, t: [utc(0)], step_s: 3600, decimated: false, sun_az_deg: [0], earth_az_deg: [0],
      sun_el_deg: [-1], earth_el_deg: [-1], sun_visible: [false], earth_visible: [false], both_visible: [false] },
  })) });
  const sky = terrainSkyScenario(model, model.sites[0])!;
  assert.equal(sky.samples.length, 1);
  assert.equal(sky.startUtc, sky.endUtc);
  assert.equal(sky.coverage, "partial");
});

test("windows and metrics alone never create sample directions", () => {
  assert.equal(terrainSkyScenario({ ...result, summaryOnly: true }, site), null);
  assert.equal(terrainSkyScenario(result, { ...site, series: null }), null);
  assert.equal(terrainSkyScenario(result, { ...site, series: { ...site.series!, t: [] } }), null);
});
