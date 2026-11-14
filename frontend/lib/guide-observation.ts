import snapshot from "./odysseus-athena-weeks.json" with { type: "json" };
import type { GuideContext } from "./api/guide-chat.ts";
import { retainedWindows, type WorkspacePlanningEvidence } from "./guide-workspace-planning.ts";

type Visibility = "both" | "sun" | "earth" | "neither" | "outsideJoint";
type Reading = { name: string; visibility: Visibility };

// A saved selection uses the older archive's joint windows. Other sources need retained, per-site intervals.
type ObservationSource = string | ReturnType<typeof retainedWindows> | null;

export function selectedModelSample(context?: GuideContext, evidence?: WorkspacePlanningEvidence | null) {
  if (context?.kind !== "terrain" || !context.rows.length || !evidence) return null;
  const retained = retainedWindows(evidence, "evaluated");
  if (context.rows.some(row => row.source !== retained.run || row.from !== retained.range.start || row.to !== retained.range.end)) return null;
  // Guide rows identify sites by name. An ambiguous label cannot identify a single model observation.
  const sites = context.rows.map(row => retained.sites.filter(site => site.name === row.site));
  if (sites.some(matches => matches.length !== 1)) return null;
  const complete = sites.flat().filter(site => site.complete);
  return complete.length ? { ...retained, sites: complete } : null;
}

function sampleTime(now: number, start: string, end: string, step: number) {
  const first = Date.parse(start);
  if (now < first || now >= Date.parse(end)) return null;
  return first + Math.floor((now - first) / step) * step;
}

export function nextGuideUpdate(now: number, source: ObservationSource) {
  if (source === null) return null;
  const ranges = typeof source !== "string" ? [source.range] : snapshot.weeks
    .filter(week => week.startUtc === source || week.sites.some(site => site.id === source))
    .map(week => ({ start: week.startUtc, end: week.endUtc, step_s: 3600 }));
  for (const range of ranges) {
    const start = Date.parse(range.start);
    if (now < start) return start;
    const step = range.step_s * 1000;
    const time = sampleTime(now, range.start, range.end, step);
    if (time !== null) return Math.min(time + step, Date.parse(range.end));
  }
  return null;
}

export function guideObservation(now: number, source: ObservationSource) {
  if (source === null) return null;
  if (typeof source !== "string") {
    const { range } = source;
    const time = sampleTime(now, range.start, range.end, range.step_s * 1000);
    if (time === null) return null;
    const covers = (w: { start: string; end: string }) => Date.parse(w.start) <= time && time < Date.parse(w.end);
    const readings: Reading[] = source.sites.map(site => {
      const sun = site.windows.sun.some(covers);
      const earth = site.windows.earth.some(covers);
      return { name: site.name, visibility: sun ? (earth ? "both" : "sun") : (earth ? "earth" : "neither") };
    });
    return { time, readings, source: source.run, saved: false };
  }

  for (const week of snapshot.weeks) {
    const time = sampleTime(now, week.startUtc, week.endUtc, 3600000);
    if (time === null) continue;
    const readings: Reading[] = week.sites.filter(site => site.id === source || week.startUtc === source).map(site => ({
      name: site.name,
      visibility: Date.parse(site.overlap.start) <= time && time < Date.parse(site.overlap.end) ? "both" : "outsideJoint",
    }));
    if (readings.length) return { time, readings, source: snapshot.runId, saved: true };
  }
  return null;
}
