import type { components } from "./producer";
import { ApiError, apiError, producer } from "./client.ts";
import { utcMillis } from "../dataset.ts";

type Schema = components["schemas"];
type Constraints = Schema["DateConstraintsInput"];
type RequestBody = Schema["AltDatesRequest"];
export type AltDatesRequest = Omit<RequestBody, "constraints" | "max_results" | "run_id">
  & { run_id: string; constraints?: Partial<Constraints>; max_results?: number };
export type AltDatesResponse = Schema["AltDatesResponse"];

const defaults: Constraints = {
  min_sun_pct: 0, min_earth_pct: 0, min_both_pct: 0, objective: "balanced", min_separation_h: 12,
  require_sun_at_landing: true, require_earth_at_landing: false, min_continuous_sun_h: 0, min_continuous_earth_h: 0,
  max_dark_gap_h: null, max_comms_gap_h: null, min_sun_el_at_landing_deg: null,
};
const objectives: Constraints["objective"][] = ["earliest", "sun", "earth", "both", "energy", "balanced"];
const HOUR = 3600000;
const METRIC_TOLERANCE = 1e-6;

function between(value: number, min: number, max = Infinity) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function wholeSecond(value: string) {
  // The producer echoes whole seconds. Reject fractional bounds instead of silently widening the search.
  try { return utcMillis(value.replace(/\.0{1,9}Z$/, "Z")) / 1000; } catch { return NaN; }
}

function countInRange(n: number, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(n) && n >= 0 && n <= max;
}

function validateRequest(request: AltDatesRequest, stepSeconds: number): RequestBody {
  const earliest = wholeSecond(request.earliest), latest = wholeSecond(request.latest);
  if (!Number.isInteger(earliest) || !Number.isInteger(latest) || latest < earliest)
    throw new ApiError("Choose whole-second UTC landing bounds in chronological order.", 422);
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(request.run_id) || !/^[A-Za-z0-9_.:-]{1,64}$/.test(request.site_id))
    throw new ApiError("Choose a valid model run and observation site.", 422);
  const steps = request.mission_h * 3600 / stepSeconds;
  if (!Number.isSafeInteger(stepSeconds) || stepSeconds <= 0 || !Number.isSafeInteger(steps) || steps < 1)
    throw new ApiError("Choose a positive mission duration that is a multiple of the model sampling step.", 422);
  const max_results = request.max_results ?? 10;
  const c = { ...defaults, ...request.constraints };
  if (Object.keys(c).some(key => !Object.hasOwn(defaults, key))
      || !countInRange(max_results, 50) || !max_results || !objectives.includes(c.objective)
      || ![c.min_sun_pct, c.min_earth_pct, c.min_both_pct].every(pct => between(pct, 0, 100))
      || ![c.min_continuous_sun_h, c.min_continuous_earth_h, c.min_separation_h].every(hours => between(hours, 0))
      || ![c.max_dark_gap_h, c.max_comms_gap_h].every(hours => hours === null || between(hours, 0))
      || (c.min_sun_el_at_landing_deg !== null && !between(c.min_sun_el_at_landing_deg, -90, 90))
      || typeof c.require_sun_at_landing !== "boolean" || typeof c.require_earth_at_landing !== "boolean")
    throw new ApiError("Choose valid landing search constraints.", 422);
  return {
    ...request, earliest: new Date(earliest * 1000).toISOString().replace(".000Z", "Z"),
    latest: new Date(latest * 1000).toISOString().replace(".000Z", "Z"), constraints: c, max_results,
  };
}

