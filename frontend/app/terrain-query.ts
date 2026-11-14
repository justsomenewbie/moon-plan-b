import { useQuery } from "@tanstack/react-query";
import { hasRetryDeadline } from "../lib/api/client";
import { getTerrainDateSites } from "../lib/api/terrain-dates";
import { runDataCache } from "../lib/api/run-data-cache";

// A second observer or a reopened panel must leave a timed failure for the manual Retry button.
export function useTerrainSiteCatalog(runId: string | undefined, opened: boolean) {
  return useQuery({
    queryKey: ["terrain-date-sites", runId],
    queryFn: ({ signal }) => getTerrainDateSites(runId!, signal),
    ...runDataCache(runId),
    enabled: query => Boolean(runId) && opened && !hasRetryDeadline(query.state.error),
  });
}
