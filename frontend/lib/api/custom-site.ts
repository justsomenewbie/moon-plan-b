import { ApiError, apiError, producer } from "./client.ts";
import type { components } from "./producer";
import { utcMillis } from "../dataset.ts";

type Schemas = components["schemas"];
export type CustomSiteInput = Required<Pick<Schemas["CustomSiteJobRequest"], "lat_deg" | "lon_deg" | "observer_height_m" | "start" | "end">>;
const jobIdPattern = /^j_[A-Za-z0-9]{6,40}$/;
const siteIdPattern = /^[A-Za-z0-9_.:-]{1,64}$/;
const terminal = ["succeeded", "failed", "cancelled"] as const;
const stages = ["queued", "precompute", "python", "import", "artifacts", "done"];

function valid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ApiError(message, 502);
}
function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function shortText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 2000;
}

export async function getCustomSiteCapability(signal?: AbortSignal) {
  const { data, error, response } = await producer.GET("/api/v1/capabilities", { signal });
  if (!response.ok) throw apiError(error, response.status);
  const jobs = Array.isArray(data?.job_types) ? data.job_types.filter(item => item?.type === "custom_site") : [];
  const job = jobs[0], spice = data?.providers?.spice, pgda = data?.dems?.pgda;
  const message = "The server returned invalid custom-site capabilities.";
  valid(jobs.length === 1 && typeof job.implemented === "boolean" && job.limits && typeof job.limits === "object" && !Array.isArray(job.limits), message);
  valid(Array.isArray(data?.horizon_methods) && [job, spice, pgda].every(item => typeof item?.available === "boolean" && (item.reason === null || shortText(item.reason))), message);
  const maxObserverHeightM = job.limits.observer_height_m_max ?? 100;
  const maxRangeDays = job.limits.max_range_days ?? 366;
  const steps = job.limits.step_min_allowed ?? [60];
  valid(finite(maxObserverHeightM, 0, Number.MAX_SAFE_INTEGER) && finite(maxRangeDays, 0, Number.MAX_SAFE_INTEGER) && maxRangeDays > 0 && Array.isArray(steps), message);
  const unavailable = [job, spice, pgda].find(item => !item?.available);
  const available = job.implemented && !unavailable && data.horizon_methods.includes("raymarch") && steps.includes(60);
  return { available, reason: available ? null : unavailable?.reason ?? "The hourly SPICE/PGDA custom-site calculation is unavailable.", maxObserverHeightM: Math.min(100, maxObserverHeightM), maxRangeDays: Math.min(366, maxRangeDays) };
}

export async function createCustomSite(input: CustomSiteInput) {
  const { lat_deg, lon_deg, observer_height_m, start, end } = input;
  const span = utcMillis(end, "End UTC") - utcMillis(start, "Start UTC");
  if (!finite(lat_deg, -90, 90) || !finite(lon_deg, -360, 360) || !finite(observer_height_m, 0, 100) || span <= 0 || span > 366 * 86_400_000) {
    throw new ApiError("Check the location, observer height and UTC range for the custom site.", 422);
  }
  const { data, error, response } = await producer.POST("/api/v1/jobs", { body: {
    type: "custom_site", lat_deg, lon_deg, observer_height_m, start, end,
    step_min: 60, provider: "spice", dem: "pgda", horizon_method: "raymarch",
  } });
  if (!response.ok) throw apiError(error, response.status);
  const message = "The server returned an invalid custom-site job receipt.";
  valid(data?.type === "custom_site" && typeof data.job_id === "string" && jobIdPattern.test(data.job_id) && typeof data.cached === "boolean" && data.poll === `/api/v1/jobs/${data.job_id}`, message);
  valid((response.status === 202 && (data.status === "queued" || data.status === "running")) || (response.status === 200 && data.cached && data.status === "succeeded"), message);
  const match = typeof data.site_id === "string" && /^custom:(-?\d{1,2}\.\d{4}):(\d{1,3}\.\d{4})$/.exec(data.site_id);
  valid(match && typeof data.site_id === "string", message);
  // The producer rounds coordinate IDs to four decimals and wraps east longitude at 360°.
  const longitudeDifference = Math.abs((Number(match[2]) - lon_deg + 540) % 360 - 180);
  valid(Math.abs(Number(match[1]) - lat_deg) <= 0.000050001 && longitudeDifference <= 0.000050001, "The accepted job describes different coordinates.");
  return { job_id: data.job_id, site_id: data.site_id, status: data.status, cached: data.cached };
}

export async function getCustomSiteJob(jobId: string, acceptedSiteId?: string, signal?: AbortSignal) {
  if (!jobIdPattern.test(jobId)) throw new ApiError("Invalid custom-site job ID.", 422);
  const { data, error, response } = await producer.GET("/api/v1/jobs/{job_id}", { params: { path: { job_id: jobId } }, signal });
  if (!response.ok) throw apiError(error, response.status);
  const message = "The server returned an invalid custom-site job status.";
  valid(data?.type === "custom_site" && data.job_id === jobId && typeof data.site_id === "string" && siteIdPattern.test(data.site_id) && (!acceptedSiteId || acceptedSiteId === data.site_id), message);
  valid(data.status === "queued" || data.status === "running" || terminal.some(status => status === data.status), message);
  const progress = data.progress;
  valid(progress && stages.includes(progress.stage) && (progress.pct === null || finite(progress.pct, 0, 100)), message);
  const { start, end } = data.params ?? {};
  valid(typeof start === "string" && typeof end === "string" && utcMillis(start) < utcMillis(end), message);
  if (data.status === "succeeded") {
    valid(data.result?.run_id === `job_${jobId}` && data.result.site_id === data.site_id, "The completed job refers to a different model run or site.");
  } else valid(data.result === null, message);
  valid(data.error === null || shortText(data.error?.code) && shortText(data.error?.message), message);
  valid(data.status === "failed" ? data.error !== null : data.status === "cancelled" || data.error === null, message);
  // Progress logs and worker output can contain host paths. Return only the status fields used by the form.
  return { job_id: data.job_id, site_id: data.site_id, status: data.status, start, end,
    progress: { stage: progress.stage, pct: progress.pct }, result: data.result,
    error: data.error && { code: data.error.code, message: data.error.message.split(/[\r\n]/, 1)[0] } };
}
