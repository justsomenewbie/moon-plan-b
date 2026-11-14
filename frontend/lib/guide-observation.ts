import snapshot from "./odysseus-athena-weeks.json" with { type: "json" };
import type { TerrainSummary } from "./api/terrain-summary";

type Visibility = "both" | "sun" | "earth" | "neither" | "outsideJoint";
type Reading = { name: string; visibility: Visibility };

function sampleTime(now: number, start: string, end: string, step: number) {
  const first = Date.parse(start);
  if (now < first || now >= Date.parse(end)) return null;
  return first + Math.floor((now - first) / step) * step;
}

export function guideObservation(now: number, savedResult: string, terrain: TerrainSummary | null) {
  if (terrain) {
    const { range } = terrain;
    const time = sampleTime(now, range.start, range.end, range.step_s * 1000);
    if (time === null) return null;
    const covers = (w: { start: string; end: string }) => Date.parse(w.start) <= time && time < Date.parse(w.end);
    const readings: Reading[] = terrain.sites.filter(site => site.coverage_in_range === "complete").map(site => {
      const sun = site.windows.sun.some(covers);
      const earth = site.windows.earth.some(covers);
      return { name: site.name, visibility: sun ? (earth ? "both" : "sun") : (earth ? "earth" : "neither") };
    });
    return readings.length ? { time, readings, source: terrain.run.run_id, saved: false } : null;
  }

  for (const week of snapshot.weeks) {
    const time = sampleTime(now, week.startUtc, week.endUtc, 3600000);
    if (time === null) continue;
    const readings: Reading[] = week.sites.filter(site => site.id === savedResult || week.startUtc === savedResult).map(site => ({
      name: site.name,
      visibility: Date.parse(site.overlap.start) <= time && time < Date.parse(site.overlap.end) ? "both" : "outsideJoint",
    }));
    if (readings.length) return { time, readings, source: snapshot.runId, saved: true };
  }
  return null;
}
