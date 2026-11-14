import { utcMillis } from "../dataset.ts";
import { ApiError, apiError, producer } from "./client.ts";
import type { components } from "./producer";

type RetainedVisibility = Pick<components["schemas"]["DatasetSeries"], "t" | "sun_visible" | "earth_visible" | "both_visible">;
type Instant = components["schemas"]["InstantResponse"];
type Body = Pick<Instant["sun"], "az_deg" | "el_deg" | "horizon_el_deg" | "clearance_deg" | "visible">;
export type SiteInstant = Pick<Instant, "run_id" | "site_id" | "t" | "sample_utc" | "sample_index" | "step_s" | "precision_h" | "both_visible"> & {
  sun: Body; earth: Body;
};

function wholeSecond(utc: string, status: number): number {
  if (typeof utc === "string" && utc.length === 20) {
    try { return utcMillis(utc); } catch { /* Invalid UTC date or format. */ }
  }
  throw new ApiError("Expected a whole-second UTC instant.", status);
}
function check(condition: unknown): asserts condition {
  if (!condition) throw new ApiError("The site instant differs from the requested site, run or model sample.", 502);
}
function readBody(body: Body): Body {
  check(body && typeof body.visible === "boolean" && Number.isFinite(body.az_deg) && body.az_deg >= 0 && body.az_deg < 360 &&
    Number.isFinite(body.el_deg) && Math.abs(body.el_deg) <= 90 &&
    Number.isFinite(body.horizon_el_deg) && Math.abs(body.horizon_el_deg) <= 90 &&
    Number.isFinite(body.clearance_deg) && Math.abs(body.clearance_deg) <= 180 &&
    Math.abs(body.clearance_deg - (body.el_deg - body.horizon_el_deg)) <= 0.000002);
  // Visibility comes from the producer; a partially visible Sun can have its centre below the horizon.
  const { az_deg, el_deg, horizon_el_deg, clearance_deg, visible } = body;
  return { az_deg, el_deg, horizon_el_deg, clearance_deg, visible };
}

export async function getSiteInstant(
  runId: string, siteId: string, at: string, stepSeconds: number, gridStart: string,
  signal?: AbortSignal, series?: RetainedVisibility | null,
): Promise<SiteInstant> {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(runId) || !/^[A-Za-z0-9_.:-]{1,64}$/.test(siteId) ||
      !Number.isSafeInteger(stepSeconds) || stepSeconds <= 0)
    throw new ApiError("Invalid run, site or model step for the site instant.", 422);
  // A datetime-local control omits the time zone and may omit seconds.
  const input = /^(\d{4}-\d\d-\d\dT\d\d:\d\d)(:\d\d)?Z?$/.exec(at);
  const t = input ? input[1] + (input[2] ?? ":00") + "Z" : at;
  const requested = wholeSecond(t, 422), grid = wholeSecond(gridStart, 422);
  signal?.throwIfAborted();
  const { data, error, response } = await producer.GET("/api/v1/sites/{site_id}/instant", {
    params: { path: { site_id: siteId }, query: { run_id: runId, t } }, signal,
  });
  signal?.throwIfAborted();
  if (!response.ok) throw apiError(error, response.status);
  check(data && data.run_id === runId && data.site_id === siteId && data.t === t && data.step_s === stepSeconds &&
    data.precision_h === stepSeconds / 3600 && (data.sample_index === undefined ||
    (Number.isSafeInteger(data.sample_index) && data.sample_index >= 0)));
  const sample = wholeSecond(data.sample_utc, 502);
  check(sample <= requested && (requested - sample) / 1000 < stepSeconds && ((sample - grid) / 1000) % stepSeconds === 0);
  const sun = readBody(data.sun), earth = readBody(data.earth);
  check(data.both_visible === (sun.visible && earth.visible));
  if (series) {
    const index = series.t.indexOf(data.sample_utc);
    if (index >= 0) check(sun.visible === series.sun_visible[index] && earth.visible === series.earth_visible[index] &&
      data.both_visible === series.both_visible[index]);
  }
  return { run_id: runId, site_id: siteId, t, sample_utc: data.sample_utc, sample_index: data.sample_index,
    step_s: stepSeconds, precision_h: data.precision_h, both_visible: data.both_visible, sun, earth };
}
