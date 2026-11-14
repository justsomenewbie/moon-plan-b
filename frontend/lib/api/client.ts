// The live aggregate and synthetic workflow each use their published or draft OpenAPI types.
import createClient from "openapi-fetch";
import type { components, paths } from "./schema";
import type { paths as ProducerPaths } from "./producer";
import { parseTerrainSummary, terrainUtcNanos } from "./terrain-summary.ts";
import { utcMillis, validateDataset } from "../dataset.ts";
import { terrainSiteIds, type TerrainTarget } from "../terrain-target.ts";
import type { Dataset } from "../dataset.ts";

export const isMock = (process.env.NEXT_PUBLIC_API_BASE_URL || "mock") === "mock";
export const isPublicTeamApi = process.env.NEXT_PUBLIC_LUNARNAV_PROXY === "1";
let mockReady: Promise<void> | undefined;
export function ensureMock(): Promise<void> {
  if (!isMock || typeof window === "undefined") return Promise.resolve();
  return mockReady ??= import("./mock-browser").then(async ({ worker }) => { await worker.start({ onUnhandledFrame: "bypass", quiet: true }); }).catch((error) => { mockReady = undefined; throw error; });
}
export class ApiError extends Error {
  status: number;
  code?: string;
  title?: string;
  hint?: string;
  fields: { path: string; message: string }[] = [];
  retryAt?: string;
  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}
// A Retry-After delay starts at receipt. Store a fixed UTC instant so a language
// switch or later render cannot restart the wait.
function retryTime(header: string | null, bodySeconds: unknown): string | undefined {
  const now = Date.now();
  let ms: number | undefined;
  if (header && /^\d+$/.test(header)) ms = now + Number(header) * 1000;
  else if (header) {
    const parsed = new Date(header);
    if (Number.isFinite(parsed.getTime()) && parsed.toUTCString() === header) ms = parsed.getTime();
  }
  if (ms === undefined && typeof bodySeconds === "number" && Number.isSafeInteger(bodySeconds) && bodySeconds >= 0)
    ms = now + bodySeconds * 1000;
  if (ms !== undefined && Number.isFinite(ms) && ms >= 0 && ms < 253402300800000) return new Date(ms).toISOString();
}

