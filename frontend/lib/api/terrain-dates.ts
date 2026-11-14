import { ApiError, apiError, getTerrainAggregate, producer, validateTerrainWindow } from "./client.ts";

type DateRange = { from: string; to: string };
export type TerrainDateRequest = {
  siteId: string;
  first: DateRange;
  second: DateRange;
  runId?: string;
};

const siteIdPattern = /^[A-Za-z0-9_.:-]{1,64}$/;

type TerrainDateSite = {
  id: string; name: string; demSource: string; horizonMethod: string;
  lat_deg: number | null; lon_deg: number | null;
};

export async function getTerrainDateSites(runId: string, signal?: AbortSignal): Promise<TerrainDateSite[]> {
  const { data, error, response } = await producer.GET("/api/v1/sites", {
    params: { query: { run_id: runId, format: "json" } }, signal,
  });
  if (!response.ok) throw apiError(error, response);
  if (!data || !("sites" in data) || data.run_id !== runId || !Array.isArray(data.sites))
    throw new ApiError("The site list does not match the selected model run.", 502);
  const ids = new Set<string>();
  return data.sites.map(site => {
    if (!site || typeof site.id !== "string" || !siteIdPattern.test(site.id) || ids.has(site.id)
        || typeof site.name !== "string" || !site.name.trim()
        || typeof site.dem_source !== "string" || !site.dem_source.trim()
        || typeof site.horizon_method !== "string" || !site.horizon_method.trim()
        || (site.lat_deg != null && (!Number.isFinite(site.lat_deg) || Math.abs(site.lat_deg) > 90))
        || (site.lon_deg != null && (!Number.isFinite(site.lon_deg) || site.lon_deg < 0 || site.lon_deg >= 360)))
      throw new ApiError("The model returned an invalid site list.", 502);
    ids.add(site.id);
    return { id: site.id, name: site.name, demSource: site.dem_source, horizonMethod: site.horizon_method,
      lat_deg: site.lat_deg ?? null, lon_deg: site.lon_deg ?? null };
  });
}

export function validateTerrainDates(request: TerrainDateRequest) {
  if (!siteIdPattern.test(request.siteId))
    throw new ApiError("Choose a valid site ID for the date comparison.", 422);
  if (request.runId !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(request.runId))
    throw new ApiError("This run link requires a live backend and a valid model run ID.", 422);

  const { first, second } = request;
  for (const range of [first, second]) validateTerrainWindow({ ...range, resolutionSeconds: 3600 });
  const duration = (range: DateRange) => Date.parse(range.to) - Date.parse(range.from);
  if (Date.parse(first.from) === Date.parse(second.from) || duration(first) !== duration(second))
    throw new ApiError("Choose two different UTC ranges of equal duration.", 422);
  return request;
}

export async function getTerrainDates(request: TerrainDateRequest, signal?: AbortSignal) {
  validateTerrainDates(request);
  async function load(range: DateRange, runId?: string) {
    signal?.throwIfAborted();
    const result = await getTerrainAggregate({ ...range, resolutionSeconds: 3600 }, request.siteId, runId, false, signal);
    signal?.throwIfAborted();
    return result;
  }
  const first = await load(request.first, request.runId);
  const second = await load(request.second, first.run.run_id);
  if (first.run.manifest_sha256 !== second.run.manifest_sha256 || first.range.step_s !== second.range.step_s)
    throw new ApiError("The two ranges have different source manifests or sampling steps.", 502);
  const site = first.sites[0], next = second.sites[0];
  if (site.lat_deg !== next.lat_deg || site.lon_deg !== next.lon_deg ||
      site.surface_height_m !== next.surface_height_m || first.run.observer_height_m !== second.run.observer_height_m)
    throw new ApiError("The site coordinates or heights differ between the two dates.", 502);
  if (first.range.start === second.range.start && first.range.end === second.range.end)
    throw new ApiError("Both requests resolve to the same model window. Choose dates farther apart.", 422);
  return { first, second };
}
