"use client";

import { useEffect, useState } from "react";
import { localTheme, savedTheme } from "../lib/theme";
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
    const update = () => { document.documentElement.dataset.theme = localTheme(mode, new Date()); };
    update();
    if (mode !== "auto") return;
    const timer = window.setInterval(update, 60000);
    document.addEventListener("visibilitychange", update);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [mode]);

  function choose(value: string) {
    const next = savedTheme(value);
    setMode(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Appearance still works when storage is unavailable. */ }
  }

  return <><label className="theme-control">{t("Appearance")}{" "}<select value={mode ?? "auto"} disabled={!mode} onChange={(event) => choose(event.target.value)} aria-describedby="theme-help">
      <option value="auto">{t("Auto · local time")}</option><option value="light">{t("Light")}</option><option value="dark">{t("Dark")}</option>
    </select>
  </label><span className="sr-only" id="theme-help">{t("Auto uses light from 07:00 to 19:00 on your device, and dark otherwise. Observation times remain UTC.")}</span></>;
}
