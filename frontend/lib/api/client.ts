// The live aggregate and synthetic workflow each use their published or draft OpenAPI types.
import createClient from "openapi-fetch";
import type { components, paths } from "./schema";
import type { paths as ProducerPaths } from "./producer";
import { parseTerrainSummary } from "./terrain-summary.ts";
import { utcMillis, validateDataset } from "../dataset.ts";
import type { Dataset } from "../dataset.ts";

export const isMock = (process.env.NEXT_PUBLIC_API_BASE_URL || "mock") === "mock";
let mockReady: Promise<void> | undefined;
export function ensureMock(): Promise<void> {
  if (!isMock || typeof window === "undefined") return Promise.resolve();
  return mockReady ??= import("./mock-browser").then(async ({ worker }) => { await worker.start({ onUnhandledFrame: "bypass", quiet: true }); }).catch((error) => { mockReady = undefined; throw error; });
}
export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) { super(message); this.name = "ApiError"; this.status = status; }
}
export function apiError(value: unknown, status = 0): ApiError {
  if (value instanceof ApiError) return value;
  const p = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const message = typeof p.detail === "string" ? p.detail : typeof p.title === "string" ? p.title : "The request could not be completed. Retry or check the connection.";
  return new ApiError(message.slice(0, 2000), status);
}
export const retryQuery = (failureCount: number, error: Error) => failureCount < 2 && error instanceof ApiError && (error.status === 0 || error.status >= 500);
const baseUrl = typeof window === "undefined" ? "http://localhost" : "";
async function boundedFetch(request: Request) {
  await ensureMock();
  const deadline = AbortSignal.timeout(15000);
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
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) { if (request.signal.aborted) throw error; if (deadline.aborted) throw new ApiError("The API did not respond within 15 seconds. Please retry.", 504); throw apiError(error); }
}
const api = createClient<paths>({ baseUrl, fetch: boundedFetch });
export const producer = createClient<ProducerPaths>({ baseUrl, fetch: boundedFetch });

export type WindowRequest = NonNullable<paths["/api/v1/dataset"]["get"]["parameters"]["query"]>;
export type JobRequest = components["schemas"]["JobRequest"];
export type Job = components["schemas"]["Job"];
export const defaultWindow: WindowRequest = isMock
  ? { from: "2026-11-14T00:00:00Z", to: "2026-11-18T00:00:00Z", resolutionSeconds: 10800 }
  : { from: "2026-11-14T00:00:00Z", to: "2026-11-21T00:00:00Z", resolutionSeconds: 3600 };
export function validateCustomWindow(request: WindowRequest) {
  const span = utcMillis(request.to, "End UTC") - utcMillis(request.from, "Start UTC");
  if (span <= 0 || span > 366 * 86400000 || request.resolutionSeconds !== 3600) throw new ApiError("Choose an increasing UTC range of up to 366 days for an hourly custom-site job.", 422);
  return request;
}
export function validateWindow(request: WindowRequest) {
  const span = utcMillis(request.to, "End UTC") - utcMillis(request.from, "Start UTC");
  if (span <= 0 || span > 31 * 86400000) throw new ApiError("Choose an increasing UTC range of at most 31 days (draft limit).", 422);
  if (!Number.isInteger(request.resolutionSeconds) || request.resolutionSeconds < 60 || request.resolutionSeconds > 86400 || Math.ceil(span / (request.resolutionSeconds * 1000)) + 1 > 10000) throw new ApiError("Choose 60–86400 seconds per sample and at most 10,000 requested samples per series.", 422);
  return request;
}
export function validateTerrainWindow(request: WindowRequest) {
  const span = utcMillis(request.to, "End UTC") - utcMillis(request.from, "Start UTC");
  if (span <= 0 || span > 31 * 86400000) throw new ApiError("Choose an increasing UTC range of up to 31 days for the catalog comparison.", 422);
  if (!Number.isInteger(request.resolutionSeconds) || request.resolutionSeconds < 3600 || request.resolutionSeconds > 2678400)
    throw new ApiError("Choose a track sampling step between 3,600 and 2,678,400 seconds.", 422);
  return request;
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
  if (!response.ok) throw apiError(error, response.status);
  return withinRequestedWindow(validateDataset(data), request);
}
export type TerrainTarget = { run_id: string; site_id?: string };
const terrainSections = ["horizon", "series", "windows", "metrics"] as const;
type ProducerDatasetQuery = NonNullable<ProducerPaths["/api/v1/dataset"]["get"]["parameters"]["query"]>;
export async function getProducerDataset(query: ProducerDatasetQuery, signal?: AbortSignal) {
  try {
    const { data, error, response } = await producer.GET("/api/v1/dataset", { params: { query }, signal });
    if (!response.ok) throw apiError(error, response.status);
    return data;
  } catch (error) {
    if (error instanceof SyntaxError) throw new ApiError("The API returned incomplete or invalid JSON. Please retry.", 502);
    throw error;
  }
}
export async function getTerrainWindow(request: WindowRequest, signal?: AbortSignal, target?: TerrainTarget) {
  if (target?.site_id) validateCustomWindow(request);
  else validateTerrainWindow(request);
  const siteIds = target?.site_id ?? "im1_odysseus,im2_athena";
  const data = await getProducerDataset({
    run_id: target?.run_id, site_ids: siteIds, start: request.from, end: request.to, step_s: request.resolutionSeconds,
    horizon_step_deg: 0.5, max_points: 10000, include: terrainSections.join(","),
  }, signal);
  if (!Array.isArray(data?.include) || !terrainSections.every(section => data.include.includes(section)))
    throw new ApiError("The server response is missing a requested dataset section.", 502);
  const result = parseTerrainSummary(data, request);
  if (target && result.run.run_id !== target.run_id) throw new ApiError("The returned model run differs from the shared link.", 502);
  if (result.sites.map(site => site.id).join(",") !== siteIds)
    throw new ApiError("The returned sites do not match the requested comparison.", 502);
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
  if (response.status !== 202 || !data || typeof data.jobId !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(data.jobId)) throw apiError(error ?? { detail: "The server did not return a valid accepted job." }, response.status);
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
  if (!response.ok) throw apiError(error, response.status);
  const job = validateJob(data);
  if (job.jobId !== id) throw new ApiError("The server returned a different job.", 502);
  if (job.status === "done") withinRequestedWindow(job.result, request);
  return job;
}
export const jobPollInterval = (job?: Job) => job?.status === "done" || job?.status === "failed" ? false : 1500;
