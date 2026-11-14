import { validateTerrainDates, type TerrainDateRequest } from "./api/terrain-dates.ts";

export function terrainDatesHref({ siteId, first, second, runId }: TerrainDateRequest) {
  if (!runId) throw new Error("This link requires one site, one model run and two UTC ranges.");
  const params = new URLSearchParams({ site_id: siteId, run_id: runId, from: first.from, to: first.to, from2: second.from, to2: second.to });
  return "/compare-dates?" + params;
}

export function readTerrainDateLink(params: URLSearchParams) {
  function field(key: string) {
    const values = params.getAll(key);
    if (values.length !== 1 || !values[0]) throw new Error("This link requires one site, one model run and two UTC ranges.");
    return values[0];
  }
  return validateTerrainDates({
    siteId: field("site_id"), runId: field("run_id"),
    first: { from: field("from"), to: field("to") }, second: { from: field("from2"), to: field("to2") },
  });
}
