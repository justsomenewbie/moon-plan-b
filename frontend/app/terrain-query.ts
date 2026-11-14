import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../lib/api/client";
import { getTerrainDateSites } from "../lib/api/terrain-dates";

export function hasRetryDeadline(error: unknown): error is ApiError {
  return error instanceof ApiError && Boolean(error.retryAt);
}

// A second observer or a reopened panel must leave a timed failure for the manual Retry button.
export function useTerrainSiteCatalog(runId: string | undefined, opened: boolean) {
  return useQuery({
    queryKey: ["terrain-date-sites", runId],
    queryFn: ({ signal }) => getTerrainDateSites(runId!, signal),
    enabled: query => Boolean(runId) && opened && !hasRetryDeadline(query.state.error),
  });
}
