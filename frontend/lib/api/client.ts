// AI-assisted draft integration. Replace the shared OpenAPI source only after producer agreement.
import createClient from "openapi-fetch";
import type { components, paths } from "./schema";
import { utcMillis, validateDataset } from "../dataset.ts";

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
const api = createClient<paths>({ baseUrl: typeof window === "undefined" ? "http://localhost" : "", fetch: async (request) => {
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
} });

export type WindowRequest = NonNullable<paths["/api/v1/dataset"]["get"]["parameters"]["query"]>;
export type JobRequest = components["schemas"]["JobRequest"];
export type Job = components["schemas"]["Job"];
export const defaultWindow: WindowRequest = { from: "2026-11-14T00:00:00Z", to: "2026-11-18T00:00:00Z", resolutionSeconds: 10800 };
export function validateWindow(request: WindowRequest) {
  const span = utcMillis(request.to, "End UTC") - utcMillis(request.from, "Start UTC");
  if (span <= 0 || span > 31 * 86400000) throw new ApiError("Choose an increasing UTC range of at most 31 days (draft limit).", 422);
  if (!Number.isInteger(request.resolutionSeconds) || request.resolutionSeconds < 60 || request.resolutionSeconds > 86400 || Math.ceil(span / (request.resolutionSeconds * 1000)) + 1 > 10000) throw new ApiError("Choose 60–86400 seconds per sample and at most 10,000 requested samples per series.", 422);
  return request;
}
export async function getDataset(request: WindowRequest, signal?: AbortSignal) {
  validateWindow(request);
  const { data, error, response } = await api.GET("/api/v1/dataset", { params: { query: request }, signal });
  if (!response.ok) throw apiError(error, response.status);
  const dataset = validateDataset(data);
  if (dataset.scenarios.some((s) => Date.parse(s.startUtc) < Date.parse(request.from) || Date.parse(s.endUtc) > Date.parse(request.to))) throw new ApiError("The server returned observations outside the requested UTC range.", 502);
  return dataset;
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
export async function getJob(id: string, signal?: AbortSignal) {
  const { data, error, response } = await api.GET("/api/v1/jobs/{id}", { params: { path: { id } }, signal });
  if (!response.ok) throw apiError(error, response.status);
  const job = validateJob(data);
  if (job.jobId !== id) throw new ApiError("The server returned a different job.", 502);
  return job;
}
export const jobPollInterval = (job?: Job) => job?.status === "done" || job?.status === "failed" ? false : 1500;
