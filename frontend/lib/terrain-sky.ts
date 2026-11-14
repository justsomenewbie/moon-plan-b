import type { TerrainSummary } from "./api/terrain-summary";
import type { Scenario } from "./dataset";

export type SkyScenario = Pick<Scenario,
  "id" | "siteId" | "startUtc" | "endUtc" | "sampleStepSeconds" | "coverage" | "samples"
>;

export function terrainSkyScenario(result: TerrainSummary, site: TerrainSummary["sites"][number]): SkyScenario | null {
  const { series } = site;
  if (result.summaryOnly || !series?.t.length) return null;

  const { range } = result;
  // The aggregate's end is exclusive. Its final native observation is one model step earlier.
  const lastSample = new Date(Date.parse(range.end) - range.step_s * 1000).toISOString().replace(".000Z", "Z");
  return {
    id: site.id,
    siteId: site.id,
    startUtc: range.start,
    endUtc: lastSample,
    sampleStepSeconds: range.step_s,
    coverage: series.decimated || series.t.length < 2 ? "partial" : site.coverage_in_range,
    samples: series.t.map((utc, index) => ({
      utc,
      sun: { azimuthDeg: series.sun_az_deg[index], elevationDeg: series.sun_el_deg[index] },
      earth: { azimuthDeg: series.earth_az_deg[index], elevationDeg: series.earth_el_deg[index] },
    })),
  };
}
