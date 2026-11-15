export type ThemeMode = "auto" | "light" | "dark";

// "auto" is light from 06:00 to 18:00 on the visitor's own clock, and dark otherwise.
export const LIGHT_FROM_HOUR = 6;
export const DARK_FROM_HOUR = 18;

export function localTheme(mode: ThemeMode, date: Date): "light" | "dark" {
  if (mode !== "auto") return mode;
  const hour = date.getHours();
  return hour >= LIGHT_FROM_HOUR && hour < DARK_FROM_HOUR ? "light" : "dark";
}

// The next local 06:00 or 18:00 after the given moment, when "auto" changes appearance.
export function nextThemeBoundary(date: Date): Date {
  const next = new Date(date);
  next.setMinutes(0, 0, 0);
  const hour = date.getHours();
  if (hour < LIGHT_FROM_HOUR) next.setHours(LIGHT_FROM_HOUR);
  else if (hour < DARK_FROM_HOUR) next.setHours(DARK_FROM_HOUR);
  else { next.setDate(next.getDate() + 1); next.setHours(LIGHT_FROM_HOUR); }
  return next;
}

export function savedTheme(value: string | null): ThemeMode {
  return value === "light" || value === "dark" ? value : "auto";
}

// Only "auto" follows the clock; an explicit choice is never changed by a timer or a tab becoming visible.
export const followsClock = (mode: ThemeMode) => mode === "auto";

// The sun/moon button always makes an explicit choice: the opposite of what is showing. This turns Auto off.
export function toggleAppearance(appearance: "light" | "dark"): ThemeMode {
  return appearance === "light" ? "dark" : "light";
}

// The Auto button is a toggle: on from an explicit choice, and off again keeping the theme that is showing.
export function toggleAuto(mode: ThemeMode, appearance: "light" | "dark"): ThemeMode {
  return mode === "auto" ? appearance : "auto";
}
