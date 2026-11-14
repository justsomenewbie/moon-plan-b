export type EarthWindow = { start: string; end: string };

// The producer supplies ordered, validated positive spans. The end of each span is exclusive.
export function clipEarthWindows(windows: readonly EarthWindow[], from: string, to: string): EarthWindow[] {
  const lower = Date.parse(from), upper = Date.parse(to);
  const result: EarthWindow[] = [];
  const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
  for (const window of windows) {
    const start = Math.max(lower, Date.parse(window.start)), end = Math.min(upper, Date.parse(window.end));
    if (start >= end) continue;
    const previous = result.at(-1);
    const startUtc = iso(start), endUtc = iso(end);
    if (previous?.end === startUtc) previous.end = endUtc;
    else result.push({ start: startUtc, end: endUtc });
  }
  return result;
}