export async function findAltDates(request: AltDatesRequest, stepSeconds: number, signal?: AbortSignal, gridStart?: string): Promise<AltDatesResponse> {
  const body = validateRequest(request, stepSeconds);
  signal?.throwIfAborted();
  const { data, error, response } = await producer.POST("/api/v1/alt-dates", { body, signal });
  signal?.throwIfAborted();
  if (!response.ok) throw apiError(error, response.status);

  const first = Date.parse(body.earliest), last = Date.parse(body.latest), step = stepSeconds * 1000;
  const c = data?.constraints;
  if (!data || data.site_id !== body.site_id || data.run_id !== body.run_id || data.step_s !== stepSeconds
      || data.precision_h !== stepSeconds / 3600 || data.mission_duration_h !== body.mission_h
      || data.earliest_utc !== body.earliest || data.latest_utc !== body.latest
      || typeof data.cache_id !== "string" || !/^[a-f0-9]{64}$/i.test(data.cache_id)
      || !c || Object.keys(c).some(key => !Object.hasOwn(defaults, key))
      || !Object.entries(body.constraints).every(([key, value]) => c[key as keyof Constraints] === value))
    throw new ApiError("The returned landing search differs from the request.", 502);

  const { n_evaluated, n_feasible, rejected_by, candidates } = data;
  const limit = Math.floor((last - first) / step) + 1;
  if (!countInRange(n_evaluated, limit) || !countInRange(n_feasible, n_evaluated)
      || !rejected_by || typeof rejected_by !== "object" || Array.isArray(rejected_by)
      || !Object.values(rejected_by).every(n => countInRange(n, n_evaluated - n_feasible))
      || !Array.isArray(candidates) || candidates.length > Math.min(n_feasible, body.max_results)
      || (n_feasible > 0 && !candidates.length))
    throw new ApiError("The landing search returned inconsistent candidate counts.", 502);

  const landings: number[] = [];
  for (const [i, candidate] of candidates.entries()) {
    if (!candidate) throw new ApiError("The server returned an invalid proposed landing window.", 502);
    const landing = wholeSecond(candidate.landing_utc) * 1000, end = wholeSecond(candidate.mission_end_utc) * 1000;
    const origin = gridStart === undefined ? landings[0] ?? landing : Date.parse(gridStart);
    if (candidate.rank !== i + 1 || !between(landing, first, last) || (landing - origin) % step !== 0
        || end - landing !== body.mission_h * HOUR || !Number.isFinite(candidate.slip_h)
        || Math.abs(candidate.slip_h - (landing - first) / HOUR) > 0.000001
        || landings.some(time => time === landing || Math.abs(landing - time) < c.min_separation_h * HOUR)
        || (i > 0 && c.objective === "earliest" && landing <= landings[i - 1])
        || !Number.isFinite(candidate.score)
        || ![candidate.sun_pct, candidate.earth_pct, candidate.both_pct].every(pct => between(pct, 0, 100))
        || candidate.both_pct > Math.min(candidate.sun_pct, candidate.earth_pct)
        // Three independently rounded percentages can differ from the exact overlap bound.
        || candidate.both_pct + 2 * METRIC_TOLERANCE < candidate.sun_pct + candidate.earth_pct - 100
        || candidate.sun_pct + METRIC_TOLERANCE < c.min_sun_pct || candidate.earth_pct + METRIC_TOLERANCE < c.min_earth_pct
        || candidate.both_pct + METRIC_TOLERANCE < c.min_both_pct
        || (c.require_sun_at_landing && !candidate.sun_at_landing) || (c.require_earth_at_landing && !candidate.earth_at_landing)
        || ![candidate.longest_dark_h, candidate.longest_comms_gap_h].every(hours => between(hours, 0, body.mission_h))
        || ![candidate.continuous_sun_h, candidate.continuous_earth_h].every(hours => between(hours, 0))
        || ![candidate.sun_el_at_landing_deg, candidate.earth_el_at_landing_deg].every(el => between(el, -90, 90))
        || (c.max_dark_gap_h !== null && candidate.longest_dark_h > c.max_dark_gap_h + METRIC_TOLERANCE)
        || (c.max_comms_gap_h !== null && candidate.longest_comms_gap_h > c.max_comms_gap_h + METRIC_TOLERANCE)
        || (c.min_sun_el_at_landing_deg !== null && candidate.sun_el_at_landing_deg + METRIC_TOLERANCE < c.min_sun_el_at_landing_deg)
        // A lower bound alone cannot disprove a required continuous duration.
        || (!candidate.continuous_sun_lower_bound && candidate.continuous_sun_h + METRIC_TOLERANCE < c.min_continuous_sun_h)
        || (!candidate.continuous_earth_lower_bound && candidate.continuous_earth_h + METRIC_TOLERANCE < c.min_continuous_earth_h)
        || ![candidate.sun_at_landing, candidate.earth_at_landing, candidate.continuous_sun_lower_bound,
          candidate.continuous_earth_lower_bound].every(flag => typeof flag === "boolean")
        || !Number.isFinite(candidate.mean_power_horizontal) || !Number.isFinite(candidate.mean_power_tracking))
      throw new ApiError("The server returned an invalid proposed landing window.", 502);
    landings.push(landing);
  }
  return data;
}
