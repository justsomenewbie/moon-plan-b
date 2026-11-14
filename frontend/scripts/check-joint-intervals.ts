// Offline release QA. The browser continues to display the producer's intervals.
import { readFileSync, statSync } from "node:fs";
import { validateDataset } from "../lib/dataset.ts";
import type { Interval } from "../lib/dataset.ts";

type Span = [number, number];

function appendSpan(spans: Span[], start: number, end: number) {
  if (start >= end) return;
  const previous = spans.at(-1);
  if (previous && previous[1] === start) previous[1] = end;
  else spans.push([start, end]);
}

function timeSpans(intervals: Interval[]): Span[] {
  const spans: Span[] = [];
  for (const interval of intervals) {
    appendSpan(spans, Date.parse(interval.startUtc), Date.parse(interval.endUtc));
  }
  return spans;
}

function intersection(sun: Span[], earth: Span[]): Span[] {
  const joint: Span[] = [];
  let i = 0, j = 0;
  while (i < sun.length && j < earth.length) {
    const [sunStart, sunEnd] = sun[i];
    const [earthStart, earthEnd] = earth[j];
    appendSpan(joint, Math.max(sunStart, earthStart), Math.min(sunEnd, earthEnd));
    if (sunEnd <= earthEnd) i++;
    if (earthEnd <= sunEnd) j++;
  }
  return joint;
}

function utcBounds(spans: Span[]) {
  return spans.map(([start, end]) => [new Date(start).toISOString(), new Date(end).toISOString()]);
}

function main() {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) throw new Error("Usage: node scripts/check-joint-intervals.ts <release.json>");
  const file = statSync(path);
  if (!file.isFile() || file.size > 5 * 1024 * 1024) throw new Error("Expected a regular JSON file up to 5 MiB.");
  const dataset = validateDataset(JSON.parse(readFileSync(path, "utf8")));
  let checked = 0;
  let intervalMismatches = 0;
  let longestReviews = 0;
  for (const scenario of dataset.scenarios) {
    const row = { scenario: scenario.id, site: scenario.siteId, startUtc: scenario.startUtc, endUtc: scenario.endUtc };
    if (!scenario.intervals) {
      console.log(JSON.stringify({ ...row, status: "unassessed", coverage: scenario.coverage }));
      continue;
    }
    checked++;
    const expected = intersection(timeSpans(scenario.intervals.sun), timeSpans(scenario.intervals.earth));
    const supplied = timeSpans(scenario.intervals.simultaneous);
    const match = expected.length === supplied.length && expected.every(([start, end], i) =>
      start === supplied[i][0] && end === supplied[i][1]);
    const longestMs = expected.reduce((max, [start, end]) => Math.max(max, end - start), 0);
    const producerLongest = scenario.metrics!.simultaneousLongestHours;
    // Apply the 0.001-hour tolerance to exact UTC milliseconds before converting to hours.
    const toleranceMs = 3600;
    const longestMatches = producerLongest > (longestMs - toleranceMs) / 3600000
      && producerLongest < (longestMs + toleranceMs) / 3600000;
    if (!match) intervalMismatches++;
    if (!longestMatches) longestReviews++;
    console.log(JSON.stringify({
      ...row, status: match ? "match" : "mismatch", longestStatus: longestMatches ? "match" : "review",
      expectedUtc: utcBounds(expected), suppliedUtc: utcBounds(supplied),
      expectedTotalHours: expected.reduce((sum, [start, end]) => sum + (end - start), 0) / 3600000,
      suppliedTotalHours: supplied.reduce((sum, [start, end]) => sum + (end - start), 0) / 3600000,
      longestContinuousHours: longestMs / 3600000, producerLongestHours: producerLongest,
    }));
  }
  console.log(JSON.stringify({ dataset: dataset.datasetId, evidence: dataset.evidence, checked, intervalMismatches, longestReviews }));
  if (!checked || intervalMismatches || longestReviews) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
