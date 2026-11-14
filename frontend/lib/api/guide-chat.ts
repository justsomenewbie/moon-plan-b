import snapshot from "../odysseus-athena-weeks.json" with { type: "json" };
import type { Dataset, Scenario } from "../dataset";
import type { TerrainSummary } from "./terrain-summary";

export type GuideRow = { site: string; from: string; to: string; source: string; sunHours: number | null; earthHours: number | null; bothHours: number | null };
export type GuideContext = { kind: "saved" | "terrain" | "scenario" | "synthetic" | "unavailable"; rows: GuideRow[] };
export type GuideAction = "compareSites" | "compareDates" | "workspace" | "sources" | "saved";
export type GuideReply = { answer: string; action: GuideAction | null };
const actions = new Set<GuideAction>(["compareSites", "compareDates", "workspace", "sources", "saved"]);
const unavailable: GuideContext = { kind: "unavailable", rows: [] };

export function savedGuideContext(selection: string): GuideContext {
  const rows = snapshot.weeks.flatMap(week => week.sites.filter(site => week.startUtc === selection || site.id === selection)
    .map(site => ({ site: site.name, from: week.startUtc, to: week.endUtc, source: snapshot.runId,
      sunHours: site.sunHours, earthHours: site.earthHours, bothHours: site.overlap.duration_h })));
  return rows.length ? { kind: "saved", rows } : unavailable;
}

// Dataset labels are supplied by the uploader. Never send links or silently truncate identifiers.
function supportedLabel(value: string, maximum: number) {
  return value === value.trim() && value.length > 0 && value.length <= maximum
    && /^[\p{L}\p{M}\p{N} .,_()+'’°:·–—-]+$/u.test(value) && !/www\./i.test(value);
}

export function workspaceGuideContext(terrain: TerrainSummary | null, data: Dataset | null, a?: Scenario, b?: Scenario, siteIndex = 0): GuideContext {
  if (terrain) {
    const active = terrain.sites[siteIndex];
    const sites = terrain.sites.length <= 8 ? terrain.sites : active ? [active] : [];
    if (!supportedLabel(terrain.run.run_id, 200) || !sites.length || sites.some(s => !supportedLabel(s.name, 120))) return unavailable;
    return { kind: "terrain", rows: sites.map(s => {
      const metrics = s.coverage_in_range === "complete" ? s.metrics : null;
      return { site: s.name, from: terrain.range.start, to: terrain.range.end, source: terrain.run.run_id,
        sunHours: metrics?.sun_hours ?? null, earthHours: metrics?.earth_hours ?? null, bothHours: metrics?.both_hours ?? null };
    }) };
  }
  if (!data || !a || !supportedLabel(data.datasetId, 200)) return unavailable;
  const rows: GuideRow[] = [];
  for (const scenario of b ? [a, b] : [a]) {
    const site = data.sites.find(s => s.id === scenario.siteId);
    if (!site || !supportedLabel(site.name, 120)) return unavailable;
    const complete = scenario.coverage === "complete";
    const intervals = complete ? scenario.intervals?.simultaneous : null;
    const bothHours = intervals ? intervals.reduce((ms, i) => ms + (Date.parse(i.endUtc) - Date.parse(i.startUtc)), 0) / 3600000 : null;
    rows.push({ site: site.name, from: scenario.startUtc, to: scenario.endUtc, source: data.datasetId,
      sunHours: complete ? scenario.metrics?.sunAboveHours ?? null : null, earthHours: complete ? scenario.metrics?.earthAboveHours ?? null : null, bothHours });
  }
  return { kind: data.evidence === "synthetic-fixture" ? "synthetic" : "scenario", rows };
}

export function parseGuideReply(value: unknown): GuideReply {
  if (!value || typeof value !== "object" || !("answer" in value) || typeof value.answer !== "string" || !value.answer.trim()
    || value.answer.length > 8000 || /(?:https?:\/\/|www\.|<\/?[a-z][^>]*>)/i.test(value.answer)) throw Error("Invalid guide response");
  const action = "action" in value && actions.has(value.action as GuideAction) ? value.action as GuideAction : null;
  return { answer: value.answer.trim(), action };
}

export type GuideErrorKey = "failed" | "offline" | "slow" | "limited" | "invalid";
export class GuideRequestError extends Error {
  reason: GuideErrorKey;
  constructor(reason: GuideErrorKey) { super(reason); this.reason = reason; }
}

export async function askGuide(payload: { locale: "en" | "vi"; question: string; previousQuestion?: string; context: GuideContext }, cancel: AbortSignal): Promise<GuideReply> {
  const deadline = AbortSignal.timeout(60_000);
  try {
    const response = await fetch("/guide/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([cancel, deadline]), body: JSON.stringify(payload) });
    if (!response.ok) {
      if (response.status === 400) throw new GuideRequestError("invalid");
      if (response.status === 503) throw new GuideRequestError("offline");
      if (response.status === 504 || response.status === 408) throw new GuideRequestError("slow");
      if (response.status === 429) throw new GuideRequestError("limited");
      throw new GuideRequestError("failed");
    }
    return parseGuideReply(await response.json());
  } catch (error) {
    if (deadline.aborted && !cancel.aborted) throw new GuideRequestError("slow");
    throw error;
  }
}
