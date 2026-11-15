// Marker brightness for the share of time a site is in sunlight.
// The ramp runs in OKLCH from a dark slate (0%) to a bright sun yellow (100%): the hue stays sun-coloured
// and lightness rises with the percentage, so brighter always means more sunlight.
export type SunlightStyle = {
  percent: number | null; // rounded for labels; null means the site has no value
  color: string;          // marker fill
  ink: string;            // text colour that stays readable on the fill
  glow: boolean;          // well-lit sites (above 70%) get a soft glow
};

const DARK = { l: .35, c: .02 }, BRIGHT = { l: .92, c: .17 }, HUE = 90;
export const sunlightRamp = { from: `oklch(${DARK.l} ${DARK.c} ${HUE})`, to: `oklch(${BRIGHT.l} ${BRIGHT.c} ${HUE})` };
export const noSunlightData: SunlightStyle = { percent: null, color: "oklch(0.62 0 0)", ink: "#0B0F1A", glow: false };

export function sunlightStyle(percent: number | null | undefined): SunlightStyle {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return noSunlightData;
  const share = Math.max(0, Math.min(100, percent)) / 100;
  const l = DARK.l + (BRIGHT.l - DARK.l) * share, c = DARK.c + (BRIGHT.c - DARK.c) * share;
  return {
    percent: Math.round(share * 100),
    color: `oklch(${+l.toFixed(3)} ${+c.toFixed(3)} ${HUE})`,
    ink: l > .62 ? "#0B0F1A" : "#FFFFFF",
    glow: share > .7,
  };
}
