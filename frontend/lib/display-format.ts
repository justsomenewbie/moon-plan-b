// Display-only helpers for labels and links. None of them changes a value.

// "B2_spice_pgda_bruteforce_2026_2030_fix676af9d" → "Run B2". The short name is the run id's own prefix.
export function runShortLabel(runId: string | null | undefined): string | null {
  const name = runId?.match(/^([A-Za-z]\d*)_/)?.[1];
  return name ? "Run " + name.toUpperCase() : null;
}

// A boundary between hourly samples is an estimate: show it to the minute with "≈", never with milliseconds.
// A time that is itself a sample keeps its ISO form (without a zero millisecond part).
export function boundaryTime(utc: string, sampled: boolean, formatUtc: (utc: string) => string): string {
  return sampled ? utc.replace(/\.000Z$/, "Z") : "≈ " + formatUtc(utc);
}

// The interface names LOLA elevation files that NASA lists on PGDA product page 90, so links that only
// reach the PGDA home page go to that product page instead. Other links are left as they are.
export const PGDA_LOLA_PRODUCT = "https://pgda.gsfc.nasa.gov/products/90";
export function sourceLink(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "pgda.gsfc.nasa.gov" && (parsed.pathname === "/" || parsed.pathname === "") ? PGDA_LOLA_PRODUCT : url;
  } catch { return url; }
}
