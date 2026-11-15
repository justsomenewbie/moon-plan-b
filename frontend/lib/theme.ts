export type ThemeMode = "auto" | "light" | "dark";

// "auto" follows the device's prefers-color-scheme setting.
export function localTheme(mode: ThemeMode, prefersDark: boolean): "light" | "dark" {
  if (mode !== "auto") return mode;
  return prefersDark ? "dark" : "light";
}

export function savedTheme(value: string | null): ThemeMode {
  return value === "light" || value === "dark" ? value : "auto";
}
