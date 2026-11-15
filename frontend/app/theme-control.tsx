"use client";

import { useEffect, useState } from "react";
import { localTheme, nextThemeBoundary, savedTheme } from "../lib/theme";
import type { ThemeMode } from "../lib/theme";
import { useLanguage } from "./language";

const STORAGE_KEY = "moon-plan-b-theme";

export default function ThemeControl() {
  const { t } = useLanguage();
  const [mode, setMode] = useState<ThemeMode | null>(null);

  useEffect(() => {
    try { setMode(savedTheme(localStorage.getItem(STORAGE_KEY))); }
    catch { setMode("auto"); }
  }, []);

  useEffect(() => {
    if (!mode) return;
    let timer = 0;
    const update = () => {
      const now = new Date();
      document.documentElement.dataset.theme = localTheme(mode, now);
      if (mode !== "auto") return;
      // Wake at the next local 06:00 or 18:00; one second late so the clock has passed the boundary.
      window.clearTimeout(timer);
      timer = window.setTimeout(update, nextThemeBoundary(now).getTime() - now.getTime() + 1000);
    };
    update();
    if (mode !== "auto") return;
    const refresh = () => { if (!document.hidden) update(); };
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [mode]);

  function choose(value: string) {
    const next = savedTheme(value);
    setMode(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Appearance still works when storage is unavailable. */ }
  }

  return <label className="theme-select">
    <span className="sr-only">{t("Appearance")}</span>
    <select aria-label={t("Appearance")} aria-describedby="theme-help" value={mode ?? "auto"} disabled={!mode}
      onChange={event => choose(event.target.value)}>
      <option value="auto">{t("Auto")}</option>
      <option value="light">{t("Light")}</option>
      <option value="dark">{t("Dark")}</option>
    </select>
    <span className="sr-only" id="theme-help">{t("Auto uses light from 06:00 to 18:00 on your device clock, and dark otherwise. Observation times remain UTC.")}</span>
  </label>;
}
