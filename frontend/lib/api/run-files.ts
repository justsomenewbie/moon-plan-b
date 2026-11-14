import { ApiError, apiError, producer } from "./client.ts";
import type { TerrainSummary } from "./terrain-summary.ts";

function check(condition: unknown): asserts condition {
  if (!condition) throw new ApiError("The source file catalog does not match this model run.", 502);
}
export async function getRunFiles(run: TerrainSummary["run"], signal?: AbortSignal) {
  check(run.run_id !== "." && run.run_id !== ".." && /^[A-Za-z0-9_.-]{1,64}$/.test(run.run_id));
  const { data, response, error } = await producer.GET("/api/v1/runs/{run_id}", {
    params: { path: { run_id: run.run_id } }, signal,
  });
  if (!response.ok) throw apiError(error, response.status);
  check(data?.run_id === run.run_id && data.status === "ready" && data.run_timestamp_utc === run.run_timestamp_utc &&
    data.code_version === run.code_version && Array.isArray(data.manifest?.files));
  const used = new Set<string>();
  return data.manifest.files.map(file => {
    check(file && typeof file.path === "string" && file.path.length <= 512 && !used.has(file.path) &&
      file.path.split("/").every(part => /^[A-Za-z0-9_.:-]+$/.test(part) && part !== "." && part !== "..") &&
      typeof file.sha256 === "string" && /^[a-f0-9]{64}$/i.test(file.sha256));
    used.add(file.path);
    return { path: file.path, sha256: file.sha256,
      href: "/api/v1/runs/" + encodeURIComponent(run.run_id) + "/files/" + encodeURIComponent(file.path) };
  });
}
