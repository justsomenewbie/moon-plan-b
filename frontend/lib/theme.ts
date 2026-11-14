export type ThemeMode = "auto" | "light" | "dark";

export function localTheme(mode: ThemeMode, date: Date): "light" | "dark" {
  if (mode !== "auto") return mode;
  const hour = date.getHours();
  return hour >= 7 && hour < 19 ? "light" : "dark";
}

export function savedTheme(value: string | null): ThemeMode {
  return value === "light" || value === "dark" ? value : "auto";
}
