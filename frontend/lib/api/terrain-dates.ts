import { ApiError, getTerrainAggregate, validateTerrainWindow } from "./client.ts";

type DateRange = { from: string; to: string };
export type TerrainDateRequest = {
  siteId: string;
  first: DateRange;
  second: DateRange;
  runId?: string;
};

export function validateTerrainDates(request: TerrainDateRequest) {
  if (!["im1_odysseus", "im2_athena"].includes(request.siteId))
    throw new ApiError("Choose Odysseus or Athena for the date comparison.", 422);
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
  if (first.range.start === second.range.start && first.range.end === second.range.end)
    throw new ApiError("Both requests resolve to the same model window. Choose dates farther apart.", 422);
  return { first, second };
}
