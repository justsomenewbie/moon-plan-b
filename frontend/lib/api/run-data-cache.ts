const minute = 60_000;
const hour = 60 * minute;

// Precomputed releases are immutable. The producer can change the default and expire job_ runs.
export function runDataCache(runId?: string, forceRefresh = false) {
  if (runId && !runId.startsWith("job_")) {
    return { staleTime: forceRefresh ? 0 : hour, gcTime: hour };
  }
  return { staleTime: forceRefresh ? 0 : minute };
}