export function apiError(value: unknown, response: Response | number = 0): ApiError {
  if (value instanceof ApiError) return value;
  const status = typeof response === "number" ? response : response.status;
  const p = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const message = typeof p.detail === "string" ? p.detail : typeof p.title === "string" ? p.title : "The request could not be completed. Retry or check the connection.";
  const code = p.status === status && typeof p.type === "string" && p.type.length > 0 &&
    typeof p.title === "string" && p.title.length > 0 && typeof p.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(p.code) ? p.code : undefined;
  const error = new ApiError(message.slice(0, 2000), status, code);
  if (code) {
    error.title = (p.title as string).slice(0, 200);
    if (typeof p.hint === "string" && p.hint.trim()) error.hint = p.hint.trim().slice(0, 2000);
    if (Array.isArray(p.errors)) {
      for (const field of p.errors) {
        if (field && typeof field.path === "string" && typeof field.message === "string" && field.message.trim())
          error.fields.push({ path: field.path.slice(0, 160), message: field.message.trim().slice(0, 500) });
        if (error.fields.length === 5) break;
      }
    }
  }
  if (status === 429 || status === 503)
    error.retryAt = retryTime(typeof response === "number" ? null : response.headers.get("retry-after"), code === "RATE_LIMITED" ? p.retry_after_s : undefined);
  return error;
}
export function jobReceiptUncertain(error: unknown): boolean {
  if (!(error instanceof ApiError) || (error.status !== 0 && error.status < 500)) return false;
  return !(error.status === 503 && error.code === "STORAGE_FULL") &&
    !(error.status === 501 && error.code === "JOB_TYPE_UNAVAILABLE");
}
export const retryQuery = (failureCount: number, error: Error) => failureCount < 2 && error instanceof ApiError && !error.retryAt && (error.status === 0 || error.status >= 500);
const baseUrl = typeof window === "undefined" ? "http://localhost" : "";
async function boundedFetch(request: Request, retainBytes?: (bytes: Uint8Array<ArrayBuffer>) => void) {
  await ensureMock();
  // The producer can spend 30 seconds on its synchronous alternative-date search.
  const dateSearch = request.method === "POST" && new URL(request.url).pathname === "/api/v1/alt-dates";
  const deadline = AbortSignal.timeout(dateSearch ? 35000 : 15000);
  try {
    const response = await fetch(new Request(request, { signal: AbortSignal.any([request.signal, deadline]) }));
    if (!response.body) return response;
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 5 * 1024 * 1024) { await reader.cancel(); throw new ApiError("API response exceeds the 5 MiB frontend limit. Request a shorter range or coarser resolution.", 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (response.ok) retainBytes?.(bytes);
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) { if (request.signal.aborted) throw error; if (deadline.aborted) throw new ApiError(dateSearch ? "The date search did not respond within 35 seconds. Please retry." : "The API did not respond within 15 seconds. Please retry.", 504); throw apiError(error); }
}
const api = createClient<paths>({ baseUrl, fetch: request => boundedFetch(request) });
export const producer = createClient<ProducerPaths>({ baseUrl, fetch: request => boundedFetch(request) });

export type WindowRequest = NonNullable<paths["/api/v1/dataset"]["get"]["parameters"]["query"]>;
export type JobRequest = components["schemas"]["JobRequest"];
export type Job = components["schemas"]["Job"];
export const defaultWindow: WindowRequest = isMock
  ? { from: "2026-11-14T00:00:00Z", to: "2026-11-18T00:00:00Z", resolutionSeconds: 10800 }
  : { from: "2026-11-14T00:00:00Z", to: "2026-11-21T00:00:00Z", resolutionSeconds: 3600 };
const day = 86_400_000_000_000n;
function checkTerrainWindow(request: WindowRequest, span: bigint, hourly: boolean) {
  if (hourly) {
    if (span <= 0n || span > 366n * day || request.resolutionSeconds !== 3600)
      throw new ApiError("Choose an increasing UTC range of up to 366 days for an hourly custom-site job.", 422);
  } else {
    if (span <= 0n || span > 31n * day) throw new ApiError("Choose an increasing UTC range of up to 31 days for the catalog comparison.", 422);
    if (!Number.isInteger(request.resolutionSeconds) || request.resolutionSeconds < 3600 || request.resolutionSeconds > 2678400)
      throw new ApiError("Choose a track sampling step between 3,600 and 2,678,400 seconds.", 422);
  }
  return request;
}
export function validateCustomWindow(request: WindowRequest) {
  const milliseconds = utcMillis(request.to, "End UTC") - utcMillis(request.from, "Start UTC");
  return checkTerrainWindow(request, BigInt(milliseconds) * 1_000_000n, true);
}
export function validateWindow(request: WindowRequest) {
  const span = utcMillis(request.to, "End UTC") - utcMillis(request.from, "Start UTC");
  if (span <= 0 || span > 31 * 86400000) throw new ApiError("Choose an increasing UTC range of at most 31 days (draft limit).", 422);
  if (!Number.isInteger(request.resolutionSeconds) || request.resolutionSeconds < 60 || request.resolutionSeconds > 86400 || Math.ceil(span / (request.resolutionSeconds * 1000)) + 1 > 10000) throw new ApiError("Choose 60–86400 seconds per sample and at most 10,000 requested samples per series.", 422);
  return request;
}
export function validateTerrainWindow(request: WindowRequest) {
  const milliseconds = utcMillis(request.to, "End UTC") - utcMillis(request.from, "Start UTC");
  return checkTerrainWindow(request, BigInt(milliseconds) * 1_000_000n, false);
}
export function windowFromInputs(from: string, to: string, resolution: string, validate = validateWindow) {
  const utc = (value: string) => {
    const timestamp = value.length === 16 ? `${value}:00` : value;
    return `${timestamp.replace(/\.(\d{1,2})$/, (_, fraction: string) => `.${fraction.padEnd(3, "0")}`)}Z`;
  };
  return validate({ from: utc(from), to: utc(to), resolutionSeconds: Number(resolution) });
}
function withinRequestedWindow(dataset: Dataset, request: WindowRequest) {
  if (dataset.scenarios.some((s) => Date.parse(s.startUtc) < Date.parse(request.from) || Date.parse(s.endUtc) > Date.parse(request.to))) throw new ApiError("The server returned observations outside the requested UTC range.", 502);
  return dataset;
}
export async function getDataset(request: WindowRequest, signal?: AbortSignal) {
  validateWindow(request);
  const { data, error, response } = await api.GET("/api/v1/dataset", { params: { query: request }, signal });
  if (response.status === 404 && error?.instance === "/api/v1/dataset" && error.title === "Route not found") {
    throw new ApiError("This backend does not yet serve the comparison dataset. Import a compatible JSON release or retry after the backend adds the route.", 404);
  }
  if (!response.ok) throw apiError(error, response);
  return withinRequestedWindow(validateDataset(data), request);
}
export { defaultTerrainSites, type TerrainTarget } from "../terrain-target.ts";
const terrainCriteriaHours = [24, 72, 168];

export async function getTerrainAggregate(request: WindowRequest, siteIds: string, runId: string | undefined, withObservations: boolean, signal?: AbortSignal, keepFile = withObservations) {
  const endSecond = request.to.replace(/\.\d{1,9}Z$/, "Z");
  utcMillis(endSecond, "End UTC");
  if (endSecond === "9999-12-31T23:59:59Z" && /\.\d*[1-9]\d*Z$/.test(request.to))
    throw new ApiError("End UTC exceeds the supported four-digit year.", 422);
  const sections = withObservations ? ["horizon", "series", "windows", "metrics", "criteria"] : ["windows", "metrics", "criteria"];
  let file: Blob | undefined;
  const { data, error, response } = await producer.GET("/api/v1/dataset", {
    ...(keepFile ? { fetch: (request: Request) => boundedFetch(request, bytes => { file = new Blob([bytes], { type: "application/json" }); }) } : {}),
    signal, params: { query: {
    run_id: runId, site_ids: siteIds, start: request.from, end: request.to, step_s: request.resolutionSeconds,
    ...(withObservations ? { horizon_step_deg: 0.5, max_points: 10000 } : {}),
    include: sections.join(","), criteria_hours: terrainCriteriaHours.join(","),
  } } }).catch(error => {
    if (error instanceof SyntaxError) throw new ApiError("The API returned incomplete or invalid JSON. Please retry.", 502);
    throw error;
  });
  if (!response.ok) throw apiError(error, response);
  if (!Array.isArray(data?.include) || !sections.every(section => data.include.some(value => value === section)))
    throw new ApiError("The server response is missing a requested dataset section.", 502);
  const result = parseTerrainSummary(data, request);
  if (result.criteria_hours?.length !== terrainCriteriaHours.length || !terrainCriteriaHours.every((hours, i) => result.criteria_hours?.[i] === hours))
    throw new ApiError("The returned duration thresholds differ from the requested thresholds.", 502);
  if (runId && result.run.run_id !== runId) throw new ApiError("The returned model run differs from the shared link.", 502);
  if (result.sites.map(site => site.id).join(",") !== siteIds)
    throw new ApiError("The returned sites do not match the requested comparison.", 502);
  if (file) result.exportFile = file;
  return result;
}

function catalogSummary(request: WindowRequest, target: TerrainTarget | undefined, span: bigint) {
  if (!target || target.run_id.startsWith("job_") || (!target.site_id && !target.site_ids)) return false;
  if (terrainSiteIds(target).split(",").some(id => id.startsWith("custom:"))) return false;
  return span > (request.resolutionSeconds === 3600 ? 366n : 31n) * day;
}

export function terrainSummaryRequested(request: WindowRequest, target?: TerrainTarget) {
  return catalogSummary(request, target, terrainUtcNanos(request.to, "End UTC") - terrainUtcNanos(request.from, "Start UTC"));
}

export function validateTerrainTargetWindow(request: WindowRequest, target?: TerrainTarget) {
  terrainSiteIds(target);
  const span = terrainUtcNanos(request.to, "End UTC") - terrainUtcNanos(request.from, "Start UTC");
  if (catalogSummary(request, target, span)) {
    if (!Number.isInteger(request.resolutionSeconds) || request.resolutionSeconds < 3600 || request.resolutionSeconds > 2678400)
      throw new ApiError("Choose a track sampling step between 3,600 and 2,678,400 seconds.", 422);
    return request;
  }
  const hourly = target?.site_id !== undefined || (target?.site_ids !== undefined && request.resolutionSeconds === 3600);
  return checkTerrainWindow(request, span, hourly);
}
export async function getTerrainWindow(request: WindowRequest, signal?: AbortSignal, target?: TerrainTarget) {
  validateTerrainTargetWindow(request, target);
  const summary = terrainSummaryRequested(request, target);
  const result = await getTerrainAggregate(request, terrainSiteIds(target), target?.run_id, !summary, signal, true);
  if (summary) result.summaryOnly = true;
  return result;
}
export function validateJobRequest(request: JobRequest) {
  validateWindow(request);
  const location = request.location;
  if (!location || !Number.isFinite(location.latitudeDeg) || Math.abs(location.latitudeDeg) > 90 || !Number.isFinite(location.longitudeEastDeg) || Math.abs(location.longitudeEastDeg) > 180 || !Number.isFinite(location.elevationKm) || Math.abs(location.elevationKm) > 100 || typeof location.frame !== "string" || !location.frame.trim() || location.frame.length > 2000 || typeof location.elevationDatum !== "string" || !location.elevationDatum.trim() || location.elevationDatum.length > 2000) throw new ApiError("Provide finite lunar coordinates, elevation, reference frame and elevation datum.", 422);
  return request;
}
export async function createJob(request: JobRequest) {
  validateJobRequest(request);
  const { data, error, response } = await api.POST("/api/v1/jobs", { body: request });
  if (response.status !== 202 || !data || typeof data.jobId !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(data.jobId)) throw apiError(error ?? { detail: "The server did not return a valid accepted job." }, response);
  return data;
}
export function validateJob(value: unknown): Job {
  const j = value as Job;
  if (!j || typeof j !== "object" || typeof j.jobId !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(j.jobId) || typeof j.status !== "string" || !["queued", "running", "done", "failed"].includes(j.status) || !Number.isFinite(j.progressPct) || j.progressPct < 0 || j.progressPct > 100) throw new ApiError("The server returned an invalid job status.", 502);
  if (j.status === "done") {
    if (j.progressPct !== 100 || j.problem !== null) throw new ApiError("The completed job is inconsistent.", 502);
    validateDataset(j.result);
  } else if (j.result !== null || (j.status === "failed" ? !j.problem || typeof j.problem.detail !== "string" || typeof j.problem.title !== "string" || typeof j.problem.type !== "string" || !Number.isInteger(j.problem.status) || j.problem.status < 400 || j.problem.status > 599 : j.problem !== null)) throw new ApiError("The job result is inconsistent with its status.", 502);
  return j;
}
export async function getJob(id: string, request: WindowRequest, signal?: AbortSignal) {
  validateWindow(request);
  const { data, error, response } = await api.GET("/api/v1/jobs/{id}", { params: { path: { id } }, signal });
  if (!response.ok) throw apiError(error, response);
  const job = validateJob(data);
  if (job.jobId !== id) throw new ApiError("The server returned a different job.", 502);
  if (job.status === "done") withinRequestedWindow(job.result, request);
  return job;
}
export const jobPollMs = 2000;
export const jobPollInterval = (job?: Job) => job?.status === "done" || job?.status === "failed" ? false : jobPollMs;
